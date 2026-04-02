/**
 * db.js
 * IndexedDB persistence for chat messages.
 * Messages are stored by room so each room has its own history.
 *
 * Content is encrypted at rest with AES-256-GCM.
 * The encryption key is derived from the user's secretKey via SHA-256
 * and never leaves memory — it is re-derived on every session.
 */

const DB_NAME = 'p2p-chat'
const DB_VERSION = 1
const STORE = 'messages'

let _db = null
let _encKey = null // CryptoKey (AES-GCM 256-bit), set via initEncryption()

/**
 * Derive and store the AES-GCM key for this session.
 * Must be called once at startup before any read/write.
 * @param {Uint8Array} masterSeed  The 32-byte masterSeed from deriveIdentityA()
 */
export async function initEncryption(masterSeed) {
  // HKDF(masterSeed, info="storage-enc-v1") → AES-256-GCM key
  const hkdfKey = await crypto.subtle.importKey('raw', masterSeed, 'HKDF', false, ['deriveKey'])
  _encKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('storage-enc-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function _encrypt(plaintext) {
  if (!_encKey) return { content: plaintext }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _encKey, encoded)
  // Encode iv + ciphertext as a single base64 string
  const combined = new Uint8Array(12 + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), 12)
  return { content: btoa(String.fromCharCode(...combined)), _enc: true }
}

async function _decrypt(record) {
  if (!record._enc || !_encKey) return record.content
  try {
    const combined = Uint8Array.from(atob(record.content), (c) => c.charCodeAt(0))
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, _encKey, ciphertext)
    return new TextDecoder().decode(plaintext)
  } catch {
    // Chiave sbagliata (account diverso) → scarta il messaggio
    return null
  }
}

async function openDB() {
  if (_db) return _db
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('by_room', 'room')
      }
    }
    req.onsuccess = () => {
      _db = req.result
      resolve(_db)
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * Save (upsert) a message for a given room.
 * @param {string} roomCode
 * @param {object} msg
 */
export async function persistMessage(roomCode, msg) {
  const db = await openDB()
  const { content, _enc } = await _encrypt(msg.content)
  const record = { ...msg, content, room: roomCode }
  if (_enc) record._enc = true
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Load all persisted messages for a room, sorted by timestamp.
 * @param {string} roomCode
 * @returns {Promise<object[]>}
 */
export async function loadMessages(roomCode) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).index('by_room').getAll(roomCode)
    req.onsuccess = async () => {
      const rows = req.result ?? []
      const msgs = await Promise.all(
        rows.map(async ({ room: _r, _enc, ...msg }) => ({
          ...msg,
          content: await _decrypt({ content: msg.content, _enc }),
        }))
      )
      // Filtra i messaggi che non si riescono a decifrare (appartenenti a un altro account)
      msgs.sort((a, b) => a.timestamp - b.timestamp)
      resolve(msgs.filter((m) => m.content !== null))
    }
    req.onerror = () => reject(req.error)
  })
}
