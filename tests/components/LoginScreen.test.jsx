/**
 * LoginScreen.test.jsx
 * Tests rendering logic and user interactions for the login/identity screen.
 *
 * All p2p and webauthn modules are mocked — this suite tests the component
 * behaviour only, not the cryptographic primitives (covered in their own tests).
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeriveIdentityA = vi.fn()
const mockCreateGuestIdentity = vi.fn()
const mockRestoreFromMasterSeed = vi.fn()
const mockSetUsername = vi.fn()
const mockGenerateUsername = vi.fn(() => 'swift-fox')
const mockGetStoredIdentityMeta = vi.fn(() => null)

vi.mock('../../src/p2p/storage.js', () => ({
  getStoredIdentityMeta: () => mockGetStoredIdentityMeta(),
  deriveIdentityA: (...args) => mockDeriveIdentityA(...args),
  createGuestIdentity: (...args) => mockCreateGuestIdentity(...args),
  restoreFromMasterSeed: (...args) => mockRestoreFromMasterSeed(...args),
  setUsername: (...args) => mockSetUsername(...args),
  generateUsername: () => mockGenerateUsername(),
  getIdentity: vi.fn(() => ({
    username: 'swift-fox',
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
  })),
}))

const mockUnlockWithBiometrics = vi.fn()
const mockIsBiometricUnlockAvailable = vi.fn(() => Promise.resolve(false))
const mockHasBiometricUnlock = vi.fn(() => false)

vi.mock('../../src/p2p/webauthn.js', () => ({
  hasBiometricUnlock: () => mockHasBiometricUnlock(),
  isBiometricUnlockAvailable: () => mockIsBiometricUnlockAvailable(),
  unlockWithBiometrics: () => mockUnlockWithBiometrics(),
}))

vi.mock('../../src/styles/login.css', () => ({}))

import LoginScreen from '../../src/components/LoginScreen.jsx'

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup(props = {}) {
  const onLogin = props.onLogin ?? vi.fn()
  render(<LoginScreen onLogin={onLogin} {...props} />)
  return { onLogin }
}

// ── Default mode (identity) ───────────────────────────────────────────────────

describe('LoginScreen — identity mode (default)', () => {
  beforeEach(() => {
    mockGetStoredIdentityMeta.mockReturnValue(null)
    mockHasBiometricUnlock.mockReturnValue(false)
  })

  it('shows the handle and passphrase fields', () => {
    setup()
    expect(screen.getByLabelText('Handle')).toBeInTheDocument()
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument()
  })

  it('shows the confirm passphrase and display name fields in create mode', () => {
    setup()
    expect(screen.getByLabelText(/confirm passphrase/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument()
  })

  it('pre-fills the display name with the generated username', () => {
    setup()
    expect(screen.getByLabelText(/display name/i).value).toBe('swift-fox')
  })

  it('submit button is disabled when handle is empty', () => {
    setup()
    expect(screen.getByRole('button', { name: /create \/ restore/i })).toBeDisabled()
  })

  it('shows the "Continue as guest" button', () => {
    setup()
    expect(screen.getByRole('button', { name: /continue as guest/i })).toBeInTheDocument()
  })
})

// ── Passphrase strength ───────────────────────────────────────────────────────

describe('LoginScreen — passphrase strength', () => {
  beforeEach(() => {
    mockGetStoredIdentityMeta.mockReturnValue(null)
    mockHasBiometricUnlock.mockReturnValue(false)
  })

  it('shows strength hints after typing a passphrase in create mode', async () => {
    setup()
    await userEvent.type(screen.getByLabelText(/^passphrase$/i), 'abc')
    expect(screen.getByText(/complete any 3 to continue/i)).toBeInTheDocument()
  })

  it('keeps submit disabled when passphrase is weak', async () => {
    setup()
    await userEvent.type(screen.getByLabelText('Handle'), 'user')
    await userEvent.type(screen.getByLabelText('Passphrase'), 'weak')
    expect(screen.getByRole('button', { name: /create \/ restore/i })).toBeDisabled()
  })

  it('hides hints when passphrase reaches score 3', async () => {
    setup()
    await userEvent.type(screen.getByLabelText('Passphrase'), 'StrongPass123!')
    expect(screen.queryByText(/complete any 3 to continue/i)).not.toBeInTheDocument()
  })
})

// ── Submit (create mode) ──────────────────────────────────────────────────────

describe('LoginScreen — submit (create)', () => {
  beforeEach(() => {
    mockGetStoredIdentityMeta.mockReturnValue(null)
    mockHasBiometricUnlock.mockReturnValue(false)
    mockDeriveIdentityA.mockResolvedValue({ isNewAccount: true })
  })

  it('calls deriveIdentityA with handle and passphrase', async () => {
    const { onLogin } = setup()
    await userEvent.type(screen.getByLabelText(/^handle$/i), 'alice')
    await userEvent.type(screen.getByLabelText(/^passphrase$/i), 'StrongPass123!')
    await userEvent.type(screen.getByLabelText(/confirm passphrase/i), 'StrongPass123!')
    fireEvent.click(screen.getByRole('button', { name: /create \/ restore/i }))

    await waitFor(() => expect(mockDeriveIdentityA).toHaveBeenCalledWith('alice', 'StrongPass123!'))
    await waitFor(() => expect(onLogin).toHaveBeenCalled())
  })

  it('applies the display name via setUsername for new accounts', async () => {
    setup()
    await userEvent.type(screen.getByLabelText(/^handle$/i), 'alice')
    await userEvent.type(screen.getByLabelText(/^passphrase$/i), 'StrongPass123!')
    await userEvent.type(screen.getByLabelText(/confirm passphrase/i), 'StrongPass123!')
    fireEvent.click(screen.getByRole('button', { name: /create \/ restore/i }))

    await waitFor(() => expect(mockSetUsername).toHaveBeenCalled())
  })

  it('shows an error on wrong-passphrase', async () => {
    mockDeriveIdentityA.mockRejectedValue(new Error('wrong-passphrase'))
    mockGetStoredIdentityMeta.mockReturnValue({
      handle: 'alice',
      publicKey: 'aabbcc',
      username: 'Alice',
      method: 'A',
    })
    setup()
    await userEvent.type(screen.getByLabelText(/^passphrase$/i), 'StrongPass123!')
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }))

    await waitFor(() => expect(screen.getByText(/wrong passphrase/i)).toBeInTheDocument())
  })
})

// ── Guest mode ────────────────────────────────────────────────────────────────

describe('LoginScreen — guest mode', () => {
  beforeEach(() => {
    mockGetStoredIdentityMeta.mockReturnValue(null)
    mockHasBiometricUnlock.mockReturnValue(false)
  })

  it('switches to guest mode when the guest button is clicked', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }))
    expect(screen.getByText(/choose a name and jump in/i)).toBeInTheDocument()
  })

  it('calls createGuestIdentity with the display name on submit', async () => {
    const { onLogin } = setup()
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }))

    const nameInput = screen.getByLabelText(/display name/i)
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Bob')
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }))

    expect(mockCreateGuestIdentity).toHaveBeenCalledWith('Bob')
    expect(onLogin).toHaveBeenCalled()
  })

  it('can switch back to identity mode from guest mode', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }))
    fireEvent.click(screen.getByRole('button', { name: /create a permanent identity/i }))
    expect(screen.getByLabelText(/^handle$/i)).toBeInTheDocument()
  })

  it('falls back to generateUsername when display name is empty on guest submit', async () => {
    const { onLogin } = setup()
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }))

    const nameInput = screen.getByLabelText(/display name/i)
    await userEvent.clear(nameInput)
    // submit with empty display name
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }))

    expect(mockCreateGuestIdentity).toHaveBeenCalledWith('swift-fox')
    expect(onLogin).toHaveBeenCalled()
  })
})

// ── Biometric mode ────────────────────────────────────────────────────────────

describe('LoginScreen — biometric mode', () => {
  beforeEach(() => {
    mockGetStoredIdentityMeta.mockReturnValue({
      handle: 'alice',
      publicKey: 'aabbcc',
      username: 'Alice',
      method: 'A',
    })
    mockHasBiometricUnlock.mockReturnValue(true)
    mockIsBiometricUnlockAvailable.mockResolvedValue(true)
  })

  it('starts in biometric mode when biometric unlock is configured', () => {
    setup()
    expect(screen.getByText(/welcome back, alice/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /unlock with biometrics/i })).toBeInTheDocument()
  })

  it('calls unlockWithBiometrics and onLogin on success', async () => {
    mockUnlockWithBiometrics.mockResolvedValue({ handle: 'alice', passphrase: 'secret' })
    mockDeriveIdentityA.mockResolvedValue({ isNewAccount: false })
    const { onLogin } = setup()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /unlock with biometrics/i })).not.toBeDisabled()
    )

    fireEvent.click(screen.getByRole('button', { name: /unlock with biometrics/i }))
    await waitFor(() => expect(onLogin).toHaveBeenCalled())
  })

  it('shows an error when biometric unlock fails (non-cancellation)', async () => {
    mockUnlockWithBiometrics.mockRejectedValue(new Error('decrypt-failed'))
    setup()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /unlock with biometrics/i })).not.toBeDisabled()
    )

    fireEvent.click(screen.getByRole('button', { name: /unlock with biometrics/i }))
    await waitFor(() => expect(screen.getByText(/biometric unlock failed/i)).toBeInTheDocument())
  })

  it('shows no error when the user cancels the biometric prompt', async () => {
    mockUnlockWithBiometrics.mockRejectedValue(new Error('cancelled'))
    setup()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /unlock with biometrics/i })).not.toBeDisabled()
    )

    fireEvent.click(screen.getByRole('button', { name: /unlock with biometrics/i }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('can fall back to passphrase mode', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /use passphrase instead/i }))
    expect(screen.getByLabelText(/^passphrase$/i)).toBeInTheDocument()
  })
})

// ── handleSubmit guards ───────────────────────────────────────────────────────

describe('LoginScreen — handleSubmit guards', () => {
  beforeEach(() => {
    mockGetStoredIdentityMeta.mockReturnValue(null)
    mockHasBiometricUnlock.mockReturnValue(false)
    mockDeriveIdentityA.mockResolvedValue({ isNewAccount: true })
  })

  it('does not call deriveIdentityA when canSubmit is false (button disabled)', async () => {
    setup()
    // Only fill handle, leave passphrase empty → canSubmit = false
    await userEvent.type(screen.getByLabelText(/^handle$/i), 'alice')
    fireEvent.click(screen.getByRole('button', { name: /create \/ restore/i }))
    expect(mockDeriveIdentityA).not.toHaveBeenCalled()
  })

  it('does not call setUsername when isNewAccount is false (returning user, different handle typed)', async () => {
    mockDeriveIdentityA.mockResolvedValue({ isNewAccount: false })
    mockGetStoredIdentityMeta.mockReturnValue({
      handle: 'alice',
      publicKey: 'aabbcc',
      username: 'Alice',
      method: 'A',
    })
    setup()
    // Type the same handle → isUnlock = true → no confirm/displayName fields
    await userEvent.type(screen.getByLabelText(/^passphrase$/i), 'AnyPassphrase1!')
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }))

    await waitFor(() => expect(mockDeriveIdentityA).toHaveBeenCalled())
    expect(mockSetUsername).not.toHaveBeenCalled()
  })

  it('shows "Unexpected error." for non-passphrase errors', async () => {
    mockDeriveIdentityA.mockRejectedValue(new Error('network-failure'))
    mockGetStoredIdentityMeta.mockReturnValue({
      handle: 'alice',
      publicKey: 'aabbcc',
      username: 'Alice',
      method: 'A',
    })
    setup()
    await userEvent.type(screen.getByLabelText(/^passphrase$/i), 'AnyPassphrase1!')
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }))

    await waitFor(() => expect(screen.getByText(/unexpected error/i)).toBeInTheDocument())
  })

  it('re-enables the submit button after a failed attempt', async () => {
    mockDeriveIdentityA.mockRejectedValue(new Error('wrong-passphrase'))
    mockGetStoredIdentityMeta.mockReturnValue({
      handle: 'alice',
      publicKey: 'aabbcc',
      username: 'Alice',
      method: 'A',
    })
    setup()
    await userEvent.type(screen.getByLabelText(/^passphrase$/i), 'AnyPassphrase1!')
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }))

    await waitFor(() => expect(screen.getByText(/wrong passphrase/i)).toBeInTheDocument())
    // button should be enabled again (loading = false)
    expect(screen.getByRole('button', { name: /unlock/i })).not.toBeDisabled()
  })
})

// ── Returning user (isUnlock) ─────────────────────────────────────────────────

describe('LoginScreen — returning user (isUnlock)', () => {
  beforeEach(() => {
    mockGetStoredIdentityMeta.mockReturnValue({
      handle: 'alice',
      publicKey: 'aabbcc',
      username: 'Alice',
      method: 'A',
    })
    mockHasBiometricUnlock.mockReturnValue(false)
    mockDeriveIdentityA.mockResolvedValue({ isNewAccount: false })
  })

  it('pre-fills the handle with the stored handle', () => {
    setup()
    expect(screen.getByLabelText(/^handle$/i).value).toBe('alice')
  })

  it('does not show the confirm passphrase field', () => {
    setup()
    expect(screen.queryByLabelText(/confirm passphrase/i)).not.toBeInTheDocument()
  })

  it('does not show the display name field', () => {
    setup()
    expect(screen.queryByLabelText(/display name/i)).not.toBeInTheDocument()
  })

  it('enables the submit button with any non-empty passphrase', async () => {
    setup()
    await userEvent.type(screen.getByLabelText(/^passphrase$/i), 'short')
    expect(screen.getByRole('button', { name: /unlock/i })).not.toBeDisabled()
  })

  it('calls onLogin on successful unlock', async () => {
    const { onLogin } = setup()
    await userEvent.type(screen.getByLabelText(/^passphrase$/i), 'AnyPassphrase1!')
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }))
    await waitFor(() => expect(onLogin).toHaveBeenCalled())
  })
})

// ── ALLOW_IDENTITY_RESET button ───────────────────────────────────────────────

describe('LoginScreen — ALLOW_IDENTITY_RESET', () => {
  beforeEach(() => {
    mockHasBiometricUnlock.mockReturnValue(false)
  })

  it('does not show the reset button when __ALLOW_IDENTITY_RESET__ is false (default in tests)', () => {
    mockGetStoredIdentityMeta.mockReturnValue({
      handle: 'alice',
      publicKey: 'aabbcc',
      username: 'Alice',
      method: 'A',
    })
    setup()
    expect(screen.queryByRole('button', { name: /create new identity/i })).not.toBeInTheDocument()
  })

  it('does not show the reset button in isCreate mode even if flag were true', () => {
    // isCreate = true when handle does not match stored handle
    mockGetStoredIdentityMeta.mockReturnValue(null)
    setup()
    // __ALLOW_IDENTITY_RESET__ is false in vitest, so button is always absent
    expect(screen.queryByRole('button', { name: /create new identity/i })).not.toBeInTheDocument()
  })
})
