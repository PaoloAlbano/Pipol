// Usage guard for Cloudflare Realtime TURN.
//
// Credentials cannot be kept secret from the browser, so whoever holds valid ones can relay traffic until
// they expire. This guard bounds the damage using Cloudflare's own usage analytics (GraphQL):
//
//   - a credential that relayed more than CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB in the last hour is revoked;
//   - once the month's egress reaches CLOUDFLARE_MONTHLY_BUDGET_GB, /ice stops issuing credentials (clients fall
//     back to public STUN). Credentials already issued stay valid until they expire (TURN_TTL, 1 hour).
//
// It needs the relay to mint a separate credential per /ice request (the cloudflare provider does), so
// that usage can be attributed to a single credential.
//
//   CLOUDFLARE_ACCOUNT_ID             Cloudflare account id
//   CLOUDFLARE_ANALYTICS_TOKEN        API token with the "Account Analytics" read permission (a *different* token
//                             from the TURN key's: that one is CLOUDFLARE_TURN_API_TOKEN)
//   CLOUDFLARE_MONTHLY_BUDGET_GB    Stop issuing at this egress (decimal GB). Unset = no budget stop.
//   CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB Revoke a credential above this per hour (default 8, 0 disables)
//   CLOUDFLARE_GUARD_INTERVAL_MIN   How often to check (default 5)
//   CLOUDFLARE_GRAPHQL_URL, CLOUDFLARE_TURN_API_URL  Overrides of the Cloudflare endpoints (tests only)
//
// If Cloudflare cannot be queried the guard keeps its last known state and logs: it never takes
// the endpoint down by itself.

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'
const TURN_API_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys'
const GB = 1e9
const HOUR_MS = 60 * 60 * 1000
const FORGET_REVOKED_MS = 3 * HOUR_MS

const USAGE_BY_KEY = `
query ($accountId: string, $keyId: string, $from: Date, $to: Date) {
  viewer {
    accounts(filter: { accountTag: $accountId }) {
      callsTurnUsageAdaptiveGroups(limit: 10000, filter: { keyId: $keyId, date_geq: $from, date_leq: $to }) {
        dimensions { keyId }
        sum { egressBytes }
      }
    }
  }
}`

const USAGE_BY_USERNAME = `
query ($accountId: string, $keyId: string, $from: Date, $to: Date) {
  viewer {
    accounts(filter: { accountTag: $accountId }) {
      callsTurnUsageAdaptiveGroups(limit: 10000, filter: { keyId: $keyId, date_geq: $from, date_leq: $to }) {
        dimensions { username datetimeFiveMinutes }
        sum { egressBytes }
      }
    }
  }
}`

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10)

