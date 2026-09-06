/**
 * storage.test.js
 * Tests identity management, preferences and onboarding flags.
 *
 * Strategy: vi.resetModules() + dynamic import in beforeEach to reset
 * the module-level singletons (_identity, _store) between tests.
 */

describe('storage — identity', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
    // Derive identity with handle+passphrase (as the UI does)
    await storage.deriveIdentityA('test-user', 'password-sicura-123')
  })

  it('returns an identity object after deriveIdentityA', () => {
    const id = storage.getIdentity()
    expect(id).toHaveProperty('publicKey')
    expect(id).toHaveProperty('secretKey')
    expect(id).toHaveProperty('username')
    expect(typeof id.username).toBe('string')
    expect(id.username.length).toBeGreaterThan(0)
  })

  it('returns the same reference on successive calls', () => {
    const first = storage.getIdentity()
    const second = storage.getIdentity()
    expect(first).toBe(second) // same reference, not just structure
  })

  it('persists non-secret metadata to localStorage', () => {
    const raw = localStorage.getItem('p2p-chat:identity')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw)
    expect(parsed).toHaveProperty('publicKey')
    expect(parsed).toHaveProperty('username')
    // secretKey is no longer stored in clear — it is re-derived from the passphrase
    expect(parsed).not.toHaveProperty('secretKey')
  })

  it('restores the same username from localStorage on reload', async () => {
    const original = storage.getIdentity()
    const originalUsername = original.username

    // Reset the singleton but keep localStorage → simulates a page reload
    vi.resetModules()
    const fresh = await import('../../src/p2p/storage.js')
    await fresh.deriveIdentityA('test-user', 'password-sicura-123')
    const reloaded = fresh.getIdentity()

    expect(reloaded.username).toBe(originalUsername)
  })

  it('updates username in memory and localStorage via setUsername', () => {
    storage.setUsername('new-name')

    const updated = storage.getIdentity()
    expect(updated.username).toBe('new-name')

    const raw = JSON.parse(localStorage.getItem('p2p-chat:identity'))
    expect(raw.username).toBe('new-name')
  })
})

describe('storage — getIdentity', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('returns null before deriveIdentityA is called', () => {
    expect(storage.getIdentity()).toBeNull()
  })

  it('returns null after lockSession', async () => {
    await storage.deriveIdentityA('user', 'passphrase-test-456')
    expect(storage.getIdentity()).not.toBeNull()
    storage.lockSession()
    expect(storage.getIdentity()).toBeNull()
  })

  it('returns identity with publicKey, secretKey and username after deriveIdentityA', async () => {
    await storage.deriveIdentityA('user', 'passphrase-test-456')
    const id = storage.getIdentity()
    expect(id).not.toBeNull()
    // publicKey and secretKey are Buffers (typed arrays)
    expect(ArrayBuffer.isView(id.publicKey)).toBe(true)
    expect(ArrayBuffer.isView(id.secretKey)).toBe(true)
    expect(id.publicKey.length).toBeGreaterThan(0)
    expect(id.secretKey.length).toBeGreaterThan(0)
    expect(typeof id.username).toBe('string')
    expect(id.username.length).toBeGreaterThan(0)
  })

  it('produces the same publicKey for the same handle+passphrase', async () => {
    await storage.deriveIdentityA('deterministic', 'same-pass-789')
    const pk1 = storage.getIdentity().publicKey.toString()

    vi.resetModules()
    const fresh = await import('../../src/p2p/storage.js')
    await fresh.deriveIdentityA('deterministic', 'same-pass-789')
    const pk2 = fresh.getIdentity().publicKey.toString()

    expect(pk1).toBe(pk2)
  })

  it('produces a different publicKey for different credentials', async () => {
    await storage.deriveIdentityA('user-a', 'passA-sicura-123')
    const pk1 = storage.getIdentity().publicKey.toString()

    vi.resetModules()
    localStorage.clear()
    const fresh = await import('../../src/p2p/storage.js')
    await fresh.deriveIdentityA('user-b', 'passB-sicura-456')
    const pk2 = fresh.getIdentity().publicKey.toString()

    expect(pk1).not.toBe(pk2)
  })

  it('throws wrong-passphrase if passphrase does not match existing handle', async () => {
    await storage.deriveIdentityA('user', 'correct-passphrase-123')

    vi.resetModules()
    const fresh = await import('../../src/p2p/storage.js')
    await expect(fresh.deriveIdentityA('user', 'wrong-passphrase-999')).rejects.toThrow('wrong-passphrase')
    expect(fresh.getIdentity()).toBeNull()
  })
})

