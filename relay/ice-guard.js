// Protection for GET /ice, which hands out TURN credentials.
//
// The endpoint has to be reachable by every browser that opens the app, so it cannot require a login.
// These two checks keep it from being a free credentials dispenser:
//
//   ICE_ALLOWED_ORIGINS  Comma-separated list of web origins allowed to call it, e.g.
//                        "https://pipol.pages.dev,https://*.pipol.pages.dev,http://localhost:5173".
//                        A leading "*." in the host matches any subdomain. "*" allows every origin.
//                        When set, requests without an Origin header (curl, scripts) are refused too.
//                        Unset = open to everyone (the previous behaviour).
//                        Note: Origin can be forged outside a browser, so this stops other websites
//                        and casual use, not a determined attacker.
//   ICE_RATE_LIMIT       Max requests per minute per client IP (default 30, 0 disables).
//   TRUST_PROXY_HOPS     Reverse proxies in front of the relay (default 1, e.g. Render). The client IP is
//                        read from X-Forwarded-For skipping that many entries from the right; 0 uses the
//                        socket address. Set it right or everybody shares one bucket.

const DEFAULT_RATE_LIMIT = 30
const WINDOW_MS = 60_000

const escapeRegex = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/**
 * Turns the ICE_ALLOWED_ORIGINS value into matchers.
 * @returns {{ open: boolean, matchers: RegExp[], invalid: string[] }}
 */
export function parseAllowedOrigins(value) {
  const entries = String(value ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
  if (entries.length === 0) return { open: true, matchers: [], invalid: [] }
  if (entries.includes('*')) return { open: true, matchers: [], invalid: [] }

  const matchers = []
  const invalid = []
  for (const entry of entries) {
    const m = entry.match(/^(https?):\/\/(\*\.)?([a-z0-9.-]+)(:\d+)?\/?$/i)
    if (!m) {
      invalid.push(entry)
      continue
    }
    const [, scheme, wildcard, host, port = ''] = m
    const hostPattern = wildcard ? `[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.${escapeRegex(host)}` : escapeRegex(host)
    matchers.push(new RegExp(`^${scheme}://${hostPattern}${escapeRegex(port)}$`, 'i'))
  }
  return { open: false, matchers, invalid }
}

/**
 * Client IP, trusting `hops` reverse proxies (entries are counted from the right of X-Forwarded-For,
 * because a client can prepend anything it likes but cannot make the proxy append for it).
 */
export function clientIp(req, hops = 1) {
  const socketIp = req.socket?.remoteAddress ?? 'unknown'
  if (!hops) return socketIp
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (forwarded.length === 0) return socketIp
  return forwarded[Math.max(forwarded.length - hops, 0)]
}

export function createIceGuard({ env = process.env, now = Date.now } = {}) {
  const origins = parseAllowedOrigins(env.ICE_ALLOWED_ORIGINS)
  const configuredLimit = Number(env.ICE_RATE_LIMIT)
  const limit = env.ICE_RATE_LIMIT === undefined || env.ICE_RATE_LIMIT === '' ? DEFAULT_RATE_LIMIT : configuredLimit
  const hops = env.TRUST_PROXY_HOPS === undefined || env.TRUST_PROXY_HOPS === '' ? 1 : Number(env.TRUST_PROXY_HOPS)

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map()

  function hit(ip) {
    const t = now()
    if (buckets.size > 5000) {
      for (const [key, b] of buckets) if (b.resetAt <= t) buckets.delete(key)
    }
    let bucket = buckets.get(ip)
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + WINDOW_MS }
      buckets.set(ip, bucket)
    }
    bucket.count++
    return { allowed: bucket.count <= limit, retryAfter: Math.ceil((bucket.resetAt - t) / 1000), ip }
  }

  return {
    /** Client IP as this guard sees it (honours TRUST_PROXY_HOPS). */
    clientIp: (req) => clientIp(req, hops),

    /** Human readable summary for the startup log. */
    describe() {
      const originPart = origins.open
        ? 'open to every origin (set ICE_ALLOWED_ORIGINS to restrict)'
        : `origins: ${origins.matchers.length} allowed`
      const ratePart = limit > 0 ? `${limit} requests/min per IP` : 'no rate limit'
      return { text: `${originPart}; ${ratePart}`, invalid: origins.invalid }
    },

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {{ rateLimit?: boolean }} [opts]  Preflight requests are not counted.
     * @returns {{ ok: true, headers: object } | { ok: false, status: number, error: string, headers: object }}
     */
    check(req, { rateLimit = true } = {}) {
      const origin = req.headers?.origin
      const baseHeaders = {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'X-Turnstile-Token',
        'Access-Control-Max-Age': '600',
      }

      let corsHeaders
      if (origins.open) {
        corsHeaders = { ...baseHeaders, 'Access-Control-Allow-Origin': '*' }
      } else {
        if (!origin || !origins.matchers.some((re) => re.test(origin))) {
          return { ok: false, status: 403, error: 'origin-not-allowed', headers: baseHeaders }
        }
        corsHeaders = { ...baseHeaders, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      }

      if (rateLimit && limit > 0) {
        const result = hit(clientIp(req, hops))
        if (!result.allowed) {
          return {
            ok: false,
            status: 429,
            error: 'rate-limited',
            headers: { ...corsHeaders, 'Retry-After': String(result.retryAfter) },
            ip: result.ip,
          }
        }
      }
      return { ok: true, headers: corsHeaders }
    },
  }
}
