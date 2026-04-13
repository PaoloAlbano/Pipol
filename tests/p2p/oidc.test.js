/**
 * oidc.test.js
 * Tests for the PKCE-based OIDC / OAuth2 flow utilities.
 *
 * Strategy: fetch is stubbed globally; window.location is replaced with a
 * controllable mock so we can inspect redirects and set the callback URL
 * without triggering real navigation.
 */

// ---------------------------------------------------------------------------
// Location mock — must happen before any module import that reads location
// ---------------------------------------------------------------------------

let locationMock

beforeAll(() => {
  locationMock = {
    origin: 'https://localhost:5173',
    pathname: '/',
    search: '',
    href: 'https://localhost:5173/',
  }
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: locationMock,
  })
})

afterAll(() => {
  // restore jsdom default (best effort)
  delete window.location
})

afterEach(() => {
  sessionStorage.clear()
  locationMock.search = ''
  locationMock.pathname = '/'
  locationMock.href = 'https://localhost:5173/'
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Module under test (imported after location mock is in place)
// ---------------------------------------------------------------------------

const SESSION_KEY = 'pipol:oidc-pending'

// Helpers
function makePendingSession(overrides = {}) {
  return {
    state: 'test-state',
    verifier: 'test-verifier',
    provider: { id: 'github', name: 'GitHub', type: 'oauth2', clientId: 'gh-client' },
    authUrl: 'https://auth.example.com',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    returnTo: '',
    ...overrides,
  }
}

function setCallbackUrl(code = 'mycode', state = 'test-state') {
  locationMock.search = `?code=${code}&state=${state}`
  locationMock.pathname = '/callback'
}

// ---------------------------------------------------------------------------
// fetchProviders
// ---------------------------------------------------------------------------

describe('fetchProviders', () => {
  let fetchProviders

  beforeEach(async () => {
    vi.resetModules()
    ;({ fetchProviders } = await import('../../src/p2p/oidc.js'))
  })

  it('returns the parsed JSON array on success', async () => {
    const providers = [{ id: 'github', name: 'GitHub' }]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(providers),
      })
    )

    const result = await fetchProviders('https://auth.example.com')
    expect(result).toEqual(providers)
    expect(fetch).toHaveBeenCalledWith('https://auth.example.com/providers')
  })

  it('returns [] when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const result = await fetchProviders('https://auth.example.com')
    expect(result).toEqual([])
  })

  it('returns [] on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))
    const result = await fetchProviders('https://auth.example.com')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// startOIDCFlow
// ---------------------------------------------------------------------------

describe('startOIDCFlow — oauth2 provider (no OIDC discovery)', () => {
  let startOIDCFlow

  const provider = {
    id: 'github',
    name: 'GitHub',
    type: 'oauth2',
    clientId: 'gh-client-id',
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    scope: 'read:user',
  }

  beforeEach(async () => {
    vi.resetModules()
    ;({ startOIDCFlow } = await import('../../src/p2p/oidc.js'))
  })

  it('does not call the OIDC discovery endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await startOIDCFlow(provider, 'https://auth.example.com')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('saves state, verifier, provider, authUrl, tokenEndpoint and returnTo to sessionStorage', async () => {
    locationMock.search = '?room=test-room'
    vi.stubGlobal('fetch', vi.fn())

    await startOIDCFlow(provider, 'https://auth.example.com')

    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY))
    expect(saved).toMatchObject({
      provider: expect.objectContaining({ id: 'github' }),
      authUrl: 'https://auth.example.com',
      tokenEndpoint: provider.tokenEndpoint,
      returnTo: '?room=test-room',
    })
    expect(typeof saved.state).toBe('string')
    expect(saved.state.length).toBeGreaterThan(0)
    expect(typeof saved.verifier).toBe('string')
    expect(saved.verifier.length).toBeGreaterThan(0)
  })

  it('redirects to the provider authorizationEndpoint with PKCE params', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await startOIDCFlow(provider, 'https://auth.example.com')

    expect(locationMock.href).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/)
    const url = new URL(locationMock.href)
    expect(url.searchParams.get('client_id')).toBe('gh-client-id')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('read:user')
    expect(url.searchParams.get('redirect_uri')).toBe('https://localhost:5173/callback')
  })
})

