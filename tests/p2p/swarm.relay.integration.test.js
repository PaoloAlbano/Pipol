// @vitest-environment node
/**
 * swarm.relay.integration.test.js
 *
 * Integration tests that use a REAL in-process WebSocket relay server.
 * WebRTC (RTCPeerConnection) is intentionally disabled via a no-op mock so
 * all message delivery is forced through the WebSocket relay fallback.
 *
 * This catches bugs that unit tests (which bypass the network) miss:
 *   • messages not arriving across real networks (symmetric NAT → no DataChannel)
 *   • relay-data broadcast/unicast not working end-to-end
 *   • auto-registration of relay-only peers
 *
 * Test environment: Node.js (not jsdom) so we can use real WebSocket servers.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createTestRelay } from './helpers/test-relay.js'

// ── Browser globals that swarm.js needs in Node.js ───────────────────────────

// Real WebSocket from 'ws' — same API as the browser's
global.WebSocket = WebSocket

// No-op RTCPeerConnection — simulates WebRTC unavailability (symmetric NAT,
// no TURN server, etc.).  DataChannel never opens; all delivery via WS relay.
class FakeDataChannel extends EventTarget {
  constructor() {
    super()
    this.readyState = 'connecting' // never transitions to 'open'
  }
  send() {} // silently dropped
  close() {
    this.readyState = 'closed'
  }
}

class FakeRTCPeerConnection extends EventTarget {
  constructor() {
    super()
    this.connectionState = 'new'
    this.localDescription = { sdp: 'v=0\r\na=fingerprint:sha-256 00:00:00' }
    this.remoteDescription = null
  }
  createDataChannel() {
    return new FakeDataChannel()
  }
  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 00:00:00' })
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 00:00:00' })
  }
  setLocalDescription(desc) {
    this.localDescription = desc
    return Promise.resolve()
  }
  setRemoteDescription(desc) {
    this.remoteDescription = desc
    return Promise.resolve()
  }
  addIceCandidate() {
    return Promise.resolve()
  }
  close() {}
}

class FakeRTCSessionDescription {
  constructor(desc) {
    Object.assign(this, desc)
  }
}
class FakeRTCIceCandidate {
  constructor(c) {
    Object.assign(this, c)
  }
}

global.RTCPeerConnection = FakeRTCPeerConnection
global.RTCSessionDescription = FakeRTCSessionDescription
global.RTCIceCandidate = FakeRTCIceCandidate

// ── Mock storage.js (uses localStorage which doesn't exist in Node.js) ────────

vi.mock('../../src/p2p/storage.js', () => ({
  getIdentity: vi.fn(() => ({
    publicKey: new Uint8Array(32).fill(0xab),
    secretKey: new Uint8Array(64).fill(0xcd),
    username: 'test-user',
  })),
  getRelayUrl: vi.fn(() => null),
  getStore: vi.fn(() =>
    Promise.resolve({
      get: vi.fn(() => ({
        ready: () => Promise.resolve(),
        on: () => {},
        append: () => Promise.resolve(),
        get: () => Promise.resolve(null),
        length: 0,
        key: new Uint8Array(32).fill(0x11),
      })),
    })
  ),
}))

// ── Import RoomSwarm after globals and mocks are set up ───────────────────────

const { RoomSwarm } = await import('../../src/p2p/swarm.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create two identities with distinct public keys so swarmA and swarmB get
 * different peerIds and are put in the same relay room.
 */
function makeIdentity(fill) {
  const pubkey = new Uint8Array(32).fill(fill)
  return {
    publicKey: pubkey,
    secretKey: new Uint8Array(64).fill(fill + 1),
    username: `peer-${fill.toString(16)}`,
  }
}

/** Wait up to `ms` for `predicate()` to return true, polling every 20 ms. */
function waitFor(predicate, ms = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'))
      setTimeout(check, 20)
    }
    check()
  })
}

// ── Relay lifecycle ───────────────────────────────────────────────────────────

let relay

beforeAll(async () => {
  relay = await createTestRelay()
})

