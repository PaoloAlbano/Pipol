/**
 * providers.real.test.js
 *
 * End-to-end tests for derive() using REAL jose JWT signing and verification.
 *
 * -- Why partial mocking? --
 * In the Node.js runtime, jose's createRemoteJWKSet fetches via node:https
 * (not globalThis.fetch), so we can't intercept it with vi.stubGlobal.
 * Instead we replace only createRemoteJWKSet with a local variant that serves
 * our test RSA key — while keeping jwtVerify and everything else completely
 * real. This means:
 *
 *   ✓ Real RS256 token signing   (SignJWT + privateKey)
 *   ✓ Real signature verification (jwtVerify with actual crypto)
 *   ✓ Real issuer / audience / expiry checks
 *   ✗ JWKS HTTP network fetch    (jose's own concern, not our code)
 *
 * These tests catch issues the fully-mocked derive.test.js can't:
 *   - Wrong issuer → jose rejects for the RIGHT reason
 *   - Wrong audience → jose rejects for the RIGHT reason
 *   - Expired token → jose rejects for the RIGHT reason
 *   - Mismatched signing key → jose rejects for the RIGHT reason
 *   - Provider-specific claim structures (Google numeric sub, Azure oid vs sub,
 *     Okta opaque id, GitHub numeric id without `sub` field)
 *   - Realistic token-endpoint error response formats
 *   - Cross-provider secret isolation
 *
 * providers.json is mocked to include Azure Entra.
 * HTTP endpoints (token exchange, userinfo) are stubbed via vi.stubGlobal.
 *
 * Real-world claim structures from:
 *   Google:      https://developers.google.com/identity/openid-connect/openid-connect
 *   Azure Entra: https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
 *   Okta:        https://developer.okta.com/docs/api/openapi/okta-oauth/guides/overview
 *   GitHub:      https://docs.github.com/en/apps/oauth-apps/building-oauth-apps
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

// Partial jose mock: keep everything real except createRemoteJWKSet.
// createRemoteJWKSet is replaced with a version that serves the test public key
// (set in beforeAll). jwtVerify stays real → full cryptographic verification.
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createRemoteJWKSet: (_url) => {
      // Returns a JWKS resolver called by jwtVerify.
      // Runs AFTER beforeAll, so publicJwk is defined by then.
      return async (protectedHeader, token) => {
        const resolver = actual.createLocalJWKSet({ keys: [publicJwk] })
        return resolver(protectedHeader, token)
      }
    },
  }
})

vi.mock('../providers.json', () => ({
  default: [
    // Google: OIDC, server-side code exchange (clientSecret required by token endpoint)
    {
      id: 'google',
      name: 'Google',
      icon: null,
      type: 'oidc',
      issuer: 'https://accounts.google.com',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientId: 'google-client-id.apps.googleusercontent.com',
      clientSecretVar: 'GOOGLE_CLIENT_SECRET',
    },
    // Azure Entra ID (v2.0): OIDC, tenant-specific issuer, no clientSecret
    // Key note: `sub` is pairwise (per-app), `oid` is stable and cross-app.
    {
      id: 'azure',
      name: 'Microsoft',
      icon: null,
      type: 'oidc',
      issuer: 'https://login.microsoftonline.com/test-tenant-id/v2.0',
      jwksUri: 'https://login.microsoftonline.com/test-tenant-id/discovery/v2.0/keys',
      clientId: 'azure-client-id',
    },
    // Okta: OIDC, dynamic issuer and clientId from env vars
    {
      id: 'okta',
      name: 'Okta',
      icon: null,
      type: 'oidc',
      issuerVar: 'PIPOL_OKTA_ISSUER',
      jwksUriSuffix: '/oauth2/v1/keys',
      clientIdVar: 'PIPOL_OKTA_CLIENT_ID',
    },
    // GitHub: OAuth2 (no id_token, identity via /user endpoint)
    {
      id: 'github',
      name: 'GitHub',
      icon: null,
      type: 'oauth2',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      userinfoEndpoint: 'https://api.github.com/user',
      clientId: 'github-client-id',
      clientSecretVar: 'GITHUB_CLIENT_SECRET',
      scope: 'read:user',
    },
  ],
}))

import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { derive, getPublicProviders } from '../src/derive.js'

// ---------------------------------------------------------------------------
// Shared RSA-2048 key pair — generated once per suite
// ---------------------------------------------------------------------------

let privateKey
let publicJwk  // referenced by the createRemoteJWKSet mock above
const TEST_KID = 'pipol-test-key-1'
const MASTER_KEY_HEX = 'a'.repeat(64) // 32 bytes — valid HMAC-SHA256

beforeAll(async () => {
  const { privateKey: priv, publicKey: pub } = await generateKeyPair('RS256', {
    modulusLength: 2048,
  })
  privateKey = priv
  const raw = await exportJWK(pub)
  publicJwk = { ...raw, kid: TEST_KID, use: 'sig', alg: 'RS256' }
})

afterEach(() => vi.unstubAllGlobals())

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides = {}) {
  return {
    PIPOL_MASTER_KEY_V1: MASTER_KEY_HEX,
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    PIPOL_OKTA_ISSUER: 'https://my-tenant.okta.com',
    PIPOL_OKTA_CLIENT_ID: 'okta-client-id',
    ...overrides,
  }
}

/**
 * Mints a real RS256 JWT with the shared test key.
 * Default exp = now+300. Pass exp: now-x for an expired token.
 */
