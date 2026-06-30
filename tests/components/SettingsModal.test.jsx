/**
 * SettingsModal.test.jsx
 * Tests form validation, saving and the network stats toggle.
 *
 * The storage and media modules are mocked to isolate the component.
 */

import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockSetupBiometricUnlock = vi.fn()
const mockRemoveBiometricUnlock = vi.fn()
const mockIsBiometricUnlockAvailable = vi.fn(() => Promise.resolve(false))
const mockHasBiometricUnlock = vi.fn(() => false)
const mockGetPassphrase = vi.fn(() => 'my-passphrase')
const mockGetStoredIdentityMeta = vi.fn(() => ({
  handle: 'alice',
  publicKey: 'aabb',
  username: 'Alice',
  method: 'passphrase',
}))

vi.mock('../../src/p2p/storage.js', () => ({
  getVideoQuality: vi.fn(() => '1080p'),
  setVideoQuality: vi.fn(),
  getRelayUrl: vi.fn(() => ''),
  setRelayUrl: vi.fn(),
  getPassphrase: () => mockGetPassphrase(),
  clearPassphrase: vi.fn(),
  getStoredIdentityMeta: () => mockGetStoredIdentityMeta(),
}))

vi.mock('../../src/p2p/webauthn.js', () => ({
  isBiometricUnlockAvailable: () => mockIsBiometricUnlockAvailable(),
  hasBiometricUnlock: () => mockHasBiometricUnlock(),
  setupBiometricUnlock: (...args) => mockSetupBiometricUnlock(...args),
  removeBiometricUnlock: () => mockRemoveBiometricUnlock(),
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
    onLock: vi.fn(),
  }
  render(<SettingsModal {...defaults} {...props} />)
  return { ...defaults, ...props }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('SettingsModal — rendering', () => {
  it('displays name field with current value', () => {
    setup()
    const input = screen.getByPlaceholderText(/your name/i)
    expect(input).toHaveValue('swift-fox')
  })

  it('displays Save and Cancel buttons', () => {
    setup()
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('displays video quality section', () => {
    setup()
    expect(screen.getByText('1080p')).toBeInTheDocument()
    expect(screen.getByText('720p')).toBeInTheDocument()
    expect(screen.getByText('480p')).toBeInTheDocument()
  })

  it('displays network stats toggle', () => {
    setup()
    expect(screen.getByText(/show network stats/i)).toBeInTheDocument()
  })
})

// ── Validation ───────────────────────────────────────────────────────────────

describe('SettingsModal — validation', () => {
  it('shows error if name is empty', async () => {
    const user = userEvent.setup()
    setup()
    const input = screen.getByPlaceholderText(/your name/i)
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(screen.getByText(/cannot be empty/i)).toBeInTheDocument()
  })

  it('shows error if name exceeds 32 characters', async () => {
    const user = userEvent.setup()
    setup()
    const input = screen.getByPlaceholderText(/your name/i)
    // fireEvent bypasses maxLength, allowing us to test JS-side validation
    fireEvent.change(input, { target: { value: 'a'.repeat(33) } })
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(screen.getByText(/max 32/i)).toBeInTheDocument()
  })

  it('shows error if name contains invalid characters', async () => {
    const user = userEvent.setup()
    setup()
    const input = screen.getByPlaceholderText(/your name/i)
    await user.clear(input)
    await user.type(input, 'nome@invalido!')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(screen.getByText(/only letters/i)).toBeInTheDocument()
  })

  it('shows no errors with a valid name', async () => {
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

describe('SettingsModal — saving', () => {
  afterEach(() => vi.useRealTimers())

  it('calls onUsernameChange with trimmed name', async () => {
    const user = userEvent.setup()
    const { onUsernameChange } = setup()
    const input = screen.getByPlaceholderText(/your name/i)
    await user.clear(input)
    await user.type(input, '  nuovo-nome  ')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onUsernameChange).toHaveBeenCalledWith('nuovo-nome')
  })

  it('shows "Saved" after saving', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(screen.getByText(/saved/i)).toBeInTheDocument()
  })

  it('calls onClose after saving', async () => {
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
  it('calls onClose when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const { onClose } = setup()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when clicking outside overlay', async () => {
    const user = userEvent.setup()
    const { onClose } = setup()
    // The overlay is the first child of the document body
    const overlay = document.querySelector('.settings-overlay')
    await user.click(overlay)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not call onUsernameChange when canceling', async () => {
    const user = userEvent.setup()
    const { onUsernameChange } = setup()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onUsernameChange).not.toHaveBeenCalled()
  })
})

// ── Biometric unlock ──────────────────────────────────────────────────────────

describe('SettingsModal — biometric unlock section visibility', () => {
  beforeEach(() => {
    mockHasBiometricUnlock.mockReturnValue(false)
  })

  it('does not show the biometric section when unavailable', async () => {
    mockIsBiometricUnlockAvailable.mockResolvedValue(false)
    setup()
    await waitFor(() => {}) // let useEffect settle
    expect(screen.queryByText(/biometric unlock/i)).not.toBeInTheDocument()
  })

  it('shows the biometric section when available', async () => {
    mockIsBiometricUnlockAvailable.mockResolvedValue(true)
    setup()
    await waitFor(() => expect(screen.getByText('Biometric unlock')).toBeInTheDocument())
  })

  it('does not show the biometric section for guest users even if available', async () => {
    mockIsBiometricUnlockAvailable.mockResolvedValue(true)
    setup({ identity: { ...DEFAULT_IDENTITY, isGuest: true } })
    await waitFor(() => {})
    expect(screen.queryByText(/biometric unlock/i)).not.toBeInTheDocument()
  })
})

describe('SettingsModal — biometric unlock not yet enabled', () => {
  beforeEach(() => {
    mockIsBiometricUnlockAvailable.mockResolvedValue(true)
    mockHasBiometricUnlock.mockReturnValue(false)
    mockSetupBiometricUnlock.mockResolvedValue(undefined)
  })

  it('shows the Enable button when biometric is not yet set up', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).toBeInTheDocument())
  })

  it('calls setupBiometricUnlock with passphrase and identity meta on Enable click', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /enable biometric unlock/i }))
    await waitFor(() =>
      expect(mockSetupBiometricUnlock).toHaveBeenCalledWith(
        'my-passphrase',
        expect.objectContaining({ handle: 'alice' })
      )
    )
  })

  it('shows "Setting up…" while setup is in progress', async () => {
    mockSetupBiometricUnlock.mockReturnValue(new Promise(() => {})) // never resolves
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /enable biometric unlock/i }))
    expect(await screen.findByText(/setting up/i)).toBeInTheDocument()
  })

  it('switches to Disable button after successful setup', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /enable biometric unlock/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^disable$/i })).toBeInTheDocument())
  })

  it('shows the not-supported message when setup returns not-supported', async () => {
    mockSetupBiometricUnlock.mockRejectedValue(new Error('not-supported'))
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /enable biometric unlock/i }))
    await waitFor(() => expect(screen.getByText(/does not support biometric unlock/i)).toBeInTheDocument())
  })

  it('shows the create-failed message when passkey creation fails', async () => {
    mockSetupBiometricUnlock.mockRejectedValue(new Error('create-failed'))
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /enable biometric unlock/i }))
    await waitFor(() => expect(screen.getByText(/passkey creation failed/i)).toBeInTheDocument())
  })

  it('shows no error message when the user cancels the biometric prompt', async () => {
    mockSetupBiometricUnlock.mockRejectedValue(new Error('cancelled'))
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /enable biometric unlock/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).not.toBeDisabled())
    expect(screen.queryByText(/failed|not support/i)).not.toBeInTheDocument()
  })

  it('shows a generic error for unexpected failures', async () => {
    mockSetupBiometricUnlock.mockRejectedValue(new Error('network-error'))
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /enable biometric unlock/i }))
    await waitFor(() => expect(screen.getByText(/setup failed\. try again/i)).toBeInTheDocument())
  })
})

