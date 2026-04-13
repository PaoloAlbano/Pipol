/**
 * swarm.js
 * Peer discovery and P2P messaging via WebRTC DataChannels.
 *
 * Architecture:
 *   Browser ──── WebSocket ────▶ Relay /signal  (signaling only: SDP + ICE)
 *   Browser ◀──── WebRTC DataChannel ────▶ Browser  (P2P: all messages)
 *
 * The relay sees only WebRTC handshake metadata (SDP/ICE), never message content.
 * After the initial handshake, all data flows directly peer-to-peer via DataChannel.
 *
 * Events emitted (CustomEvent via EventTarget):
 *   peer-joined   { id, username, messageCoreKey }
 *   peer-left     { id }
 *   call-init     { peerId }
 *   call-end      { peerId }
 *   error         { detail: Error }
 */

import b4a from 'b4a'
import { getIdentity, getRelayUrl } from './storage.js'

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]

/**
 * Extracts the DTLS fingerprint from an SDP string.
 * SDP format: a=fingerprint:sha-256 XX:XX:XX:...
 * @param {string} sdp
 * @returns {string | null} Lowercase fingerprint without colons, or null if not found
 */
function extractFingerprint(sdp) {
  if (!sdp) return null
  const match = sdp.match(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/)
  if (!match) return null
  return match[1].toLowerCase().replace(/:/g, '')
}

/** Build the signaling WebSocket URL.
 *  Priority: user setting (localStorage) → VITE_DHT_RELAY_URL env → auto-derive from window.location.
 */
