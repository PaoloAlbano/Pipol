/**
 * VideoControls.test.jsx
 * Tests the in-call control buttons: mute, camera, screen share, flip, end call.
 */

import React from 'react'
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

describe('VideoControls — rendering base', () => {
  it('mostra il pulsante mute microfono', () => {
    setup()
    expect(screen.getByTitle(/mute microphone/i)).toBeInTheDocument()
  })

  it('mostra il pulsante camera', () => {
    setup()
    expect(screen.getByTitle(/turn off camera/i)).toBeInTheDocument()
  })

  it('mostra il pulsante end call', () => {
    setup()
    expect(screen.getByTitle(/leave video call/i)).toBeInTheDocument()
  })

  it('non mostra il pulsante flip camera se onSwitchCamera non è fornito', () => {
    setup()
    expect(screen.queryByTitle(/switch camera/i)).toBeNull()
  })

  it('non mostra il pulsante screen share se onToggleScreenShare non è fornito', () => {
    setup()
    expect(screen.queryByTitle(/share screen|stop screen/i)).toBeNull()
  })
})

describe('VideoControls — pulsanti opzionali', () => {
  it('mostra il pulsante flip camera se onSwitchCamera è fornito', () => {
    setup({ onSwitchCamera: vi.fn() })
    expect(screen.getByTitle(/switch camera/i)).toBeInTheDocument()
  })

  it('mostra il pulsante screen share se onToggleScreenShare è fornito', () => {
    setup({ onToggleScreenShare: vi.fn() })
    expect(screen.getByTitle(/share screen/i)).toBeInTheDocument()
  })
})

describe('VideoControls — stato audio', () => {
  it('mostra "Mute" quando il microfono è attivo', () => {
    setup({ audioMuted: false })
    expect(screen.getByText('Mute')).toBeInTheDocument()
  })

  it('mostra "Unmute" quando il microfono è mutato', () => {
    setup({ audioMuted: true })
    expect(screen.getByText('Unmute')).toBeInTheDocument()
  })

  it('applica la classe --active quando audioMuted=true', () => {
    setup({ audioMuted: true })
    const btn = screen.getByTitle(/unmute microphone/i)
    expect(btn).toHaveClass('control-btn--active')
  })

  it('non applica la classe --active quando audioMuted=false', () => {
    setup({ audioMuted: false })
    const btn = screen.getByTitle(/mute microphone/i)
    expect(btn).not.toHaveClass('control-btn--active')
  })
})

describe('VideoControls — stato video', () => {
  it('mostra "Cam off" quando la camera è attiva', () => {
    setup({ videoMuted: false })
    expect(screen.getByText('Cam off')).toBeInTheDocument()
  })

  it('mostra "Cam on" quando la camera è mutata', () => {
    setup({ videoMuted: true })
    expect(screen.getByText('Cam on')).toBeInTheDocument()
  })
})

describe('VideoControls — stato screen share', () => {
  it('mostra "Share" quando non si sta condividendo', () => {
    setup({ screenSharing: false, onToggleScreenShare: vi.fn() })
    expect(screen.getByText('Share')).toBeInTheDocument()
  })

  it('mostra "Stop share" quando si sta condividendo', () => {
    setup({ screenSharing: true, onToggleScreenShare: vi.fn() })
    expect(screen.getByText('Stop share')).toBeInTheDocument()
  })

  it('applica --active quando screenSharing=true', () => {
    setup({ screenSharing: true, onToggleScreenShare: vi.fn() })
    const btn = screen.getByTitle(/stop screen share/i)
    expect(btn).toHaveClass('control-btn--active')
  })
})

describe('VideoControls — handlers', () => {
  it('chiama onToggleAudio al click sul pulsante microfono', async () => {
    const user = userEvent.setup()
    const { onToggleAudio } = setup()
    await user.click(screen.getByTitle(/mute microphone/i))
    expect(onToggleAudio).toHaveBeenCalledOnce()
  })

  it('chiama onToggleVideo al click sul pulsante camera', async () => {
    const user = userEvent.setup()
    const { onToggleVideo } = setup()
    await user.click(screen.getByTitle(/turn off camera/i))
    expect(onToggleVideo).toHaveBeenCalledOnce()
  })

  it('chiama onEndCall al click sul pulsante end call', async () => {
    const user = userEvent.setup()
    const { onEndCall } = setup()
    await user.click(screen.getByTitle(/leave video call/i))
    expect(onEndCall).toHaveBeenCalledOnce()
  })

  it('chiama onSwitchCamera al click sul pulsante flip', async () => {
    const user = userEvent.setup()
    const onSwitchCamera = vi.fn()
    setup({ onSwitchCamera })
    await user.click(screen.getByTitle(/switch camera/i))
    expect(onSwitchCamera).toHaveBeenCalledOnce()
  })

  it('chiama onToggleScreenShare al click sul pulsante share', async () => {
    const user = userEvent.setup()
    const onToggleScreenShare = vi.fn()
    setup({ onToggleScreenShare })
    await user.click(screen.getByTitle(/share screen/i))
    expect(onToggleScreenShare).toHaveBeenCalledOnce()
  })
})
