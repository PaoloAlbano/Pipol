/**
 * swarm.messaging.test.js
 *
 * Two-peer end-to-end message sync tests using real RoomSwarm instances.
 *
 * Strategy: bypass WebSocket/WebRTC entirely and wire two RoomSwarms together
 * by injecting a fake "sendControl" that pipes directly into the other peer's
 * _handleControl(). This exercises the real parsing + dispatch
 * pipeline without a network.
 *
 * Tests cover:
 *  1. MSG → chat-message event on receiver, correct channelName attached
 *  2. MSG for a different channelName is still dispatched (filtering happens in Room.jsx)
 *  3. HISTORY_REQ → history-req event on receiver
 *  4. HISTORY_RES → chat-message events for each message in the payload
 *  5. TYPING → typing event on receiver, channelName preserved
 *  6. DM → dm-message event on receiver
 *  7. Two-way: A→B and B→A both work on the same link
 *  8. peer-joined / peer-left lifecycle
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RoomSwarm } from '../../src/p2p/swarm.js'

// ── Storage mock ──────────────────────────────────────────────────────────────
// RoomSwarm reads identity from storage.js in the HELLO flow; mock it.

vi.mock('../../src/p2p/storage.js', () => ({
  getIdentity: vi.fn(() => ({
    publicKey: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
    secretKey: new Uint8Array([0x11, 0x22]),
    username: 'alice',
  })),
  getRelayUrl: vi.fn(() => null),
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const PEER_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PEER_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/**
 * Wire two RoomSwarm instances together so each peer's sendControl pipes
 * directly into the other peer's _handleControl.
 *
 * Returns { swarmA, swarmB } — both fully wired and "connected".
 */
function makeConnectedPair() {
  const swarmA = new RoomSwarm('test-room')
  const swarmB = new RoomSwarm('test-room')

  // Inject fake peer entries with sendControl wired to the opposite swarm
  swarmA.peers.set(PEER_B, {
    id: PEER_B,
    username: 'bob',
    messageCoreKey: null,
    pc: null,
    dc: null,
    sendControl: (msg) => swarmB._handleControl(PEER_A, msg),
  })

  swarmB.peers.set(PEER_A, {
    id: PEER_A,
    username: 'alice',
    messageCoreKey: null,
    pc: null,
    dc: null,
    sendControl: (msg) => swarmA._handleControl(PEER_B, msg),
  })

  return { swarmA, swarmB }
}

/** Collect all events of a given type from a swarm into an array. */
function collect(swarm, eventName) {
  const events = []
  swarm.addEventListener(eventName, (e) => events.push(e.detail))
  return events
}

// ─────────────────────────────────────────────────────────────────────────────