describe('storage — getMasterSeed', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('returns null before deriveIdentityA is called', () => {
    expect(storage.getMasterSeed()).toBeNull()
  })

  it('returns a 32-byte Uint8Array after deriveIdentityA', async () => {
    await storage.deriveIdentityA('user', 'passphrase-test-456')
    const seed = storage.getMasterSeed()
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed.byteLength).toBe(32)
  })

  it('returns the same seed reference on successive calls', async () => {
    await storage.deriveIdentityA('user', 'passphrase-test-456')
    expect(storage.getMasterSeed()).toBe(storage.getMasterSeed())
  })

  it('returns null again after lockSession', async () => {
    await storage.deriveIdentityA('user', 'passphrase-test-456')
    expect(storage.getMasterSeed()).not.toBeNull()
    storage.lockSession()
    expect(storage.getMasterSeed()).toBeNull()
  })
})

describe('storage — getPassphrase / clearPassphrase', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('returns null before deriveIdentityA is called', () => {
    expect(storage.getPassphrase()).toBeNull()
  })

  it('returns the passphrase after deriveIdentityA', async () => {
    await storage.deriveIdentityA('user', 'my-passphrase-789')
    expect(storage.getPassphrase()).toBe('my-passphrase-789')
  })

  it('clearPassphrase() sets passphrase to null without ending the session', async () => {
    await storage.deriveIdentityA('user', 'my-passphrase-789')
    expect(storage.getPassphrase()).toBe('my-passphrase-789')
    storage.clearPassphrase()
    expect(storage.getPassphrase()).toBeNull()
    // masterSeed and identity are still alive
    expect(storage.getMasterSeed()).not.toBeNull()
    expect(storage.getIdentity()).not.toBeNull()
  })

  it('returns null after lockSession', async () => {
    await storage.deriveIdentityA('user', 'my-passphrase-789')
    storage.lockSession()
    expect(storage.getPassphrase()).toBeNull()
  })
})

describe('storage — getStoredIdentityMeta', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('returns null when localStorage is empty', () => {
    expect(storage.getStoredIdentityMeta()).toBeNull()
  })

  it('returns null for legacy format (missing method field)', () => {
    // Simulate old format that stored secretKey in clear without a method field
    localStorage.setItem(
      'p2p-chat:identity',
      JSON.stringify({
        publicKey: 'deadbeef',
        secretKey: 'cafebabe',
        username: 'old-user',
      })
    )
    expect(storage.getStoredIdentityMeta()).toBeNull()
  })

  it('returns the metadata object for valid format', async () => {
    await storage.deriveIdentityA('test-user', 'password-sicura-123')
    const meta = storage.getStoredIdentityMeta()
    expect(meta).not.toBeNull()
    expect(meta).toHaveProperty('handle', 'test-user')
    expect(meta).toHaveProperty('publicKey')
    expect(meta).toHaveProperty('username')
    expect(meta).toHaveProperty('method', 'passphrase')
    expect(meta).not.toHaveProperty('secretKey')
  })
})

describe('storage — setUsername', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
    await storage.deriveIdentityA('test-user', 'password-sicura-123')
  })

  it('updates the username in memory', () => {
    storage.setUsername('alice')
    expect(storage.getIdentity().username).toBe('alice')
  })

  it('persists the new username to localStorage', () => {
    storage.setUsername('bob')
    const stored = JSON.parse(localStorage.getItem('p2p-chat:identity'))
    expect(stored.username).toBe('bob')
  })

  it('does not modify publicKey in localStorage', () => {
    const before = JSON.parse(localStorage.getItem('p2p-chat:identity')).publicKey
    storage.setUsername('charlie')
    const after = JSON.parse(localStorage.getItem('p2p-chat:identity')).publicKey
    expect(before).toBe(after)
  })

  it('is a no-op when called without an active identity', async () => {
    storage.lockSession()
    expect(() => storage.setUsername('ghost')).not.toThrow()
    const stored = JSON.parse(localStorage.getItem('p2p-chat:identity'))
    expect(stored.username).not.toBe('ghost')
  })

  it('overwrites a previously set username', () => {
    storage.setUsername('first')
    storage.setUsername('second')
    expect(storage.getIdentity().username).toBe('second')
    const stored = JSON.parse(localStorage.getItem('p2p-chat:identity'))
    expect(stored.username).toBe('second')
  })
})

describe('storage — video preferences', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it("returns '1080p' as default quality", () => {
    expect(storage.getVideoQuality()).toBe('1080p')
  })

  it('persists the selected video quality', () => {
    storage.setVideoQuality('720p')
    expect(storage.getVideoQuality()).toBe('720p')
  })

  it('overwrites the previous quality', () => {
    storage.setVideoQuality('480p')
    storage.setVideoQuality('1080p')
    expect(storage.getVideoQuality()).toBe('1080p')
  })
})

describe('storage — stats overlay', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('returns false by default', () => {
    expect(storage.getShowStats()).toBe(false)
  })

  it('persists true', () => {
    storage.setShowStats(true)
    expect(storage.getShowStats()).toBe(true)
  })

  it('persists false', () => {
    storage.setShowStats(true)
    storage.setShowStats(false)
    expect(storage.getShowStats()).toBe(false)
  })
})

