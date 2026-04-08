/**
 * derive.test.js
 * Tests for the core auth server logic: provider resolution, public provider
 * list, and the derive function (oauth2 code exchange + OIDC JWT verification).
 *
 * Strategy:
 *   - providers.json is mocked via vi.mock to keep tests self-contained
 *   - fetch is stubbed globally per test
 *   - jose JWT verification is mocked (real JWTs require a full key pair setup)
 *   - HMAC computation uses the real Web Crypto API (Node.js built-in)
 */

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('../providers.json', () => ({
  default: [
    {
      id: 'github',
      name: 'GitHub',
      icon: 'https://api.iconify.design/logos/github-icon.svg',
      type: 'oauth2',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      userinfoEndpoint: 'https://api.github.com/user',
      clientId: 'hardcoded-gh-client',
      clientSecretVar: 'GITHUB_CLIENT_SECRET',
      scope: 'read:user',
    },
    {
      id: 'google',
      name: 'Google',
      icon: 'https://api.iconify.design/logos/google-icon.svg',
      type: 'oidc',
      issuer: 'https://accounts.google.com',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      clientId: 'google-client-id',
    },
    {
      id: 'okta',
      name: 'Okta',
      icon: null,
      type: 'oidc',
      issuerVar: 'PIPOL_OKTA_ISSUER',
      jwksUriSuffix: '/oauth2/v1/keys',
      clientIdVar: 'PIPOL_OKTA_CLIENT_ID',
    },
  ],
}))

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
  jwtVerify: vi.fn(),
}))

import { derive, getPublicProviders, DeriveError } from '../src/derive.js'
import { jwtVerify, createRemoteJWKSet } from 'jose'

// ---------------------------------------------------------------------------
// Test env helpers
// ---------------------------------------------------------------------------

const MASTER_KEY_HEX = '0'.repeat(64) // 32 bytes of zeros — valid for HMAC

