/**
 * VideoControls.test.jsx
 * Tests the in-call control buttons: mute, camera, screen share, flip, end call.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VideoControls from '../../src/components/VideoControls.jsx'

function setup(props = {}) {
  const defaults = {
    audioMuted: false,
    videoMuted: false,
    screenSharing: false,
    onToggleAudio: vi.fn(),
    onToggleVideo: vi.fn(),
    onEndCall: vi.fn(),
  }
  render(<VideoControls {...defaults} {...props} />)
  return { ...defaults, ...props }
}

describe('VideoControls — base rendering', () => {
  it('displays microphone mute button', () => {
    setup()
    expect(screen.getByTitle(/mute microphone/i)).toBeInTheDocument()
  })

  it('displays camera button', () => {
    setup()
    expect(screen.getByTitle(/turn off camera/i)).toBeInTheDocument()
  })

  it('displays end call button', () => {
    setup()
    expect(screen.getByTitle(/leave video call/i)).toBeInTheDocument()
  })

  it('does not show camera flip button if onSwitchCamera is not provided', () => {
    setup()
    expect(screen.queryByTitle(/switch camera/i)).toBeNull()
  })

  it('does not show screen share button if onToggleScreenShare is not provided', () => {
    setup()
    expect(screen.queryByTitle(/share screen|stop screen/i)).toBeNull()
  })
})

describe('VideoControls — optional buttons', () => {
  it('displays camera flip button if onSwitchCamera is provided', () => {
    setup({ onSwitchCamera: vi.fn() })
    expect(screen.getByTitle(/switch camera/i)).toBeInTheDocument()
  })

  it('displays screen share button if onToggleScreenShare is provided', () => {
    setup({ onToggleScreenShare: vi.fn() })
    expect(screen.getByTitle(/share screen/i)).toBeInTheDocument()
  })
})

describe('VideoControls — audio state', () => {
  it('displays "Mute" when microphone is active', () => {
    setup({ audioMuted: false })
    expect(screen.getByText('Mute')).toBeInTheDocument()
  })

  it('displays "Unmute" when microphone is muted', () => {
    setup({ audioMuted: true })
    expect(screen.getByText('Unmute')).toBeInTheDocument()
  })

  it('applies --active class when audioMuted=true', () => {
    setup({ audioMuted: true })
    const btn = screen.getByTitle(/unmute microphone/i)
    expect(btn).toHaveClass('control-btn--active')
  })

  it('does not apply --active class when audioMuted=false', () => {
    setup({ audioMuted: false })
    const btn = screen.getByTitle(/mute microphone/i)
    expect(btn).not.toHaveClass('control-btn--active')
  })
})

describe('VideoControls — video state', () => {
  it('displays "Cam off" when camera is active', () => {
    setup({ videoMuted: false })
    expect(screen.getByText('Cam off')).toBeInTheDocument()
  })

  it('displays "Cam on" when camera is muted', () => {
    setup({ videoMuted: true })
    expect(screen.getByText('Cam on')).toBeInTheDocument()
  })
})

describe('VideoControls — screen share state', () => {
  it('displays "Share" when not sharing', () => {
    setup({ screenSharing: false, onToggleScreenShare: vi.fn() })
    expect(screen.getByText('Share')).toBeInTheDocument()
  })

  it('displays "Stop share" when sharing', () => {
    setup({ screenSharing: true, onToggleScreenShare: vi.fn() })
    expect(screen.getByText('Stop share')).toBeInTheDocument()
  })

  it('applies --active class when screenSharing=true', () => {
    setup({ screenSharing: true, onToggleScreenShare: vi.fn() })
    const btn = screen.getByTitle(/stop screen share/i)
    expect(btn).toHaveClass('control-btn--active')
  })
})

describe('VideoControls — handlers', () => {
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

  it('calls onEndCall when end call button is clicked', async () => {
    const user = userEvent.setup()
    const { onEndCall } = setup()
    await user.click(screen.getByTitle(/leave video call/i))
    expect(onEndCall).toHaveBeenCalledOnce()
  })

  it('calls onSwitchCamera when flip button is clicked', async () => {
    const user = userEvent.setup()
    const onSwitchCamera = vi.fn()
    setup({ onSwitchCamera })
    await user.click(screen.getByTitle(/switch camera/i))
    expect(onSwitchCamera).toHaveBeenCalledOnce()
  })

  it('calls onToggleScreenShare when share button is clicked', async () => {
    const user = userEvent.setup()
    const onToggleScreenShare = vi.fn()
    setup({ onToggleScreenShare })
    await user.click(screen.getByTitle(/share screen/i))
    expect(onToggleScreenShare).toHaveBeenCalledOnce()
  })
})

describe('VideoControls — PiP button', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'pictureInPictureEnabled', {
      value: true,
      writable: true,
      configurable: true,
    })
  })

  it('shows PiP button when onTogglePiP is provided and pictureInPictureEnabled=true', () => {
    setup({ onTogglePiP: vi.fn() })
    expect(screen.getByTitle(/open picture-in-picture/i)).toBeInTheDocument()
  })

  it('hides PiP button when onTogglePiP is not provided', () => {
    setup()
    expect(screen.queryByTitle(/picture-in-picture/i)).toBeNull()
  })

  it('hides PiP button when pictureInPictureEnabled=false', () => {
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: false, configurable: true })
    setup({ onTogglePiP: vi.fn() })
    expect(screen.queryByTitle(/picture-in-picture/i)).toBeNull()
  })

  it('shows "Close picture-in-picture" title when pipActive=true', () => {
    setup({ onTogglePiP: vi.fn(), pipActive: true })
    expect(screen.getByTitle(/close picture-in-picture/i)).toBeInTheDocument()
  })

  it('applies --active class when pipActive=true', () => {
    setup({ onTogglePiP: vi.fn(), pipActive: true })
    expect(screen.getByTitle(/close picture-in-picture/i)).toHaveClass('control-btn--active')
  })

  it('does not apply --active class when pipActive=false', () => {
    setup({ onTogglePiP: vi.fn(), pipActive: false })
    expect(screen.getByTitle(/open picture-in-picture/i)).not.toHaveClass('control-btn--active')
  })

  it('calls onTogglePiP when clicked', async () => {
    const user = userEvent.setup()
    const onTogglePiP = vi.fn()
    setup({ onTogglePiP })
    await user.click(screen.getByTitle(/open picture-in-picture/i))
    expect(onTogglePiP).toHaveBeenCalledOnce()
  })
})
