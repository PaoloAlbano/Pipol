import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUsageGuard } from '../usage-guard.js'

const GB = 1e9
const NOW = Date.parse('2026-10-31T12:00:00Z')
const quiet = { warn: () => {}, info: () => {} }

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: 'acc',
  CLOUDFLARE_ANALYTICS_TOKEN: 'analytics-token',
  CLOUDFLARE_TURN_KEY_ID: 'KEY',
  CLOUDFLARE_TURN_API_TOKEN: 'turn-token',
}

/**
 * Fake Cloudflare: month usage per key, usage per username and credential revocation.
 * @param {{ month?: number, buckets?: { username: string, at: string, bytes: number }[], failGraphql?: boolean }} data
 */
function fakeCloudflare({ month = 0, buckets = [], failGraphql = false } = {}) {
  const calls = { graphql: [], revoked: [] }
  const fetchImpl = async (url, init) => {
    if (url.includes('/graphql')) {
      const body = JSON.parse(init.body)
      calls.graphql.push(body)
      if (failGraphql) return { ok: false, status: 500, json: async () => ({}) }
      const groups = body.query.includes('username')
        ? buckets.map((b) => ({
            dimensions: { username: b.username, datetimeFiveMinutes: b.at },
            sum: { egressBytes: b.bytes },
          }))
        : [{ dimensions: { keyId: 'KEY' }, sum: { egressBytes: month } }]
      return { ok: true, json: async () => ({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: groups }] } }, errors: null }) }
    }
    if (url.endsWith('/revoke')) {
      calls.revoked.push({ url, init })
      return { ok: true, status: 204 }
    }
    throw new Error(`unexpected ${url}`)
  }
  return { fetchImpl, calls }
}

const guard = (env, cf, extra = {}) =>
  createUsageGuard({ env: { ...ENV, ...env }, fetchImpl: cf.fetchImpl, now: () => NOW, log: quiet, ...extra })

test('is disabled without the analytics settings, and never calls Cloudflare', async () => {
  const cf = fakeCloudflare()
  const g = createUsageGuard({ env: { CLOUDFLARE_TURN_KEY_ID: 'KEY', CLOUDFLARE_TURN_API_TOKEN: 't' }, fetchImpl: cf.fetchImpl, log: quiet })
  assert.equal(g.enabled, false)
  await g.tick()
  assert.equal(cf.calls.graphql.length, 0)
  assert.equal(g.exhausted, false)
  assert.match(g.describe(), /disabled/)
})

test('reads the month usage of the key and stays open under the budget', async () => {
  const cf = fakeCloudflare({ month: 100 * GB })
  const g = guard({ CLOUDFLARE_MONTHLY_BUDGET_GB: '800' }, cf)
  await g.tick()
  assert.equal(g.exhausted, false)
  assert.equal(g.state.monthBytes, 100 * GB)

  const query = cf.calls.graphql[0]
  assert.equal(query.variables.accountId, 'acc')
  assert.equal(query.variables.keyId, 'KEY')
  assert.equal(query.variables.from, '2026-10-01')
  assert.equal(query.variables.to, '2026-10-31')
})

test('stops issuing credentials once the monthly budget is reached, and resumes when usage drops', async () => {
  const cf = fakeCloudflare({ month: 801 * GB })
  const g = guard({ CLOUDFLARE_MONTHLY_BUDGET_GB: '800' }, cf)
  await g.tick()
  assert.equal(g.exhausted, true)

  const under = fakeCloudflare({ month: 10 * GB })
  const g2 = guard({ CLOUDFLARE_MONTHLY_BUDGET_GB: '800' }, under)
  await g2.tick()
  assert.equal(g2.exhausted, false)
})

test('without a budget the month usage never closes the endpoint', async () => {
  const g = guard({}, fakeCloudflare({ month: 5000 * GB }))
  await g.tick()
  assert.equal(g.exhausted, false)
})

test('revokes a credential that relayed more than the hourly limit, and only that one', async () => {
  const cf = fakeCloudflare({
    buckets: [
      { username: 'abuser-credential', at: '2026-10-31T11:30:00Z', bytes: 6 * GB },
      { username: 'abuser-credential', at: '2026-10-31T11:45:00Z', bytes: 4 * GB },
      { username: 'normal-user', at: '2026-10-31T11:45:00Z', bytes: 1 * GB },
    ],
  })
  const g = guard({ CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB: '8' }, cf)
  await g.tick()

  assert.equal(cf.calls.revoked.length, 1)
  assert.match(cf.calls.revoked[0].url, /\/turn\/keys\/KEY\/credentials\/abuser-credential\/revoke$/)
  assert.equal(cf.calls.revoked[0].init.headers.Authorization, 'Bearer turn-token')
  assert.equal(g.state.revoked, 1)
})

test('uses the analytics token for queries and the TURN key token for revoking', async () => {
  const cf = fakeCloudflare({ buckets: [{ username: 'u', at: '2026-10-31T11:50:00Z', bytes: 9 * GB }] })
  const calls = []
  const spy = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization })
    return cf.fetchImpl(url, init)
  }
  await createUsageGuard({ env: ENV, fetchImpl: spy, now: () => NOW, log: quiet }).tick()
  assert.ok(calls.filter((c) => c.url.includes('graphql')).every((c) => c.auth === 'Bearer analytics-token'))
  assert.ok(calls.filter((c) => c.url.endsWith('/revoke')).every((c) => c.auth === 'Bearer turn-token'))
})

