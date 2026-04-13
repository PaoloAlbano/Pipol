/**
 * autobase.js
 * Multi-writer group chat over Hypercore.
 *
 * Each peer owns a single append-only Hypercore for their messages in a room.
 * When peers connect via Hyperswarm, their Corestores replicate automatically —
 * including all message cores the local peer has registered.
 *
 * This implements the spirit of Autobase (multi-writer convergence) without
 * depending on autobase's complex v6 view API, making it more browser-friendly.
 * Messages from all writers are merged by timestamp at read time.
 *
 * Core naming convention (deterministic, derived from corestore primary key):
 *   "messages:{roomCode}"  →  this peer's writable message log for the room
 */

import b4a from 'b4a'
import { getStore, getIdentity } from './storage.js'
import { persistMessage, loadMessages } from './db.js'

export class MessageStore {
  /**
   * @param {string} roomCode
   * @param {{ username: string, publicKey: Buffer }} identity
   */
  constructor(roomCode, identity) {
    this.roomCode = roomCode
    this.identity = identity

    this._localCore = null
    this._remoteCores = new Map() // hex pubKey → Hypercore
    this._channelMessages = [] // messages received via swarm control channel (browser mode)
    this._store = null
    this._listeners = new Map() // event → [fn, ...]
  }

  async init() {
    this._store = await getStore()

    // Named core: deterministic key from (identity + roomCode)
    // valueEncoding: 'json' lets Hypercore handle serialisation — no manual Buffer wrapping needed
    this._localCore = this._store.get({ name: `messages:${this.roomCode}`, valueEncoding: 'json' })
    await this._localCore.ready()

    // Emit messages update whenever our own core grows
    this._localCore.on('append', () => this._emit('messages'))

    // Load persisted messages from IndexedDB into the in-memory channel cache
    const persisted = await loadMessages(this.roomCode)
    const MAX_MESSAGE_LENGTH = 10000
    for (const msg of persisted) {
      if (!this._channelMessages.some((m) => m.id === msg.id)) {
        // Validate and truncate if needed (defensive: old messages or corruption)
        if (msg.content?.length > MAX_MESSAGE_LENGTH) {
          msg.content = msg.content.slice(0, MAX_MESSAGE_LENGTH)
        }
        this._channelMessages.push(msg)
      }
    }
    console.info(`[autobase] Loaded ${persisted.length} messages from IndexedDB for room "${this.roomCode}"`)
    console.info(
      `[autobase] Local core ready. key=${b4a.toString(this._localCore.key, 'hex').slice(0, 16)}… length=${this._localCore.length}`
    )
    return this
  }

  /**
   * Accept a message forwarded via the swarm control channel
   * (used in BroadcastChannel browser mode where Hypercore replication is unavailable).
   * @param {object} msg
   */
  receiveMessage(msg) {
    if (!msg?.id) return
    if (this._channelMessages.some((m) => m.id === msg.id)) return
    // Validate message length — truncate if too long (malicious or buggy peer)
    const MAX_MESSAGE_LENGTH = 10000
    if (msg.content?.length > MAX_MESSAGE_LENGTH) {
      console.warn('[autobase] Message too long, truncating:', msg.content.length, '→', MAX_MESSAGE_LENGTH)
      msg.content = msg.content.slice(0, MAX_MESSAGE_LENGTH)
    }
    this._channelMessages.push(msg)
    persistMessage(this.roomCode, msg).catch(() => {})
    this._emit('messages')
  }

  /** Hex public key for this peer's message core (to be advertised in HELLO). */
  getLocalCoreKey() {
    const hex = this._localCore?.key ? b4a.toString(this._localCore.key, 'hex') : null
    console.log('[autobase] getLocalCoreKey length:', hex?.length, 'value:', hex?.slice(0, 16))
    return hex
  }

  /**
   * Append a new text message to our local Hypercore.
   * @param {string} content
   * @returns {Promise<object>} The message object
   * @throws {Error} If content exceeds maximum length
   */
  async addMessage(content) {
    const MAX_MESSAGE_LENGTH = 10000
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message too long (${content.length}/${MAX_MESSAGE_LENGTH} characters)`)
    }
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      username: getIdentity().username,
      publicKey: b4a.toString(this.identity.publicKey, 'hex'),
      timestamp: Date.now(),
      type: 'text',
    }
    await this._localCore.append(msg)
    persistMessage(this.roomCode, msg).catch(() => {})
    return msg
  }

  /** Timestamp of the newest message in history (0 if empty). */
  async getLastTimestamp() {
    const all = await this.getHistory()
    if (all.length === 0) return 0
    return Math.max(...all.map((m) => m.timestamp))
  }

  /**
   * Register a remote peer's message core so it gets replicated and included
   * in the merged view.  Safe to call multiple times with the same key.
   *
   * @param {string} coreKeyHex  Hex-encoded 32-byte public key
   */
  async addRemoteCore(coreKeyHex) {
    if (!coreKeyHex) return
    if (this._remoteCores.has(coreKeyHex)) return
    if (coreKeyHex === b4a.toString(this._localCore.key, 'hex')) return

    console.log(
      '[autobase] addRemoteCore type:',
      typeof coreKeyHex,
      'length:',
      coreKeyHex?.length,
      'value:',
      coreKeyHex
    )

    if (typeof coreKeyHex !== 'string' || coreKeyHex.length !== 64) {
      console.warn('[autobase] invalid core key, skipping:', coreKeyHex)
      return
    }

    const core = this._store.get({ key: b4a.from(coreKeyHex, 'hex'), valueEncoding: 'json' })
    await core.ready()

    this._remoteCores.set(coreKeyHex, core)

    // Emit an update whenever this remote core grows (new blocks replicated)
    core.on('append', () => this._emit('messages'))

    console.info(`[autobase] Registered remote core ${coreKeyHex.slice(0, 16)}… length=${core.length}`)

    return core
  }

  /**
   * Read and merge all messages from all known cores, sorted by timestamp.
   * @returns {Promise<object[]>}
   */
  async getHistory() {
    const all = []

    await this._readCoreInto(this._localCore, all)

    for (const core of this._remoteCores.values()) {
      await this._readCoreInto(core, all)
    }

    // Include messages forwarded via swarm control channel (browser mode)
    for (const msg of this._channelMessages) {
      if (!all.some((m) => m.id === msg.id)) all.push(msg)
    }

    // Stable sort by timestamp; break ties by publicKey for determinism
    all.sort((a, b) => a.timestamp - b.timestamp || a.publicKey?.localeCompare(b.publicKey))
    return all
  }

  /** Read all blocks from a core into the destination array. */
  async _readCoreInto(core, dest) {
    if (!core || core.length === 0) return
    for (let i = 0; i < core.length; i++) {
      try {
        const block = await core.get(i)
        if (block) dest.push(block) // already decoded by valueEncoding: 'json'
      } catch (err) {
        console.warn('[autobase] failed to read block', i, err)
      }
    }
  }

  on(event, listener) {
    if (!this._listeners.has(event)) this._listeners.set(event, [])
    this._listeners.get(event).push(listener)
  }

  off(event, listener) {
    const arr = this._listeners.get(event)
    if (arr) {
      const idx = arr.indexOf(listener)
      if (idx !== -1) arr.splice(idx, 1)
    }
  }

  async _emit(event) {
    const listeners = this._listeners.get(event) || []
    if (listeners.length === 0) return
    const messages = await this.getHistory()
    for (const fn of listeners) fn(messages)
  }

  async close() {
    await this._localCore?.close().catch(() => {})
    for (const core of this._remoteCores.values()) {
      await core.close().catch(() => {})
    }
  }
}
