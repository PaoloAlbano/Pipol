#!/usr/bin/env node
/**
 * Stress test for the relay (WebSocket /signal): how many connections, rooms and messages it holds.
 *
 * It simulates peers at the protocol level (the relay only forwards opaque payloads, so the payloads here are
 * fake sealed envelopes), which scales far beyond what real browsers could. Every scenario ramps up in stages
 * and stops at the first stage that breaks a limit (see STOP below), so it finds the edge without running over it.
 *
 *   node relay/stress/stress.js --url ws://localhost:8787
 *   node relay/stress/stress.js --url wss://relay.example.com --yes --scenario conns
 *
 * Scenarios: conns (idle connections), fanout (room size and message rate), bigroom (one big room, run it on its
 * own with a larger --max-room), rooms (many 1:1 chats), payload (5 MB image transfers), churn (joins per second),
 * all (every scenario except bigroom).
 *
 * Not part of the relay image or of CI. Do not point it at a server you do not run.
 */

import { WebSocket } from 'ws'
import dns from 'node:dns'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: opts } = parseArgs({
  options: {
    url: { type: 'string' }, // ws://host:port or wss://host
    scenario: { type: 'string', default: 'all' },
    yes: { type: 'boolean', default: false }, // required for anything that is not localhost
    rate: { type: 'string', default: '40' }, // new connections per second, at most
    hold: { type: 'string', default: '8' }, // seconds each stage lasts
    'max-conns': { type: 'string', default: '1000' },
    'max-room': { type: 'string', default: '50' },
    'max-rooms': { type: 'string', default: '500' },
    'max-transfers': { type: 'string', default: '25' },
    out: { type: 'string' }, // write the results as JSON
  },
})

// A stage that goes past any of these is where the limit is: the scenario stops there.
const STOP = {
  failedConnections: 0.05, // more than 5% of the connections of the stage failed
  joinP95Ms: 5000,
  deliveryBelow: 0.95, // less than 95% of the messages arrived
  latencyP95Ms: 3000,
  probeFailures: 3, // the health check failed this many times in a row
}

const RATE = Number(opts.rate)
const HOLD_MS = Number(opts.hold) * 1000
const RUN = randomBytes(3).toString('hex')

if (!opts.url) {
  console.error('Usage: node relay/stress/stress.js --url <ws://host:port|wss://host> [--yes] [--scenario all]')
  process.exit(1)
}
const target = new URL(opts.url)
const WS_BASE = `${target.protocol}//${target.host}`
const HTTP_BASE = `${target.protocol === 'wss:' ? 'https:' : 'http:'}//${target.host}`
const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname)
if (!isLocal && !opts.yes) {
  console.error(`${target.host} is not local. Add --yes to confirm that you run it and want to load it.`)
  process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rand = (bytes) => randomBytes(bytes).toString('hex')
const round = (n) => Math.round(n * 10) / 10

function summarize(values) {
  if (values.length === 0) return { n: 0, p50: null, p95: null, p99: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))])
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted[sorted.length - 1]) }
}

// Every connection would otherwise do its own DNS lookup, which at hundreds of connections per second can
// exhaust the resolver or the router and look like the server dropping clients. One lookup per name is enough.
const dnsCache = new Map()
function cachedLookup(hostname, options, callback) {
  const key = `${hostname}|${options.all ? 'all' : 'one'}|${options.family ?? 0}`
  const hit = dnsCache.get(key)
  if (hit) return process.nextTick(() => callback(null, ...hit))
  dns.lookup(hostname, options, (err, ...rest) => {
    if (!err) dnsCache.set(key, rest)
    callback(err, ...rest)
  })
}

const payloadCache = new Map()
function payload(size) {
  if (!payloadCache.has(size)) payloadCache.set(size, 'A'.repeat(size))
  return payloadCache.get(size)
}

class Peer {
  constructor(room) {
    this.room = room
    this.id = rand(32)
    this.ws = null
    this.open = false
    this.dropped = false // the connection was lost while we were using it
    this.droppedAt = 0
    this.closing = false
    this.sent = 0
    this.received = 0
    this.bytes = 0
    this.latencies = []
    this.timer = null
  }

