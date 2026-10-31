import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createIceProvider, isIceDisabled, selectProvider, sharedSecretCredentials } from '../ice.js'

test('returns no servers when nothing is configured', async () => {
  const provider = createIceProvider({ env: {} })
  assert.deepEqual(await provider.get(), { iceServers: [], ttl: 0 })
})

test('builds TURN REST credentials from a shared secret (coturn / eturnal)', async () => {
  const nowMs = 1_700_000_000_000
  const provider = createIceProvider({
    env: {
      TURN_URLS: 'turn:turn.example.com:3478, turns:turn.example.com:5349',
      TURN_SECRET: 's3cret',
      TURN_TTL: '3600',
    },
    now: () => nowMs,
  })
  const { iceServers, ttl } = await provider.get()
  assert.equal(ttl, 3600)
  assert.equal(iceServers.length, 1)

  const [server] = iceServers
  assert.deepEqual(server.urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'])
  assert.match(server.username, new RegExp(`^${1_700_000_000 + 3600}:[0-9a-f]{16}$`))
  const expected = crypto.createHmac('sha1', 's3cret').update(server.username).digest('base64')
  assert.equal(server.credential, expected)
})

test('the default credential lifetime is one hour', async () => {
  const provider = createIceProvider({ env: { TURN_URLS: 'turn:x', TURN_SECRET: 's' } })
  assert.equal((await provider.get()).ttl, 3600)
})

test('coturn credentials are minted per request, each with its own opaque id', async () => {
  const provider = createIceProvider({ env: { TURN_URLS: 'turn:x', TURN_SECRET: 's' } })
  const first = (await provider.get()).iceServers[0]
  const second = (await provider.get()).iceServers[0]
  assert.notEqual(first.username, second.username)
  assert.notEqual(first.credential, second.credential)
  for (const { username } of [first, second]) assert.equal(username.split(':').length, 2) // id has no ":"
})

test('sharedSecretCredentials accepts a fixed id', () => {
  const { username } = sharedSecretCredentials('k', ['turn:x'], 60, 2_000_000, 'abc')
  assert.equal(username, '2060:abc')
})

test('sharedSecretCredentials expires after the requested ttl', () => {
  const { username } = sharedSecretCredentials('k', ['turn:x'], 60, 2_000_000)
  assert.equal(username.split(':')[0], '2060')
})

test('asks Cloudflare for credentials and strips the browser-blocked port 53', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      json: async () => ({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478'] },
          {
            urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'],
            username: 'u',
            credential: 'c',
          },
        ],
      }),
    }
  }
  const provider = createIceProvider({ env: { CLOUDFLARE_TURN_KEY_ID: 'KEY', CLOUDFLARE_TURN_API_TOKEN: 'TOKEN' }, fetchImpl })
  const { iceServers } = await provider.get()

  assert.match(calls[0].url, /\/turn\/keys\/KEY\/credentials\/generate-ice-servers$/)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer TOKEN')
  assert.equal(JSON.parse(calls[0].init.body).ttl, 3600)
  assert.deepEqual(iceServers[1].urls, ['turn:turn.cloudflare.com:3478?transport=udp'])
  assert.equal(iceServers[1].username, 'u')
})

test('TURN_PROVIDER decides when several back-ends are configured', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: ['stun:cf'] }] }) })
  const env = { CLOUDFLARE_TURN_KEY_ID: 'K', CLOUDFLARE_TURN_API_TOKEN: 'T', TURN_URLS: 'turn:x', TURN_SECRET: 's' }

  const cloudflare = createIceProvider({ env: { ...env, TURN_PROVIDER: 'cloudflare' }, fetchImpl })
  assert.equal(cloudflare.name, 'cloudflare')
  assert.deepEqual((await cloudflare.get()).iceServers, [{ urls: ['stun:cf'] }])

  const coturn = createIceProvider({ env: { ...env, TURN_PROVIDER: 'coturn' }, fetchImpl })
  assert.equal(coturn.name, 'coturn')
  assert.deepEqual((await coturn.get()).iceServers[0].urls, ['turn:x'])
})

test('auto-detects the provider from the variables that are present', () => {
  assert.equal(selectProvider({}).name, null)
  assert.equal(selectProvider({ TURN_URLS: 'turn:x', TURN_SECRET: 's' }).name, 'coturn')
  assert.equal(selectProvider({ TURN_URLS: 'turn:x', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }).name, 'static')
  assert.equal(selectProvider({ TURN_API_URL: 'https://api.example.com' }).name, 'http')
  assert.equal(selectProvider({ CLOUDFLARE_TURN_KEY_ID: 'K', CLOUDFLARE_TURN_API_TOKEN: 'T' }).name, 'cloudflare')
})

test('reports a misspelt or incomplete TURN_PROVIDER instead of failing silently', async () => {
  const unknown = createIceProvider({ env: { TURN_PROVIDER: 'twilio' } })
  assert.equal(unknown.name, null)
  assert.match(unknown.error, /unknown TURN_PROVIDER "twilio"/)
  assert.deepEqual(await unknown.get(), { iceServers: [], ttl: 0 })

  const incomplete = createIceProvider({ env: { TURN_PROVIDER: 'coturn', TURN_URLS: 'turn:x' } })
  assert.equal(incomplete.name, null)
  assert.match(incomplete.error, /missing its variables/)
})

test('static provider serves one fixed login', async () => {
  const provider = createIceProvider({
    env: { TURN_URLS: 'turn:a:3478,turns:a:5349', TURN_USERNAME: 'user', TURN_CREDENTIAL: 'pass' },
  })
  assert.equal(provider.name, 'static')
  assert.deepEqual((await provider.get()).iceServers, [
    { urls: ['turn:a:3478', 'turns:a:5349'], username: 'user', credential: 'pass' },
  ])
})

