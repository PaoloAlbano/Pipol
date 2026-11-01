/**
 * relay-crypto.js
 * End-to-end encryption of everything that travels through the relay WebSocket
 * (`signal`, `relay-data`, `relay-data-to`), so that the relay only forwards opaque payloads.
 *
 * Every member of a room shares one symmetric key the relay never sees:
 *   - workspace: derived from the workspace secret (see deriveWorkspaceRelayKey in workspace.js)
 *   - quick room: derived from the room code with PBKDF2 (the security level is the entropy of the code)
 *
 * Wire format: { v: 1, n: <nonce, base64>, c: <NaCl secretbox ciphertext, base64> }
 * The box contains { r: room, f: sender, t: recipient|null, k: counter, d: payload }.
 * There are no associated data, so room / sender / recipient live inside the box and the receiver compares
 * them with what the relay claims: the relay cannot move a payload to another room, forge the sender or
 * redirect a unicast message.
 */

import sodium from 'sodium-javascript'
import b4a from 'b4a'
import * as crypto from 'hypercore-crypto'

const FORMAT_VERSION = 1
const ROOM_ID_CONTEXT = 'pipol/relay-room/v1'
const KDF_SALT = 'pipol/relay-key/v1'
const KDF_ITERATIONS = 210_000

/** Messages whose counter is further than this from the local clock are dropped (anti-replay). */
export const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000

/**
 * Name of a quick room as the relay sees it: a hash, so the relay never learns the room code.
 * @param {string} roomCode
 * @returns {string} 64-char hex
 */
export function roomRelayId(roomCode) {
  return b4a.toString(crypto.hash(b4a.from(`${ROOM_ID_CONTEXT}:${roomCode}`)), 'hex')
}

/**
 * Derives the relay key of a quick room from its code.
 * @param {string} roomCode
 * @returns {Promise<Uint8Array>} 32-byte key
 */
export async function deriveRoomRelayKey(roomCode) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('WebCrypto is not available')
  const material = await subtle.importKey('raw', new TextEncoder().encode(roomCode), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(KDF_SALT), iterations: KDF_ITERATIONS },
    material,
    256
  )
  return new Uint8Array(bits)
}

/**
 * Seals and opens the payloads of one room. Keeps the anti-replay state, so use one instance per swarm.
 */
export class RelayCipher {
  /**
   * @param {Uint8Array} key   32-byte shared key
   * @param {string}     room  Room name exactly as sent to the relay
   */
  constructor(key, room) {
    if (!key || key.length !== sodium.crypto_secretbox_KEYBYTES) throw new Error('Invalid relay key')
    this._key = key
    this._room = room
    this._lastSent = 0
    this._lastSeen = new Map() // sender → last accepted counter
  }

  /**
   * @param {object}      payload
   * @param {string}      from  Our peer id
   * @param {string|null} to    Recipient peer id, null for broadcast
   * @returns {{ v: number, n: string, c: string }}
   */
  seal(payload, from, to = null) {
    this._lastSent = Math.max(this._lastSent + 1, Date.now())
    const plaintext = b4a.from(JSON.stringify({ r: this._room, f: from, t: to, k: this._lastSent, d: payload }))
    const nonce = b4a.allocUnsafe(sodium.crypto_secretbox_NONCEBYTES)
    sodium.randombytes_buf(nonce)
    const ciphertext = b4a.allocUnsafe(plaintext.length + sodium.crypto_secretbox_MACBYTES)
    sodium.crypto_secretbox_easy(ciphertext, plaintext, nonce, this._key)
    return { v: FORMAT_VERSION, n: b4a.toString(nonce, 'base64'), c: b4a.toString(ciphertext, 'base64') }
  }

  /**
   * @param {*}      sealed  What the relay delivered
   * @param {string} from    Sender as declared by the relay
   * @param {string} self    Our peer id
   * @returns {object|null}  The payload, or null if it is not authentic, not for us or a replay
   */
  open(sealed, from, self) {
    try {
      if (!sealed || sealed.v !== FORMAT_VERSION || typeof sealed.n !== 'string' || typeof sealed.c !== 'string') {
        return null
      }
      const nonce = b4a.from(sealed.n, 'base64')
      const ciphertext = b4a.from(sealed.c, 'base64')
      if (
        nonce.length !== sodium.crypto_secretbox_NONCEBYTES ||
        ciphertext.length <= sodium.crypto_secretbox_MACBYTES
      ) {
        return null
      }
      const plaintext = b4a.allocUnsafe(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
      if (!sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, this._key)) return null

      const box = JSON.parse(b4a.toString(plaintext))
      if (box.r !== this._room || box.f !== from) return null
      if (box.t !== null && box.t !== self) return null
      if (typeof box.k !== 'number' || Math.abs(box.k - Date.now()) > MAX_CLOCK_SKEW_MS) return null
      if (box.k <= (this._lastSeen.get(from) ?? 0)) return null

      this._lastSeen.set(from, box.k)
      return box.d ?? null
    } catch {
      return null
    }
  }
}
