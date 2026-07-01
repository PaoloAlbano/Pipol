/**
 * Room.test.jsx
 * Tests for Room.jsx covering:
 *   - initial rendering
 *   - call lifecycle (start / end)
 *   - incoming call modal (join / decline)
 *   - audio & video mute controls
 *   - sidebar & chat collapse/expand
 *   - leave room
 *   - swarm events (peer-joined, peer-left, call-init)
 *   - relay unreachable banner
 */

import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Room from '../../src/components/Room.jsx'
import { createRoomSwarm } from '../../src/p2p/swarm.js'
import * as media from '../../src/webrtc/media.js'

// ── Module mocks ──────────────────────────────────────────────────────────────

let swarmListeners = {}
let swarmMock

vi.mock('../../src/p2p/swarm.js', () => ({
  createRoomSwarm: vi.fn(),
}))

// MessageStore is instantiated with `new`, so the mock implementation must be
// a regular function (arrow functions cannot be used as constructors).
vi.mock('../../src/p2p/autobase.js', () => ({
  MessageStore: vi.fn().mockImplementation(function () {
    return {
      init: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      getHistory: vi.fn().mockResolvedValue([]),
      getLastTimestamp: vi.fn().mockResolvedValue(0),
      getLocalCoreKey: vi.fn().mockReturnValue('fake-key'),
      addMessage: vi.fn().mockResolvedValue({ id: '1', content: 'hi', timestamp: Date.now() }),
      close: vi.fn().mockResolvedValue(undefined),
    }
  }),
}))

vi.mock('../../src/webrtc/peer.js', () => ({ WebRTCPeer: vi.fn() }))

const mockGetLocalStream = vi.fn()
vi.mock('../../src/webrtc/media.js', () => ({
  getLocalStream: (...args) => mockGetLocalStream(...args),
  stopLocalStream: vi.fn(),
  setAudioMuted: vi.fn(),
  setVideoMuted: vi.fn(),
  pauseVideoTracks: vi.fn(),
  resumeVideoTracks: vi.fn().mockReturnValue(true),
  switchCamera: vi.fn(),
  startScreenShare: vi.fn(),
  stopScreenShare: vi.fn(),
}))

// ── jsdom stubs ───────────────────────────────────────────────────────────────

Object.defineProperty(HTMLVideoElement.prototype, 'srcObject', {
  set() {},
  get() {
    return null
  },
  configurable: true,
})

Object.defineProperty(document, 'pictureInPictureEnabled', {
  value: true,
  configurable: true,
})

// ── Default props ─────────────────────────────────────────────────────────────

const identity = { publicKey: 'aabb', secretKey: 'ccdd', username: 'alice' }

