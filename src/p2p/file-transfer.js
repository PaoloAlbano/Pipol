/**
 * file-transfer.js
 * Send and receive image files (≤5 MB) via the P2P swarm DataChannel.
 *
 * Protocol:
 *   Sender → FILE_META  { fileId, name, mimeType, size, totalChunks, channelName }
 *   Sender → FILE_CHUNK { fileId, index, data: base64_slice }  ×totalChunks
 *
 * The receiver reassembles the chunks into a complete base64 data URL, then
 * emits a synthetic chat message of type 'image' into the MessageStore.
 *
 * Chunk size: 48 KB (base64 slice) → safe for all WebRTC DataChannel
 * implementations (Chrome/Safari/Firefox all support ≥64 KB messages).
 */

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB
const CHUNK_SIZE = 48 * 1024 // 48 KB of base64 per message
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

// ── Sender ────────────────────────────────────────────────────────────────────

/**
 * Read a File as a base64 data URL.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * Validate and send an image file via the swarm.
 *
 * @param {object}      swarm        RoomSwarm instance
 * @param {File}        file         The image file to send
 * @param {string|null} channelName  Channel scope (null for DMs)
 * @param {object}      identity     { publicKey, username }
 * @returns {Promise<object>}        The synthetic message object added locally
 * @throws {Error}  If file is too large or not an allowed image type
 */
export async function sendImageFile(swarm, file, channelName, identity) {
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`)
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 5 MB.`)
  }

  const dataUrl = await readAsDataUrl(file)
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const totalChunks = Math.ceil(dataUrl.length / CHUNK_SIZE)

  // Send metadata first
  swarm.sendToAll({
    type: 'FILE_META',
    fileId,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    totalChunks,
    channelName: channelName ?? null,
    senderUsername: identity?.username ?? null,
    senderPublicKey: identity?.publicKey
      ? (identity.publicKey instanceof Uint8Array
          ? Array.from(identity.publicKey).map((b) => b.toString(16).padStart(2, '0')).join('')
          : identity.publicKey)
      : null,
  })

  // Send chunks sequentially
  for (let i = 0; i < totalChunks; i++) {
    swarm.sendToAll({
      type: 'FILE_CHUNK',
      fileId,
      index: i,
      data: dataUrl.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    })
  }

  // Return the local message object (same shape as text messages)
  return buildImageMessage(fileId, dataUrl, file.name, file.size, identity)
}

// ── Receiver ──────────────────────────────────────────────────────────────────

/**
 * Manages in-progress file transfers from remote peers.
 * One instance per Room — shared across all channels (filtered by channelName).
 *
 * Usage:
 *   const receiver = new FileReceiver()
 *   // on swarm 'file-meta' event:
 *   receiver.onMeta(detail)
 *   // on swarm 'file-chunk' event:
 *   const msg = receiver.onChunk(detail)
 *   if (msg) msgStore.receiveMessage(msg) // reassembly complete
 */
export class FileReceiver {
  constructor() {
    // fileId → { meta, chunks: string[] }
    this._transfers = new Map()
  }

  /** Register incoming file metadata. */
  onMeta({ fileId, name, mimeType, size, totalChunks, channelName, peerId, identity, senderUsername, senderPublicKey }) {
    // Build identity from either the legacy `identity` field or the new flat fields
    const resolvedIdentity = identity ?? (senderUsername || senderPublicKey
      ? { username: senderUsername ?? 'unknown', publicKey: senderPublicKey ?? peerId }
      : null)
    this._transfers.set(fileId, {
      meta: { fileId, name, mimeType, size, totalChunks, channelName, peerId, identity: resolvedIdentity },
      chunks: new Array(totalChunks).fill(null),
      received: 0,
    })
  }

  /**
   * Process an incoming chunk.
   * @returns {object|null}  Complete image message if all chunks received, else null
   */
  onChunk({ fileId, index, data, peerId }) {
    const transfer = this._transfers.get(fileId)
    if (!transfer) return null
    if (transfer.chunks[index] !== null) return null // duplicate

    transfer.chunks[index] = data
    transfer.received++

    if (transfer.received < transfer.meta.totalChunks) return null

    // All chunks received — reassemble
    const dataUrl = transfer.chunks.join('')
    this._transfers.delete(fileId)

    return buildImageMessage(
      fileId,
      dataUrl,
      transfer.meta.name,
      transfer.meta.size,
      transfer.meta.identity ?? { username: 'unknown', publicKey: peerId }
    )
  }

  /** Remove stale transfers (e.g. peer disconnected mid-transfer). */
  evict(peerId) {
    for (const [id, t] of this._transfers) {
      if (t.meta.peerId === peerId) this._transfers.delete(id)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildImageMessage(fileId, dataUrl, name, size, identity) {
  const pubkeyHex =
    identity?.publicKey instanceof Uint8Array
      ? Array.from(identity.publicKey)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      : (identity?.publicKey ?? '')

  return {
    id: fileId,
    type: 'image',
    content: '', // empty text content; imageData carries the payload
    imageData: dataUrl,
    fileName: name,
    fileSize: size,
    username: identity?.username ?? 'unknown',
    publicKey: pubkeyHex,
    timestamp: Date.now(),
  }
}