function makeEnv(overrides = {}) {
  return {
    PIPOL_MASTER_KEY_V1: MASTER_KEY_HEX,
    GITHUB_CLIENT_SECRET: 'gh-secret',
    PIPOL_OKTA_ISSUER: 'https://my.okta.com',
    PIPOL_OKTA_CLIENT_ID: 'okta-client-id',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// getPublicProviders
// ---------------------------------------------------------------------------

describe('getPublicProviders', () => {
  it('returns oauth2 provider with authorization and token endpoints', () => {
    const providers = getPublicProviders(makeEnv())
    const github = providers.find((p) => p.id === 'github')
    expect(github).toBeDefined()
    expect(github.type).toBe('oauth2')
    expect(github.authorizationEndpoint).toBe('https://github.com/login/oauth/authorize')
    expect(github.tokenEndpoint).toBe('https://github.com/login/oauth/access_token')
    expect(github.scope).toBe('read:user')
    expect(github.clientId).toBe('hardcoded-gh-client')
  })

  it('returns OIDC provider with issuer (no jwksUri exposed)', () => {
    const providers = getPublicProviders(makeEnv())
    const google = providers.find((p) => p.id === 'google')
    expect(google).toBeDefined()
    expect(google.type).toBe('oidc')
    expect(google.issuer).toBe('https://accounts.google.com')
    expect(google).not.toHaveProperty('jwksUri')
  })

  it('resolves clientId from env var for Okta', () => {
    const providers = getPublicProviders(makeEnv())
    const okta = providers.find((p) => p.id === 'okta')
    expect(okta).toBeDefined()
    expect(okta.clientId).toBe('okta-client-id')
    expect(okta.issuer).toBe('https://my.okta.com')
  })

  it('excludes providers whose required env vars are missing', () => {
    const providers = getPublicProviders(makeEnv({ PIPOL_OKTA_ISSUER: undefined }))
    const ids = providers.map((p) => p.id)
    expect(ids).not.toContain('okta')
    expect(ids).toContain('github')
    expect(ids).toContain('google')
  })

  it('does not expose clientSecret or userinfoEndpoint', () => {
    const providers = getPublicProviders(makeEnv())
    for (const p of providers) {
      expect(p).not.toHaveProperty('clientSecret')
      expect(p).not.toHaveProperty('userinfoEndpoint')
      expect(p).not.toHaveProperty('clientSecretVar')
      expect(p).not.toHaveProperty('clientIdVar')
    }
  })
})

// ---------------------------------------------------------------------------
// derive — oauth2 path (GitHub, code exchange)
// ---------------------------------------------------------------------------

describe('derive — oauth2 path (code exchange)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        // Token endpoint response
        ok: true,
        json: () => Promise.resolve({ access_token: 'gh-access-token' }),
      })
      .mockResolvedValueOnce({
        // Userinfo endpoint response
        ok: true,
        json: () => Promise.resolve({ id: 12345678, login: 'testuser' }),
      })
    )
  })

  it('calls token endpoint with code, verifier, redirect_uri and client_secret', async () => {
    await derive(
      { code: 'mycode', code_verifier: 'myverifier', redirect_uri: 'https://app.example.com/callback', provider: 'github' },
      makeEnv()
    )

    const tokenCall = fetch.mock.calls[0]
    expect(tokenCall[0]).toBe('https://github.com/login/oauth/access_token')
    const body = new URLSearchParams(tokenCall[1].body)
    expect(body.get('code')).toBe('mycode')
    expect(body.get('code_verifier')).toBe('myverifier')
    expect(body.get('client_secret')).toBe('gh-secret')
    expect(body.get('redirect_uri')).toBe('https://app.example.com/callback')
  })

  it('calls userinfo endpoint with the access_token', async () => {
    await derive(
      { code: 'mycode', code_verifier: 'v', redirect_uri: 'https://app.example.com/callback', provider: 'github' },
      makeEnv()
    )

    const userinfoCall = fetch.mock.calls[1]
    expect(userinfoCall[0]).toBe('https://api.github.com/user')
    expect(userinfoCall[1].headers.Authorization).toBe('Bearer gh-access-token')
  })

  it('returns a hex serverSecret and keyVersion', async () => {
    const result = await derive(
      { code: 'c', code_verifier: 'v', redirect_uri: 'https://app/callback', provider: 'github' },
      makeEnv()
    )

    expect(result).toHaveProperty('serverSecret')
    expect(result).toHaveProperty('keyVersion', 'v1')
    expect(/^[0-9a-f]{64}$/.test(result.serverSecret)).toBe(true)
  })

  it('produces a deterministic serverSecret for the same sub', async () => {
    const call = () =>
      derive(
        { code: 'c', code_verifier: 'v', redirect_uri: 'https://app/callback', provider: 'github' },
        makeEnv()
      )

    // Reset fetch mock for second call with same response
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: 'token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 12345678 }),
      })
    )

    const r1 = await call()

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'different-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 12345678 }), // same user id
      })
    )

    const r2 = await call()
    expect(r1.serverSecret).toBe(r2.serverSecret)
  })

  it('produces a different serverSecret for a different user id', async () => {
    const call = (userId) => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'token' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: userId }) })
      )
      return derive(
        { code: 'c', code_verifier: 'v', redirect_uri: 'https://app/callback', provider: 'github' },
        makeEnv()
      )
    }

    const r1 = await call(111)
    const r2 = await call(222)
    expect(r1.serverSecret).not.toBe(r2.serverSecret)
  })
})

// ---------------------------------------------------------------------------
// derive — OIDC path (Google, JWT verification)
// ---------------------------------------------------------------------------

