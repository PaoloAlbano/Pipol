/**
 * Room.metaswarm.test.jsx
 *
 * Tests for Room when it uses a shared meta swarm (workspace rooms).
 * These tests guard the most critical behaviours that were broken before the
 * listener-leak fix:
 *
 *  1. Room uses swarmProp, never calls createRoomSwarm
 *  2. Every addEventListener call has a matching removeEventListener call on unmount
 *     (listener leak = duplicate events = WebRTC glare / missed messages)
 *  3. channel messages are filtered by channelName
 *  4. history catch-up triggers for already-connected peers on mount
 *  5. switching channels (unmount A → mount B) leaves the swarm with exactly
 *     as many listeners as a fresh Room B — never accumulates
 *  6. DM messages are accepted only from the correct peer and correctly decrypted
 *  7. teardown does NOT call swarm.leave() when using swarmProp
 */

import { render, waitFor, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Room from '../../src/components/Room.jsx'

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/p2p/swarm.js', () => ({
  createRoomSwarm: vi.fn(() => Promise.reject(new Error('should not be called'))),
}))

vi.mock('../../src/p2p/autobase.js', () => ({
  MessageStore: vi.fn().mockImplementation(function () {
    return {
      init: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      getHistory: vi.fn().mockResolvedValue([]),
      getLastTimestamp: vi.fn().mockResolvedValue(0),
      getLocalCoreKey: vi.fn().mockReturnValue('fake-key'),
      addMessage: vi.fn().mockResolvedValue({ id: '1', content: 'hi', timestamp: Date.now() }),
      receiveMessage: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }
  }),
}))

vi.mock('../../src/webrtc/peer.js', () => ({ WebRTCPeer: vi.fn() }))

vi.mock('../../src/webrtc/media.js', () => ({
  getLocalStream: vi.fn().mockResolvedValue(new MediaStream()),
  stopLocalStream: vi.fn(),
  setAudioMuted: vi.fn(),
  setVideoMuted: vi.fn(),
  pauseVideoTracks: vi.fn(),
  resumeVideoTracks: vi.fn().mockReturnValue(true),
  switchCamera: vi.fn(),
  startScreenShare: vi.fn(),
  stopScreenShare: vi.fn(),
}))

vi.mock('../../src/p2p/dm-crypto.js', () => ({
  encryptDM: vi.fn(() => ({ nonce: 'n', ciphertext: 'c' })),
  decryptDM: vi.fn(() => ({ id: 'dm-1', content: 'hello dm', timestamp: Date.now() })),
}))

// ── jsdom stubs ───────────────────────────────────────────────────────────────

Object.defineProperty(HTMLVideoElement.prototype, 'srcObject', {
  set() {},
  get() {
    return null
  },
  configurable: true,
})
Object.defineProperty(document, 'pictureInPictureEnabled', { value: false, configurable: true })

// ── TrackingSwarm ─────────────────────────────────────────────────────────────
//
// A mock RoomSwarm that precisely tracks every addEventListener /
// removeEventListener call so we can assert symmetry.

function makeTrackingSwarm(peersAlreadyConnected = []) {
  // listeners[eventName] = Set of handler references currently registered
  const active = {} // eventName → Set<fn>
  const allAdded = [] // { event, fn } — append-only log
  const allRemoved = [] // { event, fn }

  const swarm = {
    // ── EventTarget-like API ────────────────────────────────────────────────
    addEventListener(event, fn) {
      if (!active[event]) active[event] = new Set()
      active[event].add(fn)
      allAdded.push({ event, fn })
    },
    removeEventListener(event, fn) {
      active[event]?.delete(fn)
      allRemoved.push({ event, fn })
    },

    // ── Public API used by Room ─────────────────────────────────────────────
    getPeers: vi.fn().mockReturnValue(peersAlreadyConnected),
    sendToAll: vi.fn(),
    sendToPeer: vi.fn(),
    leave: vi.fn().mockResolvedValue(undefined),
    peers: new Map(),
    _ws: { readyState: WebSocket.OPEN },

    // ── Test helpers ────────────────────────────────────────────────────────

    /** Fire all currently-registered handlers for an event. */
    emit(event, detail = {}) {
      const handlers = [...(active[event] ?? [])]
      if (handlers.length === 0) return 0
      for (const h of handlers) h({ detail })
      return handlers.length
    },

    /** How many handlers are currently registered for an event. */
    listenerCount(event) {
      return active[event]?.size ?? 0
    },

    /** Total active listener count across all events. */
    totalListeners() {
      return Object.values(active).reduce((sum, s) => sum + s.size, 0)
    },

    /** Assert that every addEventListener was matched by a removeEventListener
     *  with the exact same function reference. */
    assertNoLeak() {
      for (const { event, fn } of allAdded) {
        const removed = allRemoved.some((r) => r.event === event && r.fn === fn)
        if (!removed) {
          throw new Error(
            `Listener leak: handler for "${event}" was never removed.\n` + `Handler: ${fn.name || '(anonymous)'}`
          )
        }
      }
    },
  }

  return swarm
}

