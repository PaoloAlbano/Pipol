/**
 * webauthn.test.js
 * Tests for the WebAuthn biometric unlock helpers.
 *
 * Strategy: credentials.create() captures the `user.id` secret the code generates.
 * credentials.get() returns it as `response.userHandle` (from the secure enclave).
 * The key material never touches localStorage.
 *
 * navigator.credentials is mocked — no real authenticator needed.
 * crypto.subtle is the real Node 18+ implementation so the full
 * HKDF → AES-GCM encrypt/decrypt cycle is tested against real cryptography.
 */

const MOCK_CREDENTIAL_ID = new Uint8Array(16).fill(1)

// Captures user.id from options so get() can return it as userHandle.
function makeCapturingCreate(rawId = MOCK_CREDENTIAL_ID) {
  let capturedSecret = null
  const create = vi.fn().mockImplementation(async (options) => {
    capturedSecret = new Uint8Array(options.publicKey.user.id)
    return { rawId }
  })
  const getSecret = () => capturedSecret
  return { create, getSecret }
}

function makeMatchingGet(getSecretFn, rawId = MOCK_CREDENTIAL_ID) {
  return vi.fn().mockImplementation(async () => ({
    rawId,
    response: { userHandle: getSecretFn().buffer },
  }))
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

  it('stores credentialId, salt, iv and ciphertext in localStorage', async () => {
    const { create } = makeCapturingCreate()
    vi.stubGlobal('navigator', { credentials: { create } })
    const { setupBiometricUnlock } = await getModule()
    await setupBiometricUnlock(passphrase, meta)

    const stored = JSON.parse(localStorage.getItem('p2p-chat:biometric'))
    expect(stored).toHaveProperty('credentialId')
    expect(stored).toHaveProperty('salt')
    expect(stored).toHaveProperty('iv')
    expect(stored).toHaveProperty('ciphertext')
    expect(stored).not.toHaveProperty('method')
  })

  it('sets user.id to a 32-byte random secret (not a fixed value)', async () => {
    const capturedIds = []
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockImplementation(async (options) => {
          capturedIds.push(new Uint8Array(options.publicKey.user.id))
          return { rawId: MOCK_CREDENTIAL_ID }
        }),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(passphrase, meta)
    await mod.setupBiometricUnlock(passphrase, meta)
    expect(capturedIds[0].byteLength).toBe(32)
    expect(capturedIds[0].toString()).not.toBe(capturedIds[1].toString())
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

  it('returns { handle, passphrase } after a full userhandle setup → unlock round-trip', async () => {
    const { create, getSecret } = makeCapturingCreate()
    vi.stubGlobal('navigator', {
      credentials: {
        create,
        get: makeMatchingGet(getSecret),
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
    const { create, getSecret } = makeCapturingCreate()
    vi.stubGlobal('navigator', {
      credentials: {
        create,
        get: vi.fn().mockRejectedValue(new DOMException('cancelled', 'NotAllowedError')),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(passphrase, meta)
    await expect(mod.unlockWithBiometrics()).rejects.toThrow('cancelled')
  })

  it('throws "decrypt-failed" when userHandle at unlock differs from setup', async () => {
    const { create } = makeCapturingCreate()
    vi.stubGlobal('navigator', {
      credentials: {
        create,
        get: vi.fn().mockResolvedValue({
          rawId: MOCK_CREDENTIAL_ID,
          response: { userHandle: new Uint8Array(32).fill(0x99).buffer },
        }),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(passphrase, meta)
    await expect(mod.unlockWithBiometrics()).rejects.toThrow('decrypt-failed')
  })

  it('throws "userhandle-unavailable" when the authenticator returns no userHandle', async () => {
    const { create } = makeCapturingCreate()
    vi.stubGlobal('navigator', {
      credentials: {
        create,
        get: vi.fn().mockResolvedValue({
          rawId: MOCK_CREDENTIAL_ID,
          response: { userHandle: null },
        }),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(passphrase, meta)
    await expect(mod.unlockWithBiometrics()).rejects.toThrow('userhandle-unavailable')
  })
})