async function mintJwt(claims) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ iat: now, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: TEST_KID })
    .sign(privateKey)
}

/**
 * Mints a real RS256 JWT signed with a DIFFERENT key.
 * Since createRemoteJWKSet mock always returns publicJwk (from the main key),
 * jwtVerify will fail the signature check — simulating a key-rotation attack.
 */
async function mintJwtWithWrongKey(claims) {
  const now = Math.floor(Date.now() / 1000)
  const { privateKey: otherKey } = await generateKeyPair('RS256')
  return new SignJWT({ iat: now, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'wrong-key-id' })
    .sign(otherKey)
}

/** Stub global fetch with exact-URL → response handlers. */
function stubFetch(handlers) {
  return vi.fn(async (url) => {
    const urlStr = typeof url === 'string' ? url : url?.href ?? String(url)
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (urlStr === pattern) return typeof handler === 'function' ? handler() : handler
    }
    throw new Error(`[test] Unexpected fetch URL: ${urlStr}`)
  })
}

// ---------------------------------------------------------------------------
// getPublicProviders — includes Azure Entra
// ---------------------------------------------------------------------------

describe('getPublicProviders — includes Azure Entra', () => {
  it('exposes Azure as OIDC without serverCodeExchange (no clientSecret)', () => {
    const providers = getPublicProviders(makeEnv())
    const azure = providers.find((p) => p.id === 'azure')
    expect(azure).toBeDefined()
    expect(azure.type).toBe('oidc')
    expect(azure.issuer).toBe('https://login.microsoftonline.com/test-tenant-id/v2.0')
    expect(azure).not.toHaveProperty('serverCodeExchange')
    expect(azure).not.toHaveProperty('jwksUri')
    expect(azure).not.toHaveProperty('clientSecret')
  })

  it('exposes Google with serverCodeExchange: true (has a clientSecret)', () => {
    const providers = getPublicProviders(makeEnv())
    const google = providers.find((p) => p.id === 'google')
    expect(google.serverCodeExchange).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Google — OIDC server-side code exchange + real JWT verification
//
// Real Google id_token claims (developers.google.com/identity/openid-connect):
//   iss: "https://accounts.google.com"
//   aud: "<client-id>.apps.googleusercontent.com"
//   sub: "10769150350006150715113082367"  // 21-digit numeric, NEVER changes
//   email, email_verified, at_hash, ...
// ---------------------------------------------------------------------------

describe('Google — server-side code exchange + real JWT verification', () => {
  const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

  it('derives a serverSecret from a real Google-style id_token', async () => {
    const idToken = await mintJwt({
      iss: 'https://accounts.google.com',
      aud: 'google-client-id.apps.googleusercontent.com',
      sub: '10769150350006150715113082367', // real 21-digit numeric sub
      email: 'alice@example.com',
      email_verified: true,
      at_hash: 'HK6E_P6Dh8Y93mRNtsDB1Q',
    })

    vi.stubGlobal('fetch', stubFetch({
      [GOOGLE_TOKEN]: () => ({
        ok: true,
        json: () => Promise.resolve({
          id_token: idToken,
          access_token: 'ya29.a0AfH6SMBx',
          token_type: 'Bearer',
          expires_in: 3599,
          scope: 'openid email',
        }),
      }),
    }))

    const result = await derive(
      { code: 'auth-code', code_verifier: 'verifier', redirect_uri: 'https://app.example.com/callback', provider: 'google' },
      makeEnv()
    )

    expect(/^[0-9a-f]{64}$/.test(result.serverSecret)).toBe(true)
    expect(result.keyVersion).toBe('v1')
  })

  it('serverSecret depends only on sub — email and other claims are ignored', async () => {
    const sub = '10769150350006150715113082367'

    const run = async (email) => {
      const idToken = await mintJwt({
        iss: 'https://accounts.google.com',
        aud: 'google-client-id.apps.googleusercontent.com',
        sub,
        email,
      })
      vi.stubGlobal('fetch', stubFetch({
        [GOOGLE_TOKEN]: () => ({ ok: true, json: () => Promise.resolve({ id_token: idToken }) }),
      }))
      return derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'google' }, makeEnv())
    }

    const r1 = await run('alice@example.com')
    const r2 = await run('alice.new@example.com')

    expect(r1.serverSecret).toBe(r2.serverSecret)
  })

  it('rejects a token with the wrong issuer', async () => {
    const idToken = await mintJwt({
      iss: 'https://evil-idp.com', // ← wrong
      aud: 'google-client-id.apps.googleusercontent.com',
      sub: '123',
    })

    vi.stubGlobal('fetch', stubFetch({
      [GOOGLE_TOKEN]: () => ({ ok: true, json: () => Promise.resolve({ id_token: idToken }) }),
    }))

    await expect(
      derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'google' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })

  it('rejects a token with the wrong audience', async () => {
    const idToken = await mintJwt({
      iss: 'https://accounts.google.com',
      aud: 'other-app.apps.googleusercontent.com', // ← wrong
      sub: '123',
    })

    vi.stubGlobal('fetch', stubFetch({
      [GOOGLE_TOKEN]: () => ({ ok: true, json: () => Promise.resolve({ id_token: idToken }) }),
    }))

    await expect(
      derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'google' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const idToken = await mintJwt({
      iss: 'https://accounts.google.com',
      aud: 'google-client-id.apps.googleusercontent.com',
      sub: '123',
      exp: now - 60,
    })

    vi.stubGlobal('fetch', stubFetch({
      [GOOGLE_TOKEN]: () => ({ ok: true, json: () => Promise.resolve({ id_token: idToken }) }),
    }))

    await expect(
      derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'google' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })

  it('rejects a token signed with the wrong key (key rotation / forged token)', async () => {
    // Token is signed with a different RSA key. Our mock always returns
    // publicJwk (from the main pair) → signature check fails.
    const idToken = await mintJwtWithWrongKey({
      iss: 'https://accounts.google.com',
      aud: 'google-client-id.apps.googleusercontent.com',
      sub: '123',
    })

    vi.stubGlobal('fetch', stubFetch({
      [GOOGLE_TOKEN]: () => ({ ok: true, json: () => Promise.resolve({ id_token: idToken }) }),
    }))

    await expect(
      derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'google' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })

  it('throws token-exchange-failed when Google returns HTTP 400 with error JSON', async () => {
    // Real Google error: HTTP 400 {"error":"invalid_grant","error_description":"Code was already redeemed."}
    vi.stubGlobal('fetch', stubFetch({
      [GOOGLE_TOKEN]: () => ({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'invalid_grant', error_description: 'Code was already redeemed.' }),
      }),
    }))

    await expect(
      derive({ code: 'used-code', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'google' }, makeEnv())
    ).rejects.toMatchObject({ code: 'token-exchange-failed', status: 401 })
  })

  it('throws missing-fields when code_verifier is absent (PKCE required)', async () => {
    await expect(
      derive({ code: 'c', redirect_uri: 'https://app/cb', provider: 'google' }, makeEnv())
    ).rejects.toMatchObject({ code: 'missing-fields', status: 400 })
  })

  it('throws missing-id-token when token endpoint response has no id_token field', async () => {
    vi.stubGlobal('fetch', stubFetch({
      [GOOGLE_TOKEN]: () => ({
        ok: true,
        json: () => Promise.resolve({ access_token: 'only-access-no-id-token' }),
      }),
    }))

    await expect(
      derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'google' }, makeEnv())
    ).rejects.toMatchObject({ code: 'missing-id-token', status: 401 })
  })
})

// ---------------------------------------------------------------------------
// Azure Entra ID (v2.0) — OIDC direct id_token
//
// Real Azure id_token claims (learn.microsoft.com/en-us/entra/identity-platform):
//   iss: "https://login.microsoftonline.com/{tenantId}/v2.0"
//   aud: "{clientId}"
//   sub: "AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ"  // pairwise (per-app)
//   oid: "00000000-0000-0000-66f3-3332eca7ea81"          // stable (cross-app)
//   tid: "{tenantId}"
//   preferred_username: "alice@contoso.com"
//   ver: "2.0"
//
// DESIGN NOTE — `sub` vs `oid`:
//   Azure's `sub` is scoped to the client_id (pairwise).
//   Two different Pipol deployments using different Azure app registrations
//   will see the same physical user as different `sub` values.
//   `oid` is stable across all apps but requires the `profile` scope.
//   Current behavior uses `sub` — consistent within one deployment.
// ---------------------------------------------------------------------------

describe('Azure Entra ID — real JWT with tenant-specific issuer', () => {
  const AZURE_ISSUER = 'https://login.microsoftonline.com/test-tenant-id/v2.0'

  it('derives a serverSecret from a real Azure-style id_token', async () => {
    const idToken = await mintJwt({
      iss: AZURE_ISSUER,
      aud: 'azure-client-id',
      sub: 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ',
      oid: '00000000-0000-0000-66f3-3332eca7ea81',
      tid: 'test-tenant-id',
      preferred_username: 'alice@contoso.com',
      name: 'Alice Smith',
      ver: '2.0',
    })

    const result = await derive({ token: idToken, provider: 'azure' }, makeEnv())

    expect(/^[0-9a-f]{64}$/.test(result.serverSecret)).toBe(true)
  })

  it('uses the sub claim as identifier — same sub, different oid → same secret', async () => {
    // Documents current behavior: sub is the derivation key, not oid.
    const sub = 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ'

    const t1 = await mintJwt({ iss: AZURE_ISSUER, aud: 'azure-client-id', sub, oid: 'oid-aaa', tid: 'test-tenant-id' })
    const r1 = await derive({ token: t1, provider: 'azure' }, makeEnv())

    const t2 = await mintJwt({ iss: AZURE_ISSUER, aud: 'azure-client-id', sub, oid: 'oid-bbb', tid: 'test-tenant-id' })
    const r2 = await derive({ token: t2, provider: 'azure' }, makeEnv())

    expect(r1.serverSecret).toBe(r2.serverSecret)
  })

  it('different subjects produce different secrets', async () => {
    const t1 = await mintJwt({ iss: AZURE_ISSUER, aud: 'azure-client-id', sub: 'sub-alice', tid: 'test-tenant-id' })
    const r1 = await derive({ token: t1, provider: 'azure' }, makeEnv())

    const t2 = await mintJwt({ iss: AZURE_ISSUER, aud: 'azure-client-id', sub: 'sub-bob', tid: 'test-tenant-id' })
    const r2 = await derive({ token: t2, provider: 'azure' }, makeEnv())

    expect(r1.serverSecret).not.toBe(r2.serverSecret)
  })

  it('rejects a token from a different Azure tenant (issuer mismatch)', async () => {
    const idToken = await mintJwt({
      iss: 'https://login.microsoftonline.com/other-tenant/v2.0', // ← wrong
      aud: 'azure-client-id',
      sub: 'some-user',
      tid: 'other-tenant',
    })

    await expect(
      derive({ token: idToken, provider: 'azure' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })

  it('rejects a token with wrong audience', async () => {
    const idToken = await mintJwt({
      iss: AZURE_ISSUER,
      aud: 'some-other-app', // ← not azure-client-id
      sub: 'user',
      tid: 'test-tenant-id',
    })

    await expect(
      derive({ token: idToken, provider: 'azure' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })

  it('rejects an expired Azure token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const idToken = await mintJwt({
      iss: AZURE_ISSUER,
      aud: 'azure-client-id',
      sub: 'user',
      tid: 'test-tenant-id',
      exp: now - 30,
    })

    await expect(
      derive({ token: idToken, provider: 'azure' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })

  it('rejects a token signed with the wrong key', async () => {
    const idToken = await mintJwtWithWrongKey({
      iss: AZURE_ISSUER,
      aud: 'azure-client-id',
      sub: 'user',
      tid: 'test-tenant-id',
    })

    await expect(
      derive({ token: idToken, provider: 'azure' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })
})

// ---------------------------------------------------------------------------
// Okta — OIDC with dynamic issuer from env var, no client secret
//
// Real Okta id_token claims (developer.okta.com/docs/api/openapi/okta-oauth):
//   ver: 1
//   sub: "00uid4BxXw6I6TV4m0g3"  // opaque Okta user ID
//   iss: "https://{yourOktaDomain}"
//   aud: "{clientId}"
//   amr: ["pwd"]
//   jti: "ID.4eAWJOCMB3SX8XewDfVR"
// ---------------------------------------------------------------------------

describe('Okta — real JWT with env-variable issuer', () => {
  const OKTA_ISSUER = 'https://my-tenant.okta.com'

  it('derives a serverSecret from a real Okta-style id_token', async () => {
    const idToken = await mintJwt({
      iss: OKTA_ISSUER,
      aud: 'okta-client-id',
      sub: '00uid4BxXw6I6TV4m0g3', // Okta opaque user ID format
      ver: 1,
      amr: ['pwd'],
      jti: 'ID.4eAWJOCMB3SX8XewDfVR',
      auth_time: Math.floor(Date.now() / 1000) - 30,
    })

    const result = await derive({ token: idToken, provider: 'okta' }, makeEnv())

    expect(/^[0-9a-f]{64}$/.test(result.serverSecret)).toBe(true)
  })

  it('accepts id_token field as alias for token (backward compatibility)', async () => {
    const idToken = await mintJwt({ iss: OKTA_ISSUER, aud: 'okta-client-id', sub: '00uid4' })
    const result = await derive({ id_token: idToken, provider: 'okta' }, makeEnv())
    expect(result).toHaveProperty('serverSecret')
  })

  it('rejects unknown-provider when PIPOL_OKTA_ISSUER env var is unset', async () => {
    await expect(
      derive({ token: 'x.y.z', provider: 'okta' }, makeEnv({ PIPOL_OKTA_ISSUER: undefined }))
    ).rejects.toMatchObject({ code: 'unknown-provider', status: 400 })
  })

  it('rejects a token whose issuer does not match the configured Okta domain', async () => {
    const idToken = await mintJwt({
      iss: 'https://attacker.okta.com', // ← different from PIPOL_OKTA_ISSUER
      aud: 'okta-client-id',
      sub: '00uid4BxXw6I6TV4m0g3',
    })

    await expect(
      derive({ token: idToken, provider: 'okta' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })

  it('KNOWN LIMITATION: same provider-id + same sub in two Okta tenants → same secret', async () => {
    // The HMAC input is `version:providerName:sub`.
    // Two Okta deployments share provider id 'okta'. If they coincidentally
    // produce the same sub value (unlikely but possible), the derived secret
    // would be identical. Fix: include the issuer URL in the HMAC input.
    // This test documents current behavior; flip .toBe to .not.toBe when fixed.
    const sub = '00uid4BxXw6I6TV4m0g3'

    const tA = await mintJwt({ iss: 'https://tenant-a.okta.com', aud: 'client-a', sub })
    const rA = await derive(
      { token: tA, provider: 'okta' },
      makeEnv({ PIPOL_OKTA_ISSUER: 'https://tenant-a.okta.com', PIPOL_OKTA_CLIENT_ID: 'client-a' })
    )

    const tB = await mintJwt({ iss: 'https://tenant-b.okta.com', aud: 'client-b', sub })
    const rB = await derive(
      { token: tB, provider: 'okta' },
      makeEnv({ PIPOL_OKTA_ISSUER: 'https://tenant-b.okta.com', PIPOL_OKTA_CLIENT_ID: 'client-b' })
    )

    // CURRENT BEHAVIOR — same secret for same sub across different tenants
    expect(rA.serverSecret).toBe(rB.serverSecret)
  })
})

// ---------------------------------------------------------------------------
// GitHub — OAuth2 (no id_token, identity via /user endpoint)
//
// Real GitHub /user response:
//   { "id": 1, "login": "octocat", "name": "The Octocat", "type": "User" }
// GitHub does NOT return a `sub` field — derive() uses String(id) instead.
// ---------------------------------------------------------------------------

describe('GitHub — OAuth2 realistic response formats', () => {
  const GH_TOKEN = 'https://github.com/login/oauth/access_token'

  it('derives a serverSecret using the GitHub numeric user id', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          access_token: 'ghu_16C7e42F292c6912E7710c838347Ae178B4a',
          token_type: 'bearer',
          scope: 'read:user',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          id: 1,           // @octocat's real id
          login: 'octocat',
          name: 'The Octocat',
          type: 'User',
          // ← no `sub` field — must fall back to String(id)
        }),
      })
    )

    const result = await derive(
      { code: 'gh-code', code_verifier: 'gh-verifier', redirect_uri: 'https://app/callback', provider: 'github' },
      makeEnv()
    )

    expect(/^[0-9a-f]{64}$/.test(result.serverSecret)).toBe(true)
  })

  it('produces a deterministic secret for the same GitHub user id', async () => {
    const mock = (id) => vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id, login: 'user' }) })
    )

    mock(12345)
    const r1 = await derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' }, makeEnv())

    mock(12345)
    const r2 = await derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' }, makeEnv())

    expect(r1.serverSecret).toBe(r2.serverSecret)
  })

  it('produces a different secret for a different GitHub user id', async () => {
    const mock = (id) => vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id }) })
    )

    mock(100)
    const r1 = await derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' }, makeEnv())

    mock(200)
    const r2 = await derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' }, makeEnv())

    expect(r1.serverSecret).not.toBe(r2.serverSecret)
  })

  it('sends User-Agent header to GitHub /user (required — GitHub returns 403 without it)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 1 }) })
    )

    await derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' }, makeEnv())

    const userinfoCall = fetch.mock.calls[1]
    expect(userinfoCall[1].headers['User-Agent']).toMatch(/pipol/i)
  })

  it('sends client_secret in the token exchange body', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 42 }) })
    )

    await derive({ code: 'gh-code', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' }, makeEnv())

    const tokenCall = fetch.mock.calls[0]
    expect(tokenCall[0]).toBe(GH_TOKEN)
    const body = new URLSearchParams(tokenCall[1].body)
    expect(body.get('client_secret')).toBe('gh-secret')
    expect(body.get('code_verifier')).toBe('v')
  })

  it('throws token-exchange-failed on non-ok token endpoint response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }))

    await expect(
      derive({ code: 'bad', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' }, makeEnv())
    ).rejects.toMatchObject({ code: 'token-exchange-failed', status: 401 })
  })

  it('throws invalid-token on non-ok userinfo endpoint response', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: false, status: 401 })
    )

    await expect(
      derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })
})

