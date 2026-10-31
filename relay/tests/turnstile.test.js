import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnstile } from '../turnstile.js'

const answer = (body, ok = true) => async () => ({ ok, json: async () => body })

test('is disabled, and lets everything through, without a secret', async () => {
  const turnstile = createTurnstile({ env: {}, fetchImpl: () => assert.fail('must not call Cloudflare') })
  assert.equal(turnstile.enabled, false)
  assert.deepEqual(await turnstile.verify(undefined), { ok: true })
})

test('a request without a token is refused without calling Cloudflare', async () => {
  const turnstile = createTurnstile({ env: { TURNSTILE_SECRET: 's' }, fetchImpl: () => assert.fail('no call expected') })
  for (const token of [undefined, '', 'x'.repeat(2049), 42]) {
    assert.deepEqual(await turnstile.verify(token), { ok: false, status: 403, error: 'turnstile-required' })
  }
})

test('sends the secret, the token and the client IP to siteverify', async () => {
  const calls = []
  const turnstile = createTurnstile({
    env: { TURNSTILE_SECRET: 'the-secret' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, json: async () => ({ success: true }) }
    },
  })
  assert.deepEqual(await turnstile.verify('tok', '203.0.113.7'), { ok: true })
  assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { secret: 'the-secret', response: 'tok', remoteip: '203.0.113.7' })
})

test('does not send a remoteip it does not know', async () => {
  let body
  const turnstile = createTurnstile({
    env: { TURNSTILE_SECRET: 's' },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return { ok: true, json: async () => ({ success: true }) }
    },
  })
  await turnstile.verify('tok', 'unknown')
  assert.equal('remoteip' in body, false)
})

test('a token Cloudflare rejects (forged, expired or already used) is refused with its error codes', async () => {
  const turnstile = createTurnstile({
    env: { TURNSTILE_SECRET: 's' },
    fetchImpl: answer({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
  })
  assert.deepEqual(await turnstile.verify('tok'), {
    ok: false,
    status: 403,
    error: 'turnstile-failed',
    codes: ['timeout-or-duplicate'],
  })
})

test('fails closed (503) when Cloudflare cannot be reached or answers with an error', async () => {
  const unreachable = createTurnstile({
    env: { TURNSTILE_SECRET: 's' },
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  assert.deepEqual(await unreachable.verify('tok'), { ok: false, status: 503, error: 'turnstile-unavailable' })

  const broken = createTurnstile({ env: { TURNSTILE_SECRET: 's' }, fetchImpl: answer({}, false) })
  assert.equal((await broken.verify('tok')).status, 503)
})

test('the siteverify URL can be overridden (used by the integration tests)', async () => {
  let url
  const turnstile = createTurnstile({
    env: { TURNSTILE_SECRET: 's', TURNSTILE_VERIFY_URL: 'http://127.0.0.1:1/verify' },
    fetchImpl: async (u) => {
      url = u
      return { ok: true, json: async () => ({ success: true }) }
    },
  })
  await turnstile.verify('tok')
  assert.equal(url, 'http://127.0.0.1:1/verify')
})
