/**
 * derive.js — core logic shared by both entry points
 *
 * Validates inputs, verifies the OIDC id_token, and derives the serverSecret.
 * Has no dependency on the runtime (CF Workers or Node.js) — all env access
 * is done via the plain object passed as `env`.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import PROVIDER_CONFIGS from '../providers.json' with { type: 'json' }

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a provider config to a runtime object, or returns null if required
 * env vars are missing.
 *
 * Two provider types are supported:
 *   - "oidc" (default): standard OIDC with id_token and JWKS verification.
 *     Requires issuer + jwksUri (derived from issuer if not set explicitly).
 *   - "oauth2": plain OAuth2 (e.g. GitHub). No id_token — identity is resolved
 *     by calling userinfoEndpoint with the access_token.
 *     Requires authorizationEndpoint + tokenEndpoint + userinfoEndpoint.
 */
function resolveProvider(config, env) {
  const clientId = config.clientId ?? (config.clientIdVar ? env[config.clientIdVar] : null)

  if (config.type === 'oauth2') {
    if (!config.authorizationEndpoint || !config.tokenEndpoint || !config.userinfoEndpoint)
      return null
    const clientSecret =
      config.clientSecret ?? (config.clientSecretVar ? env[config.clientSecretVar] : null)
    return {
      type: 'oauth2',
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      userinfoEndpoint: config.userinfoEndpoint,
      scope: config.scope ?? 'read:user',
      clientId,
      clientSecret,
    }
  }

  // Default: OIDC
  const issuer = config.issuer ?? (config.issuerVar ? env[config.issuerVar] : null)
  if (!issuer) return null
  const jwksUri = config.jwksUri ?? issuer + (config.jwksUriSuffix ?? '')
  // Optional server-side code exchange when a clientSecret is present (e.g. Google).
  const clientSecret =
    config.clientSecret ?? (config.clientSecretVar ? env[config.clientSecretVar] : null)
  const tokenEndpoint = config.tokenEndpoint ?? null
  return { type: 'oidc', issuer, jwksUri, clientId, clientSecret, tokenEndpoint }
}

export function getProviders(env) {
  const map = {}
  for (const config of PROVIDER_CONFIGS) {
    const resolved = resolveProvider(config, env)
    if (resolved) map[config.id] = resolved
  }
  return map
}

/**
 * Returns the public list of available providers for the PWA.
 * Only providers whose required env vars are set are included.
 * Includes the data the PWA needs to initiate the PKCE/OAuth2 flow.
 */
export function getPublicProviders(env) {
  return PROVIDER_CONFIGS.filter((c) => resolveProvider(c, env) !== null).map((c) => {
    const resolved = resolveProvider(c, env)
    const base = { id: c.id, name: c.name, icon: c.icon ?? null, clientId: resolved.clientId }
    if (resolved.type === 'oauth2') {
      return {
        ...base,
        type: 'oauth2',
        authorizationEndpoint: resolved.authorizationEndpoint,
        tokenEndpoint: resolved.tokenEndpoint,
        scope: resolved.scope,
      }
    }
    // OIDC: PWA discovers authorizationEndpoint at runtime via
    // {issuer}/.well-known/openid-configuration.
    // serverCodeExchange: true signals to the PWA that it must send the
    // authorization code to our server instead of calling the token endpoint
    // directly (needed when a clientSecret is required, e.g. Google).
    const pub = { ...base, type: 'oidc', issuer: resolved.issuer }
    if (resolved.clientSecret) pub.serverCodeExchange = true
    return pub
  })
}

// ---------------------------------------------------------------------------
// Main derive function
// Returns { serverSecret, keyVersion } or throws a DeriveError.
// ---------------------------------------------------------------------------
export class DeriveError extends Error {
  constructor(code, status) {
    super(code)
    this.code = code
    this.status = status
  }
}

