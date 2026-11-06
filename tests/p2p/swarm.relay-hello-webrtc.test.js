/**
 * The HELLO sent through the relay is faster than the WebRTC offer (which needs createOffer first), so a peer is
 * often registered, without a connection, before the WebRTC handshake starts. That handshake must still happen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RoomSwarm } from '../../src/p2p/swarm.js'
import { RelayCipher } from '../../src/p2p/relay-crypto.js'

vi.mock('../../src/p2p/storage.js', () => ({
  getIdentity: () => ({
    publicKey: new Uint8Array([1, 2, 3, 4]),
    secretKey: new Uint8Array(8),
    username: 'me',
  }),
  getRelayUrl: () => null,
  getIceSettings: () => ({ mode: 'default', servers: [], forceRelay: false, chatTurn: false }),
}))

const KEY = new Uint8Array(32).fill(5)
const ROOM = 'workspace-topic'
const ME = '1'.repeat(64)
const ALICE = 'a'.repeat(64)

let peerConnections

class FakePC extends EventTarget {
  constructor() {
    super()
    peerConnections.push(this)
  }
  createDataChannel() {
    return Object.assign(new EventTarget(), { readyState: 'connecting', send() {}, close() {} })
  }
  async createOffer() {
    return { type: 'offer', sdp: 'a=fingerprint:sha-256 AA:BB' }
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'a=fingerprint:sha-256 CC:DD' }
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {}
}

function makeSwarm() {
  const swarm = new RoomSwarm(ROOM, { relayKey: KEY })
  swarm._localPeerId = ME
  swarm._ws = { readyState: 1, send: vi.fn() }
  const sent = () => swarm._ws.send.mock.calls.map(([raw]) => JSON.parse(raw))
  return { swarm, sent, alice: new RelayCipher(KEY, ROOM) }
}

function helloFromAlice(alice) {
  return {
    type: 'relay-data',
    from: ALICE,
    data: alice.seal({ type: 'HELLO', username: 'alice', messageCoreKey: 'core' }, ALICE),
  }
}

beforeEach(() => {
  peerConnections = []
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.stubGlobal(
    'RTCSessionDescription',
    class {
      constructor(init) {
        Object.assign(this, init)
      }
    }
  )
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RoomSwarm — WebRTC handshake after a relay HELLO', () => {
  it('answers an offer from a peer already registered by its relay HELLO', async () => {
    const { swarm, sent, alice } = makeSwarm()
    swarm._handleSignal(helloFromAlice(alice))
    expect(swarm.peers.get(ALICE).pc).toBeNull()

    await swarm._handleRTCSignal(ALICE, {
      type: 'offer',
      sdp: { type: 'offer', sdp: 'x' },
      fingerprint: 'AA',
    })

    expect(peerConnections).toHaveLength(1)
    expect(swarm.peers.get(ALICE).pc).toBe(peerConnections[0])
    expect(sent().some((f) => f.type === 'signal' && f.to === ALICE)).toBe(true)
  })

  it('keeps what the HELLO said about the peer when the connection is created', async () => {
    const { swarm, alice } = makeSwarm()
    const joined = []
    swarm.addEventListener('peer-joined', (e) => joined.push(e.detail))
    swarm._handleSignal(helloFromAlice(alice))

    await swarm._handleRTCSignal(ALICE, { type: 'offer', sdp: { type: 'offer', sdp: 'x' } })

    const peer = swarm.peers.get(ALICE)
    expect(peer.username).toBe('alice')
    expect(peer.messageCoreKey).toBe('core')
    expect(peer._joinedFired).toBe(true)
    expect(joined).toHaveLength(1)
  })

  it('initiates the connection to a peer already registered by its relay HELLO', async () => {
    const { swarm, alice } = makeSwarm()
    swarm._handleSignal(helloFromAlice(alice))

    await swarm._initiateConnection(ALICE)

    expect(peerConnections).toHaveLength(1)
    expect(swarm.peers.get(ALICE).pc).toBe(peerConnections[0])
  })

  it('ignores a second offer while a connection to the peer exists', async () => {
    const { swarm } = makeSwarm()
    await swarm._handleRTCSignal(ALICE, { type: 'offer', sdp: { type: 'offer', sdp: 'x' } })
    await swarm._handleRTCSignal(ALICE, { type: 'offer', sdp: { type: 'offer', sdp: 'y' } })
    expect(peerConnections).toHaveLength(1)
  })
})
