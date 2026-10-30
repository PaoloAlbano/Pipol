// Smoke/integration tests for relay/server.js, run with the Node built-in test runner.
// The real server is started as a child process on a free port.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import WebSocket from 'ws'

const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STARTUP_TIMEOUT_MS = 30_000
const MESSAGE_TIMEOUT_MS = 3_000

let child
let port
const sockets = new Set()

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address()
      srv.close(() => resolve(p))
    })
  })
}

before(async () => {
  port = await freePort()
  child = spawn(process.execPath, ['server.js'], {
    cwd: relayDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start in time')), STARTUP_TIMEOUT_MS)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`relay exited early (code ${code})`))
    })
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Listening on port')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
})

after(async () => {
  for (const ws of sockets) ws.terminate()
  if (!child) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGINT')
  await exited
})

/** Open a WebSocket on `wsPath` and expose a queue of received JSON messages. */
async function connect(wsPath = '/signal') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`)
  sockets.add(ws)
  const inbox = []
  const waiters = []

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return // the DHT path speaks a binary protocol
    }
    const i = waiters.findIndex((w) => w.match(msg))
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg)
    else inbox.push(msg)
  })

  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  return {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(match = () => true) {
      const i = inbox.findIndex(match)
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve }
        waiters.push(waiter)
        setTimeout(() => {
          const idx = waiters.indexOf(waiter)
          if (idx >= 0) {
            waiters.splice(idx, 1)
            reject(new Error('timed out waiting for message'))
          }
        }, MESSAGE_TIMEOUT_MS)
      })
    },
    /** Resolves true if no message matching `match` shows up shortly. */
    async stays(match, ms = 300) {
      await new Promise((r) => setTimeout(r, ms))
      return !inbox.some(match)
    },
  }
}

async function join(room, peerId) {
  const client = await connect()
  client.send({ type: 'join', room, peerId })
  await client.next((m) => m.type === 'joined')
  return client
}

const ofType = (type) => (m) => m.type === type

test('answers HTTP health checks', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'OK')
})

test('accepts WebSocket upgrades on the DHT relay path', async () => {
  const client = await connect('/')
  assert.equal(client.ws.readyState, WebSocket.OPEN)
})

test('confirms a join and announces peers to each other', async () => {
  const a = await join('room-join', 'peer-a')
  const b = await connect()
  b.send({ type: 'join', room: 'room-join', peerId: 'peer-b' })

  assert.equal((await a.next(ofType('peer-joined'))).peerId, 'peer-b')
  assert.equal((await b.next(ofType('peer-joined'))).peerId, 'peer-a')
  assert.equal((await b.next(ofType('joined'))).peerId, 'peer-b')
})

test('forwards signaling messages to the target peer with the sender id', async () => {
  const a = await join('room-signal', 'peer-a')
  const b = await join('room-signal', 'peer-b')
  const c = await join('room-signal', 'peer-c')

  a.send({ type: 'signal', to: 'peer-b', kind: 'offer', sdp: 'x' })
  const received = await b.next(ofType('signal'))
  assert.equal(received.from, 'peer-a')
  assert.equal(received.sdp, 'x')
  assert.ok(await c.stays(ofType('signal')))
})

test('broadcasts relay-data to everyone but the sender', async () => {
  const a = await join('room-bcast', 'peer-a')
  const b = await join('room-bcast', 'peer-b')
  const c = await join('room-bcast', 'peer-c')

  a.send({ type: 'relay-data', data: { hello: 1 } })
  assert.deepEqual(await b.next(ofType('relay-data')), { type: 'relay-data', from: 'peer-a', data: { hello: 1 } })
  assert.equal((await c.next(ofType('relay-data'))).from, 'peer-a')
  assert.ok(await a.stays(ofType('relay-data')))
})

test('unicasts relay-data-to only to the target', async () => {
  const a = await join('room-uni', 'peer-a')
  const b = await join('room-uni', 'peer-b')
  const c = await join('room-uni', 'peer-c')

  a.send({ type: 'relay-data-to', to: 'peer-c', data: 'psst' })
  assert.deepEqual(await c.next(ofType('relay-data')), { type: 'relay-data', from: 'peer-a', data: 'psst' })
  assert.ok(await b.stays(ofType('relay-data')))
})

test('keeps rooms isolated from each other', async () => {
  const a = await join('room-one', 'peer-a')
  const b = await join('room-two', 'peer-b')

  a.send({ type: 'relay-data', data: 'x' })
  a.send({ type: 'signal', to: 'peer-b', sdp: 'x' })
  assert.ok(await b.stays((m) => m.type === 'relay-data' || m.type === 'signal'))
  assert.ok(await b.stays(ofType('peer-joined')))
})

test('notifies remaining peers when someone leaves', async () => {
  const a = await join('room-leave', 'peer-a')
  const b = await join('room-leave', 'peer-b')
  await a.next(ofType('peer-joined'))

  b.ws.close()
  assert.equal((await a.next(ofType('peer-left'))).peerId, 'peer-b')
})

test('ignores malformed messages and keeps serving', async () => {
  const a = await join('room-bad', 'peer-a')
  a.ws.send('not json')
  a.ws.send(JSON.stringify({ type: 'relay-data' })) // no data: must not crash
  const b = await join('room-bad', 'peer-b')
  a.send({ type: 'relay-data', data: 'still alive' })
  assert.equal((await b.next(ofType('relay-data'))).data, 'still alive')
})