export async function derive(
  {
    id_token,
    token,
    code,
    code_verifier,
    redirect_uri,
    provider: providerName,
    keyVersion: requestedVersion,
  },
  env
) {
  if (!providerName || typeof providerName !== 'string')
    throw new DeriveError('missing-fields', 400)

  const version = requestedVersion ?? env.PIPOL_CURRENT_KEY_VERSION ?? 'v1'
  if (!/^[a-zA-Z0-9-]+$/.test(version)) throw new DeriveError('invalid-key-version', 400)

  const retiredVersions = (env.PIPOL_RETIRED_VERSIONS ?? '').split(',').filter(Boolean)
  if (retiredVersions.includes(version)) throw new DeriveError('key-version-retired', 403)

  const masterKeyHex = env[`PIPOL_MASTER_KEY_${version.toUpperCase()}`]
  if (!masterKeyHex) throw new DeriveError('key-version-not-found', 500)

  const providers = getProviders(env)
  const providerConfig = providers[providerName]
  if (!providerConfig) throw new DeriveError('unknown-provider', 400)

  let sub
  if (providerConfig.type === 'oauth2') {
    if (code) {
      // Server-side code exchange (e.g. GitHub: token endpoint doesn't support CORS)
      if (!code_verifier || !redirect_uri) throw new DeriveError('missing-fields', 400)
      const accessToken = await exchangeCode(
        {
          code,
          code_verifier,
          redirect_uri,
          clientId: providerConfig.clientId,
          clientSecret: providerConfig.clientSecret,
        },
        providerConfig.tokenEndpoint,
        providerName
      )
      sub = await resolveSubFromUserinfo(accessToken, providerConfig.userinfoEndpoint, providerName)
    } else {
      // Direct access_token path (kept for flexibility)
      const rawToken = token ?? id_token
      if (!rawToken || typeof rawToken !== 'string') throw new DeriveError('missing-fields', 400)
      sub = await resolveSubFromUserinfo(rawToken, providerConfig.userinfoEndpoint, providerName)
    }
  } else {
    // Standard OIDC: verify id_token JWT signature + claims
    let rawToken
    if (code) {
      // Server-side code exchange — used when the token endpoint requires a
      // client_secret (e.g. Google).  The PWA sends the code here; we exchange
      // it for an id_token, then verify the JWT as normal.
      if (!code_verifier || !redirect_uri) throw new DeriveError('missing-fields', 400)
      if (!providerConfig.tokenEndpoint) throw new DeriveError('missing-fields', 400)
      const tokens = await callTokenEndpoint(
        {
          code,
          code_verifier,
          redirect_uri,
          clientId: providerConfig.clientId,
          clientSecret: providerConfig.clientSecret,
        },
        providerConfig.tokenEndpoint,
        providerName
      )
      rawToken = tokens.id_token
      if (!rawToken) {
        console.error(`[derive] token exchange missing id_token provider=${providerName}`)
        throw new DeriveError('missing-id-token', 401)
      }
    } else {
      rawToken = token ?? id_token
      if (!rawToken || typeof rawToken !== 'string') throw new DeriveError('missing-fields', 400)
    }
    try {
      const JWKS = createRemoteJWKSet(new URL(providerConfig.jwksUri))
      const verifyOptions = { issuer: providerConfig.issuer }
      if (providerConfig.clientId) verifyOptions.audience = providerConfig.clientId
      const { payload } = await jwtVerify(rawToken, JWKS, verifyOptions)
      sub = payload.sub
    } catch (err) {
      console.error(
        `[derive] token verification failed provider=${providerName} err=${err.message}`
      )
      throw new DeriveError('invalid-token', 401)
    }
  }

  if (!sub) {
    console.error(`[derive] missing sub provider=${providerName}`)
    throw new DeriveError('invalid-token', 401)
  }

  const serverSecret = await hmacSha256(
    hexToBytes(masterKeyHex),
    `${version}:${providerName}:${sub}`
  )

  return { serverSecret: bytesToHex(serverSecret), keyVersion: version }
}

/**
 * Generic token endpoint call — returns the full token response object.
 * Used by both OAuth2 (needs access_token) and OIDC (needs id_token) paths.
 */
async function callTokenEndpoint(
  { code, code_verifier, redirect_uri, clientId, clientSecret },
  tokenEndpoint,
  providerName
) {
  const params = {
    grant_type: 'authorization_code',
    code,
    redirect_uri,
    client_id: clientId,
    code_verifier,
  }
  if (clientSecret) params.client_secret = clientSecret

  let res
  try {
    res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params),
    })
  } catch (err) {
    console.error(
      `[derive] token exchange fetch failed provider=${providerName} err=${err.message}`
    )
    throw new DeriveError('token-exchange-failed', 401)
  }

  if (!res.ok) {
    console.error(`[derive] token exchange returned ${res.status} provider=${providerName}`)
    throw new DeriveError('token-exchange-failed', 401)
  }

  return res.json()
}

/**
 * Exchanges an authorization code for an access_token server-side.
 * Used for OAuth2 providers (e.g. GitHub) whose token endpoints don't support CORS.
 */
async function exchangeCode(params, tokenEndpoint, providerName) {
  const tokens = await callTokenEndpoint(params, tokenEndpoint, providerName)
  if (!tokens.access_token) {
    console.error(`[derive] token exchange missing access_token provider=${providerName}`)
    throw new DeriveError('token-exchange-failed', 401)
  }
  return tokens.access_token
}

/**
 * Calls a userinfo endpoint with an access_token and returns the subject identifier.
 * Used for plain OAuth2 providers (e.g. GitHub) that don't issue id_tokens.
 *
 * For GitHub the response is { id, login, ... } — we use String(id) as sub.
 * For standard userinfo endpoints the response is { sub, ... }.
 */
async function resolveSubFromUserinfo(accessToken, userinfoEndpoint, providerName) {
  let res
  try {
    res = await fetch(userinfoEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        // GitHub requires a User-Agent header
        'User-Agent': 'pipol-auth-server/1.0',
      },
    })
  } catch (err) {
    console.error(`[derive] userinfo fetch failed provider=${providerName} err=${err.message}`)
    throw new DeriveError('invalid-token', 401)
  }

  if (!res.ok) {
    console.error(`[derive] userinfo returned ${res.status} provider=${providerName}`)
    throw new DeriveError('invalid-token', 401)
  }

  const userinfo = await res.json()
  // Standard OIDC userinfo uses `sub`; GitHub uses numeric `id`
  const sub = userinfo.sub ?? (userinfo.id != null ? String(userinfo.id) : null)
  return sub
}

// ---------------------------------------------------------------------------
// Crypto helpers (Web Crypto API — Node.js 18+ and CF Workers)
// ---------------------------------------------------------------------------
async function hmacSha256(keyBytes, message) {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await globalThis.crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(message)
  )
  return new Uint8Array(sig)
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
