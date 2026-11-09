// A connection that drops without a goodbye is given time to come back before the room is told the peer left.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { startRelay } from './helpers/start-relay.js'

const GRACE_MS = 700
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let relay
let room = 0

before(async () => {
  relay = await startRelay({ PEER_LEFT_GRACE_MS: String(GRACE_MS) })
})

after(async () => {
  await relay.stop()
})

function join(roomCode, peerId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/signal`)
    ws.messages = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw)
      ws.messages.push(msg)
      if (msg.type === 'joined') resolve(ws)
    })
    ws.once('open', () => ws.send(JSON.stringify({ type: 'join', room: roomCode, peerId })))
    ws.once('error', reject)
  })
}

const told = (ws, peerId) => ws.messages.some((m) => m.type === 'peer-left' && m.peerId === peerId)
const closed = (ws) => new Promise((resolve) => ws.once('close', resolve))

async function pair() {
  const code = `grace-room-${room++}`
  const a = await join(code, 'peer-a')
  const b = await join(code, 'peer-b')
  return { code, a, b }
}

test('does not tell the room right away when a connection drops', async () => {
  const { a, b } = await pair()
  b.terminate()
  await sleep(GRACE_MS / 3)
  assert.equal(told(a, 'peer-b'), false)
  a.close()
})

test('tells the room once the wait is over and the peer did not come back', async () => {
  const { a, b } = await pair()
  b.terminate()
  await sleep(GRACE_MS + 400)
  assert.equal(told(a, 'peer-b'), true)
  a.close()
})

test('says nothing when the peer comes back in time, and routes to the new connection', async () => {
  const { code, a, b } = await pair()
  b.terminate()
  await sleep(GRACE_MS / 3)
  const back = await join(code, 'peer-b')

  await sleep(GRACE_MS + 400)
  assert.equal(told(a, 'peer-b'), false)

  a.send(JSON.stringify({ type: 'relay-data-to', to: 'peer-b', data: 'x' }))
  await sleep(200)
  assert.ok(back.messages.some((m) => m.type === 'relay-data' && m.data === 'x'))
  a.close()
  back.close()
})

test('tells the room at once when the peer leaves on purpose', async () => {
  const { a, b } = await pair()
  b.send(JSON.stringify({ type: 'leave' }))
  b.close()
  await closed(b)
  await sleep(150)
  assert.equal(told(a, 'peer-b'), true)
  a.close()
})