  /** Opens the socket and joins the room. @returns {Promise<{ ok: boolean, ms: number, error?: string }>} */
  connect(timeoutMs = 10000) {
    return new Promise((resolve) => {
      const started = performance.now()
      let done = false
      const finish = (ok, error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ ok, ms: performance.now() - started, error })
      }
      const ws = new WebSocket(`${WS_BASE}/signal`, { lookup: cachedLookup })
      this.ws = ws
      const timer = setTimeout(() => {
        ws.terminate()
        finish(false, 'timeout')
      }, timeoutMs)
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room: this.room, peerId: this.id })))
      ws.on('message', (raw) => {
        let msg
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }
        if (msg.type === 'joined') {
          this.open = true
          finish(true)
        } else if (msg.type === 'relay-data') {
          this.received++
          this.bytes += raw.length
          if (msg.data?.t) this.latencies.push(Date.now() - msg.data.t)
        }
      })
      ws.on('error', (err) => finish(false, err.code || err.message))
      ws.on('close', (code, reason) => {
        if (this.open && !this.closing) {
          this.dropped = true
          this.droppedAt = Date.now()
          this.closeInfo = `${code}${reason?.length ? ` ${String(reason)}` : ''}`
        }
        this.open = false
        finish(false, 'closed')
      })
    })
  }

  /** Broadcasts a payload of about `size` bytes to the rest of the room. */
  send(size) {
    if (!this.open || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ type: 'relay-data', data: { v: 1, n: 'nonce', c: payload(size), t: Date.now() } }))
    this.sent++
    return true
  }

  close() {
    this.closing = true
    clearInterval(this.timer)
    this.ws?.terminate()
  }
}

/** Connects peers at most `perSecond` per second. @returns {Promise<object[]>} one result per peer */
async function connectPeers(peers, perSecond = RATE, onResult = () => {}) {
  const results = []
  const pending = new Set()
  for (const peer of peers) {
    const job = peer.connect().then((result) => {
      results.push(result)
      onResult(peer, result)
      pending.delete(job)
    })
    pending.add(job)
    if (pending.size >= 200) await Promise.race(pending)
    await sleep(1000 / perSecond)
  }
  await Promise.all(pending)
  return results
}

/** Pings GET / once a second: if the relay gets slow or unreachable under load this shows it. */
function startProbe() {
  let samples = []
  let failures = 0
  let consecutive = 0
  let running = true
  const loop = (async () => {
    while (running) {
      const started = performance.now()
      try {
        const res = await fetch(`${HTTP_BASE}/`, { signal: AbortSignal.timeout(4000) })
        if (!res.ok) throw new Error(String(res.status))
        samples.push(performance.now() - started)
        consecutive = 0
      } catch {
        failures++
        consecutive++
      }
      await sleep(1000)
    }
  })()
  return {
    /** Statistics since the last call. */
    take() {
      const taken = { ...summarize(samples), failures, consecutive }
      samples = []
      failures = 0
      return taken
    },
    stop: async () => {
      running = false
      await loop
    },
  }
}

const results = {}
const stopped = {}

function report(scenario, row) {
  ;(results[scenario] ??= []).push(row)
  console.log(`  ${JSON.stringify(row)}`)
}

function limitHit(scenario, stage, reason) {
  stopped[scenario] = { stage, reason }
  console.log(`  ✋ limit reached at ${stage}: ${reason}`)
}

const health = (h) => ({ p50: h.p50, max: h.max, failures: h.failures })

/**
 * When connections were lost: all in the same second (something cut them together: a proxy, a restart, the
 * network) or spread out (single connections timing out).
 */
function dropTiming(peers) {
  const perSecond = new Map()
  for (const peer of peers) {
    if (!peer.dropped) continue
    const second = Math.floor(peer.droppedAt / 1000)
    perSecond.set(second, (perSecond.get(second) ?? 0) + 1)
  }
  const counts = [...perSecond.values()]
  return { seconds: counts.length, biggestSecond: Math.max(0, ...counts) }
}

