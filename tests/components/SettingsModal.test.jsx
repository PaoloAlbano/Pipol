/**
 * SettingsModal.test.jsx
 * Tests form validation, saving and the network stats toggle.
 *
 * The storage and media modules are mocked to isolate the component.
 */

import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../src/p2p/storage.js', () => ({
  getVideoQuality: vi.fn(() => '1080p'),
  setVideoQuality: vi.fn(),
  getRelayUrl: vi.fn(() => ''),
  setRelayUrl: vi.fn(),
}))

vi.mock('../../src/webrtc/media.js', () => ({
  applyVideoQuality: vi.fn(),
}))

import SettingsModal from '../../src/components/SettingsModal.jsx'

const DEFAULT_IDENTITY = {
  username: 'swift-fox',
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(64),
}

function setup(props = {}) {
  const defaults = {
    identity: DEFAULT_IDENTITY,
    onUsernameChange: vi.fn(),
    showStats: false,
    onShowStatsChange: vi.fn(),
    onClose: vi.fn(),
  }
  render(<SettingsModal {...defaults} {...props} />)
  return { ...defaults, ...props }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('SettingsModal — rendering', () => {
  it('mostra il campo nome con il valore corrente', () => {
    setup()
    const input = screen.getByPlaceholderText(/your name/i)
    expect(input).toHaveValue('swift-fox')
  })

  it('mostra i pulsanti Save e Cancel', () => {
    setup()
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('mostra la sezione qualità video', () => {
    setup()
    expect(screen.getByText('1080p')).toBeInTheDocument()
    expect(screen.getByText('720p')).toBeInTheDocument()
    expect(screen.getByText('480p')).toBeInTheDocument()
  })

  it('mostra il toggle network stats', () => {
    setup()
    expect(screen.getByText(/show network stats/i)).toBeInTheDocument()
  })
})

// ── Validazione ───────────────────────────────────────────────────────────────

describe('SettingsModal — validazione', () => {
  it('mostra errore se il nome è vuoto', async () => {
    const user = userEvent.setup()
    setup()
    const input = screen.getByPlaceholderText(/your name/i)
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(screen.getByText(/cannot be empty/i)).toBeInTheDocument()
  })

  it('mostra errore se il nome supera 32 caratteri', async () => {
    const user = userEvent.setup()
    setup()
    const input = screen.getByPlaceholderText(/your name/i)
    // fireEvent bypasses maxLength, allowing us to test JS-side validation
    fireEvent.change(input, { target: { value: 'a'.repeat(33) } })
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(screen.getByText(/max 32/i)).toBeInTheDocument()
  })

  it('mostra errore se il nome contiene caratteri non validi', async () => {
    const user = userEvent.setup()
    setup()
    const input = screen.getByPlaceholderText(/your name/i)
    await user.clear(input)
    await user.type(input, 'nome@invalido!')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(screen.getByText(/only letters/i)).toBeInTheDocument()
  })

  it('non mostra errori con un nome valido', async () => {
    const user = userEvent.setup()
    setup()
    const input = screen.getByPlaceholderText(/your name/i)
    await user.clear(input)
    await user.type(input, 'Nuovo Nome')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(screen.queryByText(/cannot be empty|max 32|only letters/i)).toBeNull()
  })
})

// ── Saving ────────────────────────────────────────────────────────────────────

describe('SettingsModal — salvataggio', () => {
  afterEach(() => vi.useRealTimers())

  it('chiama onUsernameChange con il nome trimmed', async () => {
    const user = userEvent.setup()
    const { onUsernameChange } = setup()
    const input = screen.getByPlaceholderText(/your name/i)
    await user.clear(input)
    await user.type(input, '  nuovo-nome  ')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onUsernameChange).toHaveBeenCalledWith('nuovo-nome')
  })

  it('mostra "Saved" dopo il salvataggio', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(screen.getByText(/saved/i)).toBeInTheDocument()
  })

  it('chiama onClose dopo il salvataggio', async () => {
    const { onClose } = setup()
    vi.useFakeTimers()
    // Use fireEvent to avoid userEvent's dependency on timers
    const { fireEvent: fe, act } = await import('@testing-library/react')
    fe.click(screen.getByRole('button', { name: /save/i }))
    vi.runAllTimers()
    expect(onClose).toHaveBeenCalled()
  })
})

// ── Cancel ────────────────────────────────────────────────────────────────────

describe('SettingsModal — cancel', () => {
  it('chiama onClose al click su Cancel', async () => {
    const user = userEvent.setup()
    const { onClose } = setup()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("chiama onClose al click sull'overlay esterno", async () => {
    const user = userEvent.setup()
    const { onClose } = setup()
    // The overlay is the first child of the document body
    const overlay = document.querySelector('.settings-overlay')
    await user.click(overlay)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('non chiama onUsernameChange se si cancella', async () => {
    const user = userEvent.setup()
    const { onUsernameChange } = setup()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onUsernameChange).not.toHaveBeenCalled()
  })
})

// ── Toggle network stats ──────────────────────────────────────────────────────

describe('SettingsModal — network stats toggle', () => {
  it('il toggle mostra stato off quando showStats=false', () => {
    setup({ showStats: false })
    const toggle = screen.getByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).not.toHaveClass('settings-toggle--on')
  })

  it('il toggle mostra stato on quando showStats=true', () => {
    setup({ showStats: true })
    const toggle = screen.getByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveClass('settings-toggle--on')
  })

  it('chiama onShowStatsChange con true al click se era false', async () => {
    const user = userEvent.setup()
    const { onShowStatsChange } = setup({ showStats: false })
    await user.click(screen.getByRole('switch'))
    expect(onShowStatsChange).toHaveBeenCalledWith(true)
  })

  it('chiama onShowStatsChange con false al click se era true', async () => {
    const user = userEvent.setup()
    const { onShowStatsChange } = setup({ showStats: true })
    await user.click(screen.getByRole('switch'))
    expect(onShowStatsChange).toHaveBeenCalledWith(false)
  })
})