test('http provider relays any ICE API (array body, as Metered returns)', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => [{ urls: 'turn:m:80', username: 'u', credential: 'c' }] }
  }
  const provider = createIceProvider({
    env: { TURN_API_URL: 'https://api.example.com/turn?key=1', TURN_API_AUTHORIZATION: 'Bearer abc' },
    fetchImpl,
  })
  assert.equal(provider.name, 'http')
  assert.deepEqual((await provider.get()).iceServers, [{ urls: ['turn:m:80'], username: 'u', credential: 'c' }])
  assert.equal(calls[0].url, 'https://api.example.com/turn?key=1')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer abc')
})

test('http provider also accepts { iceServers, ttl }', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: ['stun:s'] }], ttl: 600 }) })
  const provider = createIceProvider({ env: { TURN_API_URL: 'https://api.example.com' }, fetchImpl })
  assert.deepEqual(await provider.get(), { iceServers: [{ urls: ['stun:s'] }], ttl: 600 })
})

test('http provider fails on unusable answers', async () => {
  const bad = createIceProvider({
    env: { TURN_API_URL: 'https://api.example.com' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ nope: 1 }) }),
  })
  await assert.rejects(bad.get(), /no iceServers/)
})

test('strips the browser-blocked port 53 whatever the provider', async () => {
  const provider = createIceProvider({
    env: { TURN_URLS: 'turn:a:3478,turn:a:53?transport=udp', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' },
  })
  assert.deepEqual((await provider.get()).iceServers[0].urls, ['turn:a:3478'])
})

test('an HTTP ICE API is called once and reused until half of the credentials lifetime has passed', async () => {
  let nowMs = 0
  let fetches = 0
  const fetchImpl = async () => {
    fetches++
    return { ok: true, json: async () => ({ iceServers: [], ttl: 1000 }) }
  }
  const provider = createIceProvider({
    env: { TURN_API_URL: 'https://api.example.com/turn' },
    fetchImpl,
    now: () => nowMs,
  })
  await provider.get()
  nowMs = 400_000
  await provider.get()
  assert.equal(fetches, 1)
  nowMs = 501_000
  await provider.get()
  assert.equal(fetches, 2)
})

test('propagates upstream failures without caching them', async () => {
  let ok = false
  const fetchImpl = async () => (ok ? { ok: true, json: async () => ({ iceServers: [] }) } : { ok: false, status: 500 })
  const provider = createIceProvider({ env: { CLOUDFLARE_TURN_KEY_ID: 'K', CLOUDFLARE_TURN_API_TOKEN: 'T' }, fetchImpl })
  await assert.rejects(provider.get(), /500/)
  ok = true
  assert.deepEqual((await provider.get()).iceServers, [])
})

test('ttl in the answer is the time left on the credentials, not their full lifetime', async () => {
  let nowMs = 0
  const fetchImpl = async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: ['stun:s'] }], ttl: 1000 }) })
  const provider = createIceProvider({
    env: { TURN_API_URL: 'https://api.example.com/turn' },
    fetchImpl,
    now: () => nowMs,
  })
  assert.equal((await provider.get()).ttl, 1000)
  nowMs = 300_000 // served from the cache, 700 s left
  assert.equal((await provider.get()).ttl, 700)
  nowMs = 600_000 // cache expired: new credentials, full lifetime again
  assert.equal((await provider.get()).ttl, 1000)
})

test('Cloudflare mints a credential per request so usage can be attributed and an abuser revoked alone', async () => {
  let n = 0
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    return {
      ok: true,
      json: async () => ({ iceServers: [{ urls: ['turn:t:3478'], username: `u${++n}`, credential: 'c' }] }),
    }
  }
  const provider = createIceProvider({ env: { CLOUDFLARE_TURN_KEY_ID: 'K', CLOUDFLARE_TURN_API_TOKEN: 'T' }, fetchImpl })
  const first = (await provider.get()).iceServers[0].username
  const second = (await provider.get()).iceServers[0].username
  assert.notEqual(first, second)
  assert.equal(calls.length, 2)
})

test('the Cloudflare API base URL can be overridden (used by the integration tests)', async () => {
  let url
  const fetchImpl = async (u) => {
    url = u
    return { ok: true, json: async () => ({ iceServers: [] }) }
  }
  const provider = createIceProvider({
    env: { CLOUDFLARE_TURN_KEY_ID: 'K', CLOUDFLARE_TURN_API_TOKEN: 'T', CLOUDFLARE_TURN_API_URL: 'http://127.0.0.1:9/keys' },
    fetchImpl,
  })
  await provider.get()
  assert.equal(url, 'http://127.0.0.1:9/keys/K/credentials/generate-ice-servers')
})

test('the Cloudflare provider is only configured by CLOUDFLARE_* variables', () => {
  assert.equal(selectProvider({ CLOUDFLARE_TURN_KEY_ID: 'K', CLOUDFLARE_TURN_API_TOKEN: 'T' }).name, 'cloudflare')
  assert.equal(selectProvider({ CF_TURN_KEY_ID: 'K', CF_TURN_API_TOKEN: 'T' }).name, null)
})

test('ICE_DISABLED accepts true, 1 and yes, in any case, and nothing else', () => {
  for (const value of ['true', 'TRUE', '1', 'yes', ' true ']) assert.equal(isIceDisabled({ ICE_DISABLED: value }), true, value)
  for (const value of [undefined, '', 'false', '0', 'no', 'disabled']) {
    assert.equal(isIceDisabled({ ICE_DISABLED: value }), false, String(value))
  }
})