function signalUrl() {
  const stored = getRelayUrl()
  if (stored) return stored.replace(/\/?$/, '') + '/signal'
  if (import.meta.env.VITE_DHT_RELAY_URL) {
    return import.meta.env.VITE_DHT_RELAY_URL.replace(/\/?$/, '') + '/signal'
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/signal`
}

// ─── RoomSwarm ────────────────────────────────────────────────────────────────

export class RoomSwarm extends EventTarget {
  constructor(roomCode, opts = {}) {
    super()
    this.roomCode = roomCode
    this.messageCoreKey = opts.messageCoreKey || null
    this.peers = new Map() // peerId → { id, username, messageCoreKey, pc, dc, sendControl }
    this.mode = 'webrtc'

    this._ws = null // signaling WebSocket
    this._localPeerId = null
    this._identity = null

    // ICE candidates buffered before remote description is set
    this._pendingCandidates = new Map() // peerId → [candidate, ...]
  }

  async join() {
    this._identity = getIdentity()
    this._localPeerId = b4a.toString(this._identity.publicKey, 'hex')

    return new Promise((resolve, reject) => {
      const url = signalUrl()
      const ws = new WebSocket(url)
      this._ws = ws

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error(`Cannot connect to signaling server at ${url}`))
      }, 8000)

      ws.addEventListener(
        'open',
        () => {
          ws.send(JSON.stringify({ type: 'join', room: this.roomCode, peerId: this._localPeerId }))
        },
        { once: true }
      )

      ws.addEventListener('message', (e) => {
        let msg
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }

        if (msg.type === 'joined') {
          clearTimeout(timeout)
          console.info(
            `[swarm] Joined room "${this.roomCode}" via signaling (peerId: ${this._localPeerId.slice(0, 16)}…)`
          )
          resolve(this)
          return
        }

        this._handleSignal(msg)
      })

      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error connecting to ${url}`))
        },
        { once: true }
      )

      ws.addEventListener('close', () => {
        clearTimeout(timeout)
        // If the P2P DataChannels are already open, signaling is no longer needed:
        // the WebRTC connection survives the closure of the WebSocket.
        const hasOpenChannels = [...this.peers.values()].some((p) => p.dc?.readyState === 'open')
        if (this.peers.size > 0 && !hasOpenChannels) {
          this.dispatchEvent(new CustomEvent('error', { detail: new Error('Signaling connection lost') }))
        }
      })
    })
  }

  _handleSignal(msg) {
    switch (msg.type) {
      case 'peer-joined':
        // Only the lexicographically smaller peer ID initiates to avoid offer glare
        // (both sides receive peer-joined; only one should send the offer)
        if (this._localPeerId < msg.peerId) {
          console.info('[swarm] peer-joined — I initiate WebRTC to', msg.peerId.slice(0, 16) + '…')
          this._initiateConnection(msg.peerId)
        } else {
          console.info('[swarm] peer-joined — waiting for offer from', msg.peerId.slice(0, 16) + '…')
        }
        break
      case 'peer-left':
        this._handleDisconnect(msg.peerId)
        break
      case 'signal':
        this._handleRTCSignal(msg.from, msg.signal)
        break
    }
  }

  // ── WebRTC connection setup ─────────────────────────────────────────────────

  async _initiateConnection(remotePeerId) {
    if (this.peers.has(remotePeerId)) return

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const dc = pc.createDataChannel('p2p-chat', { ordered: true })

    this._registerPeer(remotePeerId, pc)
    this._setupDataChannel(remotePeerId, dc)

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) this._sendSignal(remotePeerId, { type: 'ice', candidate: e.candidate.toJSON() })
    })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    // Extract our DTLS fingerprint from the SDP
    const localFingerprint = extractFingerprint(offer.sdp)

    this._sendSignal(remotePeerId, {
      type: 'offer',
      sdp: { type: offer.type, sdp: offer.sdp },
      fingerprint: localFingerprint, // Include fingerprint in signaling
    })
    console.info('[swarm] offer sent to', remotePeerId.slice(0, 16) + '…', localFingerprint ? '(with fingerprint)' : '')
  }

  async _handleRTCSignal(remotePeerId, signal) {
    if (!signal) return

    if (signal.type === 'offer') {
      if (this.peers.has(remotePeerId)) return // already connected

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      const expectedFingerprint = signal.fingerprint || null

      this._registerPeer(remotePeerId, pc, expectedFingerprint)

      pc.addEventListener('datachannel', (e) => {
        this._setupDataChannel(remotePeerId, e.channel)
      })

      pc.addEventListener('icecandidate', (e) => {
        if (e.candidate) this._sendSignal(remotePeerId, { type: 'ice', candidate: e.candidate.toJSON() })
      })

      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
      await this._flushCandidates(remotePeerId)

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      // Extract our DTLS fingerprint from the answer SDP
      const localFingerprint = extractFingerprint(answer.sdp)

      this._sendSignal(remotePeerId, {
        type: 'answer',
        sdp: { type: answer.type, sdp: answer.sdp },
        fingerprint: localFingerprint,
      })
      console.info(
        '[swarm] answer sent to',
        remotePeerId.slice(0, 16) + '…',
        localFingerprint ? '(with fingerprint)' : ''
      )
    } else if (signal.type === 'answer') {
      const peer = this.peers.get(remotePeerId)
      if (!peer?.pc) return

      // Store the expected fingerprint before setting remote description
      if (signal.fingerprint && !peer.expectedFingerprint) {
        peer.expectedFingerprint = signal.fingerprint
      }

      await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
      await this._flushCandidates(remotePeerId)
    } else if (signal.type === 'ice') {
      const peer = this.peers.get(remotePeerId)
      if (peer?.pc?.remoteDescription) {
        await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {})
      } else {
        // Buffer until remote description is set
        if (!this._pendingCandidates.has(remotePeerId)) this._pendingCandidates.set(remotePeerId, [])
        this._pendingCandidates.get(remotePeerId).push(signal.candidate)
      }
    }
  }

  async _flushCandidates(remotePeerId) {
    const pending = this._pendingCandidates.get(remotePeerId) || []
    this._pendingCandidates.delete(remotePeerId)
    const peer = this.peers.get(remotePeerId)
    if (!peer?.pc) return
    for (const candidate of pending) {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
    }
  }

  _registerPeer(remotePeerId, pc, expectedFingerprint = null) {
    this.peers.set(remotePeerId, {
      id: remotePeerId,
      username: '…',
      messageCoreKey: null,
      pc,
      dc: null,
      sendControl: null,
      expectedFingerprint,
    })

    pc.addEventListener('connectionstatechange', () => {
      const state = pc.connectionState
      console.info('[swarm] peer', remotePeerId.slice(0, 16) + '… connectionState:', state)
      if (state === 'failed' || state === 'closed') {
        this._handleDisconnect(remotePeerId)
      }
    })
  }

  _setupDataChannel(remotePeerId, dc) {
    const peer = this.peers.get(remotePeerId)
    if (!peer) return

    peer.dc = dc
    peer.sendControl = (data) => {
      if (dc.readyState === 'open') {
        try {
          dc.send(JSON.stringify(data))
        } catch (e) {
          console.warn('[swarm] dc.send error', e)
        }
      }
    }

    dc.addEventListener('open', () => {
      console.info('[swarm] DataChannel open with', remotePeerId.slice(0, 16) + '…')
      // Send HELLO once the DataChannel is ready
      // Include our DTLS fingerprint for remote peer verification
      const localFingerprint = peer.pc.localDescription ? extractFingerprint(peer.pc.localDescription.sdp) : null
      peer.sendControl({
        type: 'HELLO',
        username: getIdentity().username,
        publicKey: this._localPeerId,
        messageCoreKey: this.messageCoreKey,
        fingerprint: localFingerprint,
      })
    })

    dc.addEventListener('message', (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      this._handleControl(remotePeerId, msg)
    })

    dc.addEventListener('close', () => {
      console.info('[swarm] DataChannel closed with', remotePeerId.slice(0, 16) + '…')
      this._handleDisconnect(remotePeerId)
    })

    dc.addEventListener('error', (e) => {
      console.warn('[swarm] DataChannel error with', remotePeerId.slice(0, 16) + '…', e)
    })
  }

  _handleControl(remoteId, msg) {
    const peer = this.peers.get(remoteId)
    if (!peer) return
    switch (msg.type) {
      case 'HELLO':
        peer.username = msg.username
        peer.messageCoreKey = msg.messageCoreKey

        peer.expectedFingerprint = 'wrongfingerprint123' //temp test

        // Verify DTLS fingerprint if we have one from signaling
        if (msg.fingerprint && peer.expectedFingerprint) {
          if (msg.fingerprint !== peer.expectedFingerprint) {
            console.error(
              '[swarm] DTLS fingerprint mismatch for peer',
              remoteId.slice(0, 16) + '…',
              'Expected:',
              peer.expectedFingerprint,
              'Got:',
              msg.fingerprint
            )
            // Disconnect peer - potential MITM attack
            this._handleDisconnect(remoteId)
            return
          }
          console.info('[swarm] DTLS fingerprint verified for', remoteId.slice(0, 16) + '…')
        }

        this.peers.set(remoteId, peer)
        this.dispatchEvent(
          new CustomEvent('peer-joined', {
            detail: { id: remoteId, username: msg.username, messageCoreKey: msg.messageCoreKey },
          })
        )
        break
      case 'MSG':
        this.dispatchEvent(new CustomEvent('chat-message', { detail: { message: msg.message } }))
        break
      case 'HISTORY':
      case 'HISTORY_RES':
        if (Array.isArray(msg.messages)) {
          for (const m of msg.messages) {
            this.dispatchEvent(new CustomEvent('chat-message', { detail: { message: m } }))
          }
        }
        break
      case 'HISTORY_REQ':
        this.dispatchEvent(new CustomEvent('history-req', { detail: { peerId: remoteId, since: msg.since ?? 0 } }))
        break
      case 'VIDEO_OFFER':
        this.dispatchEvent(new CustomEvent('video-offer', { detail: { peerId: remoteId, sdp: msg.sdp } }))
        break
      case 'VIDEO_ANSWER':
        this.dispatchEvent(new CustomEvent('video-answer', { detail: { peerId: remoteId, sdp: msg.sdp } }))
        break
      case 'VIDEO_ICE':
        this.dispatchEvent(new CustomEvent('video-ice', { detail: { peerId: remoteId, candidate: msg.candidate } }))
        break
      case 'CALL_INIT':
        this.dispatchEvent(new CustomEvent('call-init', { detail: { peerId: remoteId } }))
        break
      case 'CALL_END':
        this.dispatchEvent(new CustomEvent('call-end', { detail: { peerId: remoteId } }))
        break
      case 'SCREEN_SHARE_START':
        this.dispatchEvent(new CustomEvent('screen-share-start', { detail: { peerId: remoteId } }))
        break
      case 'SCREEN_SHARE_END':
        this.dispatchEvent(new CustomEvent('screen-share-end', { detail: { peerId: remoteId } }))
        break
    }
  }

  _handleDisconnect(remoteId) {
    if (!this.peers.has(remoteId)) return
    const peer = this.peers.get(remoteId)
    peer.dc?.close()
    peer.pc?.close()
    this.peers.delete(remoteId)
    this._pendingCandidates.delete(remoteId)
    this.dispatchEvent(new CustomEvent('peer-left', { detail: { id: remoteId } }))
  }

  _sendSignal(to, signal) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'signal', to, signal }))
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  sendToAll(msg) {
    for (const peer of this.peers.values()) peer.sendControl?.(msg)
  }

  sendToPeer(peerId, msg) {
    this.peers.get(peerId)?.sendControl?.(msg)
  }

  getPeers() {
    return Array.from(this.peers.values())
  }
  setMessageCoreKey(key) {
    this.messageCoreKey = key
  }

  async leave() {
    this._ws?.close()
    for (const peer of this.peers.values()) {
      peer.dc?.close()
      peer.pc?.close()
    }
    this.peers.clear()
    this._pendingCandidates.clear()
  }
}

export async function createRoomSwarm(roomCode, opts = {}) {
  const swarm = new RoomSwarm(roomCode, opts)
  await swarm.join()
  return swarm
}
