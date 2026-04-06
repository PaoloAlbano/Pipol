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
function resolveProvider(config, env) {
  const issuer = config.issuer ?? (config.issuerVar ? env[config.issuerVar] : null)
  if (!issuer) return null

  const jwksUri = config.jwksUri ?? issuer + (config.jwksUriSuffix ?? '')
  // clientId is not a secret — lives in providers.json.
  // clientIdVar is an optional override via env var.
  const clientId = config.clientId ?? (config.clientIdVar ? env[config.clientIdVar] : null)

  return { issuer, jwksUri, clientId }
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
 * Includes the data the PWA needs to initiate the PKCE flow.
 */
export function getPublicProviders(env) {
  return PROVIDER_CONFIGS.filter((c) => resolveProvider(c, env) !== null).map((c) => {
    const resolved = resolveProvider(c, env)
    return {
      id: c.id,
      name: c.name,
      icon: c.icon ?? null,
      clientId: resolved.clientId,
      // authorizationUrl: PWA uses OIDC discovery ({issuer}/.well-known/openid-configuration)
      // to get the actual authorization endpoint at runtime
      issuer: resolved.issuer,
    }
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
  { id_token, provider: providerName, keyVersion: requestedVersion },
  env
) {
  if (!id_token || typeof id_token !== 'string') throw new DeriveError('missing-fields', 400)
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
  try {
    const JWKS = createRemoteJWKSet(new URL(providerConfig.jwksUri))
    const verifyOptions = { issuer: providerConfig.issuer }
    if (providerConfig.clientId) verifyOptions.audience = providerConfig.clientId
    const { payload } = await jwtVerify(id_token, JWKS, verifyOptions)
    sub = payload.sub
  } catch (err) {
    console.error(`[derive] token verification failed provider=${providerName} err=${err.message}`)
    throw new DeriveError('invalid-token', 401)
  }

  if (!sub) {
    console.error(`[derive] missing sub in token provider=${providerName}`)
    throw new DeriveError('invalid-token', 401)
  }

  const serverSecret = await hmacSha256(
    hexToBytes(masterKeyHex),
    `${version}:${providerName}:${sub}`
  )

  return { serverSecret: bytesToHex(serverSecret), keyVersion: version }
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
