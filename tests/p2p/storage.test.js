/**
 * storage.test.js
 * Tests identity management, preferences and onboarding flags.
 *
 * Strategy: vi.resetModules() + dynamic import in beforeEach to reset
 * the module-level singletons (_identity, _store) between tests.
 */

describe('storage — identità', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('crea una nuova identità alla prima chiamata', () => {
    const id = storage.getIdentity()
    expect(id).toHaveProperty('publicKey')
    expect(id).toHaveProperty('secretKey')
    expect(id).toHaveProperty('username')
    expect(typeof id.username).toBe('string')
    expect(id.username.length).toBeGreaterThan(0)
  })

  it('restituisce la stessa identità nelle chiamate successive', () => {
    const first = storage.getIdentity()
    const second = storage.getIdentity()
    expect(first).toBe(second) // same reference, not just structure
  })

  it("persiste l'identità in localStorage", () => {
    storage.getIdentity()
    const raw = localStorage.getItem('p2p-chat:identity')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw)
    expect(parsed).toHaveProperty('publicKey')
    expect(parsed).toHaveProperty('secretKey')
    expect(parsed).toHaveProperty('username')
  })

  it("ricarica l'identità da localStorage se già presente", async () => {
    // Create identity in the first module instance
    const original = storage.getIdentity()
    const originalUsername = original.username

    // Reset the singleton but keep localStorage → simulates a page reload
    vi.resetModules()
    const fresh = await import('../../src/p2p/storage.js')
    const reloaded = fresh.getIdentity()

    expect(reloaded.username).toBe(originalUsername)
  })

  it('aggiorna username in memoria e localStorage', () => {
    storage.getIdentity()
    storage.setUsername('nuovo-nome')

    const updated = storage.getIdentity()
    expect(updated.username).toBe('nuovo-nome')

    const raw = JSON.parse(localStorage.getItem('p2p-chat:identity'))
    expect(raw.username).toBe('nuovo-nome')
  })
})

describe('storage — preferenze video', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it("restituisce '1080p' come qualità default", () => {
    expect(storage.getVideoQuality()).toBe('1080p')
  })

  it('persiste la qualità video selezionata', () => {
    storage.setVideoQuality('720p')
    expect(storage.getVideoQuality()).toBe('720p')
  })

  it('sovrascrive la qualità precedente', () => {
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

  it('restituisce false come default', () => {
    expect(storage.getShowStats()).toBe(false)
  })

  it('persiste il valore true', () => {
    storage.setShowStats(true)
    expect(storage.getShowStats()).toBe(true)
  })

  it('persiste il valore false', () => {
    storage.setShowStats(true)
    storage.setShowStats(false)
    expect(storage.getShowStats()).toBe(false)
  })
})

describe('storage — onboarding', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('indica prima visita se il flag non esiste', () => {
    expect(storage.isFirstVisit()).toBe(true)
  })

  it('non è più prima visita dopo markOnboarded()', () => {
    storage.markOnboarded()
    expect(storage.isFirstVisit()).toBe(false)
  })

  it('markOnboarded() è idempotente', () => {
    storage.markOnboarded()
    storage.markOnboarded()
    expect(storage.isFirstVisit()).toBe(false)
  })
})

describe('storage — generateRoomCode', () => {
  let storage

  beforeEach(async () => {
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('genera un codice con 3 parole separate da trattino', () => {
    const code = storage.generateRoomCode()
    const parts = code.split('-')
    expect(parts).toHaveLength(3)
    parts.forEach((p) => expect(p.length).toBeGreaterThan(0))
  })

  it('genera codici diversi ad ogni chiamata', () => {
    const codes = new Set(Array.from({ length: 10 }, () => storage.generateRoomCode()))
    expect(codes.size).toBeGreaterThan(1)
  })
})
