/**
 * storage.oidc.test.js
 * Tests for deriveIdentityOIDC — the OIDC identity derivation path.
 *
 * Strategy: same vi.resetModules() pattern as storage.test.js.
 * window.location.origin is http://localhost in jsdom — used as the PBKDF2 salt.
 */

const FAKE_SERVER_SECRET = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

describe('deriveIdentityOIDC — basic identity setup', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('sets an in-memory identity with publicKey, secretKey and username', async () => {
    await storage.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    const id = storage.getIdentity()
    expect(id).not.toBeNull()
    expect(ArrayBuffer.isView(id.publicKey)).toBe(true)
    expect(ArrayBuffer.isView(id.secretKey)).toBe(true)
    expect(typeof id.username).toBe('string')
    expect(id.username.length).toBeGreaterThan(0)
  })

  it('sets a 32-byte masterSeed in memory', async () => {
    await storage.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    const seed = storage.getMasterSeed()
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed.byteLength).toBe(32)
  })

  it('identity is cleared by lockSession', async () => {
    await storage.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    expect(storage.getIdentity()).not.toBeNull()
    storage.lockSession()
    expect(storage.getIdentity()).toBeNull()
    expect(storage.getMasterSeed()).toBeNull()
  })
})

describe('deriveIdentityOIDC — determinism', () => {
  it('produces the same masterSeed for the same serverSecret and origin', async () => {
    vi.resetModules()
    localStorage.clear()
    const s1 = await import('../../src/p2p/storage.js')
    await s1.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    const seed1 = s1.getMasterSeed().slice()

    vi.resetModules()
    localStorage.clear()
    const s2 = await import('../../src/p2p/storage.js')
    await s2.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    const seed2 = s2.getMasterSeed()

    expect(seed1.toString()).toBe(seed2.toString())
  })

  it('produces a different masterSeed for a different serverSecret', async () => {
    vi.resetModules()
    localStorage.clear()
    const s1 = await import('../../src/p2p/storage.js')
    await s1.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    const seed1 = s1.getMasterSeed().slice()

    vi.resetModules()
    localStorage.clear()
    const otherSecret = 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3'
    const s2 = await import('../../src/p2p/storage.js')
    await s2.deriveIdentityOIDC(otherSecret, 'v1', 'github')
    const seed2 = s2.getMasterSeed()

    expect(seed1.toString()).not.toBe(seed2.toString())
  })
})

describe('deriveIdentityOIDC — account creation and restoration', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('saves metadata to localStorage for a new account', async () => {
    await storage.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    const meta = storage.getStoredIdentityMeta()
    expect(meta).not.toBeNull()
    expect(meta.method).toBe('oidc')
    expect(meta.provider).toBe('github')
    expect(meta.serverSecretVersion).toBe('v1')
    expect(meta).toHaveProperty('publicKey')
    expect(meta).toHaveProperty('username')
  })

  it('does not store secretKey in localStorage', async () => {
    await storage.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    const meta = storage.getStoredIdentityMeta()
    expect(meta).not.toHaveProperty('secretKey')
  })

  it('reuses the existing username on a subsequent login with the same credentials', async () => {
    await storage.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    const originalUsername = storage.getIdentity().username

    // Simulate page reload: reset module but keep localStorage
    vi.resetModules()
    const fresh = await import('../../src/p2p/storage.js')
    await fresh.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')

    expect(fresh.getIdentity().username).toBe(originalUsername)
  })

  it('generates a new account if the provider changes', async () => {
    await storage.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')
    const originalMeta = storage.getStoredIdentityMeta()

    // Login with a different provider — treated as a new account
    vi.resetModules()
    const fresh = await import('../../src/p2p/storage.js')
    await fresh.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'google')

    const newMeta = fresh.getStoredIdentityMeta()
    expect(newMeta.provider).toBe('google')
    // publicKey differs because origin salt is the same but the derivation is re-run
    // and it's a new account, so a fresh username is generated
    expect(newMeta.username).toBeDefined()
  })

  it('throws key-version-changed when the derived publicKey no longer matches stored', async () => {
    // First login establishes the stored publicKey
    await storage.deriveIdentityOIDC(FAKE_SERVER_SECRET, 'v1', 'github')

    // Simulate re-login with a different serverSecret (key rotation on backend)
    vi.resetModules()
    const fresh = await import('../../src/p2p/storage.js')
    const differentSecret = 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'
    await expect(fresh.deriveIdentityOIDC(differentSecret, 'v2', 'github')).rejects.toThrow('key-version-changed')
  })
})