export function createUsageGuard({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = console,
} = {}) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const analyticsToken = env.CLOUDFLARE_ANALYTICS_TOKEN
  const keyId = env.CLOUDFLARE_TURN_KEY_ID
  const turnToken = env.CLOUDFLARE_TURN_API_TOKEN
  const graphqlUrl = env.CLOUDFLARE_GRAPHQL_URL || GRAPHQL_URL
  const turnApiUrl = env.CLOUDFLARE_TURN_API_URL || TURN_API_URL

  const budgetGb = env.CLOUDFLARE_MONTHLY_BUDGET_GB ? Number(env.CLOUDFLARE_MONTHLY_BUDGET_GB) : 0
  const hourlyLimitGb = env.CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB === undefined || env.CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB === '' ? 8 : Number(env.CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB)
  const intervalMin = Number(env.CLOUDFLARE_GUARD_INTERVAL_MIN) > 0 ? Number(env.CLOUDFLARE_GUARD_INTERVAL_MIN) : 5

  const hideSensitive = env.LOG_HIDE_SENSITIVE === 'true' // do not log credential ids
  const enabled = Boolean(accountId && analyticsToken && keyId && turnToken)

  const state = { exhausted: false, monthBytes: null, lastCheckAt: null, lastError: null }
  const revoked = new Map() // username → time of revocation
  let timer = null

  async function graphql(query, variables) {
    const res = await fetchImpl(graphqlUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${analyticsToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { accountId, keyId, ...variables } }),
    })
    if (!res.ok) throw new Error(`GraphQL responded ${res.status}`)
    const body = await res.json()
    if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`)
    return body.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups ?? []
  }

  async function revoke(username) {
    const res = await fetchImpl(`${turnApiUrl}/${keyId}/credentials/${encodeURIComponent(username)}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${turnToken}` },
    })
    if (!res.ok) throw new Error(`revoke responded ${res.status}`)
  }

  async function checkMonth(t) {
    const groups = await graphql(USAGE_BY_KEY, { from: isoDate(new Date(t).setUTCDate(1)), to: isoDate(t) })
    state.monthBytes = groups.reduce((sum, g) => sum + (g.sum?.egressBytes ?? 0), 0)
    const wasExhausted = state.exhausted
    state.exhausted = budgetGb > 0 && state.monthBytes >= budgetGb * GB
    if (state.exhausted && !wasExhausted) {
      log.warn(`[relay] TURN budget reached (${(state.monthBytes / GB).toFixed(1)} GB of ${budgetGb} GB): /ice now issues no credentials`)
    }
    if (!state.exhausted && wasExhausted) log.info('[relay] TURN usage is back under the monthly budget: /ice issues credentials again')
  }

  async function checkCredentials(t) {
    if (hourlyLimitGb <= 0) return
    // The analytics filter works on whole days: ask for yesterday and today, then keep the last hour
    const groups = await graphql(USAGE_BY_USERNAME, { from: isoDate(t - 24 * HOUR_MS), to: isoDate(t) })
    const lastHour = new Map()
    for (const g of groups) {
      const username = g.dimensions?.username
      const bucket = Date.parse(g.dimensions?.datetimeFiveMinutes ?? '')
      if (!username || Number.isNaN(bucket) || bucket < t - HOUR_MS) continue
      lastHour.set(username, (lastHour.get(username) ?? 0) + (g.sum?.egressBytes ?? 0))
    }

    for (const [username, at] of revoked) if (t - at > FORGET_REVOKED_MS) revoked.delete(username)

    for (const [username, bytes] of lastHour) {
      if (bytes < hourlyLimitGb * GB || revoked.has(username)) continue
      try {
        await revoke(username)
        revoked.set(username, t)
        log.warn(`[relay] TURN credential ${hideSensitive ? '' : `${username.slice(0, 8)}… `}revoked: ${(bytes / GB).toFixed(1)} GB in the last hour`)
      } catch (err) {
        log.warn(`[relay] TURN credential ${hideSensitive ? '' : `${username.slice(0, 8)}… `}could not be revoked: ${err.message}`)
      }
    }
  }

  async function tick() {
    if (!enabled) return state
    const t = now()
    try {
      await checkMonth(t)
      await checkCredentials(t)
      state.lastError = null
    } catch (err) {
      state.lastError = err.message
      log.warn(`[relay] TURN usage guard could not read Cloudflare analytics: ${err.message}`)
    }
    state.lastCheckAt = t
    return state
  }

  return {
    enabled,
    /** True when the monthly budget is used up and /ice must stop issuing credentials. */
    get exhausted() {
      return state.exhausted
    },
    get state() {
      return { ...state, revoked: revoked.size }
    },
    describe() {
      if (!enabled) return 'disabled (set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN to enable)'
      const budget = budgetGb > 0 ? `${budgetGb} GB/month budget` : 'no monthly budget'
      const limit = hourlyLimitGb > 0 ? `${hourlyLimitGb} GB/hour per credential` : 'no per-credential limit'
      return `${budget}, ${limit}, checked every ${intervalMin} min`
    },
    tick,
    /** Runs a first check right away (so a bad token shows up in the log at startup), then every few minutes. */
    start() {
      if (!enabled || timer) return
      tick().then((s) => {
        if (!s.lastError) log.info(`[relay] TURN usage this month: ${((s.monthBytes ?? 0) / GB).toFixed(2)} GB`)
      })
      timer = setInterval(tick, intervalMin * 60_000)
      timer.unref?.()
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
  }
}
