// Cloudflare Turnstile check for GET /ice.
//
// Turnstile proves that the request comes from a real browser on our site, which a script that found the
// relay URL cannot do. Enabled when TURNSTILE_SECRET is set; the app sends the token in X-Turnstile-Token.
// Tokens are single-use and valid for 5 minutes, so every /ice request needs a fresh one.
//
//   TURNSTILE_SECRET       Secret key of the Turnstile widget (Cloudflare dashboard → Turnstile).
//   TURNSTILE_VERIFY_URL   Override of the siteverify endpoint (tests only).

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const MAX_TOKEN_LENGTH = 2048
const VERIFY_TIMEOUT_MS = 5000

export function createTurnstile({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const secret = env.TURNSTILE_SECRET
  const verifyUrl = env.TURNSTILE_VERIFY_URL || SITEVERIFY_URL

  return {
    enabled: Boolean(secret),

    /**
     * @param {string|undefined} token  Value of the X-Turnstile-Token header
     * @param {string} [ip]             Client IP, passed to Cloudflare as an extra signal
     * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string, codes?: string[] }>}
     */
    async verify(token, ip) {
      if (!secret) return { ok: true }
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, status: 403, error: 'turnstile-required' }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)
      try {
        const res = await fetchImpl(verifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret, response: token, ...(ip && ip !== 'unknown' && { remoteip: ip }) }),
          signal: controller.signal,
        })
        if (!res.ok) return { ok: false, status: 503, error: 'turnstile-unavailable' }
        const body = await res.json()
        if (body?.success === true) return { ok: true }
        return { ok: false, status: 403, error: 'turnstile-failed', codes: body?.['error-codes'] ?? [] }
      } catch {
        // Cannot reach Cloudflare: refuse (fail closed). Clients fall back to public STUN.
        return { ok: false, status: 503, error: 'turnstile-unavailable' }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
