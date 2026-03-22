/**
 * beam.js
 * Encrypted 1-to-1 signaling channels via Hyperbeam.
 *
 * Hyperbeam provides an encrypted duplex stream between two peers who share a
 * secret key.  We derive a deterministic 32-byte key for each peer pair from
 * both public keys (sorted to be symmetric), so both sides compute the same
 * key without any prior exchange.
 *
 * Key derivation:
 *   beamKey = BLAKE2b( sort([myPubKey, remotePubKey]).join() )
 *
 * Flow for a video call:
 *   1. Initiator sends CALL_INIT via Hyperswarm control channel.
 *   2. Both sides call getOrCreateChannel(peerId) → Hyperbeam(beamKey).
 *   3. Initiator's Hyperbeam emits 'open' → initiator creates RTCPeerConnection
 *      and sends SDP offer through the beam.
 *   4. Responder receives offer, creates answer, sends it back through the beam.
 *   5. ICE candidates flow both ways through the same beam channel.
 */

import Hyperbeam from 'hyperbeam'
import * as crypto from 'hypercore-crypto'
import b4a from 'b4a'

export class BeamSignaling {
  /**
   * @param {{ publicKey: Buffer, secretKey: Buffer }} identity
   */
  constructor(identity) {
    this.identity = identity
    this._channels = new Map() // peerId (hex) → Hyperbeam instance
    this._listeners = new Map() // event → [fn, ...]
  }

  /**
   * Derive a deterministic beam key from two peer public keys.
   * Sorting ensures both peers compute the same key regardless of who initiates.
   */
  _deriveBeamKey(remotePubKeyHex) {
    const local = this.identity.publicKey
    const remote = b4a.from(remotePubKeyHex, 'hex')
    // Sort the two buffers so the key is symmetric
    const sorted = [local, remote].sort(Buffer.compare)
    return crypto.hash(b4a.concat(sorted))
  }

  /**
   * Get (or lazily create) the Hyperbeam channel for a given peer.
   * @param {string} peerId  Hex public key of the remote peer
   * @returns {Promise<Hyperbeam>}
   */
  async getOrCreateChannel(peerId) {
    if (this._channels.has(peerId)) return this._channels.get(peerId)

    const key = this._deriveBeamKey(peerId)
    const beam = new Hyperbeam(key)

    // Buffer incomplete JSON data across chunks
    let buffer = ''

    beam.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() // keep incomplete tail
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          this._emit(msg.type, { peerId, ...msg })
        } catch (err) {
          console.warn('[beam] parse error', err)
        }
      }
    })

    beam.on('error', (err) => console.error(`[beam] error for ${peerId.slice(0, 12)}…`, err))
    beam.on('close', () => {
      this._channels.delete(peerId)
      console.info(`[beam] channel closed for ${peerId.slice(0, 12)}…`)
    })

    this._channels.set(peerId, beam)
    console.info(`[beam] Created channel for ${peerId.slice(0, 12)}…`)
    return beam
  }

  /**
   * Wait until the Hyperbeam channel with a peer is fully open (connected).
   * Resolves immediately if already open.
   * @param {string} peerId
   * @returns {Promise<void>}
   */
  async waitForConnection(peerId) {
    const beam = await this.getOrCreateChannel(peerId)
    if (beam.destroyed) throw new Error('Beam channel was destroyed')
    return new Promise((resolve, reject) => {
      if (beam.opened) return resolve()
      beam.once('open', resolve)
      beam.once('error', reject)
    })
  }

  /**
   * Send a WebRTC signaling message through the beam channel.
   * @param {string} peerId
   * @param {object} signal  e.g. { type: 'offer', sdp: {...} }
   */
  async sendSignal(peerId, signal) {
    const beam = await this.getOrCreateChannel(peerId)
    beam.write(Buffer.from(JSON.stringify(signal) + '\n'))
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

  _emit(event, data) {
    for (const fn of this._listeners.get(event) || []) fn(data)
  }

  /** Close all beam channels (e.g. when leaving the room). */
  close() {
    for (const beam of this._channels.values()) {
      beam.destroy()
    }
    this._channels.clear()
  }
}
