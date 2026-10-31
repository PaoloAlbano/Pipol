/**
 * ice.test.js
 * ICE server validation and resolution (user setting > workspace > app default).
 */

import { getTurnstileToken } from '../../src/webrtc/turnstile.js'
import {
  DEFAULT_ICE_SERVERS,
  buildWorkspaceIce,
  chatIceConfig,
  clearIceCache,
  deriveIceUrl,
  hasTurnServer,
  isTurnDisabled,
  parseIceUrls,
  resolveIceConfig,
  testIceServers,
  validateIceServers,
  validateWorkspaceIce,
} from '../../src/webrtc/ice.js'

const mockSiteKey = vi.hoisted(() => ({ value: '' }))

vi.mock('../../src/webrtc/turnstile.js', () => ({
  turnstileSiteKey: () => mockSiteKey.value,
  getTurnstileToken: vi.fn(),
}))

const TURN = { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }
const defaults = { mode: 'default', servers: [], forceRelay: false }

const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, json: async () => body })

beforeEach(() => {
  mockSiteKey.value = ''
  getTurnstileToken.mockReset()
  clearIceCache()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('parseIceUrls', () => {
  it('splits on newlines, commas and spaces', () => {
    expect(parseIceUrls('turn:a:3478, turns:b:5349\nstun:c:3478  ')).toEqual([
      'turn:a:3478',
      'turns:b:5349',
      'stun:c:3478',
    ])
  })

  it('returns an empty list for empty input', () => {
    expect(parseIceUrls('')).toEqual([])
    expect(parseIceUrls(undefined)).toEqual([])
  })
})

describe('validateIceServers', () => {
  it('accepts TURN with credentials and STUN without', () => {
    expect(validateIceServers([TURN, { urls: 'stun:stun.example.com:3478' }])).toEqual([
      TURN,
      { urls: ['stun:stun.example.com:3478'] },
    ])
  })

  it.each([
    ['empty list', []],
    ['not a list', 'turn:x'],
    ['http scheme', [{ urls: 'http://evil.example.com' }]],
    ['javascript scheme', [{ urls: 'javascript:alert(1)' }]],
    ['TURN without credentials', [{ urls: 'turn:turn.example.com:3478' }]],
    ['TURN without password', [{ urls: 'turn:turn.example.com:3478', username: 'u' }]],
    ['oversized credential', [{ ...TURN, credential: 'x'.repeat(600) }]],
    ['too many servers', Array.from({ length: 9 }, () => TURN)],
  ])('rejects %s', (_name, input) => {
    expect(() => validateIceServers(input)).toThrow('invalid-ice-servers')
  })
})

describe('validateWorkspaceIce', () => {
  it('accepts static servers and an https endpoint', () => {
    const ice = validateWorkspaceIce({ servers: [TURN], url: 'https://relay.example.com/ice' })
    expect(ice.servers).toEqual([TURN])
    expect(ice.url).toBe('https://relay.example.com/ice')
  })

  it('treats missing config as none', () => {
    expect(validateWorkspaceIce(null)).toBeNull()
    expect(validateWorkspaceIce({})).toBeNull()
  })

  it.each([
    ['a non-object', 'x'],
    ['a javascript: endpoint', { url: 'javascript:alert(1)' }],
    ['a file: endpoint', { url: 'file:///etc/passwd' }],
    ['an invalid server', { servers: [{ urls: 'ftp://x' }] }],
  ])('rejects %s', (_name, input) => {
    expect(() => validateWorkspaceIce(input)).toThrow('invalid-ice-config')
  })
})

describe('buildWorkspaceIce', () => {
  it('returns null when every field is empty', () => {
    expect(buildWorkspaceIce({})).toBeNull()
  })

  it('builds a server from the form fields', () => {
    const ice = buildWorkspaceIce({ urls: 'turn:turn.example.com:3478', username: ' u ', credential: 'p' })
    expect(ice.servers).toEqual([TURN])
  })

  it('builds an endpoint-only config', () => {
    expect(buildWorkspaceIce({ endpoint: 'https://relay.example.com/ice' }).url).toBe('https://relay.example.com/ice')
  })

  it('throws on TURN without a password', () => {
    expect(() => buildWorkspaceIce({ urls: 'turn:turn.example.com:3478', username: 'u' })).toThrow('invalid-ice-config')
  })
})

describe('deriveIceUrl', () => {
  it('maps the relay WebSocket URL to its /ice endpoint', () => {
    expect(deriveIceUrl('wss://relay.example.com')).toBe('https://relay.example.com/ice')
    expect(deriveIceUrl('ws://localhost:8787/')).toBe('http://localhost:8787/ice')
    expect(deriveIceUrl('wss://example.com/relay')).toBe('https://example.com/relay/ice')
  })

  it('returns null for missing or invalid input', () => {
    expect(deriveIceUrl(null)).toBeNull()
    expect(deriveIceUrl('not a url')).toBeNull()
  })
})

describe('hasTurnServer', () => {
  it('only counts turn: and turns: URLs', () => {
    expect(hasTurnServer([{ urls: ['stun:x:3478'] }])).toBe(false)
    expect(hasTurnServer([{ urls: ['stun:x:3478'] }, { urls: ['turns:y:5349'] }])).toBe(true)
  })
})

describe('resolveIceConfig — user settings', () => {
  it('"off" uses public STUN only and never calls the network', async () => {
    const fetchImpl = vi.fn()
    const cfg = await resolveIceConfig({
      relayUrl: 'wss://relay.example.com',
      settings: { ...defaults, mode: 'off', forceRelay: true },
      fetchImpl,
    })
    expect(cfg).toEqual({ iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('"custom" uses the user servers and wins over the workspace', async () => {
    const fetchImpl = vi.fn()
    const cfg = await resolveIceConfig({
      workspaceIce: { servers: [{ urls: ['turn:ws.example.com'], username: 'w', credential: 'w' }] },
      settings: { mode: 'custom', servers: [TURN], forceRelay: false },
      fetchImpl,
    })
    expect(cfg.iceServers).toEqual([TURN])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('falls back to STUN when the custom servers are invalid', async () => {
    const cfg = await resolveIceConfig({ settings: { mode: 'custom', servers: [{ urls: 'x' }], forceRelay: false } })
    expect(cfg.iceServers).toEqual(DEFAULT_ICE_SERVERS)
  })

  it('forces relay only when a TURN server is available', async () => {
    const withTurn = await resolveIceConfig({ settings: { mode: 'custom', servers: [TURN], forceRelay: true } })
    expect(withTurn.iceTransportPolicy).toBe('relay')

    const stunOnly = await resolveIceConfig({
      settings: { mode: 'custom', servers: [{ urls: 'stun:s.example.com:3478' }], forceRelay: true },
    })
    expect(stunOnly.iceTransportPolicy).toBe('all')
  })
})

describe('resolveIceConfig — workspace and app default', () => {
  it('uses static workspace servers without fetching', async () => {
    const fetchImpl = vi.fn()
    const cfg = await resolveIceConfig({ workspaceIce: { servers: [TURN] }, settings: defaults, fetchImpl })
    expect(cfg.iceServers).toEqual([TURN])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fetches the workspace endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ iceServers: [TURN], ttl: 3600 }))
    const cfg = await resolveIceConfig({
      workspaceIce: { url: 'https://ice.example.com/ice' },
      relayUrl: 'wss://relay.example.com',
      settings: defaults,
      fetchImpl,
    })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://ice.example.com/ice')
    expect(cfg.iceServers).toEqual([TURN])
  })

  it('derives <relay>/ice when nothing else is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ iceServers: [TURN] }))
    await resolveIceConfig({ relayUrl: 'wss://relay.example.com', settings: defaults, fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://relay.example.com/ice')
  })

  it('caches the endpoint response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ iceServers: [TURN], ttl: 3600 }))
    const ctx = { relayUrl: 'wss://relay.example.com', settings: defaults, fetchImpl }
    await resolveIceConfig(ctx)
    await resolveIceConfig(ctx)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('drops invalid entries from the endpoint response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ iceServers: [TURN, { urls: 'http://evil.example.com' }, { urls: 'turn:x' }] }))
    const cfg = await resolveIceConfig({ relayUrl: 'wss://relay.example.com', settings: defaults, fetchImpl })
    expect(cfg.iceServers).toEqual([TURN])
  })

  it.each([
    ['an HTTP error', () => Promise.resolve(jsonResponse({}, false, 502))],
    ['a network error', () => Promise.reject(new Error('offline'))],
    ['a non-JSON answer', () => Promise.resolve({ ok: true, json: async () => Promise.reject(new Error('html')) })],
  ])('falls back to public STUN on %s and marks the result as degraded', async (_name, impl) => {
    const cfg = await resolveIceConfig({
      relayUrl: 'wss://relay.example.com',
      settings: defaults,
      fetchImpl: vi.fn(impl),
    })
    expect(cfg).toEqual({ iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all', degraded: true })
  })

  it('falls back to public STUN on an empty list (not an error, so not degraded)', async () => {
    const cfg = await resolveIceConfig({
      relayUrl: 'wss://relay.example.com',
      settings: defaults,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ iceServers: [] })),
    })
    expect(cfg).toEqual({ iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all' })
  })

  it('falls back to STUN when there is no relay to ask', async () => {
    const cfg = await resolveIceConfig({ settings: defaults, fetchImpl: vi.fn() })
    expect(cfg.iceServers).toEqual(DEFAULT_ICE_SERVERS)
  })
})

describe('chatIceConfig — TURN is for calls only by default', () => {
  const callConfig = { iceServers: [TURN], iceTransportPolicy: 'all' }

  it('keeps chat on public STUN', () => {
    expect(chatIceConfig(callConfig, defaults)).toEqual({
      iceServers: DEFAULT_ICE_SERVERS,
      iceTransportPolicy: 'all',
    })
  })

  it('gives chat the call configuration when the user opts in', () => {
    expect(chatIceConfig(callConfig, { ...defaults, chatTurn: true })).toBe(callConfig)
  })

  it('gives chat the call configuration when always relaying, so the IP is not leaked', () => {
    const relayConfig = { iceServers: [TURN], iceTransportPolicy: 'relay' }
    expect(chatIceConfig(relayConfig, { ...defaults, forceRelay: true })).toBe(relayConfig)
  })
})

describe('resolveIceConfig — credential renewal', () => {
  const ctx = (fetchImpl) => ({ relayUrl: 'wss://relay.example.com', settings: defaults, fetchImpl })

  it('asks to be renewed at 60% of the time left on the credentials', async () => {
    const cfg = await resolveIceConfig(ctx(vi.fn().mockResolvedValue(jsonResponse({ iceServers: [TURN], ttl: 3600 }))))
    expect(cfg.refreshInMs).toBe(3600 * 600)
  })

  it('never asks to renew sooner than 30 seconds', async () => {
    const cfg = await resolveIceConfig(ctx(vi.fn().mockResolvedValue(jsonResponse({ iceServers: [TURN], ttl: 10 }))))
    expect(cfg.refreshInMs).toBe(30_000)
  })

  it('has nothing to renew for static servers, custom servers and "off"', async () => {
    expect(
      (await resolveIceConfig({ workspaceIce: { servers: [TURN] }, settings: defaults })).refreshInMs
    ).toBeUndefined()
    expect(
      (await resolveIceConfig({ settings: { ...defaults, mode: 'custom', servers: [TURN] } })).refreshInMs
    ).toBeUndefined()
    expect((await resolveIceConfig({ settings: { ...defaults, mode: 'off' } })).refreshInMs).toBeUndefined()
  })

  it('serves the cache with the time that is really left, then fetches new credentials once it is stale', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ iceServers: [TURN], ttl: 3600 }))
      await resolveIceConfig(ctx(fetchImpl))

      vi.advanceTimersByTime(20 * 60 * 1000) // 40 minutes left, cache still fresh (half of the lifetime)
      const cached = await resolveIceConfig(ctx(fetchImpl))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(cached.refreshInMs).toBe(2400 * 600)

      vi.advanceTimersByTime(11 * 60 * 1000) // cache stale: asks the endpoint again
      await resolveIceConfig(ctx(fetchImpl))
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('testIceServers', () => {
  afterEach(() => {
    delete globalThis.RTCPeerConnection
  })

  function fakePC(candidateTypes) {
    globalThis.RTCPeerConnection = class {
      constructor() {
        this.closed = false
      }
      createDataChannel() {}
      async createOffer() {
        return { type: 'offer' }
      }
      async setLocalDescription() {
        for (const type of candidateTypes) this.onicecandidate({ candidate: { type } })
        this.onicecandidate({ candidate: null })
      }
      close() {
        this.closed = true
      }
    }
  }

  it('reports a relayed candidate when TURN works', async () => {
    fakePC(['host', 'srflx', 'relay'])
    expect(await testIceServers({ iceServers: [TURN] })).toEqual({ relay: true, srflx: true })
  })

  it('reports no relay when TURN rejects the credentials', async () => {
    fakePC(['host', 'srflx'])
    expect(await testIceServers({ iceServers: [TURN] })).toEqual({ relay: false, srflx: true })
  })
})

describe('resolveIceConfig — Turnstile', () => {
  const ctx = (fetchImpl, extra = {}) => ({
    relayUrl: 'wss://relay.example.com',
    settings: defaults,
    fetchImpl,
    ...extra,
  })
  const ok = () => vi.fn().mockResolvedValue(jsonResponse({ iceServers: [TURN], ttl: 3600 }))

  beforeEach(() => {
    vi.stubEnv('VITE_DHT_RELAY_URL', 'wss://relay.example.com')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('does not involve Turnstile when no site key is configured', async () => {
    const fetchImpl = ok()
    await resolveIceConfig(ctx(fetchImpl))
    expect(getTurnstileToken).not.toHaveBeenCalled()
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({})
  })

  it("sends a fresh token to the app's own /ice endpoint", async () => {
    mockSiteKey.value = '0xKEY'
    getTurnstileToken.mockResolvedValue('tok-1')
    const fetchImpl = ok()
    const cfg = await resolveIceConfig(ctx(fetchImpl))

    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ 'X-Turnstile-Token': 'tok-1' })
    expect(cfg.iceServers).toEqual([TURN])
  })

  it('asks for a token only when it really goes to the network (not on a cache hit)', async () => {
    mockSiteKey.value = '0xKEY'
    getTurnstileToken.mockResolvedValue('tok-1')
    const fetchImpl = ok()
    await resolveIceConfig(ctx(fetchImpl))
    await resolveIceConfig(ctx(fetchImpl))
    expect(getTurnstileToken).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not hand the token to a third-party relay or endpoint', async () => {
    mockSiteKey.value = '0xKEY'
    const fetchImpl = ok()
    await resolveIceConfig(ctx(fetchImpl, { relayUrl: 'wss://other-relay.example.org' }))
    await resolveIceConfig(ctx(fetchImpl, { workspaceIce: { url: 'https://ice.partner.example/ice' } }))

    expect(getTurnstileToken).not.toHaveBeenCalled()
    expect(fetchImpl.mock.calls.every(([, init]) => !('X-Turnstile-Token' in init.headers))).toBe(true)
  })

  it('falls back to public STUN, without calling the relay, when no token can be obtained', async () => {
    mockSiteKey.value = '0xKEY'
    getTurnstileToken.mockResolvedValue(null)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = ok()
    const cfg = await resolveIceConfig(ctx(fetchImpl))

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(cfg).toEqual({ iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all', degraded: true })
  })

  it('recognises VITE_ICE_URL as the app endpoint too', async () => {
    vi.stubEnv('VITE_DHT_RELAY_URL', '')
    vi.stubEnv('VITE_ICE_URL', 'https://ice.app.example/ice')
    mockSiteKey.value = '0xKEY'
    getTurnstileToken.mockResolvedValue('tok')
    const fetchImpl = ok()
    await resolveIceConfig({ workspaceIce: { url: 'https://ice.app.example/ice' }, settings: defaults, fetchImpl })
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ 'X-Turnstile-Token': 'tok' })
  })
})

describe('VITE_TURN_DISABLED — build-level kill switch', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is off unless set to true, 1 or yes', () => {
    expect(isTurnDisabled()).toBe(false)
    for (const value of ['true', 'TRUE', '1', 'yes']) {
      vi.stubEnv('VITE_TURN_DISABLED', value)
      expect(isTurnDisabled()).toBe(true)
    }
    for (const value of ['false', '0', '']) {
      vi.stubEnv('VITE_TURN_DISABLED', value)
      expect(isTurnDisabled()).toBe(false)
    }
  })

  it('makes "default" use public STUN only, without asking the relay or using the workspace TURN', async () => {
    vi.stubEnv('VITE_TURN_DISABLED', 'true')
    const fetchImpl = vi.fn()
    const viaRelay = await resolveIceConfig({ relayUrl: 'wss://relay.example.com', settings: defaults, fetchImpl })
    const viaWorkspace = await resolveIceConfig({ workspaceIce: { servers: [TURN] }, settings: defaults, fetchImpl })

    expect(viaRelay).toEqual({ iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all' })
    expect(viaWorkspace).toEqual({ iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not honour "always relay" without a TURN server', async () => {
    vi.stubEnv('VITE_TURN_DISABLED', 'true')
    const cfg = await resolveIceConfig({ settings: { ...defaults, forceRelay: true } })
    expect(cfg.iceTransportPolicy).toBe('all')
  })

  it('still lets the user pick their own custom TURN', async () => {
    vi.stubEnv('VITE_TURN_DISABLED', 'true')
    const cfg = await resolveIceConfig({
      settings: { mode: 'custom', servers: [TURN], forceRelay: false, chatTurn: false },
    })
    expect(cfg.iceServers).toEqual([TURN])
  })
})

describe('resolveIceConfig — a relay that switched /ice off (404)', () => {
  const notFound = () =>
    vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'not-found' }) })
  const ctx = (fetchImpl) => ({ relayUrl: 'wss://relay.example.com', settings: defaults, fetchImpl })

  it('means "no TURN here": public STUN, not degraded, and no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cfg = await resolveIceConfig(ctx(notFound()))
    expect(cfg).toEqual({ iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not ask again for a while', async () => {
    const fetchImpl = notFound()
    await resolveIceConfig(ctx(fetchImpl))
    await resolveIceConfig(ctx(fetchImpl))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
