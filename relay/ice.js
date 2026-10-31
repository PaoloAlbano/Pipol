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
//   cloudflare      CF_TURN_KEY_ID, CF_TURN_API_TOKEN     Cloudflare Realtime TURN
//
// Common: TURN_TTL (seconds, default 86400) for the providers that mint credentials.
// With nothing configured the list is empty and clients fall back to public STUN.

import crypto from 'node:crypto'

const DEFAULT_TTL_SECONDS = 86400
const CLOUDFLARE_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'

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

/** TURN REST API (draft-uberti-behave-turn-rest): username = "<expiry>:<id>", credential = HMAC-SHA1. */
export function sharedSecretCredentials(secret, urls, ttlSeconds, nowMs = Date.now()) {
  const username = `${Math.floor(nowMs / 1000) + ttlSeconds}:pipol`
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
    configured: (env) => Boolean(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN),
    async fetch({ env, ttl, fetchImpl }) {
      const res = await fetchImpl(`${CLOUDFLARE_API}/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
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
  let cached = null // { value, expiresAt }

  return {
    /** Name of the active provider, or null when TURN is not configured. */
    name: selection.name,
    /** Why TURN is not configured although the user tried to (misspelt or incomplete setup). */
    error: selection.error ?? null,

    /** Credentials are fetched once and reused until half of their lifetime has passed. */
    async get() {
      if (!selection.name) return { iceServers: [], ttl: 0 }
      if (cached && cached.expiresAt > now()) return cached.value

      const result = await providers[selection.name].fetch({ env, ttl, now, fetchImpl })
      const value = { iceServers: dropBlockedPorts(result.iceServers), ttl: result.ttl }
      cached = { value, expiresAt: now() + (value.ttl * 1000) / 2 }
      return value
    },
  }
}