describe('RoomSwarm two-peer — MSG → chat-message', () => {
  it('delivers a MSG from A to B with the correct message payload', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const received = collect(swarmB, 'chat-message')

    swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: '1', content: 'ciao' } })

    expect(received).toHaveLength(1)
    expect(received[0].message).toMatchObject({ id: '1', content: 'ciao' })
    expect(received[0].channelName).toBe('generale')
  })

  it('attaches the channelName from the MSG payload', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const received = collect(swarmB, 'chat-message')

    swarmA.sendToAll({ type: 'MSG', channelName: 'random', message: { id: '2', content: 'hello' } })

    expect(received[0].channelName).toBe('random')
  })

  it('MSG without channelName dispatches with channelName: undefined', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const received = collect(swarmB, 'chat-message')

    swarmA.sendToAll({ type: 'MSG', message: { id: '3', content: 'no channel' } })

    expect(received).toHaveLength(1)
    // swarm.js: detail = { message, channelName: msg.channelName }
    // if msg.channelName is absent, it's undefined — Room.jsx treats that as match-all
    expect(received[0].channelName).toBeUndefined()
  })

  it('two-way: B→A also works on the same link', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const receivedByA = collect(swarmA, 'chat-message')

    swarmB.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: '9', content: 'from bob' } })

    expect(receivedByA).toHaveLength(1)
    expect(receivedByA[0].message.content).toBe('from bob')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RoomSwarm two-peer — HISTORY_REQ / HISTORY_RES', () => {
  it('HISTORY_REQ on A fires history-req on B with correct channelName', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const reqs = collect(swarmB, 'history-req')

    // A sends a HISTORY_REQ directly to B (simulates "I just joined, send me history")
    swarmA.sendToPeer(PEER_B, { type: 'HISTORY_REQ', channelName: 'generale', since: 0 })

    expect(reqs).toHaveLength(1)
    expect(reqs[0].channelName).toBe('generale')
    expect(reqs[0].since).toBe(0)
    expect(reqs[0].peerId).toBe(PEER_A)
  })

  it('HISTORY_RES dispatches one chat-message per message in the payload', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const msgs = collect(swarmB, 'chat-message')

    swarmA.sendToPeer(PEER_B, {
      type: 'HISTORY_RES',
      channelName: 'generale',
      messages: [
        { id: 'm1', content: 'first' },
        { id: 'm2', content: 'second' },
        { id: 'm3', content: 'third' },
      ],
    })

    expect(msgs).toHaveLength(3)
    expect(msgs.map((m) => m.message.content)).toEqual(['first', 'second', 'third'])
    // Each carries the channelName
    expect(msgs.every((m) => m.channelName === 'generale')).toBe(true)
  })

  it('HISTORY_RES with empty messages array dispatches nothing', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const msgs = collect(swarmB, 'chat-message')

    swarmA.sendToPeer(PEER_B, { type: 'HISTORY_RES', channelName: 'generale', messages: [] })

    expect(msgs).toHaveLength(0)
  })

  it('HISTORY_REQ for a different channel carries that channelName', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const reqs = collect(swarmB, 'history-req')

    swarmA.sendToPeer(PEER_B, { type: 'HISTORY_REQ', channelName: 'random', since: 1000 })

    expect(reqs[0].channelName).toBe('random')
    expect(reqs[0].since).toBe(1000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RoomSwarm two-peer — TYPING', () => {
  it('TYPING from A reaches B with channelName and username', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const typings = collect(swarmB, 'typing')

    swarmA.sendToAll({ type: 'TYPING', username: 'alice', channelName: 'generale', stopped: false })

    expect(typings).toHaveLength(1)
    expect(typings[0].username).toBe('alice')
    expect(typings[0].channelName).toBe('generale')
    expect(typings[0].stopped).toBe(false)
  })

  it('TYPING stopped:true is propagated correctly', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const typings = collect(swarmB, 'typing')

    swarmA.sendToAll({ type: 'TYPING', username: 'alice', channelName: 'generale', stopped: true })

    expect(typings[0].stopped).toBe(true)
  })

  it('TYPING from channel X and channel Y carry independent channelNames', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const typings = collect(swarmB, 'typing')

    swarmA.sendToAll({ type: 'TYPING', username: 'alice', channelName: 'generale', stopped: false })
    swarmA.sendToAll({ type: 'TYPING', username: 'alice', channelName: 'random', stopped: false })

    expect(typings[0].channelName).toBe('generale')
    expect(typings[1].channelName).toBe('random')
  })

  it('TYPING for a DM (channelName null) is propagated with null', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const typings = collect(swarmB, 'typing')

    swarmA.sendToAll({ type: 'TYPING', username: 'alice', channelName: null, stopped: false })

    expect(typings[0].channelName).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RoomSwarm two-peer — DM message', () => {
  it('DM from A reaches B with from/to/nonce/ciphertext', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const dms = collect(swarmB, 'dm-message')

    swarmA.sendToAll({
      type: 'DM',
      to: PEER_B,
      nonce: 'abc123',
      ciphertext: 'encrypted-payload',
    })

    expect(dms).toHaveLength(1)
    expect(dms[0].from).toBe(PEER_A)
    expect(dms[0].to).toBe(PEER_B)
    expect(dms[0].nonce).toBe('abc123')
    expect(dms[0].ciphertext).toBe('encrypted-payload')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RoomSwarm two-peer — peer lifecycle', () => {
  it('peer-joined fires on B when A sends HELLO', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const joined = collect(swarmB, 'peer-joined')

    // Simulate A's DataChannel open → sends HELLO to B
    swarmA.sendToPeer(PEER_B, { type: 'HELLO', username: 'alice', messageCoreKey: null })

    expect(joined).toHaveLength(1)
    expect(joined[0].username).toBe('alice')
    expect(joined[0].id).toBe(PEER_A)
  })

  it('multiple messages after HELLO are all delivered', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const chatMsgs = collect(swarmB, 'chat-message')

    swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: '1', content: 'uno' } })
    swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: '2', content: 'due' } })
    swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: '3', content: 'tre' } })

    expect(chatMsgs).toHaveLength(3)
    expect(chatMsgs.map((m) => m.message.content)).toEqual(['uno', 'due', 'tre'])
  })

  it('messages from two different senders both arrive on the receiver', () => {
    // Three-way: A and C both send to B
    const swarmA = new RoomSwarm('test-room')
    const swarmB = new RoomSwarm('test-room')
    const swarmC = new RoomSwarm('test-room')
    const PEER_C = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'

    // Register B's peers so _handleControl doesn't bail on `if (!peer) return`
    swarmB.peers.set(PEER_A, {
      id: PEER_A,
      username: 'alice',
      messageCoreKey: null,
      pc: null,
      dc: null,
      sendControl: null,
    })
    swarmB.peers.set(PEER_C, {
      id: PEER_C,
      username: 'charlie',
      messageCoreKey: null,
      pc: null,
      dc: null,
      sendControl: null,
    })

    // Wire A→B and C→B
    swarmA.peers.set(PEER_B, {
      id: PEER_B,
      username: 'bob',
      messageCoreKey: null,
      pc: null,
      dc: null,
      sendControl: (msg) => swarmB._handleControl(PEER_A, msg),
    })
    swarmC.peers.set(PEER_B, {
      id: PEER_B,
      username: 'bob',
      messageCoreKey: null,
      pc: null,
      dc: null,
      sendControl: (msg) => swarmB._handleControl(PEER_C, msg),
    })

    const chatMsgs = collect(swarmB, 'chat-message')

    swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: 'a1', content: 'from alice' } })
    swarmC.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: 'c1', content: 'from charlie' } })

    expect(chatMsgs).toHaveLength(2)
    expect(chatMsgs.map((m) => m.message.content)).toEqual(['from alice', 'from charlie'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('RoomSwarm two-peer — CHANNEL_NOTIFY', () => {
  it('CHANNEL_NOTIFY from A reaches B with channelName', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const notifs = collect(swarmB, 'channel-notify')

    swarmA.sendToAll({ type: 'CHANNEL_NOTIFY', channelName: 'generale' })

    expect(notifs).toHaveLength(1)
    expect(notifs[0].channelName).toBe('generale')
    expect(notifs[0].peerId).toBe(PEER_A)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Disconnection and re-sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper: rewire swarmA→swarmB after a disconnect.
 * Mirrors what happens when a new DataChannel is established after reconnect:
 * - register the peer again in both maps
 * - wire sendControl back
 */
function reconnect(swarmA, swarmB) {
  swarmA.peers.set(PEER_B, {
    id: PEER_B,
    username: 'bob',
    messageCoreKey: null,
    pc: null,
    dc: null,
    sendControl: (msg) => swarmB._handleControl(PEER_A, msg),
  })
  swarmB.peers.set(PEER_A, {
    id: PEER_A,
    username: 'alice',
    messageCoreKey: null,
    pc: null,
    dc: null,
    sendControl: (msg) => swarmA._handleControl(PEER_B, msg),
  })
}

describe('RoomSwarm — disconnect + re-sync', () => {
  it('peer-left fires when _handleDisconnect is called', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const left = collect(swarmA, 'peer-left')

    swarmA._handleDisconnect(PEER_B)

    expect(left).toHaveLength(1)
    expect(left[0].id).toBe(PEER_B)
  })

  it('peer is removed from peers map after disconnect', () => {
    const { swarmA } = makeConnectedPair()

    swarmA._handleDisconnect(PEER_B)

    expect(swarmA.peers.has(PEER_B)).toBe(false)
    expect(swarmA.getPeers()).toHaveLength(0)
  })

  it('sendToAll is a no-op after peer disconnects (no throw, no delivery)', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const received = collect(swarmB, 'chat-message')

    swarmA._handleDisconnect(PEER_B)

    // After disconnect B is gone — sendToAll should silently skip it
    expect(() => {
      swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: '1', content: 'ghost' } })
    }).not.toThrow()
    expect(received).toHaveLength(0)
  })

  it('_handleDisconnect is idempotent (calling twice does not throw)', () => {
    const { swarmA } = makeConnectedPair()

    expect(() => {
      swarmA._handleDisconnect(PEER_B)
      swarmA._handleDisconnect(PEER_B) // second call: peer no longer in map
    }).not.toThrow()
  })

  it('peer-left fires only once per disconnect even if called twice', () => {
    const { swarmA } = makeConnectedPair()
    const left = collect(swarmA, 'peer-left')

    swarmA._handleDisconnect(PEER_B)
    swarmA._handleDisconnect(PEER_B)

    expect(left).toHaveLength(1)
  })

  it('messages sent BEFORE disconnect are received; messages AFTER are not', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const received = collect(swarmB, 'chat-message')

    swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: '1', content: 'before' } })
    swarmA._handleDisconnect(PEER_B)
    swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: '2', content: 'after' } })

    expect(received).toHaveLength(1)
    expect(received[0].message.content).toBe('before')
  })

  it('after reconnect, messages are delivered again', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const received = collect(swarmB, 'chat-message')

    // Disconnect
    swarmA._handleDisconnect(PEER_B)
    swarmB._handleDisconnect(PEER_A)

    // Reconnect (simulates new DataChannel)
    reconnect(swarmA, swarmB)

    swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: '3', content: 'after reconnect' } })

    expect(received).toHaveLength(1)
    expect(received[0].message.content).toBe('after reconnect')
  })

  it('after reconnect, peer-joined fires again via HELLO', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const joined = collect(swarmB, 'peer-joined')

    swarmA._handleDisconnect(PEER_B)
    swarmB._handleDisconnect(PEER_A)
    reconnect(swarmA, swarmB)

    // Simulate the HELLO that happens when the DataChannel reopens
    swarmA.sendToPeer(PEER_B, { type: 'HELLO', username: 'alice', messageCoreKey: null })

    expect(joined).toHaveLength(1)
    expect(joined[0].id).toBe(PEER_A)
  })

  it('after reconnect, HISTORY_REQ for catch-up is sent and received', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const reqs = collect(swarmB, 'history-req')

    swarmA._handleDisconnect(PEER_B)
    swarmB._handleDisconnect(PEER_A)
    reconnect(swarmA, swarmB)

    // Simulate Room.jsx catch-up: on peer-joined send HISTORY_REQ
    swarmA.sendToPeer(PEER_B, { type: 'HISTORY_REQ', channelName: 'generale', since: 1000 })

    expect(reqs).toHaveLength(1)
    expect(reqs[0].channelName).toBe('generale')
    expect(reqs[0].since).toBe(1000)
  })

  it('full cycle: send → disconnect → reconnect → HISTORY_RES → messages restored', () => {
    const { swarmA, swarmB } = makeConnectedPair()
    const chatOnB = collect(swarmB, 'chat-message')

    // Phase 1: A sends a message, B receives it
    swarmA.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: 'm1', content: 'message 1' } })
    expect(chatOnB).toHaveLength(1)

    // Phase 2: B disconnects
    swarmA._handleDisconnect(PEER_B)
    swarmB._handleDisconnect(PEER_A)

    // Phase 3: Reconnect
    reconnect(swarmA, swarmB)

    // Phase 4: B requests history since t=0 (hasn't seen anything after disconnect)
    const reqs = collect(swarmA, 'history-req')
    swarmB.sendToPeer(PEER_A, { type: 'HISTORY_REQ', channelName: 'generale', since: 0 })
    expect(reqs).toHaveLength(1)

    // Phase 5: A responds with HISTORY_RES containing the missed messages
    swarmA.sendToPeer(PEER_B, {
      type: 'HISTORY_RES',
      channelName: 'generale',
      messages: [{ id: 'm1', content: 'message 1' }],
    })

    // B now has 2 events total: the original MSG + the HISTORY_RES replay
    expect(chatOnB).toHaveLength(2)
    expect(chatOnB[1].message.content).toBe('message 1')
    expect(chatOnB[1].channelName).toBe('generale')
  })

  it('disconnect does not affect a second unrelated peer', () => {
    const PEER_C = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const swarmB = new RoomSwarm('test-room')
    const swarmA = new RoomSwarm('test-room')
    const swarmC = new RoomSwarm('test-room')

    // Register all peers on B
    swarmB.peers.set(PEER_A, {
      id: PEER_A,
      username: 'alice',
      messageCoreKey: null,
      pc: null,
      dc: null,
      sendControl: (msg) => swarmA._handleControl(PEER_B, msg),
    })
    swarmB.peers.set(PEER_C, {
      id: PEER_C,
      username: 'charlie',
      messageCoreKey: null,
      pc: null,
      dc: null,
      sendControl: (msg) => swarmC._handleControl(PEER_B, msg),
    })
    swarmA.peers.set(PEER_B, {
      id: PEER_B,
      username: 'bob',
      messageCoreKey: null,
      pc: null,
      dc: null,
      sendControl: (msg) => swarmB._handleControl(PEER_A, msg),
    })
    swarmC.peers.set(PEER_B, {
      id: PEER_B,
      username: 'bob',
      messageCoreKey: null,
      pc: null,
      dc: null,
      sendControl: (msg) => swarmB._handleControl(PEER_C, msg),
    })

    const chatOnA = collect(swarmA, 'chat-message')

    // A disconnects from B — C should be unaffected
    swarmB._handleDisconnect(PEER_A)
    expect(swarmB.peers.has(PEER_C)).toBe(true) // C still connected to B

    // C can still send to B and B can broadcast to C
    swarmC.sendToAll({ type: 'MSG', channelName: 'generale', message: { id: 'c1', content: 'still here' } })
    expect(swarmB.peers.size).toBe(1) // only C remains
  })
})