const defaultProps = {
  roomCode: 'test-room',
  identity,
  showStats: false,
  onLeave: vi.fn(),
  onOpenSettings: vi.fn(),
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetSwarmMock() {
  swarmListeners = {}
  swarmMock = {
    addEventListener: vi.fn((evt, cb) => {
      swarmListeners[evt] = cb
    }),
    removeEventListener: vi.fn(),
    sendToAll: vi.fn(),
    sendToPeer: vi.fn(),
    getPeers: vi.fn().mockReturnValue([]),
    leave: vi.fn().mockResolvedValue(undefined),
    peers: new Map(),
    _ws: { readyState: WebSocket.OPEN },
  }
  createRoomSwarm.mockResolvedValue(swarmMock)
}

/** Fire a swarm event by name. */
function fireSwarmEvent(name, detail = {}) {
  const handler = swarmListeners[name]
  if (!handler) throw new Error(`No swarm listener for '${name}'`)
  return handler({ detail })
}

/**
 * Render Room and wait for the swarm to finish connecting.
 * "waiting for peers…" appears right after attachSwarmListeners runs.
 */
async function setup(props = {}) {
  render(<Room {...defaultProps} {...props} />)
  await waitFor(() => screen.getByText(/waiting for peers/i))
}

/** Render Room, connect swarm, and start a video call. */
async function setupWithCall(props = {}) {
  mockGetLocalStream.mockResolvedValue(new MediaStream())
  await setup(props)
  await userEvent.click(screen.getByText(/start video call/i))
  await waitFor(() => screen.getByTitle(/mute microphone/i))
}

beforeEach(() => {
  resetSwarmMock()
  mockGetLocalStream.mockResolvedValue(new MediaStream())
})

// ── Initial rendering ─────────────────────────────────────────────────────────

describe('Room — initial rendering', () => {
  it('shows the room code in the sidebar', async () => {
    await setup()
    // Room code appears in both sidebar and mobile header
    expect(screen.getAllByText('test-room').length).toBeGreaterThan(0)
  })

  it("shows the user's own name in the participants list", async () => {
    await setup()
    expect(screen.getByText(/alice.*you/i)).toBeInTheDocument()
  })

  it('shows "Start Video Call" button when not in a call', async () => {
    await setup()
    expect(screen.getByText(/start video call/i)).toBeInTheDocument()
  })

  it('does not show VideoControls when not in a call', async () => {
    await setup()
    expect(screen.queryByTitle(/mute microphone/i)).toBeNull()
  })

  it('shows "waiting for peers…" status after connecting', async () => {
    await setup()
    expect(screen.getByText(/waiting for peers/i)).toBeInTheDocument()
  })
})

// ── Call lifecycle ────────────────────────────────────────────────────────────

describe('Room — call lifecycle', () => {
  it('calls getLocalStream when "Start Video Call" is clicked', async () => {
    await setup()
    await userEvent.click(screen.getByText(/start video call/i))
    expect(mockGetLocalStream).toHaveBeenCalled()
  })

  it('shows VideoControls after starting a call', async () => {
    await setupWithCall()
    expect(screen.getByTitle(/mute microphone/i)).toBeInTheDocument()
  })

  it('hides VideoControls and shows "Start Video Call" again after ending a call', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/leave video call/i))
    await waitFor(() => screen.getByText(/start video call/i))
    expect(screen.queryByTitle(/mute microphone/i)).toBeNull()
  })

  it('broadcasts CALL_INIT when starting a call', async () => {
    await setup()
    await userEvent.click(screen.getByText(/start video call/i))
    await waitFor(() =>
      expect(swarmMock.sendToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'CALL_INIT' }))
    )
  })

  it('broadcasts CALL_END when ending a call', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/leave video call/i))
    expect(swarmMock.sendToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'CALL_END' }))
  })
})

// ── Call duration timer ───────────────────────────────────────────────────────