describe('SettingsModal — biometric unlock already enabled', () => {
  beforeEach(() => {
    mockIsBiometricUnlockAvailable.mockResolvedValue(true)
    mockHasBiometricUnlock.mockReturnValue(true)
  })

  it('shows the Disable button when biometric is already enabled', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /^disable$/i })).toBeInTheDocument())
  })

  it('shows the active-state hint text when enabled', async () => {
    setup()
    await waitFor(() => expect(screen.getByText(/biometric unlock is active/i)).toBeInTheDocument())
  })

  it('shows confirmation warning when Disable is clicked', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /^disable$/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^disable$/i }))
    expect(screen.getByText(/log out and log back in/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /yes, disable/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /keep enabled/i })).toBeInTheDocument()
  })

  it('cancelling confirmation keeps biometric enabled', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /^disable$/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^disable$/i }))
    fireEvent.click(screen.getByRole('button', { name: /keep enabled/i }))
    expect(mockRemoveBiometricUnlock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^disable$/i })).toBeInTheDocument()
  })

  it('calls removeBiometricUnlock and switches to Enable button after confirming disable', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('button', { name: /^disable$/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^disable$/i }))
    fireEvent.click(screen.getByRole('button', { name: /yes, disable/i }))
    expect(mockRemoveBiometricUnlock).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole('button', { name: /enable biometric unlock/i })).toBeInTheDocument())
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