// ── REACTION dispatch ──────────────────────────────────────────────────────

describe('RoomSwarm two-peer — REACTION', () => {
  let swarmA, swarmB

  beforeEach(() => {
    ;({ swarmA, swarmB } = makeConnectedPair())
  })

  it('REACTION from A dispatches reaction event on B with correct detail', () => {
    const received = collect(swarmB, 'reaction')
    swarmA.sendToAll({
      type: 'REACTION',
      messageId: 'msg-1',
      emoji: '👍',
      userPubkey: 'aabbccdd',
      channelName: 'generale',
      removed: false,
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      messageId: 'msg-1',
      emoji: '👍',
      userPubkey: 'aabbccdd',
      channelName: 'generale',
      removed: false,
    })
  })

  it('REACTION with removed:true is propagated correctly', () => {
    const received = collect(swarmB, 'reaction')
    swarmA.sendToAll({
      type: 'REACTION',
      messageId: 'msg-2',
      emoji: '❤️',
      userPubkey: 'aabbccdd',
      channelName: 'generale',
      removed: true,
    })
    expect(received).toHaveLength(1)
    expect(received[0].removed).toBe(true)
  })

  it('REACTION without channelName defaults to null', () => {
    const received = collect(swarmB, 'reaction')
    swarmA.sendToAll({
      type: 'REACTION',
      messageId: 'msg-3',
      emoji: '😂',
      userPubkey: 'aabbccdd',
    })
    expect(received[0].channelName).toBeNull()
    expect(received[0].removed).toBe(false)
  })

  it('REACTION includes peerId of the sender', () => {
    const received = collect(swarmB, 'reaction')
    swarmA.sendToAll({
      type: 'REACTION',
      messageId: 'msg-4',
      emoji: '🔥',
      userPubkey: 'aabbccdd',
      channelName: 'generale',
    })
    expect(received[0].peerId).toBe(PEER_A)
  })
})

