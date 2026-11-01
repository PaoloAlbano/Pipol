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
import { signMessage, verifyMessage, cleanMessage, sameMessage, signOp, verifyOp, toHex } from './signing.js'

const MAX_MESSAGE_LENGTH = 10000

export class MessageStore {
  /**
   * @param {string} roomCode  Also the scope of every signature made or verified by this store
   * @param {{ username: string, publicKey: Uint8Array, secretKey: Uint8Array }} identity
   */
  constructor(roomCode, identity) {
    this.roomCode = roomCode
    this.identity = identity

    this._localCore = null
    this._remoteCores = new Map() // hex pubKey → Hypercore
    this._channelMessages = [] // signed messages received via swarm / loaded from IndexedDB
    this._store = null
    this._listeners = new Map() // event → [fn, ...]
    // Signed edit/delete operations, keyed `${messageId}:${authorPublicKey}`. They are kept apart from the
    // messages (which stay exactly as signed) and applied in getHistory(), only when the signer is the
    // author of the message. This also covers messages that live in immutable Hypercore blocks.
    this._edits = new Map()
    this._deletes = new Map()
    this._verifiedBlocks = new Map() // `${id}:${sig}` → { block, msg }: the verdict for a block, reused only if identical
  }

  async init() {
    this._store = await getStore()

    // Named core: deterministic key from (identity + roomCode)
    // valueEncoding: 'json' lets Hypercore handle serialisation — no manual Buffer wrapping needed
    this._localCore = this._store.get({ name: `messages:${this.roomCode}`, valueEncoding: 'json' })
    await this._localCore.ready()

    // Emit messages update whenever our own core grows
    this._localCore.on('append', () => this._emit('messages'))

    // Load persisted messages from IndexedDB into the in-memory channel cache (our own storage: trusted)
    const persisted = await loadMessages(this.roomCode)
    for (const stored of persisted) {
      const { edit, del, ...msg } = stored
      if (this._has(msg.id, msg.publicKey)) continue
      if (msg.type !== 'image' && msg.content?.length > MAX_MESSAGE_LENGTH) continue
      this._signOwnLegacyMessage(msg)
      this._channelMessages.push(msg)
      if (edit) this._acceptOp('edit', { ...edit, originalId: msg.id })
      if (del) this._acceptOp('delete', { ...del, originalId: msg.id })
    }
    console.info(`[autobase] Loaded ${persisted.length} messages from IndexedDB for room "${this.roomCode}"`)
    console.info(
      `[autobase] Local core ready. key=${b4a.toString(this._localCore.key, 'hex').slice(0, 16)}… length=${this._localCore.length}`
    )
    return this
  }

  /**
   * Messages written before signatures existed: the ones we wrote can be signed now, so that they can still be
   * shared with the others (who accept only signed messages).
   */
  _signOwnLegacyMessage(msg) {
    if (msg.sig || msg.deleted || msg.publicKey !== toHex(this.identity.publicKey) || !this.identity.secretKey) return
    msg.sig = signMessage(this.roomCode, msg, this.identity.secretKey)
    persistMessage(this.roomCode, msg).catch(() => {})
  }

  /**
   * Accept a message forwarded via the swarm control channel, relayed history included.
   * It must carry a valid signature of its author, otherwise it is dropped. Only the signed fields are kept.
   * @param {object} raw
   */
  receiveMessage(raw) {
    if (typeof raw?.id !== 'string') return
    if (this._has(raw.id, raw.publicKey)) {
      this._ingestEmbeddedOps(raw) // already known: the copy may still carry an edit/delete we missed
      return
    }
    if (!verifyMessage(this.roomCode, raw)) {
      console.warn('[autobase] dropped a message with a missing or invalid signature')
      return
    }
    const msg = cleanMessage(raw)
    // Image messages carry a data URL in imageData and have empty content — skip the limit.
    if (msg.type !== 'image' && msg.content.length > MAX_MESSAGE_LENGTH) {
      console.warn('[autobase] dropped a message that is too long:', msg.content.length)
      return
    }
    this._channelMessages.push(msg)
    this._ingestEmbeddedOps(raw)
    persistMessage(this.roomCode, this._persistable(msg)).catch(() => {})
    this._emit('messages')
  }

