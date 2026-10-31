// ICE server provider behind GET /ice.
//
// Browsers ask the relay for TURN credentials, so no long-term secret ever reaches the client.
// The relay does not care which TURN service sits behind it: pick one provider with
// TURN_PROVIDER, or leave it unset and the first provider whose variables are present is used.
//
//   TURN_PROVIDER   Needs                                 Use it with
//   -------------   -----------------------------------   -------------------------------------------
//   coturn          TURN_URLS, TURN_SECRET                coturn (use-auth-secret), eturnal, any server
//                                                         implementing the TURN REST API (shared secret)
//   static          TURN_URLS, TURN_USERNAME,             any TURN with one fixed login
//                   TURN_CREDENTIAL
//   http            TURN_API_URL                          a service that returns ICE servers over HTTP:
//                   [TURN_API_AUTHORIZATION]              Metered, Xirsys, Twilio proxy, your own API…
//   cloudflare      CF_TURN_KEY_ID, CF_TURN_API_TOKEN     Cloudflare Realtime TURN (one credential per request,
//                                                         so usage can be attributed: see usage-guard.js)
//
// Common: TURN_TTL (seconds, default 3600) for the providers that mint credentials. Clients renew them
// before they expire, so a short lifetime limits how long copied credentials stay usable.
// With nothing configured the list is empty and clients fall back to public STUN.

import crypto from 'node:crypto'

const DEFAULT_TTL_SECONDS = 3600
const CLOUDFLARE_API = 'https://rtc.live.cloudflare.com/v1/turn/keys' // CF_TURN_API_URL overrides it (tests)

const splitList = (value) =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

/** Browsers block port 53, and waiting for it to time out slows ICE down. */
function dropBlockedPorts(iceServers) {
  return iceServers
    .map((server) => ({ ...server, urls: [].concat(server.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((server) => server.urls.length > 0)
}

/**
 * TURN REST API (draft-uberti-behave-turn-rest): username = "<expiry>:<id>", credential = HMAC-SHA1.
 * `id` must not contain ":"; by default every call gets a fresh random one, which makes each
 * issuance attributable in the TURN logs and lets coturn's `user-quota` apply per issuance.
 */
export function sharedSecretCredentials(
  secret,
  urls,
  ttlSeconds,
  nowMs = Date.now(),
  id = crypto.randomBytes(8).toString('hex')
) {
  const username = `${Math.floor(nowMs / 1000) + ttlSeconds}:${id}`
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64')
  return { urls, username, credential }
}

/**
 * Each provider has:
 *   configured(env) → true when its variables are present
 *   fetch({ env, ttl, now, fetchImpl }) → { iceServers, ttl }
 * Order matters for auto-detection.
 */
export const providers = {
  coturn: {
    // Minting is a local HMAC (free), so nothing is cached: every client gets its own username
    cacheable: false,
    configured: (env) => Boolean(env.TURN_URLS && env.TURN_SECRET),
    async fetch({ env, ttl, now }) {
      const server = sharedSecretCredentials(env.TURN_SECRET, splitList(env.TURN_URLS), ttl, now())
      return { iceServers: [server], ttl }
    },
  },

  static: {
    configured: (env) => Boolean(env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL),
    async fetch({ env }) {
      const server = { urls: splitList(env.TURN_URLS), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }
      // Fixed credentials do not expire: let the relay cache them for a day
      return { iceServers: [server], ttl: DEFAULT_TTL_SECONDS }
    },
  },

  http: {
    configured: (env) => Boolean(env.TURN_API_URL),
    async fetch({ env, fetchImpl }) {
      const headers = env.TURN_API_AUTHORIZATION ? { Authorization: env.TURN_API_AUTHORIZATION } : {}
      const res = await fetchImpl(env.TURN_API_URL, { headers })
      if (!res.ok) throw new Error(`TURN API responded ${res.status}`)
      const body = await res.json()
      // Accept both `[ {urls, …} ]` (Metered) and `{ iceServers: [ … ] }`
      const iceServers = Array.isArray(body) ? body : body?.iceServers
      if (!Array.isArray(iceServers)) throw new Error('TURN API returned no iceServers')
      return { iceServers, ttl: Number(body?.ttl) > 0 ? Number(body.ttl) : 3600 }
    },
  },

  cloudflare: {
    // A credential per request: usage is reported per credential, so an abusive one can be revoked alone
    cacheable: false,
    configured: (env) => Boolean(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN),
    async fetch({ env, ttl, fetchImpl }) {
      const res = await fetchImpl(`${env.CF_TURN_API_URL || CLOUDFLARE_API}/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl }),
      })
      if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`)
      const body = await res.json()
      return { iceServers: body.iceServers ?? [], ttl }
    },
  },
}

/**
 * Picks the provider from the environment.
 * @returns {{ name: string|null, error?: string }}
 */
export function selectProvider(env = process.env) {
  const requested = env.TURN_PROVIDER?.trim().toLowerCase()
  if (requested) {
    if (!providers[requested]) {
      return { name: null, error: `unknown TURN_PROVIDER "${requested}" (use ${Object.keys(providers).join(', ')})` }
    }
    if (!providers[requested].configured(env)) {
      return { name: null, error: `TURN_PROVIDER=${requested} is missing its variables (see relay/ice.js)` }
    }
    return { name: requested }
  }
  const detected = Object.keys(providers).find((name) => providers[name].configured(env))
  return { name: detected ?? null }
}

export function createIceProvider({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const ttl = Number(env.TURN_TTL) > 0 ? Number(env.TURN_TTL) : DEFAULT_TTL_SECONDS
  const selection = selectProvider(env)
  let cached = null // { iceServers, expiresAt, reuseUntil }

  // `ttl` in the answer is the time left, so clients know when to renew whatever the age of the cache
  const remaining = (entry) => ({
    iceServers: entry.iceServers,
    ttl: Math.max(Math.floor((entry.expiresAt - now()) / 1000), 0),
  })

  return {
    /** Name of the active provider, or null when TURN is not configured. */
    name: selection.name,
    /** Why TURN is not configured although the user tried to (misspelt or incomplete setup). */
    error: selection.error ?? null,

    /** Providers that call an external API reuse the credentials until half of their lifetime has passed. */
    async get() {
      if (!selection.name) return { iceServers: [], ttl: 0 }
      const provider = providers[selection.name]
      const cacheable = provider.cacheable !== false
      if (cacheable && cached && cached.reuseUntil > now()) return remaining(cached)

      const result = await provider.fetch({ env, ttl, now, fetchImpl })
      const issuedAt = now()
      const entry = {
        iceServers: dropBlockedPorts(result.iceServers),
        expiresAt: issuedAt + result.ttl * 1000,
        reuseUntil: issuedAt + (result.ttl * 1000) / 2,
      }
      if (cacheable) cached = entry
      return remaining(entry)
    },
  }
}