afterAll(async () => {
  await relay.close()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RoomSwarm — WebSocket relay fallback (no WebRTC DataChannel)', () => {
  let swarmA, swarmB

  beforeEach(async () => {
    const idA = makeIdentity(0xaa)
    const idB = makeIdentity(0xbb)

    // Override getIdentity for each swarm (they call it at join time)
    const { getIdentity } = await import('../../src/p2p/storage.js')
    getIdentity
      .mockReturnValueOnce(idA) // swarmA.join()
      .mockReturnValueOnce(idB) // swarmB.join()
      // also called inside _setupDataChannel → HELLO, so return idA/idB again
      .mockReturnValueOnce(idA)
      .mockReturnValueOnce(idB)
      .mockReturnValue(idA) // fallback

    swarmA = new RoomSwarm('integration-test-room', { relayUrl: relay.url })
    swarmB = new RoomSwarm('integration-test-room', { relayUrl: relay.url })

    await Promise.all([swarmA.join(), swarmB.join()])
    // Give the signaling round-trip time to complete (offer/answer)
    await new Promise((r) => setTimeout(r, 100))
  })

  afterEach(async () => {
    swarmA?.leave()
    swarmB?.leave()
  })

  it('delivers MSG from A to B via WebSocket relay', async () => {
    const received = []
    swarmB.addEventListener('chat-message', (e) => received.push(e.detail))

    swarmA.sendToAll({
      type: 'MSG',
      channelName: 'general',
      message: { id: 'msg-1', content: 'hello from A', timestamp: Date.now(), type: 'text' },
    })

    await waitFor(() => received.length > 0)

    expect(received).toHaveLength(1)
    expect(received[0].channelName).toBe('general')
    expect(received[0].message.content).toBe('hello from A')
    expect(received[0].message.id).toBe('msg-1')
  })

  it('delivers MSG from B to A via WebSocket relay (bidirectional)', async () => {
    const received = []
    swarmA.addEventListener('chat-message', (e) => received.push(e.detail))

    swarmB.sendToAll({
      type: 'MSG',
      channelName: 'general',
      message: { id: 'msg-2', content: 'reply from B', timestamp: Date.now(), type: 'text' },
    })

    await waitFor(() => received.length > 0)

    expect(received[0].message.content).toBe('reply from B')
  })

  it('delivers WORKSPACE_META via relay (new channel creation)', async () => {
    const received = []
    swarmB.addEventListener('workspace-meta', (e) => received.push(e.detail))

    swarmA.sendToAll({
      type: 'WORKSPACE_META',
      channels: [
        { name: 'general', topic: '' },
        { name: 'announcements', topic: '' },
      ],
    })

    await waitFor(() => received.length > 0)

    expect(received[0].channels).toHaveLength(2)
    expect(received[0].channels[1].name).toBe('announcements')
  })

  it('delivers CHANNEL_NOTIFY via relay', async () => {
    const received = []
    swarmB.addEventListener('channel-notify', (e) => received.push(e.detail))

    swarmA.sendToAll({ type: 'CHANNEL_NOTIFY', channelName: 'random' })

    await waitFor(() => received.length > 0)

    expect(received[0].channelName).toBe('random')
  })

  it('delivers MEMBER_HELLO via relay (presence sync)', async () => {
    const received = []
    swarmB.addEventListener('member-hello', (e) => received.push(e.detail))

    swarmA.sendToAll({
      type: 'MEMBER_HELLO',
      pubkey: 'aabbcc',
      username: 'alice',
      status: 'online',
    })

    await waitFor(() => received.length > 0)

    expect(received[0].username).toBe('alice')
    expect(received[0].status).toBe('online')
  })

  it('delivers HISTORY_REQ unicast via relay (sendToPeer fallback)', async () => {
    const received = []
    swarmB.addEventListener('history-req', (e) => received.push(e.detail))

    // swarmB's peerId is its public key hex
    const swarmBPeerId = Array.from(makeIdentity(0xbb).publicKey)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    swarmA.sendToPeer(swarmBPeerId, {
      type: 'HISTORY_REQ',
      channelName: 'general',
      since: 0,
    })

    await waitFor(() => received.length > 0)

    expect(received[0].channelName).toBe('general')
    expect(received[0].since).toBe(0)
  })

  it('does not deliver a message back to the sender', async () => {
    const receivedByA = []
    swarmA.addEventListener('chat-message', (e) => receivedByA.push(e.detail))

    swarmA.sendToAll({
      type: 'MSG',
      channelName: 'general',
      message: { id: 'msg-self', content: 'self message', timestamp: Date.now(), type: 'text' },
    })

    await new Promise((r) => setTimeout(r, 200))

    expect(receivedByA).toHaveLength(0)
  })

  it('handles multiple rapid messages in order', async () => {
    const received = []
    swarmB.addEventListener('chat-message', (e) => received.push(e.detail))

    for (let i = 0; i < 5; i++) {
      swarmA.sendToAll({
        type: 'MSG',
        channelName: 'general',
        message: { id: `msg-${i}`, content: `message ${i}`, timestamp: Date.now() + i, type: 'text' },
      })
    }

    await waitFor(() => received.length >= 5)

    expect(received).toHaveLength(5)
    const ids = received.map((r) => r.message.id)
    expect(ids).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4'])
  })
})
