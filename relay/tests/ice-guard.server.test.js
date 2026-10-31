// GET /ice protection, against the real server: origin allow-list and rate limit.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startRelay } from './helpers/start-relay.js'

const ALLOWED = 'https://app.example.com'
const TURN_ENV = { TURN_URLS: 'turn:turn.test:3478', TURN_SECRET: 'test-secret' }

/** Plain http.request: unlike fetch it lets us send any Origin / X-Forwarded-For header. */
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

let restricted // allow-list + small rate limit
let open // defaults

before(async () => {
  restricted = await startRelay({
    ...TURN_ENV,
    ICE_ALLOWED_ORIGINS: `${ALLOWED},https://*.preview.example.com`,
    ICE_RATE_LIMIT: '3',
    TRUST_PROXY_HOPS: '1',
  })
  open = await startRelay(TURN_ENV)
})

after(async () => {
  await restricted?.stop()
  await open?.stop()
})

test('logs the effective /ice policy at startup', () => {
  assert.match(restricted.output(), /\/ice access: origins: 2 allowed; 3 requests\/min per IP/)
  assert.match(open.output(), /\/ice access: open to every origin.*30 requests\/min per IP/)
})

test('an allowed origin gets credentials and its own origin echoed back', async () => {
  const res = await get(restricted.port, { headers: { Origin: ALLOWED, 'X-Forwarded-For': '198.51.100.1' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['access-control-allow-origin'], ALLOWED)
  assert.equal(res.headers.vary, 'Origin')
  assert.deepEqual(JSON.parse(res.body).iceServers[0].urls, ['turn:turn.test:3478'])
})

test('wildcard preview origins are allowed', async () => {
  const res = await get(restricted.port, {
    headers: { Origin: 'https://feat-x.preview.example.com', 'X-Forwarded-For': '198.51.100.2' },
  })
  assert.equal(res.status, 200)
})

test('another website is refused', async () => {
  const res = await get(restricted.port, { headers: { Origin: 'https://evil.example.com' } })
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error, 'origin-not-allowed')
  assert.equal(res.headers['access-control-allow-origin'], undefined)
  assert.doesNotMatch(res.body, /credential/)
})

test('a plain curl without an Origin is refused when an allow-list is set', async () => {
  const res = await get(restricted.port)
  assert.equal(res.status, 403)
})

test('the preflight only succeeds for allowed origins', async () => {
  const ok = await get(restricted.port, { method: 'OPTIONS', headers: { Origin: ALLOWED } })
  assert.equal(ok.status, 204)
  assert.equal(ok.headers['access-control-allow-origin'], ALLOWED)

  const denied = await get(restricted.port, { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } })
  assert.equal(denied.status, 403)
})

test('the 4th request from the same IP within a minute gets 429 with Retry-After', async () => {
  const headers = { Origin: ALLOWED, 'X-Forwarded-For': '198.51.100.50' }
  for (let i = 0; i < 3; i++) assert.equal((await get(restricted.port, { headers })).status, 200)

  const blocked = await get(restricted.port, { headers })
  assert.equal(blocked.status, 429)
  assert.equal(JSON.parse(blocked.body).error, 'rate-limited')
  assert.ok(Number(blocked.headers['retry-after']) > 0)
  assert.equal(blocked.headers['access-control-allow-origin'], ALLOWED)
  assert.doesNotMatch(blocked.body, /credential/)

  // a different client is not affected
  const other = await get(restricted.port, { headers: { Origin: ALLOWED, 'X-Forwarded-For': '198.51.100.51' } })
  assert.equal(other.status, 200)
})

test('forging X-Forwarded-For does not reset the limit (the last hop is trusted)', async () => {
  // the "proxy" (last entry) is always the same client address; the forged left part changes every time
  const results = []
  for (let i = 0; i < 5; i++) {
    const res = await get(restricted.port, {
      headers: { Origin: ALLOWED, 'X-Forwarded-For': `10.0.0.${i}, 198.51.100.77` },
    })
    results.push(res.status)
  }
  assert.deepEqual(results, [200, 200, 200, 429, 429])
})

test('the first rate-limited client is logged once, to help check TRUST_PROXY_HOPS', async () => {
  assert.match(restricted.output(), /rate limit hit for 198\.51\.100\.50/)
  assert.equal((restricted.output().match(/rate limit hit for 198\.51\.100\.50/g) ?? []).length, 1)
})

test('open mode (defaults) still answers every origin with a wildcard', async () => {
  const res = await get(open.port, { headers: { Origin: 'https://anything.example.com' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers['access-control-allow-origin'], '*')
  assert.equal((await get(open.port)).status, 200)
})

test('ICE_DISABLED=true switches the endpoint off (404) even with TURN fully configured', async () => {
  const disabled = await startRelay({ ...TURN_ENV, ICE_DISABLED: 'true' })
  try {
    const res = await get(disabled.port)
    assert.equal(res.status, 404)
    assert.equal(JSON.parse(res.body).error, 'not-found')
    assert.doesNotMatch(res.body, /credential|iceServers/)
    assert.equal(res.headers['access-control-allow-origin'], undefined)

    assert.equal((await get(disabled.port, { method: 'OPTIONS' })).status, 404)
    assert.match(disabled.output(), /\/ice endpoint: DISABLED/)

    // the rest of the relay is unaffected
    const health = await fetch(`http://127.0.0.1:${disabled.port}/`)
    assert.equal(health.status, 200)
  } finally {
    await disabled.stop()
  }
})