describe('storage — mirrorVideo', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('returns true by default (mirror on)', () => {
    expect(storage.getMirrorVideo()).toBe(true)
  })

  it('persists false', () => {
    storage.setMirrorVideo(false)
    expect(storage.getMirrorVideo()).toBe(false)
  })

  it('persists true after setting false', () => {
    storage.setMirrorVideo(false)
    storage.setMirrorVideo(true)
    expect(storage.getMirrorVideo()).toBe(true)
  })
})

describe('storage — restoreFromMasterSeed', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('restores identity from the correct masterSeed', async () => {
    await storage.deriveIdentityA('restore-test', 'pass-restore-123')
    const seed = storage.getMasterSeed()
    const original = storage.getIdentity()

    storage.lockSession()
    expect(storage.getIdentity()).toBeNull()

    storage.restoreFromMasterSeed(seed)
    const restored = storage.getIdentity()

    expect(restored).not.toBeNull()
    expect(restored.publicKey.toString()).toBe(original.publicKey.toString())
    expect(restored.username).toBe(original.username)
  })

  it('throws "no-stored-identity" when localStorage is empty', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32))
    expect(() => storage.restoreFromMasterSeed(seed)).toThrow('no-stored-identity')
  })

  it('throws "seed-mismatch" when the seed does not match the stored publicKey', async () => {
    await storage.deriveIdentityA('mismatch-test', 'pass-mismatch-123')
    const wrongSeed = crypto.getRandomValues(new Uint8Array(32))
    expect(() => storage.restoreFromMasterSeed(wrongSeed)).toThrow('seed-mismatch')
  })
})

describe('storage — createGuestIdentity', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('sets a valid in-memory identity', () => {
    storage.createGuestIdentity('Guest User')
    const id = storage.getIdentity()
    expect(id).not.toBeNull()
    expect(id.username).toBe('Guest User')
    expect(id.isGuest).toBe(true)
    expect(ArrayBuffer.isView(id.publicKey)).toBe(true)
    expect(ArrayBuffer.isView(id.secretKey)).toBe(true)
  })

  it('sets a 32-byte masterSeed in memory', () => {
    storage.createGuestIdentity('Guest')
    const seed = storage.getMasterSeed()
    expect(seed).toBeInstanceOf(Uint8Array)
    expect(seed.byteLength).toBe(32)
  })

  it('does not write anything to localStorage', () => {
    storage.createGuestIdentity('Ghost')
    expect(localStorage.getItem('p2p-chat:identity')).toBeNull()
  })

  it('produces a different keypair on each call', () => {
    storage.createGuestIdentity('A')
    const pk1 = storage.getIdentity().publicKey.toString()

    vi.resetModules()
    import('../../src/p2p/storage.js').then((fresh) => {
      fresh.createGuestIdentity('B')
      const pk2 = fresh.getIdentity().publicKey.toString()
      expect(pk1).not.toBe(pk2)
    })
  })

  it('identity is cleared by lockSession', () => {
    storage.createGuestIdentity('Temp')
    expect(storage.getIdentity()).not.toBeNull()
    storage.lockSession()
    expect(storage.getIdentity()).toBeNull()
  })
})

describe('storage — generateUsername', () => {
  let storage

  beforeEach(async () => {
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('returns a non-empty string', () => {
    expect(typeof storage.generateUsername()).toBe('string')
    expect(storage.generateUsername().length).toBeGreaterThan(0)
  })

  it('follows the adjective-noun pattern (two words separated by a hyphen)', () => {
    const name = storage.generateUsername()
    const parts = name.split('-')
    expect(parts).toHaveLength(2)
    parts.forEach((p) => expect(p.length).toBeGreaterThan(0))
  })

  it('produces varied results across multiple calls', () => {
    const names = new Set(Array.from({ length: 20 }, () => storage.generateUsername()))
    expect(names.size).toBeGreaterThan(1)
  })
})

describe('storage — generateRoomCode', () => {
  let storage

  beforeEach(async () => {
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('generates a code as word-random6-word', () => {
    const code = storage.generateRoomCode()
    const parts = code.split('-')
    expect(parts).toHaveLength(3)
    expect(parts[0].length).toBeGreaterThan(0)
    expect(parts[1]).toMatch(/^[a-z0-9]{6}$/)
    expect(parts[2].length).toBeGreaterThan(0)
  })

  it('generates different codes on each call', () => {
    const codes = new Set(Array.from({ length: 10 }, () => storage.generateRoomCode()))
    expect(codes.size).toBeGreaterThan(1)
  })

  it('never repeats across many calls (suffix provides real entropy)', () => {
    const codes = new Set(Array.from({ length: 500 }, () => storage.generateRoomCode()))
    expect(codes.size).toBe(500)
  })
})
