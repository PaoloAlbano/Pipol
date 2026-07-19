/**
 * useWorkspaceSync.test.js
 *
 * Unit-level tests for the mention-detection pathway.
 * Mocks RoomSwarm so the hook never actually opens a network connection;
 * instead we emit synthetic CustomEvents directly on the fake swarm instance
 * to exercise the `chat-message` → `onMentionNotify` path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ── Mocks (must be declared before importing the module under test) ────────────

let lastSwarm = null

vi.mock('../../src/p2p/swarm.js', () => {
  class FakeSwarm extends EventTarget {
    constructor() {
      super()
      this.joined = false
      this.sentMessages = []
      lastSwarm = this
    }
    join() {
      this.joined = true
      return Promise.resolve()
    }
    leave() {}
    sendToAll(msg) {
      this.sentMessages.push(msg)
    }
    sendToPeer() {}
  }
  return { RoomSwarm: FakeSwarm }
})

vi.mock('../../src/p2p/workspace.js', () => ({
  deriveSwarmTopic: vi.fn(() => 'fake-topic'),
  mergeChannelList: vi.fn((a, b) => [...a, ...b]),
  getWorkspaces: vi.fn(() => []),
  saveWorkspace: vi.fn(),
  getEffectiveConfig: vi.fn(() => ({ relayUrl: null })),
}))

vi.mock('../../src/p2p/dm-crypto.js', () => ({
  encryptDM: vi.fn(() => ({ nonce: new Uint8Array(), ciphertext: new Uint8Array() })),
}))

import { useWorkspaceSync } from '../../src/p2p/useWorkspaceSync.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKSPACE = {
  id: 'ws-test',
  secret: 'abc123',
  channels: [{ name: 'general', topic: '' }],
}

const IDENTITY = {
  publicKey: new Uint8Array([0xaa, 0xbb]),
  secretKey: new Uint8Array([0x11, 0x22]),
  username: 'alice',
}

function renderSync(hook, initialProps) {
  let result
  act(() => {
    result = renderHook(hook, { initialProps })
  })
  return result
}

// ── onMentionNotify — mention detection ───────────────────────────────────────

describe('useWorkspaceSync — onMentionNotify via chat-message', () => {
  beforeEach(() => {
    lastSwarm = null
  })

  it('calls onMentionNotify when a chat-message mentions the current user', async () => {
    const onMentionNotify = vi.fn()

    const { unmount } = renderHook(() =>
      useWorkspaceSync(
        WORKSPACE,
        IDENTITY,
        undefined, // onChannelsUpdated
        undefined, // onChannelNotify
        undefined, // onDMOpen
        onMentionNotify
      )
    )

    // Let the join promise resolve so the swarm is fully set up.
    await act(async () => {})

    expect(lastSwarm).not.toBeNull()

    act(() => {
      lastSwarm.dispatchEvent(
        new CustomEvent('chat-message', {
          detail: {
            channelName: 'general',
            message: { id: '1', content: 'hey @alice can you help?' },
          },
        })
      )
    })

    expect(onMentionNotify).toHaveBeenCalledTimes(1)
    expect(onMentionNotify).toHaveBeenCalledWith(
      'general',
      expect.objectContaining({ content: 'hey @alice can you help?' })
    )

    unmount()
  })

  it('does NOT call onMentionNotify when the message does not mention the user', async () => {
    const onMentionNotify = vi.fn()

    const { unmount } = renderHook(() =>
      useWorkspaceSync(WORKSPACE, IDENTITY, undefined, undefined, undefined, onMentionNotify)
    )
    await act(async () => {})

    act(() => {
      lastSwarm.dispatchEvent(
        new CustomEvent('chat-message', {
          detail: {
            channelName: 'general',
            message: { id: '2', content: 'hello everyone' },
          },
        })
      )
    })

    expect(onMentionNotify).not.toHaveBeenCalled()
    unmount()
  })

  it('does NOT call onMentionNotify for a partial username match (@alic does not trigger alice)', async () => {
    const onMentionNotify = vi.fn()

    const { unmount } = renderHook(() =>
      useWorkspaceSync(WORKSPACE, IDENTITY, undefined, undefined, undefined, onMentionNotify)
    )
    await act(async () => {})

    act(() => {
      lastSwarm.dispatchEvent(
        new CustomEvent('chat-message', {
          detail: {
            channelName: 'general',
            message: { id: '3', content: 'pinging @alicex not alice' },
          },
        })
      )
    })

    expect(onMentionNotify).not.toHaveBeenCalled()
    unmount()
  })

  it('works without onMentionNotify provided (does not throw)', async () => {
    const { unmount } = renderHook(() =>
      useWorkspaceSync(WORKSPACE, IDENTITY, undefined, undefined, undefined, undefined)
    )
    await act(async () => {})

    expect(() => {
      act(() => {
        lastSwarm.dispatchEvent(
          new CustomEvent('chat-message', {
            detail: {
              channelName: 'general',
              message: { id: '4', content: 'hey @alice!' },
            },
          })
        )
      })
    }).not.toThrow()

    unmount()
  })
})

// ── onChannelNotify via channel-notify ────────────────────────────────────────

describe('useWorkspaceSync — onChannelNotify via channel-notify', () => {
  beforeEach(() => {
    lastSwarm = null
  })

  it('calls onChannelNotify when a channel-notify event is received', async () => {
    const onChannelNotify = vi.fn()
    const { unmount } = renderHook(() => useWorkspaceSync(WORKSPACE, IDENTITY, undefined, onChannelNotify))
    await act(async () => {})

    act(() => {
      lastSwarm.dispatchEvent(new CustomEvent('channel-notify', { detail: { channelName: 'general' } }))
    })

    expect(onChannelNotify).toHaveBeenCalledWith('general')
    unmount()
  })

  it('does not call onChannelNotify when channelName is missing', async () => {
    const onChannelNotify = vi.fn()
    const { unmount } = renderHook(() => useWorkspaceSync(WORKSPACE, IDENTITY, undefined, onChannelNotify))
    await act(async () => {})

    act(() => {
      lastSwarm.dispatchEvent(new CustomEvent('channel-notify', { detail: {} }))
    })

    expect(onChannelNotify).not.toHaveBeenCalled()
    unmount()
  })
})

// ── member presence ───────────────────────────────────────────────────────────

describe('useWorkspaceSync — member presence', () => {
  beforeEach(() => {
    lastSwarm = null
  })

  it('adds a member when member-hello is received', async () => {
    const { result, unmount } = renderHook(() => useWorkspaceSync(WORKSPACE, IDENTITY))
    await act(async () => {})

    act(() => {
      lastSwarm.dispatchEvent(
        new CustomEvent('member-hello', {
          detail: { pubkey: 'aabbcc', username: 'bob', status: 'online' },
        })
      )
    })

    expect(result.current.members.get('aabbcc')).toMatchObject({ username: 'bob', status: 'online' })
    unmount()
  })

  it('updates member status when presence-update is received', async () => {
    const { result, unmount } = renderHook(() => useWorkspaceSync(WORKSPACE, IDENTITY))
    await act(async () => {})

    // First, register the member
    act(() => {
      lastSwarm.dispatchEvent(
        new CustomEvent('member-hello', { detail: { pubkey: 'dd1122', username: 'carol', status: 'online' } })
      )
    })

    // Then update their presence
    act(() => {
      lastSwarm.dispatchEvent(new CustomEvent('presence-update', { detail: { pubkey: 'dd1122', status: 'away' } }))
    })

    expect(result.current.members.get('dd1122')).toMatchObject({ status: 'away' })
    unmount()
  })

  it('ignores presence-update when pubkey or status is missing', async () => {
    const { result, unmount } = renderHook(() => useWorkspaceSync(WORKSPACE, IDENTITY))
    await act(async () => {})

    act(() => {
      lastSwarm.dispatchEvent(new CustomEvent('presence-update', { detail: { pubkey: null, status: null } }))
    })

    expect(result.current.members.size).toBe(0)
    unmount()
  })
})
