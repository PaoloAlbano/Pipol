/**
 * webauthn.test.js
 * Tests for the WebAuthn PRF biometric unlock helpers.
 *
 * navigator.credentials is mocked — no real authenticator needed.
 * crypto.subtle is the real Node 18+ implementation so the
 * AES-GCM encrypt/decrypt cycle is tested against actual cryptography.
 */

const MOCK_CREDENTIAL_ID = new Uint8Array(16).fill(1)

// A fixed 32-byte PRF output reused across create and get mocks so
// the encrypt/decrypt round-trip closes correctly.
const MOCK_PRF_OUTPUT = new Uint8Array(32).fill(0xab)

function makeMockCredential(prfFirst = MOCK_PRF_OUTPUT) {
  return {
    rawId: MOCK_CREDENTIAL_ID,
    getClientExtensionResults: () => ({
      prf: { results: { first: prfFirst } },
    }),
  }
}

function makeMockAssertion(prfFirst = MOCK_PRF_OUTPUT) {
  return {
    getClientExtensionResults: () => ({
      prf: { results: { first: prfFirst } },
    }),
  }
}

async function getModule() {
  vi.resetModules()
  localStorage.clear()
  return import('../../src/p2p/webauthn.js')
}

// ── hasBiometricUnlock / removeBiometricUnlock ────────────────────────────────

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

  it('ignores getClientCapabilities — extension:prf is unreliable across authenticators', async () => {
    // Even if extension:prf=true, Windows Hello and Google PM may not return PRF results.
    // We only gate on platform authenticator presence; actual PRF support is
    // determined at registration time.
    vi.stubGlobal('PublicKeyCredential', {
      getClientCapabilities: vi.fn().mockResolvedValue({ 'extension:prf': true }),
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(true),
    })
    const { isBiometricUnlockAvailable } = await getModule()
    expect(await isBiometricUnlockAvailable()).toBe(true)
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
  const masterSeed = crypto.getRandomValues(new Uint8Array(32))
  const meta = { handle: 'alice@example.com', username: 'Alice' }

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('saves an encrypted blob to localStorage', async () => {
    vi.stubGlobal('navigator', {
      credentials: { create: vi.fn().mockResolvedValue(makeMockCredential()) },
    })
    const { setupBiometricUnlock } = await getModule()
    await setupBiometricUnlock(masterSeed, meta)

    const raw = localStorage.getItem('p2p-chat:biometric')
    expect(raw).not.toBeNull()
    const blob = JSON.parse(raw)
    expect(blob).toHaveProperty('credentialId')
    expect(blob).toHaveProperty('iv')
    expect(blob).toHaveProperty('ciphertext')
  })

  it('throws "cancelled" when the user dismisses the prompt', async () => {
    vi.stubGlobal('navigator', {
      credentials: { create: vi.fn().mockRejectedValue(new DOMException('cancelled')) },
    })
    const { setupBiometricUnlock } = await getModule()
    await expect(setupBiometricUnlock(masterSeed, meta)).rejects.toThrow('cancelled')
    expect(localStorage.getItem('p2p-chat:biometric')).toBeNull()
  })

  it('throws "authenticator-no-prf" when the authenticator does not return a PRF result', async () => {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockResolvedValue({
          rawId: MOCK_CREDENTIAL_ID,
          getClientExtensionResults: () => ({}), // no prf key
        }),
      },
    })
    const { setupBiometricUnlock } = await getModule()
    await expect(setupBiometricUnlock(masterSeed, meta)).rejects.toThrow('authenticator-no-prf')
  })
})

// ── unlockWithBiometrics ──────────────────────────────────────────────────────

describe('webauthn — unlockWithBiometrics', () => {
  const masterSeed = crypto.getRandomValues(new Uint8Array(32))
  const meta = { handle: 'alice@example.com', username: 'Alice' }

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  async function setupAndUnlock() {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockResolvedValue(makeMockCredential()),
        get: vi.fn().mockResolvedValue(makeMockAssertion()),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(masterSeed, meta)
    return mod.unlockWithBiometrics()
  }

  it('returns the original masterSeed after a setup+unlock round-trip', async () => {
    const recovered = await setupAndUnlock()
    expect(recovered).toBeInstanceOf(Uint8Array)
    expect(recovered).toEqual(masterSeed)
  })

  it('throws "no-biometric-setup" when no blob is stored', async () => {
    const { unlockWithBiometrics } = await getModule()
    await expect(unlockWithBiometrics()).rejects.toThrow('no-biometric-setup')
  })

  it('throws "cancelled" when the user dismisses the prompt', async () => {
    // First setup so the blob exists
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockResolvedValue(makeMockCredential()),
        get: vi.fn().mockRejectedValue(new DOMException('cancelled')),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(masterSeed, meta)
    await expect(mod.unlockWithBiometrics()).rejects.toThrow('cancelled')
  })

  it('throws "decrypt-failed" when the PRF output is wrong', async () => {
    // Setup with one PRF output, unlock with a different one
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockResolvedValue(makeMockCredential(new Uint8Array(32).fill(0xab))),
        get: vi.fn().mockResolvedValue(makeMockAssertion(new Uint8Array(32).fill(0xcd))),
      },
    })
    vi.resetModules()
    localStorage.clear()
    const mod = await import('../../src/p2p/webauthn.js')
    await mod.setupBiometricUnlock(masterSeed, meta)
    await expect(mod.unlockWithBiometrics()).rejects.toThrow('decrypt-failed')
  })
})