describe('Room — call duration timer', () => {
  it('shows a timer (MM:SS) after starting a call', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockGetLocalStream.mockResolvedValue(new MediaStream())
      await setup()
      await userEvent.click(screen.getByText(/start video call/i))
      await waitFor(() => screen.getByTitle(/mute microphone/i))
      // Advance 2 seconds
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      await waitFor(() => screen.getByLabelText(/call duration/i))
      expect(screen.getByLabelText(/call duration/i).textContent).toMatch(/^\d{2}:\d{2}$/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('increments the timer each second', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockGetLocalStream.mockResolvedValue(new MediaStream())
      await setup()
      await userEvent.click(screen.getByText(/start video call/i))
      await waitFor(() => screen.getByTitle(/mute microphone/i))

      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
      await waitFor(() => screen.getByLabelText(/call duration/i))
      expect(screen.getByLabelText(/call duration/i).textContent).toBe('00:01')

      await act(async () => {
        vi.advanceTimersByTime(59000)
      })
      await waitFor(() => expect(screen.getByLabelText(/call duration/i).textContent).toBe('01:00'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes the timer when the call ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mockGetLocalStream.mockResolvedValue(new MediaStream())
      await setup()
      await userEvent.click(screen.getByText(/start video call/i))
      await waitFor(() => screen.getByTitle(/mute microphone/i))
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      await waitFor(() => screen.getByLabelText(/call duration/i))

      await userEvent.click(screen.getByTitle(/leave video call/i))
      await waitFor(() => screen.getByText(/start video call/i))
      expect(screen.queryByLabelText(/call duration/i)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── Incoming call modal ───────────────────────────────────────────────────────

describe('Room — incoming call modal', () => {
  it('shows the incoming call modal when a peer sends call-init', async () => {
    swarmMock.peers.set('peer-1', { username: 'bob' })
    await setup()

    await act(async () => {
      fireSwarmEvent('call-init', { peerId: 'peer-1' })
    })

    expect(screen.getByText(/bob has started a video call/i)).toBeInTheDocument()
  })

  it('dismisses the modal when "Decline" is clicked', async () => {
    swarmMock.peers.set('peer-1', { username: 'bob' })
    await setup()

    await act(async () => {
      fireSwarmEvent('call-init', { peerId: 'peer-1' })
    })

    await userEvent.click(screen.getByRole('button', { name: /decline/i }))
    expect(screen.queryByText(/has started a video call/i)).toBeNull()
  })

  it('dismisses the modal and starts the call when "Join" is clicked', async () => {
    swarmMock.peers.set('peer-1', { username: 'bob' })
    await setup()

    await act(async () => {
      fireSwarmEvent('call-init', { peerId: 'peer-1' })
    })

    // The modal has a "Join" button; pick the one inside the modal overlay
    const modal = screen.getByText(/has started a video call/i).closest('.call-modal')
    await userEvent.click(modal.querySelector('button'))
    await waitFor(() => expect(mockGetLocalStream).toHaveBeenCalled())
    expect(screen.queryByText(/has started a video call/i)).toBeNull()
  })
})

// ── Audio & video mute ────────────────────────────────────────────────────────

describe('Room — mute controls', () => {
  it('shows "Unmute" after muting the microphone', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/mute microphone/i))
    expect(screen.getByText('Unmute')).toBeInTheDocument()
  })

  it('shows "Mute" after unmuting the microphone', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/mute microphone/i))
    await userEvent.click(screen.getByTitle(/unmute microphone/i))
    expect(screen.getByText('Mute')).toBeInTheDocument()
  })

  it('shows "Cam on" after turning off the camera', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/turn off camera/i))
    expect(screen.getByText('Cam on')).toBeInTheDocument()
  })

  it('shows "Cam off" after turning the camera back on', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/turn off camera/i))
    await userEvent.click(screen.getByTitle(/turn on camera/i))
    expect(screen.getByText('Cam off')).toBeInTheDocument()
  })
})

// ── Sidebar & chat collapse ───────────────────────────────────────────────────

describe('Room — sidebar & chat collapse', () => {
  it('shows the expand button after collapsing the sidebar', async () => {
    await setup()
    await userEvent.click(screen.getByTitle(/collapse sidebar/i))
    expect(screen.getByTitle(/expand sidebar/i)).toBeInTheDocument()
  })

  it('shows the collapse button after expanding the sidebar', async () => {
    await setup()
    await userEvent.click(screen.getByTitle(/collapse sidebar/i))
    await userEvent.click(screen.getByTitle(/expand sidebar/i))
    expect(screen.getByTitle(/collapse sidebar/i)).toBeInTheDocument()
  })

  it('shows the expand button after collapsing the chat', async () => {
    await setup()
    await userEvent.click(screen.getByTitle(/collapse chat/i))
    expect(screen.getByTitle(/expand chat/i)).toBeInTheDocument()
  })

  it('shows the collapse button after expanding the chat', async () => {
    await setup()
    await userEvent.click(screen.getByTitle(/collapse chat/i))
    await userEvent.click(screen.getByTitle(/expand chat/i))
    expect(screen.getByTitle(/collapse chat/i)).toBeInTheDocument()
  })
})

// ── Leave room ────────────────────────────────────────────────────────────────

