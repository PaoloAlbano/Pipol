/**
 * db.test.js
 * Tests message persistence on IndexedDB and content encryption.
 *
 * Uses fake-indexeddb for a real IndexedDB implementation in jsdom,
 * and the native Web Crypto API from Node 18+ to test encryption.
 */

import { IDBFactory } from 'fake-indexeddb'

// Replaces the global IndexedDB with the in-memory implementation
// before each test (fresh instance = clean db)
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

// Re-imports the module each time to reset the _db singleton
// (which would otherwise retain the reference to the previous db)
async function getDb() {
  vi.resetModules()
  return import('../../src/p2p/db.js')
}

// ── Helper ────────────────────────────────────────────────────────────────────

function makeMsg(overrides = {}) {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    content: 'Hello world',
    username: 'test-user',
    publicKey: 'aabbcc',
    timestamp: Date.now(),
    type: 'text',
    ...overrides,
  }
}

// ── persistMessage / loadMessages ─────────────────────────────────────────────

describe('db — persistMessage + loadMessages', () => {
  it('salva e recupera un messaggio', async () => {
    const { persistMessage, loadMessages } = await getDb()
    const msg = makeMsg()

    await persistMessage('room-a', msg)
    const results = await loadMessages('room-a')

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(msg.id)
    expect(results[0].content).toBe(msg.content)
  })

  it('restituisce array vuoto per room sconosciuta', async () => {
    const { loadMessages } = await getDb()
    const results = await loadMessages('room-sconosciuta')
    expect(results).toEqual([])
  })

  it('isola i messaggi per room', async () => {
    const { persistMessage, loadMessages } = await getDb()
    const msgA = makeMsg({ id: 'a', content: 'Msg room A' })
    const msgB = makeMsg({ id: 'b', content: 'Msg room B' })

    await persistMessage('room-a', msgA)
    await persistMessage('room-b', msgB)

    const resultsA = await loadMessages('room-a')
    const resultsB = await loadMessages('room-b')

    expect(resultsA).toHaveLength(1)
    expect(resultsA[0].id).toBe('a')
    expect(resultsB).toHaveLength(1)
    expect(resultsB[0].id).toBe('b')
  })

  it('ordina i messaggi per timestamp crescente', async () => {
    const { persistMessage, loadMessages } = await getDb()
    const now = Date.now()

    // Inserts in reverse order
    await persistMessage('room-a', makeMsg({ id: 'c', timestamp: now + 200 }))
    await persistMessage('room-a', makeMsg({ id: 'a', timestamp: now }))
    await persistMessage('room-a', makeMsg({ id: 'b', timestamp: now + 100 }))

    const results = await loadMessages('room-a')
    expect(results.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('non espone il campo room nel risultato', async () => {
    const { persistMessage, loadMessages } = await getDb()
    await persistMessage('room-a', makeMsg())
    const [result] = await loadMessages('room-a')
    expect(result).not.toHaveProperty('room')
  })

  it('fa upsert: salva due volte lo stesso id senza duplicati', async () => {
    const { persistMessage, loadMessages } = await getDb()
    const msg = makeMsg({ id: 'fixed-id', content: 'originale' })
    await persistMessage('room-a', msg)
    await persistMessage('room-a', { ...msg, content: 'aggiornato' })

    const results = await loadMessages('room-a')
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('aggiornato')
  })
})

// ── Cifratura ─────────────────────────────────────────────────────────────────

describe('db — cifratura contenuto', () => {
  it('il contenuto in IndexedDB è diverso dal plaintext dopo initEncryption', async () => {
    const { initEncryption, persistMessage } = await getDb()

    // Test key: 64 random bytes (like an ed25519 secretKey)
    const secretKey = crypto.getRandomValues(new Uint8Array(64))
    await initEncryption(secretKey)

    const msg = makeMsg({ content: 'testo segreto' })
    await persistMessage('room-a', msg)

    // Reads directly from IndexedDB without going through loadMessages
    const raw = await new Promise((resolve, reject) => {
      const req = indexedDB.open('p2p-chat', 1)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('messages', 'readonly')
        const store = tx.objectStore('messages')
        const getReq = store.get(msg.id)
        getReq.onsuccess = () => resolve(getReq.result)
        getReq.onerror = () => reject(getReq.error)
      }
      req.onerror = () => reject(req.error)
    })

    // The raw content must not be the original plaintext
    expect(raw.content).not.toBe('testo segreto')
    expect(raw._enc).toBe(true)
  })

  it('loadMessages decifra correttamente il contenuto', async () => {
    const { initEncryption, persistMessage, loadMessages } = await getDb()

    const secretKey = crypto.getRandomValues(new Uint8Array(64))
    await initEncryption(secretKey)

    const msg = makeMsg({ content: 'messaggio cifrato' })
    await persistMessage('room-a', msg)
    const results = await loadMessages('room-a')

    expect(results[0].content).toBe('messaggio cifrato')
  })

  it('senza initEncryption il contenuto rimane in chiaro', async () => {
    const { persistMessage, loadMessages } = await getDb()

    const msg = makeMsg({ content: 'plaintext' })
    await persistMessage('room-a', msg)
    const results = await loadMessages('room-a')

    expect(results[0].content).toBe('plaintext')
  })

  it('loadMessages gestisce messaggi legacy (non cifrati) senza errori', async () => {
    const { initEncryption, persistMessage, loadMessages } = await getDb()

    // Save without encryption
    const msg = makeMsg({ content: 'vecchio messaggio' })
    await persistMessage('room-a', msg)

    // Then enable encryption and read — must return the content as-is
    const secretKey = crypto.getRandomValues(new Uint8Array(64))
    await initEncryption(secretKey)

    const results = await loadMessages('room-a')
    expect(results[0].content).toBe('vecchio messaggio')
  })
})