  /** Edit/delete operations that travel inside a message (history sync) are verified like any other. */
  _ingestEmbeddedOps(raw) {
    let changed = false
    if (raw.edit) changed = this._acceptOp('edit', { ...raw.edit, originalId: raw.id }) || changed
    if (raw.del) changed = this._acceptOp('delete', { ...raw.del, originalId: raw.id }) || changed
    if (changed) this._emit('messages')
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
   * @param {{ parentId?: string }} [opts]  Optional metadata (e.g. thread parentId)
   * @returns {Promise<object>} The message object
   * @throws {Error} If content exceeds maximum length
   */
  async addMessage(content, opts = {}) {
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message too long (${content.length}/${MAX_MESSAGE_LENGTH} characters)`)
    }
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      username: getIdentity().username,
      publicKey: toHex(this.identity.publicKey),
      timestamp: Date.now(),
      type: 'text',
    }
    if (opts.parentId) msg.parentId = opts.parentId
    msg.sig = signMessage(this.roomCode, msg, this.identity.secretKey)
    await this._localCore.append(msg)
    this._channelMessages.push(msg) // needed to apply our own edits and deletions
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
   * Ids are only unique per author: anybody can sign a message of their own with somebody else's id, so a
   * message is identified by its author and its id together.
   */
  _has(id, publicKey) {
    return this._channelMessages.some((m) => m.id === id && m.publicKey === publicKey)
  }

  /** Our own messages plus everything received, one entry per author and id, still exactly as signed. */
  async _collectRaw() {
    const byKey = new Map()
    const keyOf = (msg) => `${msg.publicKey}:${msg.id}`
    for (const msg of this._channelMessages) byKey.set(keyOf(msg), msg)

    const blocks = []
    await this._readCoreInto(this._localCore, blocks, false)
    for (const core of this._remoteCores.values()) {
      await this._readCoreInto(core, blocks, true)
    }
    for (const block of blocks) {
      if (!byKey.has(keyOf(block))) byKey.set(keyOf(block), block)
    }
    return [...byKey.values()]
  }

  /**
   * Read and merge all messages from all known cores, sorted by timestamp, with edits and deletions applied.
   * @returns {Promise<object[]>}
   */
  async getHistory() {
    const all = (await this._collectRaw()).map((msg) => this._display(msg))
    // Stable sort by timestamp; break ties by publicKey for determinism
    all.sort((a, b) => a.timestamp - b.timestamp || a.publicKey?.localeCompare(b.publicKey))
    return all
  }

  /**
   * The messages to give to a peer that asks for history: the signed ones only, with the signed edit and
   * delete operations attached, so the peer can verify everything without trusting us.
   * @returns {Promise<object[]>}
   */
  async getSignedHistory() {
    return (await this._collectRaw()).filter((msg) => msg.sig).map((msg) => this._persistable(msg))
  }

  /** The message as shown: edit and deletion applied (only when signed by the author of the message). */
  _display(raw) {
    const key = `${raw.id}:${raw.publicKey}`
    const edit = this._edits.get(key)
    const del = this._deletes.get(key)
    const msg = { ...raw }
    if (edit) {
      msg.content = edit.newContent
      msg.edited = true
      msg.editedAt = edit.editedAt
    }
    if (del) {
      msg.deleted = true
      msg.content = ''
    }
    return msg
  }

  /** The signed message with the signed operations that apply to it (what is stored and given to peers). */
  _persistable(msg) {
    const key = `${msg.id}:${msg.publicKey}`
    const body = ({ originalId: _id, ...rest }) => rest
    const edit = this._edits.get(key)
    const del = this._deletes.get(key)
    return { ...msg, ...(edit ? { edit: body(edit) } : {}), ...(del ? { del: body(del) } : {}) }
  }

  /** Read all blocks from a core into the destination array. Blocks of other peers must be signed. */
  async _readCoreInto(core, dest, verify = false) {
    if (!core || core.length === 0) return
    for (let i = 0; i < core.length; i++) {
      try {
        const block = await core.get(i) // already decoded by valueEncoding: 'json'
        if (!block) continue
        if (verify) {
          const msg = this._authenticBlock(block)
          if (msg) dest.push(msg)
        } else {
          dest.push(block)
        }
      } catch (err) {
        console.warn('[autobase] failed to read block', i, err)
      }
    }
  }

  /**
   * The message as signed if the block of another peer's core is authentic, otherwise null. The result is
   * cached, but only reused for a block identical in every signed field: the same id and signature with other
   * content is a different block and is verified again.
   */
  _authenticBlock(block) {
    const key = `${block.id}:${block.sig}`
    const cached = this._verifiedBlocks.get(key)
    if (cached && sameMessage(cached.block, block)) return cached.msg
    const ok =
      verifyMessage(this.roomCode, block) && (block.type === 'image' || block.content.length <= MAX_MESSAGE_LENGTH)
    const msg = ok ? cleanMessage(block) : null
    this._verifiedBlocks.set(key, { block: cleanMessage(block), msg })
    return msg
  }

  /**
   * Verify and store a signed edit or deletion. It is accepted only if the signature is valid. It is kept per
   * author and applies only to a message of that author. An edit replaces an older one; a deletion is final.
   * @returns {boolean} true if the operation is new
   */
  _acceptOp(kind, op) {
    if (!verifyOp(kind, this.roomCode, op)) return false
    if (kind === 'edit' && op.newContent.length > MAX_MESSAGE_LENGTH) return false

    const ops = kind === 'edit' ? this._edits : this._deletes
    const key = `${op.originalId}:${op.publicKey}`
    const current = ops.get(key)
    if (current && (kind === 'delete' || current.editedAt >= op.editedAt)) return false

    ops.set(key, op)
    const raw = this._channelMessages.find((m) => m.id === op.originalId && m.publicKey === op.publicKey)
    if (raw) persistMessage(this.roomCode, this._persistable(raw)).catch(() => {})
    return true
  }

  /**
   * Apply a signed edit received from a peer.
   * @param {{ originalId: string, newContent: string, editedAt: number, publicKey: string, sig: string }} op
   */
  receiveEdit(op) {
    if (this._acceptOp('edit', op)) this._emit('messages')
  }

  /**
   * Apply a signed deletion received from a peer: the content is blanked and the message flagged.
   * @param {{ originalId: string, publicKey: string, sig: string }} op
   */
  receiveDelete(op) {
    if (this._acceptOp('delete', op)) this._emit('messages')
  }

  /**
   * Edit one of our messages: signs the edit, applies it and returns it, ready to be sent to the others.
   * @returns {object} the signed operation
   */
  createEdit(originalId, newContent) {
    const previous = this._edits.get(`${originalId}:${toHex(this.identity.publicKey)}`)
    const editedAt = Math.max(Date.now(), (previous?.editedAt ?? 0) + 1)
    const op = signOp('edit', this.roomCode, { originalId, newContent, editedAt }, this.identity)
    this.receiveEdit(op)
    return op
  }

  /**
   * Delete one of our messages: signs the deletion, applies it and returns it, ready to be sent.
   * @returns {object} the signed operation
   */
  createDelete(originalId) {
    const op = signOp('delete', this.roomCode, { originalId }, this.identity)
    this.receiveDelete(op)
    return op
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