// ── MSG_EDIT dispatch ──────────────────────────────────────────────────────

describe('RoomSwarm two-peer — MSG_EDIT', () => {
  let swarmA, swarmB

  beforeEach(() => {
    ;({ swarmA, swarmB } = makeConnectedPair())
  })

  it('MSG_EDIT from A dispatches msg-edit event on B with correct detail', () => {
    const received = collect(swarmB, 'msg-edit')
    swarmA.sendToAll({
      type: 'MSG_EDIT',
      originalId: 'msg-1',
      newContent: 'updated content',
      editedAt: 1234567890,
      channelName: 'generale',
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      originalId: 'msg-1',
      newContent: 'updated content',
      editedAt: 1234567890,
      channelName: 'generale',
    })
  })

  it('MSG_EDIT includes peerId of the sender', () => {
    const received = collect(swarmB, 'msg-edit')
    swarmA.sendToAll({
      type: 'MSG_EDIT',
      originalId: 'msg-2',
      newContent: 'hello',
      editedAt: 1000,
      channelName: 'generale',
    })
    expect(received[0].peerId).toBe(PEER_A)
  })

  it('MSG_EDIT without channelName defaults to null', () => {
    const received = collect(swarmB, 'msg-edit')
    swarmA.sendToAll({
      type: 'MSG_EDIT',
      originalId: 'msg-3',
      newContent: 'dm edit',
    })
    expect(received[0].channelName).toBeNull()
  })
})