describe('Room — leave room', () => {
  it('calls onLeave when the leave button is clicked', async () => {
    const onLeave = vi.fn()
    await setup({ onLeave })
    // Leave room button exists in both sidebar and mobile header — click the first
    await userEvent.click(screen.getAllByTitle(/leave room/i)[0])
    expect(onLeave).toHaveBeenCalled()
  })

  it('broadcasts CALL_END before leaving when a call is active', async () => {
    const onLeave = vi.fn()
    await setupWithCall({ onLeave })
    await userEvent.click(screen.getAllByTitle(/leave room/i)[0])
    expect(swarmMock.sendToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'CALL_END' }))
    expect(onLeave).toHaveBeenCalled()
  })
})

// ── Swarm events ──────────────────────────────────────────────────────────────

describe('Room — swarm events', () => {
  it('adds a peer to the participants list when peer-joined fires', async () => {
    swarmMock.getPeers.mockReturnValue([{ id: 'peer-1', username: 'carol' }])
    await setup()

    await act(async () => {
      fireSwarmEvent('peer-joined', { id: 'peer-1' })
    })

    expect(screen.getByText('carol')).toBeInTheDocument()
  })

  it('removes a peer from the list when peer-left fires', async () => {
    swarmMock.getPeers.mockReturnValueOnce([{ id: 'peer-1', username: 'carol' }]).mockReturnValue([])
    await setup()

    await act(async () => {
      fireSwarmEvent('peer-joined', { id: 'peer-1' })
    })
    expect(screen.getByText('carol')).toBeInTheDocument()

    await act(async () => {
      fireSwarmEvent('peer-left', { id: 'peer-1' })
    })
    expect(screen.queryByText('carol')).toBeNull()
  })

  it('shows "call in progress" indicator when a remote peer is in a call', async () => {
    await setup()

    await act(async () => {
      fireSwarmEvent('call-init', { peerId: 'peer-1' })
    })

    expect(screen.getByText(/call in progress/i)).toBeInTheDocument()
  })

  it('updates status when swarm emits an error', async () => {
    await setup()

    await act(async () => {
      fireSwarmEvent('error', { message: 'something broke' })
    })

    expect(screen.getByText(/swarm error/i)).toBeInTheDocument()
  })

  it('shows the relay unreachable banner when createRoomSwarm rejects', async () => {
    createRoomSwarm.mockRejectedValueOnce(new Error('relay down'))
    render(<Room {...defaultProps} />)
    await waitFor(() => expect(screen.getByText(/cannot reach relay server/i)).toBeInTheDocument())
  })
})

// ── In-call button visibility & actions ──────────────────────────────────────

describe('Room — in-call button visibility', () => {
  it('hides the screen share button when getDisplayMedia is not supported', async () => {
    await setupWithCall()
    expect(screen.queryByTitle(/share screen/i)).toBeNull()
  })

  it('shows the screen share button when getDisplayMedia is supported', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([]) },
      configurable: true,
    })
    await setupWithCall()
    expect(screen.getByTitle(/share screen/i)).toBeInTheDocument()
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })

  it('hides the flip button when only one camera is available', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]),
      },
      configurable: true,
    })
    await setupWithCall()
    await waitFor(() => expect(screen.queryByTitle(/switch camera/i)).toBeNull())
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })

  it('shows the flip button when multiple cameras are available', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }, { kind: 'videoinput' }]),
      },
      configurable: true,
    })
    await setupWithCall()
    await waitFor(() => expect(screen.getByTitle(/switch camera/i)).toBeInTheDocument())
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })
})

