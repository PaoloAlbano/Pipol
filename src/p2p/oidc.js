/**
 * oidc.js
 * PKCE-based OIDC / OAuth2 flow utilities.
 *
 * Flow:
 *   1. fetchProviders(authUrl)          → list of available IDPs
 *   2. startOIDCFlow(provider, authUrl) → redirect to IDP
 *   3. handleOIDCCallback()             → exchange code → token → serverSecret
 *
 * Supports two provider types:
 *   - "oidc"  : standard OIDC — discovers endpoints via {issuer}/.well-known/openid-configuration,
 *               token response contains id_token (JWT).
 *   - "oauth2": plain OAuth2 (e.g. GitHub) — endpoints provided directly by the auth server,
 *               token response contains access_token (opaque). Identity resolved server-side.
 */

const SESSION_KEY = 'pipol:oidc-pending'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches the list of available providers from the auth server.
 * Returns [] on any error so the caller can degrade gracefully.
 */
export async function fetchProviders(authUrl) {
  try {
    const res = await fetch(`${authUrl}/providers`)
    if (!res.ok) return []
    return res.json()
  } catch {
    return []
  }
}

/**
 * Initiates the PKCE flow for the given provider.
 * Saves pending state to sessionStorage, then redirects to the IDP.
 *
 * For OIDC providers: discovers authorization + token endpoints via issuer discovery.
 * For OAuth2 providers (e.g. GitHub): uses endpoints supplied directly by the auth server.
 *
 * @param {{ id, name, type, clientId, issuer?, authorizationEndpoint?, tokenEndpoint?, scope? }} provider
 * @param {string} authUrl  Base URL of the Pipol auth server
 */
export async function startOIDCFlow(provider, authUrl) {
  let authorizationEndpoint, tokenEndpoint

  if (provider.type === 'oauth2') {
    // Endpoints provided directly — no discovery needed
    authorizationEndpoint = provider.authorizationEndpoint
    tokenEndpoint = provider.tokenEndpoint
  } else {
    // Standard OIDC — discover via {issuer}/.well-known/openid-configuration
    ;({ authorizationEndpoint, tokenEndpoint } = await discoverEndpoints(provider.issuer))
  }

  const verifier = randomBase64Url(32)
  const challenge = await sha256Base64Url(verifier)
  const state = randomBase64Url(16)

  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ state, verifier, provider, authUrl, tokenEndpoint })
  )

  const scope = provider.scope ?? 'openid email profile'

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: `${window.location.origin}/callback`,
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })

  window.location.href = `${authorizationEndpoint}?${params}`
}

/**
 * Handles the OAuth callback at /callback?code=...
 * Exchanges the code for a token, then calls /derive on the auth server.
 *
 * @returns {{ serverSecret: string, keyVersion: string, provider: object }}
 * @throws {Error} with a short error code string
 */
export async function handleOIDCCallback() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const returnedState = params.get('state')

  if (!code) throw new Error('missing-code')

  const pending = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null')
  if (!pending) throw new Error('no-pending-session')
  sessionStorage.removeItem(SESSION_KEY)

  if (returnedState !== pending.state) throw new Error('state-mismatch')

  // Exchange code for tokens at the IDP token endpoint
  const tokenRes = await fetch(pending.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${window.location.origin}/callback`,
      client_id: pending.provider.clientId,
      code_verifier: pending.verifier,
    }),
  })

  if (!tokenRes.ok) throw new Error('token-exchange-failed')
  const tokens = await tokenRes.json()

  // OIDC providers return id_token (JWT); OAuth2 providers return access_token (opaque)
  const token = tokens.id_token ?? tokens.access_token
  if (!token) throw new Error('missing-id-token')

  // Send token to the Pipol auth server to get serverSecret
  const deriveRes = await fetch(`${pending.authUrl}/derive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, provider: pending.provider.id }),
  })

  if (!deriveRes.ok) {
    const body = await deriveRes.json().catch(() => ({}))
    throw new Error(body.error || 'derive-failed')
  }

  const { serverSecret, keyVersion } = await deriveRes.json()
  return { serverSecret, keyVersion, provider: pending.provider }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function discoverEndpoints(issuer) {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error('discovery-failed')
  const config = await res.json()
  return {
    authorizationEndpoint: config.authorization_endpoint,
    tokenEndpoint: config.token_endpoint,
  }
}

function randomBase64Url(byteCount) {
  const arr = crypto.getRandomValues(new Uint8Array(byteCount))
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

async function sha256Base64Url(str) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}
