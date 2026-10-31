import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientIp, createIceGuard, parseAllowedOrigins } from '../ice-guard.js'

const req = (headers = {}, ip = '10.0.0.1') => ({ headers, socket: { remoteAddress: ip } })

test('no allow-list means open to every origin', () => {
  assert.equal(parseAllowedOrigins(undefined).open, true)
  assert.equal(parseAllowedOrigins('').open, true)
  assert.equal(parseAllowedOrigins('*').open, true)
  assert.equal(parseAllowedOrigins('https://app.example.com, *').open, true)
})

test('open mode answers with a wildcard CORS header, with or without an Origin', () => {
  const guard = createIceGuard({ env: {} })
  assert.equal(guard.check(req({ origin: 'https://anywhere.example' })).headers['Access-Control-Allow-Origin'], '*')
  assert.equal(guard.check(req()).ok, true)
})

test('an allow-list accepts only the listed origins and echoes the origin back', () => {
  const guard = createIceGuard({ env: { ICE_ALLOWED_ORIGINS: 'https://app.example.com,http://localhost:5173' } })

  const ok = guard.check(req({ origin: 'https://app.example.com' }))
  assert.equal(ok.ok, true)
  assert.equal(ok.headers['Access-Control-Allow-Origin'], 'https://app.example.com')
  assert.equal(ok.headers.Vary, 'Origin')

  assert.equal(guard.check(req({ origin: 'http://localhost:5173' })).ok, true)
  for (const origin of [
    'https://evil.example.com',
    'http://app.example.com', // wrong scheme
    'https://app.example.com:8443', // wrong port
    'https://app.example.com.evil.com', // suffix trick
    'https://sub.app.example.com',
  ]) {
    const verdict = guard.check(req({ origin }))
    assert.equal(verdict.ok, false, origin)
    assert.equal(verdict.status, 403)
  }
})

test('with an allow-list, requests without an Origin (curl, scripts) are refused', () => {
  const guard = createIceGuard({ env: { ICE_ALLOWED_ORIGINS: 'https://app.example.com' } })
  const verdict = guard.check(req())
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  assert.equal(verdict.error, 'origin-not-allowed')
})

test('wildcard subdomains match deeper labels but not the bare domain or look-alikes', () => {
  const guard = createIceGuard({ env: { ICE_ALLOWED_ORIGINS: 'https://*.pipol.pages.dev' } })
  assert.equal(guard.check(req({ origin: 'https://feat-x.pipol.pages.dev' })).ok, true)
  assert.equal(guard.check(req({ origin: 'https://a.b.pipol.pages.dev' })).ok, true)
  assert.equal(guard.check(req({ origin: 'https://pipol.pages.dev' })).ok, false)
  assert.equal(guard.check(req({ origin: 'https://evilpipol.pages.dev' })).ok, false)
  assert.equal(guard.check(req({ origin: 'https://x.pipol.pages.dev.evil.com' })).ok, false)
})

test('reports invalid allow-list entries instead of silently ignoring them', () => {
  const parsed = parseAllowedOrigins('https://ok.example.com, not-a-url, ftp://x.example.com')
  assert.equal(parsed.open, false)
  assert.equal(parsed.matchers.length, 1)
  assert.deepEqual(parsed.invalid, ['not-a-url', 'ftp://x.example.com'])
})

test('a list with only invalid entries denies everything rather than opening up', () => {
  const guard = createIceGuard({ env: { ICE_ALLOWED_ORIGINS: 'garbage' } })
  assert.equal(guard.check(req({ origin: 'https://app.example.com' })).ok, false)
})

test('rate limit: allows the configured number per minute per IP, then 429 with Retry-After', () => {
  let nowMs = 1_000_000
  const guard = createIceGuard({ env: { ICE_RATE_LIMIT: '3', TRUST_PROXY_HOPS: '0' }, now: () => nowMs })

  for (let i = 0; i < 3; i++) assert.equal(guard.check(req()).ok, true)
  const blocked = guard.check(req())
  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 429)
  assert.equal(blocked.error, 'rate-limited')
  assert.ok(Number(blocked.headers['Retry-After']) > 0)
  assert.equal(blocked.headers['Access-Control-Allow-Origin'], '*') // so a browser can read the 429

  // another IP is unaffected
  assert.equal(guard.check(req({}, '10.0.0.2')).ok, true)

  // the window resets
  nowMs += 61_000
  assert.equal(guard.check(req()).ok, true)
})

test('rate limit can be disabled with 0', () => {
  const guard = createIceGuard({ env: { ICE_RATE_LIMIT: '0' } })
  for (let i = 0; i < 200; i++) assert.equal(guard.check(req()).ok, true)
})

test('the default limit is 30 per minute', () => {
  const guard = createIceGuard({ env: { TRUST_PROXY_HOPS: '0' } })
  for (let i = 0; i < 30; i++) assert.equal(guard.check(req()).ok, true)
  assert.equal(guard.check(req()).status, 429)
})

test('preflight requests are not counted against the limit', () => {
  const guard = createIceGuard({ env: { ICE_RATE_LIMIT: '1', TRUST_PROXY_HOPS: '0' } })
  for (let i = 0; i < 5; i++) assert.equal(guard.check(req(), { rateLimit: false }).ok, true)
  assert.equal(guard.check(req()).ok, true)
})

test('origin is checked before the rate limit, so refused origins never fill the bucket', () => {
  const guard = createIceGuard({
    env: { ICE_ALLOWED_ORIGINS: 'https://app.example.com', ICE_RATE_LIMIT: '1', TRUST_PROXY_HOPS: '0' },
  })
  for (let i = 0; i < 5; i++) assert.equal(guard.check(req({ origin: 'https://evil.example.com' })).status, 403)
  assert.equal(guard.check(req({ origin: 'https://app.example.com' })).ok, true)
})

test('client IP: counts proxies from the right so a forged X-Forwarded-For cannot dodge the limit', () => {
  const r = req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }, '10.1.1.1')
  assert.equal(clientIp(r, 1), '203.0.113.9') // the proxy appended the real client
  assert.equal(clientIp(r, 2), '1.2.3.4')
  assert.equal(clientIp(r, 0), '10.1.1.1') // no proxy: socket address
  assert.equal(clientIp(req({}, '10.1.1.1'), 1), '10.1.1.1') // header missing
  assert.equal(clientIp(r, 5), '1.2.3.4') // more hops than entries: leftmost
})

test('a forged X-Forwarded-For does not give a fresh bucket per request', () => {
  const guard = createIceGuard({ env: { ICE_RATE_LIMIT: '2', TRUST_PROXY_HOPS: '1' } })
  const forged = (n) => req({ 'x-forwarded-for': `9.9.9.${n}, 203.0.113.9` })
  assert.equal(guard.check(forged(1)).ok, true)
  assert.equal(guard.check(forged(2)).ok, true)
  assert.equal(guard.check(forged(3)).status, 429)
})

test('describe() summarises the effective policy', () => {
  assert.match(createIceGuard({ env: {} }).describe().text, /open to every origin.*30 requests\/min/)
  const restricted = createIceGuard({ env: { ICE_ALLOWED_ORIGINS: 'https://a.example.com', ICE_RATE_LIMIT: '0' } })
  assert.match(restricted.describe().text, /origins: 1 allowed.*no rate limit/)
})