describe('derive — OIDC path (JWT verification)', () => {
  beforeEach(() => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'google-user-abc' } })
  })

  it('verifies the id_token with the correct JWKS and issuer', async () => {
    await derive({ token: 'jwt.token.sig', provider: 'google' }, makeEnv())

    expect(createRemoteJWKSet).toHaveBeenCalledWith(
      new URL('https://www.googleapis.com/oauth2/v3/certs')
    )
    expect(jwtVerify).toHaveBeenCalledWith(
      'jwt.token.sig',
      'mock-jwks',
      expect.objectContaining({
        issuer: 'https://accounts.google.com',
        audience: 'google-client-id',
      })
    )
  })

  it('returns a serverSecret derived from the JWT sub', async () => {
    const result = await derive({ token: 'jwt.token.sig', provider: 'google' }, makeEnv())
    expect(/^[0-9a-f]{64}$/.test(result.serverSecret)).toBe(true)
  })

  it('accepts id_token field for backward compatibility', async () => {
    const result = await derive({ id_token: 'jwt.token.sig', provider: 'google' }, makeEnv())
    expect(result).toHaveProperty('serverSecret')
  })

  it('throws invalid-token (401) when JWT verification fails', async () => {
    jwtVerify.mockRejectedValue(new Error('signature verification failed'))

    await expect(
      derive({ token: 'bad.jwt', provider: 'google' }, makeEnv())
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })
})

// ---------------------------------------------------------------------------
// derive — error cases
// ---------------------------------------------------------------------------

describe('derive — error cases', () => {
  it('throws missing-fields (400) when provider is absent', async () => {
    await expect(derive({ token: 'x' }, makeEnv())).rejects.toMatchObject({
      code: 'missing-fields',
      status: 400,
    })
  })

  it('throws missing-fields (400) when token/code is absent for OIDC', async () => {
    await expect(derive({ provider: 'google' }, makeEnv())).rejects.toMatchObject({
      code: 'missing-fields',
      status: 400,
    })
  })

  it('throws unknown-provider (400) for an unrecognised provider id', async () => {
    await expect(
      derive({ token: 'x', provider: 'facebook' }, makeEnv())
    ).rejects.toMatchObject({ code: 'unknown-provider', status: 400 })
  })

  it('throws key-version-retired (403) for a retired version', async () => {
    await expect(
      derive(
        { token: 'x', provider: 'google', keyVersion: 'v0' },
        makeEnv({ PIPOL_RETIRED_VERSIONS: 'v0' })
      )
    ).rejects.toMatchObject({ code: 'key-version-retired', status: 403 })
  })

  it('throws key-version-not-found (500) when master key env var is missing', async () => {
    await expect(
      derive(
        { token: 'x', provider: 'google' },
        makeEnv({ PIPOL_MASTER_KEY_V1: undefined })
      )
    ).rejects.toMatchObject({ code: 'key-version-not-found', status: 500 })
  })

  it('throws token-exchange-failed when GitHub token endpoint returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false }))

    await expect(
      derive(
        { code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' },
        makeEnv()
      )
    ).rejects.toMatchObject({ code: 'token-exchange-failed', status: 401 })
  })

  it('throws invalid-token when userinfo endpoint returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: false })
    )

    await expect(
      derive(
        { code: 'c', code_verifier: 'v', redirect_uri: 'https://app/cb', provider: 'github' },
        makeEnv()
      )
    ).rejects.toMatchObject({ code: 'invalid-token', status: 401 })
  })

  it('throws missing-fields (400) for oauth2 code exchange without code_verifier', async () => {
    await expect(
      derive({ code: 'c', redirect_uri: 'https://app/cb', provider: 'github' }, makeEnv())
    ).rejects.toMatchObject({ code: 'missing-fields', status: 400 })
  })
})

// ---------------------------------------------------------------------------
// DeriveError
// ---------------------------------------------------------------------------

describe('DeriveError', () => {
  it('exposes code and status properties', () => {
    const err = new DeriveError('unknown-provider', 400)
    expect(err.message).toBe('unknown-provider')
    expect(err.code).toBe('unknown-provider')
    expect(err.status).toBe(400)
    expect(err).toBeInstanceOf(Error)
  })
})