test('ignores traffic older than one hour', async () => {
  const cf = fakeCloudflare({
    buckets: [
      { username: 'old', at: '2026-10-31T10:30:00Z', bytes: 50 * GB },
      { username: 'edge', at: '2026-10-31T11:00:00Z', bytes: 2 * GB },
    ],
  })
  await guard({}, cf).tick()
  assert.equal(cf.calls.revoked.length, 0)
})

test('does not revoke the same credential again on every check', async () => {
  const cf = fakeCloudflare({ buckets: [{ username: 'abuser', at: '2026-10-31T11:50:00Z', bytes: 20 * GB }] })
  const g = guard({}, cf)
  await g.tick()
  await g.tick()
  assert.equal(cf.calls.revoked.length, 1)
})

test('forgets old revocations after a few hours', async () => {
  const cf = fakeCloudflare({ buckets: [{ username: 'abuser', at: '2026-10-31T15:50:00Z', bytes: 20 * GB }] })
  let t = NOW
  const g = createUsageGuard({ env: ENV, fetchImpl: cf.fetchImpl, now: () => t, log: quiet })
  await g.tick()
  assert.equal(cf.calls.revoked.length, 1)
  t = NOW + 4 * 3600_000
  await g.tick()
  assert.equal(g.state.revoked, 1) // the old entry was dropped, the new check revoked it again
})

test('the per-credential limit can be switched off', async () => {
  const cf = fakeCloudflare({ buckets: [{ username: 'u', at: '2026-10-31T11:50:00Z', bytes: 100 * GB }] })
  await guard({ CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB: '0' }, cf).tick()
  assert.equal(cf.calls.revoked.length, 0)
  assert.equal(cf.calls.graphql.filter((c) => c.query.includes('username')).length, 0)
})

test('a failed revoke is logged and retried on the next check', async () => {
  const cf = fakeCloudflare({ buckets: [{ username: 'abuser', at: '2026-10-31T11:50:00Z', bytes: 20 * GB }] })
  let fail = true
  const warnings = []
  const fetchImpl = async (url, init) => (url.endsWith('/revoke') && fail ? { ok: false, status: 500 } : cf.fetchImpl(url, init))
  const g = createUsageGuard({ env: ENV, fetchImpl, now: () => NOW, log: { ...quiet, warn: (m) => warnings.push(m) } })
  await g.tick()
  assert.match(warnings.join('\n'), /could not be revoked/)
  assert.equal(g.state.revoked, 0)
  fail = false
  await g.tick()
  assert.equal(cf.calls.revoked.length, 1)
})

test('fails open: an analytics error keeps the last state and is only logged', async () => {
  const ok = fakeCloudflare({ month: 900 * GB })
  let broken = false
  const warnings = []
  const fetchImpl = async (url, init) => (broken ? { ok: false, status: 500, json: async () => ({}) } : ok.fetchImpl(url, init))
  const g = createUsageGuard({
    env: { ...ENV, CLOUDFLARE_MONTHLY_BUDGET_GB: '800' },
    fetchImpl,
    now: () => NOW,
    log: { ...quiet, warn: (m) => warnings.push(m) },
  })
  await g.tick()
  assert.equal(g.exhausted, true)

  broken = true
  await g.tick()
  assert.equal(g.exhausted, true) // unchanged
  assert.match(warnings.join('\n'), /could not read Cloudflare analytics/)
  assert.match(g.state.lastError, /500/)
})

test('GraphQL errors are surfaced in the log, so a wrong token or schema shows up at startup', async () => {
  const warnings = []
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: null, errors: [{ message: 'not authorized' }] }) })
  const g = createUsageGuard({ env: ENV, fetchImpl, now: () => NOW, log: { ...quiet, warn: (m) => warnings.push(m) } })
  await g.tick()
  assert.match(warnings.join('\n'), /GraphQL: not authorized/)
})

test('describe() summarises the effective policy', () => {
  const g = guard({ CLOUDFLARE_MONTHLY_BUDGET_GB: '800', CLOUDFLARE_GUARD_INTERVAL_MIN: '10' }, fakeCloudflare())
  assert.equal(g.describe(), '800 GB/month budget, 8 GB/hour per credential, checked every 10 min')
})

test('LOG_HIDE_SENSITIVE leaves the credential id out of the revoke log, and the credential is still revoked', async () => {
  const cf = fakeCloudflare({
    buckets: [{ username: 'secret-credential-id', at: '2026-10-31T11:50:00Z', bytes: 20 * GB }],
  })
  const warnings = []
  const g = createUsageGuard({
    env: { ...ENV, LOG_HIDE_SENSITIVE: 'true' },
    fetchImpl: cf.fetchImpl,
    now: () => NOW,
    log: { ...quiet, warn: (m) => warnings.push(m) },
  })
  await g.tick()
  const line = warnings.find((m) => m.includes('revoked'))
  assert.equal(line, '[relay] TURN credential revoked: 20.0 GB in the last hour')
  assert.equal(cf.calls.revoked.length, 1)
})

test('the credential id is shown in the revoke log by default', async () => {
  const cf = fakeCloudflare({ buckets: [{ username: 'secret-credential-id', at: '2026-10-31T11:50:00Z', bytes: 20 * GB }] })
  const warnings = []
  const g = createUsageGuard({ env: ENV, fetchImpl: cf.fetchImpl, now: () => NOW, log: { ...quiet, warn: (m) => warnings.push(m) } })
  await g.tick()
  assert.match(warnings.join('\n'), /TURN credential secret-c… revoked/)
})
