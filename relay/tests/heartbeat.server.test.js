// Heartbeat, slow-client cutoff and the optional stats line of the signaling WebSocket.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { startRelay } from './helpers/start-relay.js'

const ROOM = 'heartbeat-secret-room'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function join(port, peerId, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`, options)
    ws.messages = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw)
      ws.messages.push(msg)
      if (msg.type === 'joined') resolve(ws)
    })
    ws.once('open', () => ws.send(JSON.stringify({ type: 'join', room: ROOM, peerId })))
    ws.once('error', reject)
  })
}

let relay

before(async () => {
  relay = await startRelay({
    PEER_LEFT_GRACE_MS: '0',
    HEARTBEAT_INTERVAL_MS: '200',
    MAX_CLIENT_BUFFER_MB: '1',
    RELAY_STATS_INTERVAL_SEC: '1',
  })
})

after(async () => {
  await relay.stop()
})

test('pings clients, and a client that answers stays connected', async () => {
  const ws = await join(relay.port, 'alive-peer')
  let pings = 0
  ws.on('ping', () => pings++)
  await sleep(1100)
  assert.equal(ws.readyState, WebSocket.OPEN)
  assert.ok(pings >= 3, `expected several pings, got ${pings}`)
  ws.close()
})

test('drops a client that stops answering and tells the rest of the room', async () => {
  const watcher = await join(relay.port, 'watcher-peer')
  const silent = await join(relay.port, 'silent-peer', { autoPong: false })
  const closed = new Promise((resolve) => silent.once('close', resolve))

  await Promise.race([closed, sleep(3000).then(() => assert.fail('the silent client was not dropped'))])
  await sleep(100)
  assert.ok(
    watcher.messages.some((m) => m.type === 'peer-left' && m.peerId === 'silent-peer'),
    'the room was not told that the peer left'
  )
  watcher.close()
})

test('cuts off a client that cannot keep up instead of buffering for it forever', async () => {
  // Its own relay: a long heartbeat, so that it is the buffer limit that cuts the client off, not silence
  const slowRelay = await startRelay({
    HEARTBEAT_INTERVAL_MS: '600000',
    MAX_CLIENT_BUFFER_MB: '1',
    RELAY_STATS_INTERVAL_SEC: '1',
  })
  try {
    const sender = await join(slowRelay.port, 'fast-peer')
    const slow = await join(slowRelay.port, 'slow-peer')
    slow._socket.pause() // it stops reading: what the relay sends piles up

    const chunk = 'A'.repeat(1024 * 1024)
    for (let i = 0; i < 80 && sender.readyState === WebSocket.OPEN; i++) {
      sender.send(JSON.stringify({ type: 'relay-data', data: { c: chunk } }))
      await sleep(10)
    }
    await sleep(1500) // a stats line

    const line = slowRelay.output().split('\n').filter((l) => l.includes('[relay] stats:')).pop()
    assert.match(line, /connections=1 /, 'only the sender should be left')
    assert.match(line, /slowClientsClosed=1/, 'the cut-off client should be counted')
    assert.equal(sender.readyState, WebSocket.OPEN, 'the sender must not be affected')
    sender.close()
  } finally {
    await slowRelay.stop()
  }
})

test('writes a stats line with the load and without identifiers', async () => {
  await sleep(1300)
  const line = relay.output().split('\n').filter((l) => l.includes('[relay] stats:')).pop()
  assert.ok(line, 'no stats line was written')
  assert.match(line, /connections=\d+ rooms=\d+ rss=\d+MB heap=\d+MB slowClientsClosed=0/)
  assert.ok(!line.includes(ROOM), 'the stats line must not name rooms')
})
