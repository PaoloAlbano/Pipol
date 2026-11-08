/**
 * swarm.outbox.test.js
 * Signaling that cannot leave because the relay connection is down is kept, and sent when it is back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RoomSwarm, OUTBOX_TTL_MS, OUTBOX_MAX } from '../../src/p2p/swarm.js'
import { RelayCipher } from '../../src/p2p/relay-crypto.js'

vi.mock('../../src/p2p/storage.js', () => ({
  getIdentity: () => ({ publicKey: new Uint8Array([1, 2, 3, 4]), secretKey: new Uint8Array(8), username: 'me' }),
  getRelayUrl: () => 'wss://relay.example.com',
  getIceSettings: () => ({ mode: 'default', servers: [], forceRelay: false, chatTurn: false }),
}))

const KEY = new Uint8Array(32).fill(5)
const ROOM = 'workspace-topic'
const ME = '1'.repeat(64)
const ALICE = 'a'.repeat(64)

function makeSwarm() {
  const swarm = new RoomSwarm(ROOM, { relayKey: KEY })
  swarm._localPeerId = ME
  swarm._relayRoom = ROOM
  swarm._ws = { readyState: 1, send: vi.fn() }
  const opener = new RelayCipher(KEY, ROOM)
  // What went out through the current connection, opened
  const sent = () =>
    swarm._ws.send.mock.calls.map(([raw]) => {
      const frame = JSON.parse(raw)
      return {
        frame,
        payload:
          opener.open(frame.signal ?? frame.data, ME, ALICE) ?? opener.open(frame.signal ?? frame.data, ME, null),
      }
    })
  const setConnection = (readyState) => (swarm._ws = { readyState, send: vi.fn() })
  return { swarm, sent, setConnection }
}

const offline = (swarm) => (swarm._ws = { readyState: 3, send: vi.fn(), close: vi.fn() })

describe('RoomSwarm — signaling kept while the relay connection is down', () => {
  it('keeps the signaling of a call and sends it, in order, once the connection is back', () => {
    const { swarm, sent, setConnection } = makeSwarm()
    offline(swarm)

    swarm.sendToPeer(ALICE, { type: 'VIDEO_ANSWER', sdp: 'answer' })
    swarm.sendToPeer(ALICE, { type: 'VIDEO_ICE', candidate: 'c1' })
    swarm.sendToPeer(ALICE, { type: 'VIDEO_ICE', candidate: 'c2' })
    expect(swarm._outbox).toHaveLength(3)

    setConnection(1)
    swarm._flushOutbox()

    const out = sent() // opened once: a sealed message cannot be opened twice
    expect(out.map((s) => s.payload.type)).toEqual(['VIDEO_ANSWER', 'VIDEO_ICE', 'VIDEO_ICE'])
    expect(out.map((s) => s.payload.candidate ?? s.payload.sdp)).toEqual(['answer', 'c1', 'c2'])
    expect(swarm._outbox).toHaveLength(0)
  })

  it('keeps every kind of call message, to one peer or to all', () => {
    const { swarm } = makeSwarm()
    offline(swarm)
    const types = [
      'VIDEO_OFFER',
      'VIDEO_ANSWER',
      'VIDEO_ICE',
      'CALL_INIT',
      'CALL_END',
      'SCREEN_SHARE_START',
      'SCREEN_SHARE_END',
      'VIDEO_STATE',
    ]
    for (const type of types) swarm.sendToPeer(ALICE, { type })
    swarm.sendToAll({ type: 'CALL_INIT' })
    expect(swarm._outbox).toHaveLength(types.length + 1)
  })

  it('keeps the signaling of the chat connection too (SDP and ICE of the data channel)', () => {
    const { swarm, setConnection, sent } = makeSwarm()
    offline(swarm)
    swarm._sendSignal(ALICE, { type: 'offer', sdp: { sdp: 'x' } })
    swarm._sendSignal(ALICE, { type: 'ice', candidate: 'c' })
    expect(swarm._outbox).toHaveLength(2)

    setConnection(1)
    swarm._flushOutbox()
    const out = sent()
    expect(out.map((s) => s.frame.type)).toEqual(['signal', 'signal'])
    expect(out.map((s) => s.frame.to)).toEqual([ALICE, ALICE])
  })

  it('does not keep chat messages, which are synced again when the peer is seen', () => {
    const { swarm } = makeSwarm()
    offline(swarm)
    swarm.sendToPeer(ALICE, { type: 'MSG', message: { id: '1' } })
    swarm.sendToAll({ type: 'TYPING', username: 'me' })
    swarm.sendToPeer(ALICE, { type: 'HISTORY_REQ' })
    expect(swarm._outbox).toHaveLength(0)
  })

  it('sends at once, keeping nothing, while the connection is up', () => {
    const { swarm, sent } = makeSwarm()
    swarm.sendToPeer(ALICE, { type: 'VIDEO_ANSWER', sdp: 'a' })
    expect(sent()).toHaveLength(1)
    expect(swarm._outbox).toHaveLength(0)
  })

  it('does not send over the relay what went through an open data channel', () => {
    const { swarm } = makeSwarm()
    const dcSend = vi.fn()
    swarm.peers.set(ALICE, {
      id: ALICE,
      dc: { readyState: 'open' },
      sendControl: dcSend,
    })
    offline(swarm)
    swarm.sendToPeer(ALICE, { type: 'VIDEO_ANSWER', sdp: 'a' })
    expect(dcSend).toHaveBeenCalledOnce()
    expect(swarm._outbox).toHaveLength(0)
  })

  it('leaves out what has waited too long', () => {
    vi.useFakeTimers()
    try {
      const { swarm, sent, setConnection } = makeSwarm()
      offline(swarm)
      swarm.sendToPeer(ALICE, { type: 'VIDEO_ANSWER', sdp: 'old' })
      vi.advanceTimersByTime(OUTBOX_TTL_MS + 1)
      swarm.sendToPeer(ALICE, { type: 'VIDEO_ICE', candidate: 'fresh' })

      setConnection(1)
      swarm._flushOutbox()

      expect(sent().map((s) => s.payload.candidate)).toEqual(['fresh'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps at most OUTBOX_MAX, dropping the oldest', () => {
    const { swarm } = makeSwarm()
    offline(swarm)
    for (let i = 0; i < OUTBOX_MAX + 25; i++) swarm.sendToPeer(ALICE, { type: 'VIDEO_ICE', candidate: String(i) })
    expect(swarm._outbox).toHaveLength(OUTBOX_MAX)
    expect(swarm._outbox[0].payload.candidate).toBe('25')
  })

  it('keeps what is left when the connection drops again in the middle of sending, with its original age', () => {
    vi.useFakeTimers()
    try {
      const { swarm } = makeSwarm()
      offline(swarm)
      swarm.sendToPeer(ALICE, { type: 'VIDEO_ICE', candidate: 'a' })
      swarm.sendToPeer(ALICE, { type: 'VIDEO_ICE', candidate: 'b' })
      const originalAge = swarm._outbox[0].at

      vi.advanceTimersByTime(5000)
      const connection = { readyState: 1, send: vi.fn() }
      connection.send.mockImplementationOnce(() => {
        connection.readyState = 3 // the first goes, then the connection is gone
      })
      swarm._ws = connection
      swarm._flushOutbox()

      expect(connection.send).toHaveBeenCalledOnce()
      expect(swarm._outbox.map((i) => i.payload.candidate)).toEqual(['b'])
      expect(swarm._outbox[0].at).toBe(originalAge)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps nothing while leaving, and forgets what it had when it leaves', async () => {
    const { swarm } = makeSwarm()
    offline(swarm)
    swarm.sendToPeer(ALICE, { type: 'VIDEO_ICE', candidate: 'a' })
    await swarm.leave()
    expect(swarm._outbox).toHaveLength(0)

    swarm.sendToPeer(ALICE, { type: 'VIDEO_ICE', candidate: 'b' })
    expect(swarm._outbox).toHaveLength(0)
  })

  it('does not keep anything before it has a key (nothing could be sent anyway)', () => {
    const swarm = new RoomSwarm(ROOM) // quick room that has not derived its key yet
    swarm._localPeerId = ME
    swarm._ws = { readyState: 3, send: vi.fn() }
    swarm.sendToPeer(ALICE, { type: 'VIDEO_ANSWER', sdp: 'a' })
    expect(swarm._outbox).toHaveLength(0)
  })
})

// ── Through a real reconnection ───────────────────────────────────────────────

describe('RoomSwarm — sending what was kept after the WebSocket is back', () => {
  let sockets

  class FakeWebSocket extends EventTarget {
    static OPEN = 1
    constructor(url) {
      super()
      this.url = url
      this.readyState = 0
      this.sent = []
      sockets.push(this)
    }
    send(data) {
      this.sent.push(JSON.parse(data))
    }
    close() {}
    open() {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    }
    receive(message) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
    }
  }

  beforeEach(() => {
    sockets = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('joins the room again first, and sends what was kept only when the relay says it has joined', () => {
    const { swarm } = makeSwarm()
    swarm._ws = { readyState: 3, send: vi.fn() }
    swarm._wsReconnectTimer = null
    swarm.sendToPeer(ALICE, { type: 'VIDEO_ANSWER', sdp: 'answer' })
    swarm.sendToPeer(ALICE, { type: 'VIDEO_ICE', candidate: 'c1' })

    swarm._reconnectWS()
    const [ws] = sockets
    ws.open()
    expect(ws.sent.map((f) => f.type)).toEqual(['join']) // not yet: the relay has not said it has us

    ws.receive({ type: 'joined', peerId: ME })
    expect(ws.sent.map((f) => f.type)).toEqual(['join', 'relay-data-to', 'relay-data-to'])
    expect(ws.sent[1].to).toBe(ALICE)
    expect(swarm._outbox).toHaveLength(0)
  })

  it('sends nothing extra when nothing was kept', () => {
    const { swarm } = makeSwarm()
    swarm._ws = { readyState: 3, send: vi.fn() }
    swarm._reconnectWS()
    sockets[0].open()
    sockets[0].receive({ type: 'joined', peerId: ME })
    expect(sockets[0].sent.map((f) => f.type)).toEqual(['join'])
  })
})
