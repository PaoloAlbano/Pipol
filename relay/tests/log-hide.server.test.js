// LOG_HIDE_SENSITIVE against the real server: the lines that identify clients are not written at all.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import { startRelay } from './helpers/start-relay.js'

const ROOM = 'quick-room-secret-code'
const PEER = 'peer-abcdef123456'
const CLIENT_IP = '203.0.113.77'
const BASE = { TURN_URLS: 'turn:turn.test:3478', TURN_SECRET: 's', ICE_RATE_LIMIT: '2', TRUST_PROXY_HOPS: '1' }

function iceRequest(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/ice', headers: { 'X-Forwarded-For': CLIENT_IP } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function open(port, path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Produces every kind of log line that carries an identifier. */
async function generateTraffic(port) {
  const signal = await open(port, '/signal')
  signal.send(JSON.stringify({ type: 'join', room: ROOM, peerId: PEER }))
  await sleep(300)
  signal.close() // "left room"
  const dht = await open(port, '/')
  await sleep(200)
  dht.terminate() // "DHT - disconnected"
  for (let i = 0; i < 4; i++) await iceRequest(port) // rate limit hit
  await sleep(500)
}

let shown
let hidden

before(async () => {
  shown = await startRelay(BASE)
  hidden = await startRelay({ ...BASE, LOG_HIDE_SENSITIVE: 'true' })
  await generateTraffic(shown.port)
  await generateTraffic(hidden.port)
})

after(async () => {
  await shown?.stop()
  await hidden?.stop()
})

test('control: by default the log shows the room, the peer, the client IP and the proxy chain', () => {
  const log = shown.output()
  assert.match(log, new RegExp(ROOM))
  assert.match(log, /peer-abc/)
  assert.match(log, new RegExp(`rate limit hit for ${CLIENT_IP.replace(/\./g, '\\.')}`))
  assert.match(log, /DHT \+ connected: [^\s]*127\.0\.0\.1/)
})

test('with LOG_HIDE_SENSITIVE those lines are simply not written', () => {
  const log = hidden.output()
  assert.doesNotMatch(log, /joined room|left room/)
  assert.doesNotMatch(log, /DHT [+-] /)
  assert.doesNotMatch(log, /rate limit hit/)
})

test('with LOG_HIDE_SENSITIVE no room name, peer id or IP appears anywhere in the log', () => {
  const log = hidden.output()
  assert.doesNotMatch(log, new RegExp(ROOM))
  assert.doesNotMatch(log, /peer-abc/)
  assert.doesNotMatch(log, new RegExp(CLIENT_IP.replace(/\./g, '\\.')))
  assert.doesNotMatch(log, /127\.0\.0\.1/)
  assert.doesNotMatch(log, /::1\b/)
})

test('the log says that these details are not logged, and the rest is unchanged', () => {
  const log = hidden.output()
  assert.match(log, /log: client IPs, room names and peer ids are not logged/)
  assert.match(log, /Listening on port/)
  assert.match(log, /\/ice access: /)
})

test('hiding the log does not change how the relay works', async () => {
  const signal = await open(hidden.port, '/signal')
  const reply = new Promise((resolve) => signal.on('message', (m) => resolve(JSON.parse(m))))
  signal.send(JSON.stringify({ type: 'join', room: 'another-room', peerId: 'peer-zzzzzz' }))
  assert.equal((await reply).type, 'joined')
  signal.close()
})
