/**
 * turnstile.js
 * Cloudflare Turnstile token for the relay's GET /ice.
 *
 * When the relay requires Turnstile (TURNSTILE_SECRET), a script that found its URL cannot obtain TURN
 * credentials: it would have to run a real browser for every request. The widget runs invisibly
 * (it only shows up if Cloudflare needs an interaction). Enabled by VITE_TURNSTILE_SITE_KEY; without a
 * site key nothing is loaded and no third-party script is involved.
 *
 * Tokens are single-use and valid for 5 minutes, so one is requested for every /ice fetch.
 */

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const DEFAULT_TIMEOUT_MS = 15_000

let scriptPromise = null

/** Site key of the widget, or '' when Turnstile is not configured. */
export function turnstileSiteKey() {
  return import.meta.env?.VITE_TURNSTILE_SITE_KEY || ''
}

function loadScript() {
  if (globalThis.window?.turnstile) return Promise.resolve(globalThis.window.turnstile)
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT_URL
      script.async = true
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')))
      script.onerror = () => reject(new Error('turnstile script failed to load'))
      document.head.appendChild(script)
    }).catch((err) => {
      scriptPromise = null // allow a retry later
      throw err
    })
  }
  return scriptPromise
}

/**
 * Runs the widget and returns a fresh token, or null if it could not be obtained (blocked script, challenge
 * failed or timed out). Never throws: callers fall back to public STUN.
 *
 * @param {string} [siteKey]
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
export async function getTurnstileToken(siteKey = turnstileSiteKey(), timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!siteKey) return null

  let turnstile
  try {
    turnstile = await loadScript()
  } catch (err) {
    console.warn('[turnstile]', err.message)
    return null
  }

  // Invisible unless Cloudflare asks for an interaction, in which case it appears in the corner
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647'
  document.body.appendChild(container)

  return new Promise((resolve) => {
    let widgetId = null
    let done = false
    const finish = (token) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        if (widgetId !== null) turnstile.remove(widgetId)
      } catch {
        // the widget is already gone
      }
      container.remove()
      resolve(token)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)

    try {
      widgetId = turnstile.render(container, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        callback: (token) => finish(token),
        'error-callback': () => finish(null),
        'timeout-callback': () => finish(null),
      })
    } catch (err) {
      console.warn('[turnstile]', err.message)
      finish(null)
    }
  })
}