// ---------------------------------------------------------------------------
// Cross-provider security — secrets are isolated
// ---------------------------------------------------------------------------

describe('Cross-provider security — secrets are isolated between providers', () => {
  it('same sub value in different providers produces different secrets', async () => {
    // An attacker with a valid Okta token for sub X cannot impersonate
    // the Azure user with the same sub X (or any other provider).
    const sub = 'shared-sub-value'

    const oktaToken = await mintJwt({ iss: 'https://my-tenant.okta.com', aud: 'okta-client-id', sub })
    const oktaResult = await derive({ token: oktaToken, provider: 'okta' }, makeEnv())

    const azureToken = await mintJwt({
      iss: 'https://login.microsoftonline.com/test-tenant-id/v2.0',
      aud: 'azure-client-id',
      sub,
      tid: 'test-tenant-id',
    })
    const azureResult = await derive({ token: azureToken, provider: 'azure' }, makeEnv())

    expect(oktaResult.serverSecret).not.toBe(azureResult.serverSecret)
  })

  it('a valid Okta id_token cannot be submitted to the Google provider (issuer mismatch)', async () => {
    const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

    const oktaIdToken = await mintJwt({
      iss: 'https://my-tenant.okta.com',
      aud: 'okta-client-id',
      sub: 'okta-user',
    })

    vi.stubGlobal('fetch', stubFetch({
      [GOOGLE_TOKEN]: () => ({ ok: true, json: () => Promise.resolve({ id_token: oktaIdToken }) }),
    }))

    await expect(
      derive({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'google' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })
})
