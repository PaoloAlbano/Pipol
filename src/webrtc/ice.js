/**
 * ice.js
 * Resolves the ICE (STUN/TURN) configuration used by every RTCPeerConnection.
 *
 * Precedence, highest first:
 *   1. User setting   — "off" (STUN only) or "custom" servers (Settings → Connection)
 *   2. Workspace      — `config.ice` from the invite: static `servers` or an `url` returning { iceServers }
 *   3. App default    — VITE_ICE_URL, otherwise `<relay>/ice` (short-lived TURN credentials)
 *
 * TURN is used for calls only. Chat connections stay on public STUN (they have their own
 * WebSocket fallback) unless the user opts in or asks to always relay.
 *
 * Any failure falls back to the public STUN servers, so a broken TURN setup never blocks a call.
 * TURN only relays packets that are already end-to-end encrypted (DTLS-SRTP).
 */

import { getIceSettings } from '../p2p/storage.js'
import { getTurnstileToken, turnstileSiteKey } from './turnstile.js'

export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]

const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):[^\s]+$/i
const MAX_SERVERS = 8
const MAX_URLS_PER_SERVER = 12
const MAX_FIELD_LENGTH = 512
const FETCH_TIMEOUT_MS = 4000
const MIN_CACHE_MS = 60_000
const MIN_REFRESH_MS = 30_000

const DEFAULT_SETTINGS = { mode: 'default', servers: [], forceRelay: false, chatTurn: false }

function readSettings() {
  try {
    return getIceSettings()
  } catch {
    return DEFAULT_SETTINGS
  }
}

const fetchCache = new Map() // url → { iceServers, expiresAt }

/**
 * Build-level kill switch: VITE_TURN_DISABLED=true (or 1/yes) makes the app use public STUN only.
 * Users can still choose "Custom" servers of their own in Settings.
 */
export function isTurnDisabled() {
  return /^(1|true|yes)$/i.test(String(import.meta.env?.VITE_TURN_DISABLED ?? '').trim())
}

const isTurn = (url) => /^turns?:/i.test(url)

/** True when at least one server can relay traffic. */
export function hasTurnServer(iceServers) {
  return iceServers.some((s) => [].concat(s.urls).some(isTurn))
}

/**
 * Splits free text (one URL per line, or comma/space separated) into a list of URLs.
 * @param {string} text
 * @returns {string[]}
 */
export function parseIceUrls(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean)
}

function normalizeServer(server) {
  if (!server || typeof server !== 'object') return null
  const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((u) => typeof u === 'string')
  if (urls.length === 0 || urls.length > MAX_URLS_PER_SERVER || !urls.every((u) => ICE_URL_PATTERN.test(u))) return null

  const entry = { urls }
  for (const field of ['username', 'credential']) {
    if (server[field] == null || server[field] === '') continue
    if (typeof server[field] !== 'string' || server[field].length > MAX_FIELD_LENGTH) return null
    entry[field] = server[field]
  }
  // TURN cannot authenticate without both fields
  if (urls.some(isTurn) && (!entry.username || !entry.credential)) return null
  return entry
}

/**
 * Strictly validates a list of ICE servers (user input, invite payloads).
 * @param {unknown} servers
 * @returns {{ urls: string[], username?: string, credential?: string }[]}
 * @throws {Error} 'invalid-ice-servers'
 */
export function validateIceServers(servers) {
  if (!Array.isArray(servers) || servers.length === 0 || servers.length > MAX_SERVERS) {
    throw new Error('invalid-ice-servers')
  }
  return servers.map((s) => {
    const entry = normalizeServer(s)
    if (!entry) throw new Error('invalid-ice-servers')
    return entry
  })
}

/**
 * Validates the `ice` block of a workspace config: { servers } and/or { url }.
 * @param {unknown} ice
 * @returns {{ servers?: object[], url?: string } | null}
 * @throws {Error} 'invalid-ice-config'
 */