describe('Room — in-call button actions', () => {
  it('calls setAudioMuted(true) when muting the microphone', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/mute microphone/i))
    expect(media.setAudioMuted).toHaveBeenCalledWith(true)
  })

  it('calls setAudioMuted(false) when unmuting the microphone', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/mute microphone/i))
    await userEvent.click(screen.getByTitle(/unmute microphone/i))
    expect(media.setAudioMuted).toHaveBeenCalledWith(false)
  })

  it('calls setVideoMuted(true) when turning off the camera', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/turn off camera/i))
    expect(media.setVideoMuted).toHaveBeenCalledWith(true)
  })

  it('calls setVideoMuted(false) when turning the camera back on', async () => {
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/turn off camera/i))
    await userEvent.click(screen.getByTitle(/turn on camera/i))
    expect(media.setVideoMuted).toHaveBeenCalledWith(false)
  })

  it('calls switchCamera when the flip button is clicked', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }, { kind: 'videoinput' }]),
      },
      configurable: true,
    })
    media.switchCamera.mockResolvedValue(null)
    await setupWithCall()
    await waitFor(() => expect(screen.getByTitle(/switch camera/i)).toBeInTheDocument())
    await userEvent.click(screen.getByTitle(/switch camera/i))
    expect(media.switchCamera).toHaveBeenCalled()
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })

  it('broadcasts SCREEN_SHARE_START and shows "Stop share" when screen sharing starts', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([]) },
      configurable: true,
    })
    const fakeTrack = Object.assign(new EventTarget(), { kind: 'video', stop: vi.fn() })
    const fakeStream = Object.assign(new MediaStream(), {})
    media.startScreenShare.mockResolvedValueOnce({ stream: fakeStream, screenTrack: fakeTrack })
    await setupWithCall()
    await userEvent.click(screen.getByTitle(/share screen/i))
    await waitFor(() =>
      expect(swarmMock.sendToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'SCREEN_SHARE_START' }))
    )
    expect(screen.getByTitle(/stop screen share/i)).toBeInTheDocument()
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })
})

// ── Thread panel ──────────────────────────────────────────────────────────────

describe('Room — thread panel', () => {
  // Thread tests need a proper Uint8Array publicKey so b4a.toString works in ChatMessages
  const threadIdentity = {
    publicKey: Uint8Array.from([0xaa, 0xbb]),
    secretKey: 'ccdd',
    username: 'alice',
  }

  it('opens the thread panel when a thread button is clicked', async () => {
    const { MessageStore } = await import('../../src/p2p/autobase.js')
    const parentMsg = {
      id: 'parent-1',
      content: 'Root message',
      username: 'alice',
      publicKey: 'aabb',
      timestamp: Date.now(),
      type: 'text',
    }
    MessageStore.mockImplementationOnce(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        getHistory: vi.fn().mockResolvedValue([parentMsg]),
        getLastTimestamp: vi.fn().mockResolvedValue(0),
        getLocalCoreKey: vi.fn().mockReturnValue('fake-key'),
        addMessage: vi.fn().mockResolvedValue({ id: '2', content: 'reply', timestamp: Date.now() }),
        close: vi.fn().mockResolvedValue(undefined),
      }
    })

    render(<Room {...defaultProps} identity={threadIdentity} />)
    await waitFor(() => screen.getByText(/waiting for peers/i))
    await waitFor(() => screen.getByText('Root message'))

    await userEvent.click(screen.getByRole('button', { name: /reply in thread/i }))

    expect(screen.getByLabelText('Thread')).toBeInTheDocument()
    expect(screen.getByText('Thread')).toBeInTheDocument()
  })

  it('closes the thread panel when the close button is clicked', async () => {
    const { MessageStore } = await import('../../src/p2p/autobase.js')
    const parentMsg = {
      id: 'parent-2',
      content: 'Another root',
      username: 'alice',
      publicKey: 'aabb',
      timestamp: Date.now(),
      type: 'text',
    }
    MessageStore.mockImplementationOnce(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        getHistory: vi.fn().mockResolvedValue([parentMsg]),
        getLastTimestamp: vi.fn().mockResolvedValue(0),
        getLocalCoreKey: vi.fn().mockReturnValue('fake-key'),
        addMessage: vi.fn().mockResolvedValue({ id: '3', content: 'reply', timestamp: Date.now() }),
        close: vi.fn().mockResolvedValue(undefined),
      }
    })

    render(<Room {...defaultProps} identity={threadIdentity} />)
    await waitFor(() => screen.getByText(/waiting for peers/i))
    await waitFor(() => screen.getByText('Another root'))
    await userEvent.click(screen.getByRole('button', { name: /reply in thread/i }))
    expect(screen.getByLabelText('Thread')).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText(/close thread/i))
    expect(screen.queryByLabelText('Thread')).not.toBeInTheDocument()
  })
})