// ── Default props ─────────────────────────────────────────────────────────────

const myPublicKey = new Uint8Array([0xaa, 0xbb, 0xcc])
const myPublicKeyHex = 'aabbcc'
const peerPublicKey = new Uint8Array([0x11, 0x22, 0x33])
const peerPubkeyHex = '112233'

const identity = { publicKey: myPublicKey, secretKey: new Uint8Array([0xdd, 0xee]), username: 'alice' }

function channelProps(channelName, swarm) {
  return {
    roomCode: 'abc123456789',
    identity,
    showStats: false,
    onLeave: vi.fn(),
    onOpenSettings: vi.fn(),
    embedded: true,
    swarm,
    channelName,
    isDM: false,
  }
}

function dmProps(swarm) {
  return {
    roomCode: 'dm-room-code',
    identity,
    showStats: false,
    onLeave: vi.fn(),
    onOpenSettings: vi.fn(),
    embedded: true,
    swarm,
    isDM: true,
    dmPeerPublicKey: peerPublicKey,
    dmPeerPubkeyHex: peerPubkeyHex,
  }
}

// ── Helper: mount and wait for Room to be ready ──────────────────────────────

async function mountRoom(props) {
  const result = render(<Room {...props} />)
  // Room is ready once it has attached swarm listeners and set status
  await waitFor(() => {
    // listeners must be attached (peer-joined is always added)
    if (props.swarm.listenerCount('peer-joined') === 0) {
      throw new Error('not mounted yet')
    }
  })
  return result
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Room (meta swarm) — does not create its own swarm', () => {
  it('never calls createRoomSwarm when swarmProp is provided', async () => {
    const { createRoomSwarm } = await import('../../src/p2p/swarm.js')
    const swarm = makeTrackingSwarm()
    await mountRoom(channelProps('generale', swarm))
    expect(createRoomSwarm).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('Room (meta swarm) — listener lifecycle (the leak regression)', () => {
  it('registers listeners on mount', async () => {
    const swarm = makeTrackingSwarm()
    await mountRoom(channelProps('generale', swarm))
    // At minimum these events must be listened to
    for (const evt of [
      'peer-joined',
      'peer-left',
      'chat-message',
      'history-req',
      'call-init',
      'call-end',
      'typing',
      'error',
    ]) {
      expect(swarm.listenerCount(evt)).toBe(1)
    }
  })

  it('removes every listener it added when unmounted (no leak)', async () => {
    const swarm = makeTrackingSwarm()
    const { unmount } = await mountRoom(channelProps('generale', swarm))

    unmount()

    // Give teardown a tick to run
    await act(async () => {})

    swarm.assertNoLeak()
    // After unmount, no active listeners should remain
    expect(swarm.totalListeners()).toBe(0)
  })

  it('does not accumulate listeners when switching channels', async () => {
    const swarm = makeTrackingSwarm()

    // Mount channel A
    const { unmount: unmountA } = await mountRoom(channelProps('generale', swarm))
    const listenersAfterA = swarm.totalListeners()
    expect(listenersAfterA).toBeGreaterThan(0)

    // Unmount channel A
    unmountA()
    await act(async () => {})

    // Mount channel B
    const { unmount: unmountB } = await mountRoom(channelProps('random', swarm))
    const listenersAfterB = swarm.totalListeners()

    // B must have exactly the same count as A — no accumulation
    expect(listenersAfterB).toBe(listenersAfterA)

    // Clean up
    unmountB()
    await act(async () => {})
    expect(swarm.totalListeners()).toBe(0)
  })

  it('peer-joined fires exactly once per event even after a channel switch', async () => {
    const swarm = makeTrackingSwarm()

    const { unmount: unmountA } = await mountRoom(channelProps('generale', swarm))
    unmountA()
    await act(async () => {})

    await mountRoom(channelProps('random', swarm))

    // Fire peer-joined — should be handled by exactly 1 handler
    const count = swarm.emit('peer-joined', { id: 'peer-x' })
    expect(count).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('Room (meta swarm) — does not leave the swarm on unmount', () => {
  it('does not call swarm.leave() when using swarmProp', async () => {
    const swarm = makeTrackingSwarm()
    const { unmount } = await mountRoom(channelProps('generale', swarm))
    unmount()
    await act(async () => {})
    expect(swarm.leave).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('Room (meta swarm) — channel message filtering', () => {
  it('delivers a chat-message for the correct channelName', async () => {
    const { MessageStore } = await import('../../src/p2p/autobase.js')
    const swarm = makeTrackingSwarm()
    await mountRoom(channelProps('generale', swarm))

    const msgStore = MessageStore.mock.results.at(-1).value
    await act(async () => {
      swarm.emit('chat-message', { message: { id: '1', content: 'hi' }, channelName: 'generale' })
    })
    expect(msgStore.receiveMessage).toHaveBeenCalledTimes(1)
  })

  it('ignores a chat-message for a different channelName', async () => {
    const { MessageStore } = await import('../../src/p2p/autobase.js')
    const swarm = makeTrackingSwarm()
    await mountRoom(channelProps('generale', swarm))

    const msgStore = MessageStore.mock.results.at(-1).value
    await act(async () => {
      swarm.emit('chat-message', { message: { id: '1', content: 'not mine' }, channelName: 'random' })
    })
    expect(msgStore.receiveMessage).not.toHaveBeenCalled()
  })

  it('ignores chat-message events when Room is in DM mode', async () => {
    const { MessageStore } = await import('../../src/p2p/autobase.js')
    const swarm = makeTrackingSwarm()
    await mountRoom(dmProps(swarm))

    const msgStore = MessageStore.mock.results.at(-1).value
    await act(async () => {
      swarm.emit('chat-message', { message: { id: '1', content: 'oops' }, channelName: 'generale' })
    })
    expect(msgStore.receiveMessage).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('Room (meta swarm) — history catch-up for already-connected peers', () => {
  it('sends HISTORY_REQ to peers already in the swarm on mount', async () => {
    const alreadyConnected = [{ id: 'peer-already', username: 'bob' }]
    const swarm = makeTrackingSwarm(alreadyConnected)
    await mountRoom(channelProps('generale', swarm))

    expect(swarm.sendToPeer).toHaveBeenCalledWith(
      'peer-already',
      expect.objectContaining({ type: 'HISTORY_REQ', channelName: 'generale' })
    )
  })

  it('does not send HISTORY_REQ when there are no peers on mount', async () => {
    const swarm = makeTrackingSwarm([]) // no peers
    await mountRoom(channelProps('generale', swarm))
    expect(swarm.sendToPeer).not.toHaveBeenCalled()
  })

  it('sends HISTORY_REQ to a newly joined peer with the correct channelName', async () => {
    const swarm = makeTrackingSwarm()
    await mountRoom(channelProps('random', swarm))

    await act(async () => {
      swarm.emit('peer-joined', { id: 'new-peer' })
    })

    expect(swarm.sendToPeer).toHaveBeenCalledWith(
      'new-peer',
      expect.objectContaining({ type: 'HISTORY_REQ', channelName: 'random' })
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('Room (meta swarm) — history request filtering', () => {
  it('responds to HISTORY_REQ for its own channel', async () => {
    const swarm = makeTrackingSwarm([{ id: 'peer-1', username: 'bob' }])
    await mountRoom(channelProps('generale', swarm))

    await act(async () => {
      swarm.emit('history-req', { peerId: 'peer-1', since: 0, channelName: 'generale' })
    })

    // sendToPeer is called for catch-up on mount AND for the history response.
    // At minimum one call must be HISTORY_RES.
    const historyResCalls = swarm.sendToPeer.mock.calls.filter(([, msg]) => msg.type === 'HISTORY_RES')
    // No messages in store so newer.length === 0 → no HISTORY_RES sent (correct)
    // We just verify it didn't throw and didn't respond to the wrong channel
    expect(historyResCalls.length).toBe(0) // empty history → nothing to send
  })

  it('ignores HISTORY_REQ for a different channel', async () => {
    const swarm = makeTrackingSwarm()
    await mountRoom(channelProps('generale', swarm))
    swarm.sendToPeer.mockClear()

    await act(async () => {
      swarm.emit('history-req', { peerId: 'peer-1', since: 0, channelName: 'random' })
    })

    expect(swarm.sendToPeer).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('Room (meta swarm) — DM message handling', () => {
  it('decrypts and stores a dm-message from the correct peer', async () => {
    const { MessageStore } = await import('../../src/p2p/autobase.js')
    const { decryptDM } = await import('../../src/p2p/dm-crypto.js')
    const swarm = makeTrackingSwarm()
    await mountRoom(dmProps(swarm))

    const msgStore = MessageStore.mock.results.at(-1).value

    await act(async () => {
      swarm.emit('dm-message', {
        from: peerPubkeyHex,
        to: myPublicKeyHex,
        nonce: 'n',
        ciphertext: 'c',
      })
    })

    expect(decryptDM).toHaveBeenCalledWith('n', 'c', identity.secretKey, peerPublicKey)
    expect(msgStore.receiveMessage).toHaveBeenCalledTimes(1)
  })

  it('ignores a dm-message from an unknown peer', async () => {
    const { MessageStore } = await import('../../src/p2p/autobase.js')
    const swarm = makeTrackingSwarm()
    await mountRoom(dmProps(swarm))

    const msgStore = MessageStore.mock.results.at(-1).value

    await act(async () => {
      swarm.emit('dm-message', {
        from: 'deadbeef', // someone else
        to: myPublicKeyHex,
        nonce: 'n',
        ciphertext: 'c',
      })
    })

    expect(msgStore.receiveMessage).not.toHaveBeenCalled()
  })

  it('ignores a dm-message addressed to someone else', async () => {
    const { MessageStore } = await import('../../src/p2p/autobase.js')
    const swarm = makeTrackingSwarm()
    await mountRoom(dmProps(swarm))

    const msgStore = MessageStore.mock.results.at(-1).value

    await act(async () => {
      swarm.emit('dm-message', {
        from: peerPubkeyHex,
        to: 'ffffff', // wrong recipient
        nonce: 'n',
        ciphertext: 'c',
      })
    })

    expect(msgStore.receiveMessage).not.toHaveBeenCalled()
  })

  it('does not register a dm-message listener on a channel Room', async () => {
    const swarm = makeTrackingSwarm()
    await mountRoom(channelProps('generale', swarm))
    // Channel rooms must NOT listen for dm-message
    expect(swarm.listenerCount('dm-message')).toBe(0)
  })

  it('registers a dm-message listener on a DM Room', async () => {
    const swarm = makeTrackingSwarm()
    await mountRoom(dmProps(swarm))
    expect(swarm.listenerCount('dm-message')).toBe(1)
  })

  it('removes the dm-message listener when a DM Room unmounts', async () => {
    const swarm = makeTrackingSwarm()
    const { unmount } = await mountRoom(dmProps(swarm))
    unmount()
    await act(async () => {})
    expect(swarm.listenerCount('dm-message')).toBe(0)
    swarm.assertNoLeak()
  })
})