// ── Notifications section ─────────────────────────────────────────────────────

vi.mock('../../src/p2p/notifications.js', () => ({
  getNotificationPermission: vi.fn(() => 'default'),
  requestNotificationPermission: vi.fn(() => Promise.resolve('granted')),
}))

describe('SettingsModal — notifications section', () => {
  it('shows Enable button when permission is default', async () => {
    const { getNotificationPermission } = await import('../../src/p2p/notifications.js')
    getNotificationPermission.mockReturnValue('default')
    setup()
    expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument()
  })

  it('shows granted text when permission is already granted', async () => {
    const { getNotificationPermission } = await import('../../src/p2p/notifications.js')
    getNotificationPermission.mockReturnValue('granted')
    setup()
    expect(screen.getByText(/notifications are enabled/i)).toBeInTheDocument()
  })

  it('shows blocked warning when permission is denied', async () => {
    const { getNotificationPermission } = await import('../../src/p2p/notifications.js')
    getNotificationPermission.mockReturnValue('denied')
    setup()
    expect(screen.getByText(/notifications are blocked/i)).toBeInTheDocument()
  })

  it('shows unavailable message when Notification API is unsupported', async () => {
    const { getNotificationPermission } = await import('../../src/p2p/notifications.js')
    getNotificationPermission.mockReturnValue('unsupported')
    setup()
    expect(screen.getByText(/unavailable in this browser/i)).toBeInTheDocument()
  })

  it('calls requestNotificationPermission and updates UI when Enable is clicked', async () => {
    const user = userEvent.setup()
    const { getNotificationPermission, requestNotificationPermission } = await import('../../src/p2p/notifications.js')
    getNotificationPermission.mockReturnValue('default')
    requestNotificationPermission.mockResolvedValue('granted')
    setup()
    await user.click(screen.getByRole('button', { name: /enable notifications/i }))
    expect(requestNotificationPermission).toHaveBeenCalledTimes(1)
  })
})

// ── Workspace section ─────────────────────────────────────────────────────────

describe('SettingsModal — workspace section', () => {
  const ws1 = { id: 'ws-1', name: 'Acme Corp', channels: [] }
  const ws2 = { id: 'ws-2', name: 'Side Project', channels: [] }

  it('shows workspace list when workspaces are provided', () => {
    setup({ workspaces: [ws1, ws2], activeWorkspace: ws1 })
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('Side Project')).toBeInTheDocument()
  })

  it('marks the active workspace with "current" badge', () => {
    setup({ workspaces: [ws1, ws2], activeWorkspace: ws1 })
    expect(screen.getByText('current')).toBeInTheDocument()
  })

  it('does not show workspace section when no workspaces', () => {
    setup({ workspaces: [] })
    expect(screen.queryByText(/workspaces/i)).not.toBeInTheDocument()
  })

  it('shows Leave button for the active workspace when onLeaveWorkspace is provided', () => {
    setup({ workspaces: [ws1], activeWorkspace: ws1, onLeaveWorkspace: vi.fn() })
    expect(screen.getByRole('button', { name: /leave/i })).toBeInTheDocument()
  })

  it('shows confirmation prompt when Leave is clicked', async () => {
    const user = userEvent.setup()
    setup({ workspaces: [ws1], activeWorkspace: ws1, onLeaveWorkspace: vi.fn() })
    await user.click(screen.getByRole('button', { name: /^leave$/i }))
    expect(screen.getByText(/sure\?/i)).toBeInTheDocument()
  })

  it('calls onLeaveWorkspace and onClose when confirmed', async () => {
    const user = userEvent.setup()
    const onLeaveWorkspace = vi.fn()
    const onClose = vi.fn()
    setup({ workspaces: [ws1], activeWorkspace: ws1, onLeaveWorkspace, onClose })
    await user.click(screen.getByRole('button', { name: /^leave$/i }))
    await user.click(screen.getByRole('button', { name: /^leave$/i }))
    expect(onLeaveWorkspace).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('cancels leave confirmation when Cancel is clicked', async () => {
    const user = userEvent.setup()
    setup({ workspaces: [ws1], activeWorkspace: ws1, onLeaveWorkspace: vi.fn() })
    await user.click(screen.getByRole('button', { name: /^leave$/i }))
    // Click the small "Cancel" button inside the leave confirmation
    const { container } = render(<React.Fragment />)
    const confirmCancel = document.querySelector('.btn.btn-secondary.btn-xs')
    if (confirmCancel) await user.click(confirmCancel)
    expect(screen.queryByText(/sure\?/i)).not.toBeInTheDocument()
  })
})