// ── MSG_DELETE dispatch ────────────────────────────────────────────────────

describe('RoomSwarm two-peer — MSG_DELETE', () => {
  let swarmA, swarmB

  beforeEach(() => {
    ;({ swarmA, swarmB } = makeConnectedPair())
  })

  it('MSG_DELETE from A dispatches msg-delete event on B with correct detail', () => {
    const received = collect(swarmB, 'msg-delete')
    swarmA.sendToAll({
      type: 'MSG_DELETE',
      originalId: 'msg-del-1',
      channelName: 'generale',
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      originalId: 'msg-del-1',
      channelName: 'generale',
    })
  })

  it('MSG_DELETE includes peerId of the sender', () => {
    const received = collect(swarmB, 'msg-delete')
    swarmA.sendToAll({ type: 'MSG_DELETE', originalId: 'msg-del-2', channelName: 'x' })
    expect(received[0].peerId).toBe(PEER_A)
  })

  it('MSG_DELETE without channelName defaults to null', () => {
    const received = collect(swarmB, 'msg-delete')
    swarmA.sendToAll({ type: 'MSG_DELETE', originalId: 'msg-del-3' })
    expect(received[0].channelName).toBeNull()
  })
})

// ── FILE_META + FILE_CHUNK dispatch ───────────────────────────────────────