describe('startOIDCFlow — OIDC provider (with discovery)', () => {
  let startOIDCFlow

  const provider = {
    id: 'google',
    name: 'Google',
    type: 'oidc',
    clientId: 'google-client-id',
    issuer: 'https://accounts.google.com',
  }

  beforeEach(async () => {
    vi.resetModules()
    ;({ startOIDCFlow } = await import('../../src/p2p/oidc.js'))
  })

  it('calls the OIDC discovery endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
          }),
      })
    )

    await startOIDCFlow(provider, 'https://auth.example.com')

    expect(fetch).toHaveBeenCalledWith('https://accounts.google.com/.well-known/openid-configuration')
  })

  it('saves the discovered token endpoint to sessionStorage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
          }),
      })
    )

    await startOIDCFlow(provider, 'https://auth.example.com')

    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY))
    expect(saved.tokenEndpoint).toBe('https://oauth2.googleapis.com/token')
  })

  it('uses openid email profile as default scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            authorization_endpoint: 'https://accounts.google.com/o/oauth2/auth',
            token_endpoint: 'https://oauth2.googleapis.com/token',
          }),
      })
    )

    await startOIDCFlow(provider, 'https://auth.example.com')
    const url = new URL(locationMock.href)
    expect(url.searchParams.get('scope')).toBe('openid email profile')
  })
})

// ---------------------------------------------------------------------------
// handleOIDCCallback — error cases
// ---------------------------------------------------------------------------

describe('handleOIDCCallback — error cases', () => {
  let handleOIDCCallback

  beforeEach(async () => {
    vi.resetModules()
    ;({ handleOIDCCallback } = await import('../../src/p2p/oidc.js'))
  })

  it('throws missing-code if no code in URL', async () => {
    locationMock.search = '?state=abc'
    await expect(handleOIDCCallback()).rejects.toThrow('missing-code')
  })

  it('throws no-pending-session if sessionStorage is empty', async () => {
    setCallbackUrl()
    await expect(handleOIDCCallback()).rejects.toThrow('no-pending-session')
  })

  it('throws state-mismatch if returned state does not match', async () => {
    setCallbackUrl('mycode', 'wrong-state')
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(makePendingSession({ state: 'correct-state' })))
    await expect(handleOIDCCallback()).rejects.toThrow('state-mismatch')
  })
})

// ---------------------------------------------------------------------------
// handleOIDCCallback — oauth2 path (e.g. GitHub)
// ---------------------------------------------------------------------------

describe('handleOIDCCallback — oauth2 path', () => {
  let handleOIDCCallback

  beforeEach(async () => {
    vi.resetModules()
    ;({ handleOIDCCallback } = await import('../../src/p2p/oidc.js'))
    setCallbackUrl('gh-code', 'test-state')
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(makePendingSession({ returnTo: '?room=abc' })))
  })

  it('sends code and code_verifier to /derive and returns serverSecret', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ serverSecret: 'deadbeef', keyVersion: 'v1' }),
      })
    )

    const result = await handleOIDCCallback()

    expect(result.serverSecret).toBe('deadbeef')
    expect(result.keyVersion).toBe('v1')
    expect(result.provider.id).toBe('github')

    expect(fetch).toHaveBeenCalledWith('https://auth.example.com/derive', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.code).toBe('gh-code')
    expect(body.code_verifier).toBe('test-verifier')
    expect(body.provider).toBe('github')
    expect(body.redirect_uri).toBe('https://localhost:5173/callback')
  })

  it('preserves returnTo from the saved session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ serverSecret: 'aabbcc', keyVersion: 'v1' }),
      })
    )

    const result = await handleOIDCCallback()
    expect(result.returnTo).toBe('?room=abc')
  })

  it('throws derive-failed if /derive returns non-ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'token-exchange-failed' }),
      })
    )

    await expect(handleOIDCCallback()).rejects.toThrow('token-exchange-failed')
  })

  it('clears the pending session from sessionStorage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ serverSecret: 'aabb', keyVersion: 'v1' }),
      })
    )

    await handleOIDCCallback()
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleOIDCCallback — OIDC path (e.g. Google)
// ---------------------------------------------------------------------------

describe('handleOIDCCallback — OIDC path', () => {
  let handleOIDCCallback

  const oidcPending = makePendingSession({
    provider: { id: 'google', name: 'Google', type: 'oidc', clientId: 'google-client' },
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
  })

  beforeEach(async () => {
    vi.resetModules()
    ;({ handleOIDCCallback } = await import('../../src/p2p/oidc.js'))
    setCallbackUrl('google-code', 'test-state')
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(oidcPending))
  })

  it('exchanges code for id_token at token endpoint, then calls /derive with token', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id_token: 'jwt.token.here' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ serverSecret: 'cafebabe', keyVersion: 'v1' }),
        })
    )

    const result = await handleOIDCCallback()

    // First call: token endpoint
    expect(fetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token')
    // Second call: /derive with id_token
    const deriveBody = JSON.parse(fetch.mock.calls[1][1].body)
    expect(deriveBody.token).toBe('jwt.token.here')
    expect(deriveBody.provider).toBe('google')

    expect(result.serverSecret).toBe('cafebabe')
  })

  it('throws missing-id-token if token endpoint returns no id_token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'only-access' }),
      })
    )

    await expect(handleOIDCCallback()).rejects.toThrow('missing-id-token')
  })

  it('throws token-exchange-failed if token endpoint returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false }))
    await expect(handleOIDCCallback()).rejects.toThrow('token-exchange-failed')
  })
})
