/**
 * PiPOverlay.test.jsx
 * Tests the Document Picture-in-Picture overlay: video tiles and control buttons.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PiPOverlay from '../../src/components/PiPOverlay.jsx'

// jsdom does not support HTMLVideoElement.srcObject
Object.defineProperty(HTMLVideoElement.prototype, 'srcObject', {
  set() {},
  get() {
    return null
  },
  configurable: true,
})

function makeFakeStream() {
  return { id: Math.random().toString() }
}

function setup(overrides = {}) {
  const defaults = {
    localStream: makeFakeStream(),
    remoteStreams: {},
    peers: [],
    audioMuted: false,
    videoMuted: false,
    onToggleAudio: vi.fn(),
    onToggleVideo: vi.fn(),
  }
  const props = { ...defaults, ...overrides }
  render(<PiPOverlay {...props} />)
  return props
}

// ── Video tiles ───────────────────────────────────────────────────────────────

describe('PiPOverlay — video tiles', () => {
  it('shows local "You" tile when there are no remote peers', () => {
    setup()
    expect(screen.getByText('You')).toBeInTheDocument()
  })

  it('shows remote peer tiles when present', () => {
    const peers = [{ id: 'p1', username: 'alice' }]
    setup({ peers, remoteStreams: { p1: makeFakeStream() } })
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.queryByText('You')).toBeNull()
  })

  it('shows multiple remote tiles', () => {
    const peers = [
      { id: 'p1', username: 'alice' },
      { id: 'p2', username: 'bob' },
    ]
    setup({
      peers,
      remoteStreams: { p1: makeFakeStream(), p2: makeFakeStream() },
    })
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  it('falls back to first 8 chars of peer id when username is not found', () => {
    const peers = [{ id: 'abcdefghij', username: 'alice' }]
    // remoteStreams has an id not present in peers
    setup({
      peers,
      remoteStreams: { '12345678xx': makeFakeStream() },
    })
    expect(screen.getByText('12345678')).toBeInTheDocument()
  })

  it('shows 👤 placeholder when stream is null', () => {
    setup({ localStream: null })
    expect(screen.getByText('👤')).toBeInTheDocument()
  })
})

// ── Audio / video buttons ─────────────────────────────────────────────────────

describe('PiPOverlay — audio/video buttons', () => {
  it('shows the mute microphone button', () => {
    setup()
    expect(screen.getByTitle(/mute microphone/i)).toBeInTheDocument()
  })

  it('shows the camera button', () => {
    setup()
    expect(screen.getByTitle(/turn off camera/i)).toBeInTheDocument()
  })

  it('shows "Unmute" when audioMuted=true', () => {
    setup({ audioMuted: true })
    expect(screen.getByText('Unmute')).toBeInTheDocument()
  })

  it('shows "Mute" when audioMuted=false', () => {
    setup({ audioMuted: false })
    expect(screen.getByText('Mute')).toBeInTheDocument()
  })

  it('shows "Cam on" when videoMuted=true', () => {
    setup({ videoMuted: true })
    expect(screen.getByText('Cam on')).toBeInTheDocument()
  })

  it('shows "Cam off" when videoMuted=false', () => {
    setup({ videoMuted: false })
    expect(screen.getByText('Cam off')).toBeInTheDocument()
  })

  it('applies --active class to audio button when muted', () => {
    setup({ audioMuted: true })
    expect(screen.getByTitle(/unmute microphone/i)).toHaveClass('control-btn--active')
  })

  it('applies --active class to video button when muted', () => {
    setup({ videoMuted: true })
    expect(screen.getByTitle(/turn on camera/i)).toHaveClass('control-btn--active')
  })
})

// ── Handlers ──────────────────────────────────────────────────────────────────

describe('PiPOverlay — handlers', () => {
  it('calls onToggleAudio when microphone button is clicked', async () => {
    const user = userEvent.setup()
    const { onToggleAudio } = setup()
    await user.click(screen.getByTitle(/mute microphone/i))
    expect(onToggleAudio).toHaveBeenCalledOnce()
  })

  it('calls onToggleVideo when camera button is clicked', async () => {
    const user = userEvent.setup()
    const { onToggleVideo } = setup()
    await user.click(screen.getByTitle(/turn off camera/i))
    expect(onToggleVideo).toHaveBeenCalledOnce()
  })
})
