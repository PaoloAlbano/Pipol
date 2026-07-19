/**
 * swarm.test.jsx
 * Tests for P2P peer discovery and DTLS fingerprint verification.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RoomSwarm, extractFingerprint } from '../../src/p2p/swarm.js'

// Mock storage functions (hoisted by Vitest to the top of the file regardless
// of where declared; placed at top level to avoid the nested vi.mock warning)
vi.mock('../../src/p2p/storage.js', () => ({
  getIdentity: () => ({
    publicKey: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    secretKey: new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]),
    username: 'test-user',
  }),
  getRelayUrl: () => null,
}))

// Mock WebSocket
class MockWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = WebSocket.OPEN
    this.listeners = {}
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(handler)
  }

  send(data) {
    // Mock send - just store for inspection
    this.lastSent = data
  }

  close() {
    this.readyState = WebSocket.CLOSED
  }

  // Helper to trigger events from tests
  trigger(event, data) {
    const handlers = this.listeners[event] || []
    handlers.forEach((h) => h(data))
  }
}

// Mock RTCPeerConnection
class MockRTCPeerConnection {
  constructor(config) {
    this.config = config
    this.localDescription = null
    this.remoteDescription = null
    this.connectionState = 'new'
    this.listeners = {}
    this.dataChannels = []
  }

  createDataChannel(name, opts) {
    const dc = new MockDataChannel(name, opts)
    this.dataChannels.push(dc)
    return dc
  }

  createOffer() {
    return Promise.resolve({
      type: 'offer',
      sdp: 'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    })
  }

  createAnswer() {
    return Promise.resolve({
      type: 'answer',
      sdp: 'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
    })
  }

  setLocalDescription(desc) {
    this.localDescription = desc
    return Promise.resolve()
  }

  setRemoteDescription(desc) {
    this.remoteDescription = desc
    return Promise.resolve()
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(handler)
  }

  addIceCandidate(candidate) {
    return Promise.resolve()
  }

  close() {
    this.connectionState = 'closed'
  }

  // Helper to trigger ICE candidate
  triggerIceCandidate(candidate) {
    const handlers = this.listeners['icecandidate'] || []
    handlers.forEach((h) => h({ candidate }))
  }

  // Helper to trigger connection state change
  triggerConnectionState(state) {
    this.connectionState = state
    const handlers = this.listeners['connectionstatechange'] || []
    handlers.forEach((h) => h())
  }
}

// Mock DataChannel
class MockDataChannel {
  constructor(name, opts) {
    this.name = name
    this.readyState = 'open'
    this.listeners = {}
  }

  send(data) {
    this.lastSent = data
  }

  addEventListener(event, handler) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(handler)
  }

  close() {
    this.readyState = 'closed'
    // Trigger close event
    const handlers = this.listeners['close'] || []
    handlers.forEach((h) => h())
  }

  // Helper to trigger message event
  triggerMessage(data) {
    const handlers = this.listeners['message'] || []
    handlers.forEach((h) => h({ data: JSON.stringify(data) }))
  }

  // Helper to trigger any event
  trigger(event) {
    const handlers = this.listeners[event] || []
    handlers.forEach((h) => h())
  }
}

// Setup mocks
beforeEach(() => {
  // Mock WebSocket con auto-open
  global.WebSocket = class MockWebSocket {
    constructor(url) {
      this.url = url
      this.readyState = WebSocket.CONNECTING
      this.listeners = {}
      // Simula apertura async
      setTimeout(() => {
        this.readyState = WebSocket.OPEN
        const handlers = this.listeners['open'] || []
        handlers.forEach((h) => h({}))
      }, 0)
    }

    addEventListener(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = []
      this.listeners[event].push(handler)
    }

    send(data) {
      this.lastSent = data
    }

    close() {
      this.readyState = WebSocket.CLOSED
    }

    // Helper to trigger events from tests
    trigger(event, data) {
      const handlers = this.listeners[event] || []
      handlers.forEach((h) => h(data))
    }
  }

  global.RTCPeerConnection = MockRTCPeerConnection
  global.RTCSessionDescription = vi.fn((desc) => desc)
  global.RTCIceCandidate = vi.fn((candidate) => candidate)
})

describe('RoomSwarm — DTLS fingerprint verification', () => {
  it('verifies fingerprint when HELLO message includes matching fingerprint', async () => {
    const swarm = new RoomSwarm('TESTROOM')

    // Mock join without waiting for WebSocket
    swarm._localPeerId = '0102030405060708'
    swarm.peers = new Map()

    // Simulate a peer connection with expected fingerprint
    const peerId = 'remote-peer-123'
    const expectedFingerprint = 'aabbccddeeff00112233445566778899'

    swarm.peers.set(peerId, {
      id: peerId,
      username: '...',
      messageCoreKey: null,
      pc: new MockRTCPeerConnection({}),
      dc: new MockDataChannel('p2p-chat', {}),
      sendControl: (data) => {},
      expectedFingerprint,
    })

    const peerJoinedSpy = vi.fn()
    swarm.addEventListener('peer-joined', peerJoinedSpy)

    // Send HELLO with matching fingerprint
    swarm._handleControl(peerId, {
      type: 'HELLO',
      username: 'remote-user',
      messageCoreKey: 'key-123',
      fingerprint: expectedFingerprint,
    })

    // Peer should be accepted
    expect(peerJoinedSpy).toHaveBeenCalledOnce()
    expect(peerJoinedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          id: peerId,
          username: 'remote-user',
        }),
      })
    )
  })

  it('disconnects peer when fingerprint does not match (MITM protection)', async () => {
    const swarm = new RoomSwarm('TESTROOM')

    // Mock join without waiting for WebSocket
    swarm._localPeerId = '0102030405060708'
    swarm.peers = new Map()

    const peerId = 'remote-peer-456'
    const expectedFingerprint = 'correctfingerprint123'
    const wrongFingerprint = 'wrongfingerprint456'

    swarm.peers.set(peerId, {
      id: peerId,
      username: '...',
      messageCoreKey: null,
      pc: new MockRTCPeerConnection({}),
      dc: new MockDataChannel('p2p-chat', {}),
      sendControl: (data) => {},
      expectedFingerprint,
    })

    const peerLeftSpy = vi.fn()
    swarm.addEventListener('peer-left', peerLeftSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Send HELLO with WRONG fingerprint
    swarm._handleControl(peerId, {
      type: 'HELLO',
      username: 'attacker',
      messageCoreKey: 'fake-key',
      fingerprint: wrongFingerprint,
    })

    // Peer should be disconnected
    expect(peerLeftSpy).toHaveBeenCalledOnce()
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[swarm] DTLS fingerprint mismatch for peer',
      expect.stringContaining('remote-peer'),
      'Expected:',
      expectedFingerprint,
      'Got:',
      wrongFingerprint
    )

    // Peer should be removed from the map
    expect(swarm.peers.has(peerId)).toBe(false)

    consoleErrorSpy.mockRestore()
  })

  it('accepts peer when no fingerprint is provided (backward compatibility)', async () => {
    const swarm = new RoomSwarm('TESTROOM')

    // Mock join without waiting for WebSocket
    swarm._localPeerId = '0102030405060708'
    swarm.peers = new Map()

    const peerId = 'old-peer-789'

    swarm.peers.set(peerId, {
      id: peerId,
      username: '...',
      messageCoreKey: null,
      pc: new MockRTCPeerConnection({}),
      dc: new MockDataChannel('p2p-chat', {}),
      sendControl: (data) => {},
      expectedFingerprint: null, // No fingerprint expected
    })

    const peerJoinedSpy = vi.fn()
    swarm.addEventListener('peer-joined', peerJoinedSpy)

    // Send HELLO without fingerprint (old client)
    swarm._handleControl(peerId, {
      type: 'HELLO',
      username: 'old-client',
      messageCoreKey: 'old-key',
      // No fingerprint field
    })

    // Peer should be accepted (no verification when fingerprint is missing)
    expect(peerJoinedSpy).toHaveBeenCalledOnce()
    expect(peerJoinedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          username: 'old-client',
        }),
      })
    )
  })
})

describe('RoomSwarm — extractFingerprint', () => {
  it('extracts fingerprint from SDP', () => {
    const sdp = `v=0
o=- 123456 IN IP4 192.168.1.1
s=-
t=0 0
m=video 9 UDP/TLS/RTP/SAVPF 96
a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99
a=setup:actpass`

    const fingerprint = extractFingerprint(sdp)

    expect(fingerprint).toBe('aabbccddeeff00112233445566778899')
  })

  it('returns null if fingerprint is not found', () => {
    const sdp = `v=0
o=- 123456 IN IP4 192.168.1.1
s=-
t=0 0`

    const fingerprint = extractFingerprint(sdp)

    expect(fingerprint).toBeNull()
  })

  it('handles SDP with multiple fingerprint attributes (uses first)', () => {
    const sdp = `v=0
o=- 123456 IN IP4 192.168.1.1
s=-
m=video 9 UDP/TLS/RTP/SAVPF 96
a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00
m=audio 9 UDP/TLS/RTP/SAVPF 97
a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99`

    const fingerprint = extractFingerprint(sdp)

    expect(fingerprint).toBe('112233445566778899aabbccddeeff00')
  })
})

// I test seguenti richiedono un mocking più complesso di WebRTC/DataChannel
// e sono meglio coperti dai test di integrazione in Room.test.jsx
//
// describe('RoomSwarm — peer lifecycle', () => { ... })
// describe('RoomSwarm — message handling', () => { ... })
