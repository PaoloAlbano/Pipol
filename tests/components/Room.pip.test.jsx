/**
 * Room.pip.test.jsx
 * Tests Picture-in-Picture behavior in Room:
 *   - auto-trigger on visibilitychange (Document PiP + standard PiP fallback)
 *   - manual PiP button (open / close toggle)
 *   - guard conditions (no video, no call, window already open)
 */

import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Room from '../../src/components/Room.jsx'

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/p2p/swarm.js', () => ({
  createRoomSwarm: vi.fn().mockResolvedValue({
    addEventListener: vi.fn(),
    sendToAll: vi.fn(),
    sendToPeer: vi.fn(),
    getPeers: vi.fn().mockReturnValue([]),
    leave: vi.fn().mockResolvedValue(undefined),
    peers: new Map(),
  }),
}))

vi.mock('../../src/p2p/autobase.js', () => ({
  MessageStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    getLastTimestamp: vi.fn().mockResolvedValue(0),
    getLocalCoreKey: vi.fn().mockReturnValue('fake-key'),
    addMessage: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  })),
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

// VideoControls shows the PiP button only when document.pictureInPictureEnabled=true
beforeEach(() => {
  Object.defineProperty(document, 'pictureInPictureEnabled', {
    value: true,
    configurable: true,
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const defaultProps = {
  roomCode: 'TEST123',
  identity: { publicKey: 'aabb', secretKey: 'ccdd', username: 'tester' },
  showStats: false,
  onLeave: vi.fn(),
  onOpenSettings: vi.fn(),
}

/** Minimal mock for a Document PiP window returned by requestWindow(). */
function makeFakePiPWindow() {
  const pagehideListeners = []
  function makeEl() {
    const el = {
      style: { cssText: '' },
      appendChild: vi.fn(),
      addEventListener: vi.fn(),
      querySelector: vi.fn().mockReturnValue(null),
      insertBefore: vi.fn(),
    }
    // Allow innerHTML / textContent assignments (used by makeBtn)
    Object.defineProperty(el, 'innerHTML', {
      get() {
        return this._html ?? ''
      },
      set(v) {
        this._html = v
      },
      configurable: true,
    })
    Object.defineProperty(el, 'textContent', {
      get() {
        return this._text ?? ''
      },
      set(v) {
        this._text = v
      },
      configurable: true,
    })
    return el
  }

  const win = {
    document: {
      documentElement: { style: { cssText: '' } },
      body: {
        style: { cssText: '' },
        appendChild: vi.fn(),
      },
      createElement: vi.fn().mockImplementation(() => makeEl()),
    },
    addEventListener: vi.fn((evt, cb) => {
      if (evt === 'pagehide') pagehideListeners.push(cb)
    }),
    close: vi.fn(() => {
      win.closed = true
      pagehideListeners.forEach((cb) => cb())
    }),
    closed: false,
    _firePagehide() {
      pagehideListeners.forEach((cb) => cb())
    },
  }
  return win
}

// Track manually injected video elements so they can be removed after each test.
// React's cleanup() only unmounts the React tree; elements appended to document.body
// directly are not removed automatically.
const _injectedVideos = []
afterEach(() => {
  _injectedVideos.forEach((v) => v.remove())
  _injectedVideos.length = 0
})

/**
 * Add a <video class="video-element"> to document.body with readyState=1
 * so that getPiPVideo() inside Room will find it.
 * Returns the element (automatically removed after the test).
 */
function injectVideoElement({ muted = false } = {}) {
  const video = document.createElement('video')
  video.className = 'video-element'
  video.muted = muted
  Object.defineProperty(video, 'readyState', { value: 1, configurable: true })
  // Provide a no-op stub so the fallback path never throws "not a function"
  video.requestPictureInPicture = vi.fn().mockResolvedValue(undefined)
  document.body.appendChild(video)
  _injectedVideos.push(video)
  return video
}

/** Set document.visibilityState and fire visibilitychange. */
function setVisibilityState(state) {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
    writable: false,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/**
 * Render Room and activate a call by clicking "Start Video Call".
 * Waits until VideoControls (mute button) is mounted, confirming callActive=true.
 */
async function renderWithActiveCall(extraProps = {}) {
  mockGetLocalStream.mockResolvedValue(new MediaStream())
  const user = userEvent.setup()
  render(<Room {...defaultProps} {...extraProps} />)
  await waitFor(() => screen.getByText(/start video call/i))
  await user.click(screen.getByText(/start video call/i))
  await waitFor(() => screen.getByTitle(/mute microphone/i))
  return { user }
}

// ── Auto-trigger: Document PiP ────────────────────────────────────────────────

describe('Room PiP — auto-trigger Document PiP on tab hide', () => {
  let requestWindow

  beforeEach(() => {
    const pipWin = makeFakePiPWindow()
    requestWindow = vi.fn().mockResolvedValue(pipWin)
    window.documentPictureInPicture = { requestWindow }
  })

  afterEach(() => {
    delete window.documentPictureInPicture
    setVisibilityState('visible')
  })

  it('calls requestWindow when tab is hidden during an active call', async () => {
    await renderWithActiveCall()
    injectVideoElement()

    await act(async () => {
      setVisibilityState('hidden')
    })

    expect(requestWindow).toHaveBeenCalled()
  })

  it('does NOT call requestWindow when the tab becomes visible', async () => {
    await renderWithActiveCall()
    injectVideoElement()

    await act(async () => {
      setVisibilityState('visible')
    })

    expect(requestWindow).not.toHaveBeenCalled()
  })

  it('does NOT call requestWindow when no call is active', async () => {
    mockGetLocalStream.mockResolvedValue(new MediaStream())
    render(<Room {...defaultProps} />)
    await waitFor(() => screen.getByText(/start video call/i))
    // Do NOT click start call — callActive remains false
    injectVideoElement()

    await act(async () => {
      setVisibilityState('hidden')
    })

    expect(requestWindow).not.toHaveBeenCalled()
  })

  it('does NOT call requestWindow when no video element is present', async () => {
    await renderWithActiveCall()
    // Do not inject any video element

    await act(async () => {
      setVisibilityState('hidden')
    })

    expect(requestWindow).not.toHaveBeenCalled()
  })

  it('does NOT call requestWindow when a PiP window is already open', async () => {
    await renderWithActiveCall()
    injectVideoElement()

    // First hide → opens PiP
    await act(async () => {
      setVisibilityState('hidden')
    })
    expect(requestWindow).toHaveBeenCalledTimes(1)

    // Restore visibility then hide again
    setVisibilityState('visible')
    await act(async () => {
      setVisibilityState('hidden')
    })

    // requestWindow should not be called a second time (window already open)
    expect(requestWindow).toHaveBeenCalledTimes(1)
  })
})

// ── Auto-trigger: standard PiP fallback ──────────────────────────────────────

describe('Room PiP — auto-trigger falls back to standard PiP', () => {
  beforeEach(() => {
    // documentPictureInPicture not available in this suite
    delete window.documentPictureInPicture
  })

  afterEach(() => {
    setVisibilityState('visible')
  })

  it('calls requestPictureInPicture on the video element when Document PiP is unavailable', async () => {
    await renderWithActiveCall()
    const video = injectVideoElement()
    const requestPiP = vi.fn().mockResolvedValue(undefined)
    video.requestPictureInPicture = requestPiP

    await act(async () => {
      setVisibilityState('hidden')
    })

    expect(requestPiP).toHaveBeenCalled()
  })

  it('does NOT call requestPictureInPicture when pictureInPictureElement is already active', async () => {
    await renderWithActiveCall()
    const video = injectVideoElement()
    const requestPiP = vi.fn().mockResolvedValue(undefined)
    video.requestPictureInPicture = requestPiP

    // Simulate an already-active standard PiP session
    Object.defineProperty(document, 'pictureInPictureElement', {
      value: video,
      configurable: true,
    })

    await act(async () => {
      setVisibilityState('hidden')
    })

    expect(requestPiP).not.toHaveBeenCalled()

    // Cleanup
    Object.defineProperty(document, 'pictureInPictureElement', {
      value: null,
      configurable: true,
    })
  })
})

// ── Manual PiP button ─────────────────────────────────────────────────────────

describe('Room PiP — manual button', () => {
  let requestWindow
  let pipWin

  beforeEach(() => {
    pipWin = makeFakePiPWindow()
    requestWindow = vi.fn().mockResolvedValue(pipWin)
    window.documentPictureInPicture = { requestWindow }
  })

  afterEach(() => {
    delete window.documentPictureInPicture
    setVisibilityState('visible')
  })

  it('opens Document PiP when the PiP button is clicked', async () => {
    const { user } = await renderWithActiveCall()
    injectVideoElement()

    await user.click(screen.getByTitle(/open picture-in-picture/i))
    await waitFor(() => expect(requestWindow).toHaveBeenCalled())
  })

  it('closes the PiP window when the button is clicked while PiP is open', async () => {
    const { user } = await renderWithActiveCall()
    injectVideoElement()

    // Open PiP
    await user.click(screen.getByTitle(/open picture-in-picture/i))
    await waitFor(() => expect(requestWindow).toHaveBeenCalled())

    // Close PiP
    await user.click(screen.getByTitle(/close picture-in-picture/i))
    expect(pipWin.close).toHaveBeenCalled()
  })

  it('shows the PiP button only when pictureInPictureEnabled=true', async () => {
    Object.defineProperty(document, 'pictureInPictureEnabled', {
      value: true,
      configurable: true,
    })
    await renderWithActiveCall()
    expect(screen.getByTitle(/open picture-in-picture/i)).toBeInTheDocument()
  })

  it('hides the PiP button when pictureInPictureEnabled=false', async () => {
    Object.defineProperty(document, 'pictureInPictureEnabled', {
      value: false,
      configurable: true,
    })
    await renderWithActiveCall()
    expect(screen.queryByTitle(/picture-in-picture/i)).toBeNull()
  })
})
