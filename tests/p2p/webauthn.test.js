/**
 * webauthn.test.js
 * Tests for the WebAuthn biometric unlock helpers.
 *
 * Strategy: passphrase + handle are encrypted with AES-GCM using a key
 * derived from the credential's rawId via HKDF. No PRF or largeBlob needed.
 *
 * navigator.credentials is mocked — no real authenticator needed.
 * crypto.subtle is the real Node 18+ implementation so the full
 * HKDF → AES-GCM encrypt/decrypt cycle is tested against real cryptography.
 */

const MOCK_CREDENTIAL_ID = new Uint8Array(16).fill(1)

function makeMockCredential(rawId = MOCK_CREDENTIAL_ID) {
  return { rawId }
}

function makeMockAssertion(rawId = MOCK_CREDENTIAL_ID) {
  return { rawId }
}

async function getModule() {
  vi.resetModules()
  localStorage.clear()
  return import('../../src/p2p/webauthn.js')
}

// ── hasBiometricUnlock ────────────────────────────────────────────────────────

describe('webauthn — hasBiometricUnlock', () => {
  it('returns false when nothing is stored', async () => {
    localStorage.clear()
    const { hasBiometricUnlock } = await getModule()
    expect(hasBiometricUnlock()).toBe(false)
  })

  it('returns true after a blob has been stored', async () => {
    const { hasBiometricUnlock } = await getModule()
    localStorage.setItem('p2p-chat:biometric', JSON.stringify({ test: true }))
    expect(hasBiometricUnlock()).toBe(true)
  })
})

// ── removeBiometricUnlock ─────────────────────────────────────────────────────

describe('webauthn — removeBiometricUnlock', () => {
  it('clears the stored blob', async () => {
    localStorage.setItem('p2p-chat:biometric', JSON.stringify({ test: true }))
    const { removeBiometricUnlock, hasBiometricUnlock } = await getModule()
    removeBiometricUnlock()
    expect(hasBiometricUnlock()).toBe(false)
    expect(localStorage.getItem('p2p-chat:biometric')).toBeNull()
  })
})

// ── isBiometricUnlockAvailable ────────────────────────────────────────────────

describe('webauthn — isBiometricUnlockAvailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns false when PublicKeyCredential is not defined', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined)
    const { isBiometricUnlockAvailable } = await getModule()
    expect(await isBiometricUnlockAvailable()).toBe(false)
  })

  it('returns true when platform authenticator is available', async () => {
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(true),
    })
    const { isBiometricUnlockAvailable } = await getModule()
    expect(await isBiometricUnlockAvailable()).toBe(true)
  })

  it('returns false when platform authenticator is not available', async () => {
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(false),
    })
    const { isBiometricUnlockAvailable } = await getModule()
    expect(await isBiometricUnlockAvailable()).toBe(false)
  })

  it('returns false when the API throws', async () => {
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockRejectedValue(new Error('nope')),
    })
    const { isBiometricUnlockAvailable } = await getModule()
    expect(await isBiometricUnlockAvailable()).toBe(false)
  })
})

// ── setupBiometricUnlock ──────────────────────────────────────────────────────

describe('webauthn — setupBiometricUnlock', () => {
  const passphrase = 'my-super-secret-passphrase'
  const meta = { handle: 'alice@example.com', username: 'Alice' }

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('stores credentialId, iv and ciphertext in localStorage', async () => {
    vi.stubGlobal('navigator', {
      credentials: { create: vi.fn().mockResolvedValue(makeMockCredential()) },
    })
    const { setupBiometricUnlock } = await getModule()
    await setupBiometricUnlock(passphrase, meta)

    const stored = JSON.parse(localStorage.getItem('p2p-chat:biometric'))
    expect(stored).toHaveProperty('credentialId')
    expect(stored).toHaveProperty('iv')
    expect(stored).toHaveProperty('ciphertext')
  })

  it('throws "cancelled" when the user dismisses the prompt (NotAllowedError)', async () => {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockRejectedValue(new DOMException('User cancelled', 'NotAllowedError')),
      },
    })
    const { setupBiometricUnlock } = await getModule()
    await expect(setupBiometricUnlock(passphrase, meta)).rejects.toThrow('cancelled')
    expect(localStorage.getItem('p2p-chat:biometric')).toBeNull()
  })

  it('throws "create-failed" on unexpected authenticator errors', async () => {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockRejectedValue(new Error('SomeOtherError')),
      },
    })
    const { setupBiometricUnlock } = await getModule()
    await expect(setupBiometricUnlock(passphrase, meta)).rejects.toThrow('create-failed')
  })

  it('throws "not-supported" when the platform authenticator rejects with NotSupportedError', async () => {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockRejectedValue(new DOMException('Not supported', 'NotSupportedError')),
      },
    })
    const { setupBiometricUnlock } = await getModule()
    await expect(setupBiometricUnlock(passphrase, meta)).rejects.toThrow('not-supported')
  })

  it('throws "not-supported" when the platform rejects with ConstraintError (no biometric enrolled)', async () => {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockRejectedValue(new DOMException('No authenticator', 'ConstraintError')),
      },
    })
    const { setupBiometricUnlock } = await getModule()
    await expect(setupBiometricUnlock(passphrase, meta)).rejects.toThrow('not-supported')
  })
})

// ── unlockWithBiometrics ──────────────────────────────────────────────────────

describe('webauthn — unlockWithBiometrics', () => {
  const passphrase = 'my-super-secret-passphrase'
  const meta = { handle: 'alice@example.com', username: 'Alice' }

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('returns { handle, passphrase } after a full setup → unlock round-trip', async () => {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockResolvedValue(makeMockCredential()),
        get: vi.fn().mockResolvedValue(makeMockAssertion()),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(passphrase, meta)
    const result = await mod.unlockWithBiometrics()
    expect(result.handle).toBe(meta.handle)
    expect(result.passphrase).toBe(passphrase)
  })

  it('throws "no-biometric-setup" when nothing is stored', async () => {
    const { unlockWithBiometrics } = await getModule()
    await expect(unlockWithBiometrics()).rejects.toThrow('no-biometric-setup')
  })

  it('throws "cancelled" when the user dismisses the get() prompt', async () => {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockResolvedValue(makeMockCredential()),
        get: vi.fn().mockRejectedValue(new DOMException('cancelled', 'NotAllowedError')),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(passphrase, meta)
    await expect(mod.unlockWithBiometrics()).rejects.toThrow('cancelled')
  })

  it('throws "decrypt-failed" when assertion returns a different rawId (wrong key)', async () => {
    const differentRawId = new Uint8Array(16).fill(0xff)
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockResolvedValue(makeMockCredential(MOCK_CREDENTIAL_ID)),
        get: vi.fn().mockResolvedValue(makeMockAssertion(differentRawId)),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(passphrase, meta)
    await expect(mod.unlockWithBiometrics()).rejects.toThrow('decrypt-failed')
  })
})
