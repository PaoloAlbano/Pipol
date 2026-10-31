// GET /ice protection against the real server, with fake Cloudflare endpoints:
// Turnstile verification, one credential per request, usage budget and revocation of abusive credentials.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startRelay } from './helpers/start-relay.js'

const GB = 1e9

/** Fake Cloudflare: TURN API, GraphQL analytics and Turnstile siteverify, controllable from the tests. */
const cloudflare = {
  server: null,
  port: 0,
  issued: 0,
  revoked: [],
  usedTokens: new Set(),
  monthBytes: 0,
  buckets: [], // { username, bytes } within the last hour
  graphqlCalls: 0,
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

function startFakeCloudflare() {
  cloudflare.server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (req.url === '/siteverify') {
      const { response } = JSON.parse(body)
      const ok = response === 'good-token' || (response.startsWith('once-') && !cloudflare.usedTokens.has(response))
      cloudflare.usedTokens.add(response)
      return json(200, ok ? { success: true } : { success: false, 'error-codes': ['timeout-or-duplicate'] })
    }
    if (req.url.endsWith('/generate-ice-servers')) {
      cloudflare.issued++
      return json(201, {
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478'] },
          { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: `cred-${cloudflare.issued}`, credential: 'c' },
        ],
      })
    }
    if (req.url === '/graphql') {
      cloudflare.graphqlCalls++
      const { query } = JSON.parse(body)
      const now = new Date()
      const bucket = new Date(now.getTime() - 5 * 60_000).toISOString()
      const groups = query.includes('username')
        ? cloudflare.buckets.map((b) => ({
            dimensions: { username: b.username, datetimeFiveMinutes: bucket },
            sum: { egressBytes: b.bytes },
          }))
        : [{ dimensions: { keyId: 'KEY' }, sum: { egressBytes: cloudflare.monthBytes } }]
      return json(200, { data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: groups }] } }, errors: null })
    }
    if (req.url.endsWith('/revoke')) {
      cloudflare.revoked.push(decodeURIComponent(req.url.split('/credentials/')[1].replace('/revoke', '')))
      res.writeHead(204)
      return res.end()
    }
    json(404, {})
  })
  return new Promise((resolve) => {
    cloudflare.server.listen(0, '127.0.0.1', () => {
      cloudflare.port = cloudflare.server.address().port
      resolve(undefined)
    })
  })
}

function get(port, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ice', method, headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  assert.fail('timed out waiting for the condition')
}

let relay

before(async () => {
  await startFakeCloudflare()
  const base = `http://127.0.0.1:${cloudflare.port}`
  relay = await startRelay({
    TURN_PROVIDER: 'cloudflare',
    CF_TURN_KEY_ID: 'KEY',
    CF_TURN_API_TOKEN: 'turn-token',
    CF_TURN_API_URL: `${base}/keys`,
    CF_ACCOUNT_ID: 'acc',
    CF_ANALYTICS_TOKEN: 'analytics-token',
    CF_GRAPHQL_URL: `${base}/graphql`,
    TURN_MONTHLY_BUDGET_GB: '100',
    TURN_USER_HOURLY_LIMIT_GB: '8',
    TURN_GUARD_INTERVAL_MIN: '0.03',
    TURNSTILE_SECRET: 'secret',
    TURNSTILE_VERIFY_URL: `${base}/siteverify`,
    ICE_RATE_LIMIT: '0',
  })
})

after(async () => {
  await relay?.stop()
  await new Promise((resolve) => cloudflare.server.close(resolve))
})

test('logs the protections at startup', () => {
  assert.match(relay.output(), /Turnstile\): required/)
  assert.match(relay.output(), /TURN usage guard: 100 GB\/month budget, 8 GB\/hour per credential/)
})

test('without a Turnstile token the endpoint issues nothing', async () => {
  const res = await get(relay.port)
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error, 'turnstile-required')
  assert.doesNotMatch(res.body, /credential/)
  assert.equal(cloudflare.issued, 0)
})

test('a token Cloudflare rejects issues nothing', async () => {
  const res = await get(relay.port, { headers: { 'X-Turnstile-Token': 'forged' } })
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error, 'turnstile-failed')
  assert.equal(cloudflare.issued, 0)
})

test('a valid token gets a credential of its own on every request', async () => {
  const first = await get(relay.port, { headers: { 'X-Turnstile-Token': 'good-token' } })
  const second = await get(relay.port, { headers: { 'X-Turnstile-Token': 'good-token' } })
  assert.equal(first.status, 200)
  const usernames = [first, second].map((r) => JSON.parse(r.body).iceServers.find((s) => s.username).username)
  assert.notEqual(usernames[0], usernames[1])
})

test('a token cannot be used twice', async () => {
  assert.equal((await get(relay.port, { headers: { 'X-Turnstile-Token': 'once-1' } })).status, 200)
  const replay = await get(relay.port, { headers: { 'X-Turnstile-Token': 'once-1' } })
  assert.equal(replay.status, 403)
  assert.equal(JSON.parse(replay.body).error, 'turnstile-failed')
})

test('the preflight allows the Turnstile header', async () => {
  const res = await get(relay.port, { method: 'OPTIONS' })
  assert.equal(res.status, 204)
  assert.match(res.headers['access-control-allow-headers'], /X-Turnstile-Token/)
})

test('revokes a credential that relayed too much in the last hour', async () => {
  cloudflare.buckets = [
    { username: 'cred-abuser', bytes: 12 * GB },
    { username: 'cred-fine', bytes: 1 * GB },
  ]
  await waitFor(() => cloudflare.revoked.includes('cred-abuser'))
  assert.equal(cloudflare.revoked.includes('cred-fine'), false)
  assert.match(relay.output(), /credential cred-abu… revoked/)
  cloudflare.buckets = []
})

test('stops issuing credentials when the monthly budget is used up, and resumes after', async () => {
  cloudflare.monthBytes = 120 * GB
  await waitFor(async () => {
    const res = await get(relay.port, { headers: { 'X-Turnstile-Token': 'good-token' } })
    return JSON.parse(res.body).iceServers.length === 0
  })
  const issuedWhileClosed = cloudflare.issued
  const closed = await get(relay.port, { headers: { 'X-Turnstile-Token': 'good-token' } })
  assert.equal(closed.status, 200)
  assert.deepEqual(JSON.parse(closed.body), { iceServers: [], ttl: 0 })
  assert.equal(cloudflare.issued, issuedWhileClosed) // nothing was minted at Cloudflare
  assert.match(relay.output(), /TURN budget reached/)

  cloudflare.monthBytes = 10 * GB
  await waitFor(async () => {
    const res = await get(relay.port, { headers: { 'X-Turnstile-Token': 'good-token' } })
    return JSON.parse(res.body).iceServers.length > 0
  })
})