/** Why connections were lost: close code (1006 = no close frame, so the network or a proxy cut it; 1001/1012 = the server). */
function lostReasons(peers) {
  const tally = {}
  for (const peer of peers) if (peer.dropped) tally[peer.closeInfo] = (tally[peer.closeInfo] ?? 0) + 1
  return tally
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

/** Idle connections, in pairs of peers in a room, added in stages. */
async function scenarioConns(probe) {
  const peers = []
  const stages = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 40000].filter((n) => n <= Number(opts['max-conns']))
  for (const total of stages) {
    const batch = []
    while (peers.length + batch.length < total) {
      batch.push(new Peer(`stress-${RUN}-c${Math.floor((peers.length + batch.length) / 2)}`))
    }
    probe.take()
    const outcome = await connectPeers(batch)
    peers.push(...batch)
    await sleep(HOLD_MS)

    const ok = outcome.filter((r) => r.ok)
    const failedRate = (outcome.length - ok.length) / outcome.length
    const errors = [...new Set(outcome.filter((r) => !r.ok).map((r) => r.error))]
    const join = summarize(ok.map((r) => r.ms))
    const h = probe.take()
    report('conns', {
      connections: total,
      open: peers.filter((p) => p.open).length,
      failed: outcome.length - ok.length,
      lost: peers.filter((p) => p.dropped).length,
      ...(peers.some((p) => p.dropped) ? { lostReasons: lostReasons(peers), lostTiming: dropTiming(peers) } : {}),
      joinMs: join,
      healthMs: health(h),
      ...(errors.length ? { errors } : {}),
    })
    if (failedRate > STOP.failedConnections) {
      peers.forEach((p) => p.close())
      return limitHit('conns', total, `${round(failedRate * 100)}% of the connections failed`)
    }
    if (join.p95 > STOP.joinP95Ms) {
      peers.forEach((p) => p.close())
      return limitHit('conns', total, `joining takes ${join.p95} ms (p95)`)
    }
    if (h.consecutive >= STOP.probeFailures) {
      peers.forEach((p) => p.close())
      return limitHit('conns', total, 'the health check stopped answering')
    }
  }
  peers.forEach((p) => p.close())
}

/**
 * `rooms` rooms of `size` peers, each peer sending `rate` messages per second of `bytes` bytes.
 * @returns {Promise<{ reason: string|null, row: object }>}
 */
async function chatStage({ rooms, size, rate, bytes, seconds }, probe) {
  const peers = []
  for (let r = 0; r < rooms; r++) {
    for (let i = 0; i < size; i++) peers.push(new Peer(`stress-${RUN}-r${r}-${size}-${rate}`))
  }
  probe.take()
  const outcome = await connectPeers(peers)
  const failed = outcome.filter((r) => !r.ok).length
  await sleep(500)

  for (const peer of peers) {
    setTimeout(
      () => {
        peer.timer = setInterval(() => peer.send(bytes), 1000 / rate)
      },
      Math.random() * (1000 / rate)
    )
  }
  await sleep(seconds * 1000)
  peers.forEach((p) => clearInterval(p.timer))
  await sleep(2500) // let the last messages arrive

  const sent = peers.reduce((n, p) => n + p.sent, 0)
  const received = peers.reduce((n, p) => n + p.received, 0)
  const expected = sent * (size - 1)
  const delivery = expected ? received / expected : 1
  const latency = summarize(peers.flatMap((p) => p.latencies))
  const h = probe.take()
  const lost = peers.filter((p) => p.dropped).length
  peers.forEach((p) => p.close())
  await sleep(500)

  const row = {
    rooms,
    peersPerRoom: size,
    msgPerSecPerPeer: round(rate),
    bytes,
    connections: peers.length,
    failedConnections: failed,
    lostConnections: lost,
    ...(lost ? { lostReasons: lostReasons(peers), lostTiming: dropTiming(peers) } : {}),
    sentPerSec: round(sent / seconds),
    deliveredPerSec: round(received / seconds),
    delivery: Math.round(delivery * 1000) / 1000,
    latencyMs: latency,
    healthMs: health(h),
  }
  const reason =
    failed / peers.length > STOP.failedConnections
      ? `${failed} connections failed`
      : delivery < STOP.deliveryBelow
        ? `only ${round(delivery * 100)}% of the messages arrived`
        : latency.p95 > STOP.latencyP95Ms
          ? `message latency p95 is ${latency.p95} ms`
          : h.consecutive >= STOP.probeFailures
            ? 'the health check stopped answering'
            : null
  return { reason, row }
}