describe('RoomSwarm two-peer — FILE_META + FILE_CHUNK', () => {
  let swarmA, swarmB

  beforeEach(() => {
    ;({ swarmA, swarmB } = makeConnectedPair())
  })

  it('FILE_META from A dispatches file-meta event on B with correct detail', () => {
    const received = collect(swarmB, 'file-meta')
    swarmA.sendToAll({
      type: 'FILE_META',
      fileId: 'f1',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 12345,
      totalChunks: 2,
      channelName: 'generale',
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      fileId: 'f1',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 12345,
      totalChunks: 2,
      channelName: 'generale',
    })
  })

  it('FILE_CHUNK from A dispatches file-chunk event on B with correct detail', () => {
    const received = collect(swarmB, 'file-chunk')
    swarmA.sendToAll({ type: 'FILE_CHUNK', fileId: 'f1', index: 0, data: 'abc123' })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ fileId: 'f1', index: 0, data: 'abc123' })
  })

  it('FILE_META peerId is set correctly', () => {
    const received = collect(swarmB, 'file-meta')
    swarmA.sendToAll({ type: 'FILE_META', fileId: 'f2', name: 'x.png', mimeType: 'image/png', size: 1, totalChunks: 1 })
    expect(received[0].peerId).toBe(PEER_A)
  })
})