export function validateWorkspaceIce(ice) {
  if (ice == null) return null
  if (typeof ice !== 'object' || Array.isArray(ice)) throw new Error('invalid-ice-config')

  const out = {}
  if (ice.servers != null) {
    try {
      out.servers = validateIceServers(ice.servers)
    } catch {
      throw new Error('invalid-ice-config')
    }
  }
  if (ice.url != null) {
    let parsed
    try {
      parsed = new URL(ice.url)
    } catch {
      throw new Error('invalid-ice-config')
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('invalid-ice-config')
    out.url = parsed.toString()
  }
  return out.servers || out.url ? out : null
}

/**
 * Builds a workspace `ice` block from form fields. Returns null when every field is empty.
 * @param {{ urls?: string, username?: string, credential?: string, endpoint?: string }} fields
 * @returns {{ servers?: object[], url?: string } | null}
 * @throws {Error} 'invalid-ice-config'
 */
export function buildWorkspaceIce({ urls = '', username = '', credential = '', endpoint = '' } = {}) {
  const list = parseIceUrls(urls)
  const ice = {}
  if (list.length > 0) ice.servers = [{ urls: list, username: username.trim(), credential }]
  if (endpoint.trim()) ice.url = endpoint.trim()
  return Object.keys(ice).length > 0 ? validateWorkspaceIce(ice) : null
}

/**
 * Builds the HTTP(S) URL of the relay's /ice endpoint from its WebSocket URL.
 * @param {string|null} relayUrl  e.g. wss://relay.example.com
 * @returns {string|null}
 */
export function deriveIceUrl(relayUrl) {
  if (!relayUrl) return null
  try {
    const u = new URL(relayUrl)
    u.protocol = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:'
    u.pathname = u.pathname.replace(/\/+$/, '') + '/ice'
    u.search = ''
    return u.toString()
  } catch {
    return null
  }
}

/** True for the app's own /ice endpoint: the Turnstile token only makes sense there, not for third-party relays. */
function isAppIceEndpoint(url) {
  const own = [import.meta.env?.VITE_ICE_URL, deriveIceUrl(import.meta.env?.VITE_DHT_RELAY_URL)].filter(Boolean)
  try {
    return own.some((candidate) => new URL(candidate).origin === new URL(url).origin)
  } catch {
    return false
  }
}

/** `ttl` is the time left on the credentials (seconds), as answered by the endpoint. */
async function fetchIceServers(url, fetchImpl) {
  const cached = fetchCache.get(url)
  if (cached && cached.reuseUntil > Date.now()) {
    return {
      iceServers: cached.iceServers,
      ttl: Math.max(Math.floor((cached.credentialsExpireAt - Date.now()) / 1000), 0),
    }
  }

  // The relay may require a Turnstile token (a fresh one per request)
  const headers = {}
  if (turnstileSiteKey() && isAppIceEndpoint(url)) {
    const token = await getTurnstileToken()
    if (!token) throw new Error('could not get a Turnstile token')
    headers['X-Turnstile-Token'] = token
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers })
    if (res.status === 404) {
      // The relay switched /ice off (ICE_DISABLED) or has none: not an error, just no TURN. Do not ask again soon.
      fetchCache.set(url, { iceServers: [], credentialsExpireAt: 0, reuseUntil: Date.now() + MIN_CACHE_MS })
      return { iceServers: [], ttl: 0 }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const iceServers = (Array.isArray(body?.iceServers) ? body.iceServers : []).map(normalizeServer).filter(Boolean)
    const ttl = Number(body?.ttl) > 0 ? Number(body.ttl) : 0
    const now = Date.now()
    fetchCache.set(url, {
      iceServers,
      credentialsExpireAt: now + ttl * 1000,
      reuseUntil: now + Math.max(ttl * 500, MIN_CACHE_MS),
    })
    return { iceServers, ttl }
  } finally {
    clearTimeout(timer)
  }
}

/** Clears cached /ice responses (used by tests and the Settings "Test" button). */
export function clearIceCache() {
  fetchCache.clear()
}

/**
 * Resolves the RTCConfiguration to use. Never throws.
 *
 * @param {object}  ctx
 * @param {string|null} [ctx.relayUrl]      Relay base URL in use (to derive <relay>/ice)
 * @param {object|null} [ctx.workspaceIce]  Validated `config.ice` of the active workspace
 * @param {object}  [ctx.settings]          User settings (defaults to localStorage)
 * @param {Function} [ctx.fetchImpl]
 * The result carries `refreshInMs` when the credentials expire (renew them by calling again at that time) and
 * `degraded: true` when the endpoint could not be reached and only public STUN is returned.
 *
 * @returns {Promise<{ iceServers: object[], iceTransportPolicy: 'all'|'relay', refreshInMs?: number, degraded?: boolean }>}
 */
export async function resolveIceConfig({
  relayUrl = null,
  workspaceIce = null,
  settings = null,
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  settings ??= readSettings()
  const fallback = { iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all' }
  const withPolicy = (iceServers) => ({
    iceServers,
    iceTransportPolicy: settings.forceRelay && hasTurnServer(iceServers) ? 'relay' : 'all',
  })

  if (settings.mode === 'off') return fallback

  if (settings.mode === 'custom') {
    try {
      return withPolicy(validateIceServers(settings.servers))
    } catch {
      return fallback
    }
  }

  // Kill switch: neither the workspace's nor the app's TURN is used
  if (isTurnDisabled()) return fallback

  if (workspaceIce?.servers?.length) return withPolicy(workspaceIce.servers)

  const url = workspaceIce?.url || import.meta.env?.VITE_ICE_URL || deriveIceUrl(relayUrl)
  if (!url || !fetchImpl) return fallback

  try {
    const { iceServers, ttl } = await fetchIceServers(url, fetchImpl)
    if (iceServers.length === 0) return fallback
    // Renew at 60% of what is left: after the cached copy went stale, with a good margin before expiry
    return { ...withPolicy(iceServers), ...(ttl > 0 && { refreshInMs: Math.max(ttl * 600, MIN_REFRESH_MS) }) }
  } catch (err) {
    console.warn('[ice] could not load ICE servers, using public STUN only:', err.message)
    return { ...fallback, degraded: true }
  }
}

/**
 * RTCConfiguration for the chat data channels, derived from the one used for calls.
 * Calls get TURN; chat only gets it when the user opted in or forces relaying (otherwise
 * "always relay" would still leak the IP through the chat connection).
 *
 * @param {{ iceServers: object[], iceTransportPolicy: string }} callConfig
 * @param {object} [settings]
 */
export function chatIceConfig(callConfig, settings = null) {
  settings ??= readSettings()
  if (settings.chatTurn || settings.forceRelay) return callConfig
  return { iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all' }
}

/**
 * Gathers candidates against the given servers to check they work.
 * `relay: true` means the TURN server accepted our credentials and allocated a relayed address.
 *
 * @param {{ iceServers: object[] }} config
 * @param {number} [timeoutMs]
 * @returns {Promise<{ relay: boolean, srflx: boolean }>}
 */
export async function testIceServers(config, timeoutMs = 6000) {
  const pc = new RTCPeerConnection({ iceServers: config.iceServers })
  const found = { relay: false, srflx: false }
  try {
    pc.createDataChannel('ice-test')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          clearTimeout(timer)
          resolve()
          return
        }
        if (e.candidate.type === 'relay') found.relay = true
        if (e.candidate.type === 'srflx') found.srflx = true
      }
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(resolve)
    })
  } finally {
    pc.close()
  }
  return found
}