/** One room that grows (2…50 peers), then a growing message rate in a room of 10. */
async function scenarioFanout(probe) {
  const maxRoom = Number(opts['max-room'])
  const seconds = HOLD_MS / 1000
  for (const size of [2, 5, 10, 25, 50].filter((n) => n <= maxRoom)) {
    const { reason, row } = await chatStage({ rooms: 1, size, rate: 1, bytes: 1024, seconds }, probe)
    report('fanout', row)
    if (reason) return limitHit('fanout', `${size} peers in a room`, reason)
  }
  for (const rate of [5, 20, 50]) {
    const { reason, row } = await chatStage({ rooms: 1, size: 10, rate, bytes: 1024, seconds }, probe)
    report('fanout', row)
    if (reason) return limitHit('fanout', `${rate} msg/s per peer in a room of 10`, reason)
  }
}

/** Many people in ONE room, each writing a message every 5 seconds on average: how big can a room get? */
async function scenarioBigRoom(probe) {
  const seconds = Math.max(HOLD_MS / 1000, 15)
  for (const size of [10, 25, 50, 100, 200, 300, 500, 750].filter((n) => n <= Number(opts['max-room']))) {
    const { reason, row } = await chatStage({ rooms: 1, size, rate: 0.2, bytes: 512, seconds }, probe)
    report('bigroom', row)
    if (reason) return limitHit('bigroom', `${size} people in a room`, reason)
  }
}

/** Many 1:1 conversations at once, each peer writing a message every 3 seconds. */
async function scenarioRooms(probe) {
  const seconds = HOLD_MS / 1000 + 4
  for (const rooms of [50, 100, 250, 500, 1000].filter((n) => n <= Number(opts['max-rooms']))) {
    const { reason, row } = await chatStage({ rooms, size: 2, rate: 1 / 3, bytes: 512, seconds }, probe)
    report('rooms', row)
    if (reason) return limitHit('rooms', `${rooms} conversations`, reason)
  }
}

/** Image transfers: 110 chunks of 48 KB (about 5 MB) between two peers, several at the same time. */
async function scenarioPayload(probe) {
  const CHUNKS = 110
  const CHUNK_BYTES = 48 * 1024
  for (const transfers of [1, 5, 10, 25, 50].filter((n) => n <= Number(opts['max-transfers']))) {
    const pairs = Array.from({ length: transfers }, (_, i) => [
      new Peer(`stress-${RUN}-f${transfers}-${i}`),
      new Peer(`stress-${RUN}-f${transfers}-${i}`),
    ])
    probe.take()
    const outcome = await connectPeers(pairs.flat())
    const failed = outcome.filter((r) => !r.ok).length

    const started = performance.now()
    await Promise.all(
      pairs.map(async ([sender, receiver]) => {
        for (let i = 0; i < CHUNKS && sender.open; i++) {
          while (sender.ws.bufferedAmount > 1_000_000) await sleep(5)
          sender.send(CHUNK_BYTES)
        }
        const deadline = performance.now() + 60000
        while (receiver.received < CHUNKS && performance.now() < deadline) await sleep(50)
      })
    )
    const seconds = (performance.now() - started) / 1000
    const delivered = pairs.reduce((n, [, receiver]) => n + receiver.received, 0)
    const complete = pairs.filter(([, receiver]) => receiver.received >= CHUNKS).length
    const megabytes = pairs.reduce((n, [, receiver]) => n + receiver.bytes, 0) / 1024 / 1024
    const latency = summarize(pairs.flatMap(([, receiver]) => receiver.latencies))
    const h = probe.take()
    pairs.flat().forEach((p) => p.close())
    await sleep(500)

    report('payload', {
      simultaneousTransfers: transfers,
      completeTransfers: complete,
      failedConnections: failed,
      seconds: round(seconds),
      megabytesPerSec: round(megabytes / seconds),
      chunkLatencyMs: latency,
      chunksDelivered: `${delivered}/${transfers * CHUNKS}`,
      healthMs: health(h),
    })
    if (complete < transfers) {
      return limitHit('payload', `${transfers} transfers`, `${transfers - complete} did not complete`)
    }
    if (h.consecutive >= STOP.probeFailures) {
      return limitHit('payload', `${transfers} transfers`, 'the health check stopped answering')
    }
  }
}

/** Joins per second: every client connects, joins its own room and leaves half a second later. */
async function scenarioChurn(probe) {
  for (const perSecond of [10, 25, 50, 100]) {
    const total = perSecond * (HOLD_MS / 1000)
    const peers = Array.from({ length: total }, (_, i) => new Peer(`stress-${RUN}-j${perSecond}-${i}`))
    probe.take()
    const outcome = await connectPeers(peers, perSecond, (peer, result) => {
      if (result.ok) setTimeout(() => peer.close(), 500)
    })
    await sleep(1000)
    const ok = outcome.filter((r) => r.ok)
    const failedRate = (outcome.length - ok.length) / outcome.length
    const join = summarize(ok.map((r) => r.ms))
    const h = probe.take()
    peers.forEach((p) => p.close())
    report('churn', {
      joinsPerSec: perSecond,
      joins: total,
      failed: outcome.length - ok.length,
      joinMs: join,
      healthMs: health(h),
    })
    if (failedRate > STOP.failedConnections) {
      return limitHit('churn', `${perSecond} joins/s`, `${round(failedRate * 100)}% of the joins failed`)
    }
    if (join.p95 > STOP.joinP95Ms) {
      return limitHit('churn', `${perSecond} joins/s`, `joining takes ${join.p95} ms (p95)`)
    }
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

const SCENARIOS = {
  conns: scenarioConns,
  fanout: scenarioFanout,
  bigroom: scenarioBigRoom,
  rooms: scenarioRooms,
  payload: scenarioPayload,
  churn: scenarioChurn,
}

// `bigroom` is not part of "all": it only makes sense with a larger --max-room
const selected =
  opts.scenario === 'all' ? Object.keys(SCENARIOS).filter((n) => n !== 'bigroom') : opts.scenario.split(',')
for (const name of selected) {
  if (!SCENARIOS[name]) {
    console.error(`Unknown scenario "${name}". Choose from: ${Object.keys(SCENARIOS).join(', ')}, all`)
    process.exit(1)
  }
}

console.log(`Stress test of ${target.host} (run ${RUN}), scenarios: ${selected.join(', ')}`)
const probe = startProbe()
await sleep(1500)
const first = probe.take()
if (first.failures > 0 && first.n === 0) {
  console.error(`The health check of ${HTTP_BASE}/ does not answer: is the relay up?`)
  await probe.stop()
  process.exit(1)
}

for (const name of selected) {
  console.log(`\n▶ ${name}`)
  await SCENARIOS[name](probe)
  await sleep(3000) // let the relay settle between scenarios
}
await probe.stop()

console.log('\n── Summary ──')
for (const name of selected) {
  console.log(
    stopped[name] ? `${name}: limit at ${stopped[name].stage} (${stopped[name].reason})` : `${name}: no limit reached`
  )
}
if (opts.out) {
  writeFileSync(opts.out, JSON.stringify({ target: target.host, run: RUN, stopped, results }, null, 2))
  console.log(`Results written to ${opts.out}`)
}
process.exit(0)
