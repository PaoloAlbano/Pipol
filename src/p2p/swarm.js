/**
 * swarm.js
 * Peer discovery and P2P messaging via WebRTC DataChannels.
 *
 * Architecture:
 *   Browser ──── WebSocket ────▶ Relay /signal  (signaling: SDP + ICE)
 *   Browser ◀──── WebRTC DataChannel ────▶ Browser  (P2P: all messages)
 *
 * When every peer's DataChannel is open, the relay only ever sees the
 * (encrypted) WebRTC handshake — never message content.
 *
 * Fallback: if a peer's DataChannel cannot be established (e.g. symmetric
 * NAT with no TURN server — common on mobile networks), messages to that
 * peer are relayed through the signaling WebSocket (`relay-data` /
 * `relay-data-to`). Everything that goes through the relay — signaling
 * included — is encrypted end-to-end with a key the relay does not know
 * (see relay-crypto.js), so the relay only forwards opaque payloads.
 * sendToAll/sendToPeer only use this path for peers that actually need it.
 *
 * Events emitted (CustomEvent via EventTarget):
 *   peer-joined   { id, username, messageCoreKey }
 *   peer-left     { id }
 *   call-init     { peerId }
 *   call-end      { peerId }
 *   video-state   { peerId, off }   the peer turned their camera off or on during a call
 *   error         { detail: Error }
 */

import b4a from 'b4a'
import { getIdentity, getRelayUrl } from './storage.js'
import { DEFAULT_ICE_SERVERS, resolveIceConfig, chatIceConfig } from '../webrtc/ice.js'
import { RelayCipher, deriveRoomRelayKey, roomRelayId } from './relay-crypto.js'

/**
 * Extracts the DTLS fingerprint from an SDP string.
 * SDP format: a=fingerprint:sha-256 XX:XX:XX:...
 * @param {string} sdp
 * @returns {string | null} Lowercase fingerprint without colons, or null if not found
 */
export function extractFingerprint(sdp) {
  if (!sdp) return null
  const match = sdp.match(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/)
  if (!match) return null
  return match[1].toLowerCase().replace(/:/g, '')
}

/** Build the signaling WebSocket URL.
 *  Priority: explicit override (workspace config) → user setting (localStorage) → VITE_DHT_RELAY_URL env → auto-derive from window.location.
 * @param {string|null} [override]  Optional relay base URL that takes over everything else.
 */
function signalUrl(override) {
  if (override) return override.replace(/\/?$/, '') + '/signal'
  const stored = getRelayUrl()
  if (stored) return stored.replace(/\/?$/, '') + '/signal'
  if (import.meta.env.VITE_DHT_RELAY_URL) {
    return import.meta.env.VITE_DHT_RELAY_URL.replace(/\/?$/, '') + '/signal'
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/signal`
}

// ─── RoomSwarm ────────────────────────────────────────────────────────────────

/**
 * What goes through the relay while the signaling connection is down is lost, unless it is something nobody would
 * ask for again: the signaling of a connection (SDP and ICE of the chat link and of the calls) and the messages that
 * start, end and describe a call. Chat messages are not kept: the history is synced when a peer is seen again.
 */
const KEPT_WHILE_OFFLINE = new Set([
  'VIDEO_OFFER',
  'VIDEO_ANSWER',
  'VIDEO_ICE',
  'CALL_INIT',
  'CALL_END',
  'SCREEN_SHARE_START',
  'SCREEN_SHARE_END',
  'VIDEO_STATE',
])
/** Signaling that waited longer than this (ms) is no longer worth sending: the connection it was for is gone. */
export const OUTBOX_TTL_MS = 30_000
/** At most this many are kept; the oldest go first. */
export const OUTBOX_MAX = 200

export class RoomSwarm extends EventTarget {
  /**
   * @param {string} roomCode
   * @param {object} [opts]
   * @param {Uint8Array} [opts.relayKey]  Key shared by the room members, for rooms whose name is already
   *   a hash (workspaces). Without it the key is derived from `roomCode` and the relay only sees its hash.
   */
  constructor(roomCode, opts = {}) {
    super()
    this.roomCode = roomCode
    this.messageCoreKey = opts.messageCoreKey || null
    this.peers = new Map() // peerId → { id, username, messageCoreKey, pc, dc, sendControl }
    this.mode = 'webrtc'

    // Encryption of everything sent through the relay; without a cipher nothing is sent there
    this._relayRoom = opts.relayKey ? roomCode : null // room name as the relay sees it
    this._relayCipher = opts.relayKey ? new RelayCipher(opts.relayKey, roomCode) : null
    // Optional workspace-level relay override (takes priority over global settings)
    this._relayUrl = opts.relayUrl || null

    // Optional workspace-level ICE override ({ servers } or { url }), see webrtc/ice.js
    this._workspaceIce = opts.ice || null
    this._iceConfig = { iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all' } // calls
    this._dataIceConfig = this._iceConfig // chat data channels

    this._ws = null // signaling WebSocket
    this._localPeerId = null
    this._identity = null
    this._leaving = false // true while leave() is in progress
    this._wsReconnectTimer = null // reconnect back-off timer
    this._outbox = [] // signaling that could not be sent because the relay connection was down

    // ICE candidates buffered before remote description is set
    this._pendingCandidates = new Map() // peerId → [candidate, ...]
  }

  /** RTCConfiguration (ICE servers + policy) for video calls made through this swarm. */
  get rtcConfiguration() {
    return this._iceConfig
  }

  /**
   * Fetches the ICE configuration again (cheap while the cached credentials are fresh) so that new calls and
   * calls in progress get valid TURN credentials. If the endpoint cannot be reached, the credentials we
   * already have are kept: they stay valid for a while and only a retry is suggested.
   * @returns {Promise<object>} the configuration, with `refreshInMs` when it expires
   */
  async refreshIceConfig() {
    const config = await resolveIceConfig({ relayUrl: this._iceRelayBase, workspaceIce: this._workspaceIce })
    if (config.degraded && this._iceConfig.iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u)))) {
      return { ...this._iceConfig, degraded: true, refreshInMs: 30_000 }
    }
    this._iceConfig = config
    this._dataIceConfig = chatIceConfig(config)
    return config
  }

  /** Quick rooms have no shared secret: the key comes from the room code, the relay only sees a hash of it. */
  async _ensureRelayCipher() {
    if (this._relayCipher) return
    const key = await deriveRoomRelayKey(this.roomCode)
    this._relayRoom = roomRelayId(this.roomCode)
    this._relayCipher = new RelayCipher(key, this._relayRoom)
  }

  async join() {
    this._identity = getIdentity()
    this._localPeerId = b4a.toString(this._identity.publicKey, 'hex')

    return new Promise((resolve, reject) => {
      const url = signalUrl(this._relayUrl)

      // Resolve TURN/STUN in parallel with the signaling handshake; never rejects
      this._iceRelayBase = url.replace(/\/signal$/, '')
      const icePromise = this.refreshIceConfig().catch((err) =>
        console.warn('[swarm] ICE config unavailable, using defaults:', err.message)
      )
      const keyPromise = this._ensureRelayCipher().then(
        () => null,
        (err) => err
      )
      const ws = new WebSocket(url)
      this._ws = ws

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error(`Cannot connect to signaling server at ${url}`))
      }, 8000)

      ws.addEventListener(
        'open',
        async () => {
          // Peers start connecting as soon as we have joined, so the ICE servers and the key must be ready by then
          await icePromise
          const keyError = await keyPromise
          if (keyError) {
            clearTimeout(timeout)
            this._leaving = true
            ws.close()
            reject(new Error(`Cannot derive the relay encryption key: ${keyError.message}`))
            return
          }
          ws.send(JSON.stringify({ type: 'join', room: this._relayRoom, peerId: this._localPeerId }))
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
        // Schedule reconnect unless the swarm is intentionally being torn down.
        if (!this._leaving) {
          clearTimeout(this._wsReconnectTimer)
          this._wsReconnectTimer = setTimeout(() => this._reconnectWS(), 3000)
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
        // ── WS-relay bootstrap ─────────────────────────────────────────────
        // Send HELLO via WS relay immediately so the other side can fire
        // peer-joined without waiting for WebRTC DataChannel to open.
        // This is the critical path on mobile / symmetric-NAT where WebRTC
        // ICE often fails: without this, HISTORY_REQ and WORKSPACE_META are
        // never triggered and the two clients see nothing from each other.
        this._sendRelayHello(msg.peerId)
        break
      case 'peer-left':
        this._handleDisconnect(msg.peerId)
        break
      case 'signal': {
        const signal = this._relayCipher?.open(msg.signal, msg.from, this._localPeerId)
        if (signal) this._handleRTCSignal(msg.from, signal)
        break
      }
      // ── WebSocket relay fallback ───────────────────────────────────────────
      // Received when the sender could not (or did not) use the DataChannel.
      case 'relay-data': {
        const data = msg.from ? this._relayCipher?.open(msg.data, msg.from, this._localPeerId) : null
        if (data) {
          // Auto-register the sender if we haven't seen them via WebRTC yet.
          // This lets messages arrive even when the DataChannel hasn't established.
          if (!this.peers.has(msg.from)) {
            this.peers.set(msg.from, {
              id: msg.from,
              username: msg.from.slice(0, 8),
              messageCoreKey: null,
              pc: null,
              dc: null,
              sendControl: null, // DataChannel not yet open; WS relay used for replies
              expectedFingerprint: null,
              _joinedFired: false,
            })
          }
          this._handleControl(msg.from, data)
        }
        break
      }
    }
  }

  // ── WebRTC connection setup ─────────────────────────────────────────────────

  async _initiateConnection(remotePeerId) {
    // A peer auto-registered by a relay HELLO has no pc yet: it still needs the WebRTC connection
    if (this.peers.get(remotePeerId)?.pc) return

    const pc = new RTCPeerConnection(this._dataIceConfig)
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
      if (this.peers.get(remotePeerId)?.pc) return // already connected (a relay-only peer has no pc yet)

      const pc = new RTCPeerConnection(this._dataIceConfig)
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
    // Keep what a relay HELLO may already have told us about this peer
    const existing = this.peers.get(remotePeerId)
    this.peers.set(remotePeerId, {
      id: remotePeerId,
      username: existing?.username ?? '…',
      messageCoreKey: existing?.messageCoreKey ?? null,
      pc,
      dc: null,
      sendControl: null,
      expectedFingerprint,
      _joinedFired: existing?._joinedFired ?? false,
    })

    pc.addEventListener('connectionstatechange', () => {
      const state = pc.connectionState
      console.info('[swarm] peer', remotePeerId.slice(0, 16) + '… connectionState:', state)
      if (state === 'failed' || state === 'closed') this._handleDirectLinkLost(remotePeerId, { pc })
    })
  }

  /**
   * The WebRTC link to a peer ended (it could not connect, or dropped). That is not the peer leaving: while the
   * signaling connection is up, the relay tells us when they really leave, and everything keeps going through the
   * relay meanwhile. Without signaling nobody can say, so the peer is dropped.
   * `pc` / `dc` identify the link that ended, so that the end of a link already replaced is ignored.
   */
  _handleDirectLinkLost(remoteId, { pc, dc } = {}) {
    const peer = this.peers.get(remoteId)
    if (!peer || (pc && peer.pc !== pc) || (dc && peer.dc !== dc)) return
    if (this._ws?.readyState !== WebSocket.OPEN) {
      this._handleDisconnect(remoteId)
      return
    }
    console.info('[swarm] direct link with', remoteId.slice(0, 16) + '… ended, continuing through the relay')
    const { dc: oldDc, pc: oldPc } = peer
    peer.dc = null
    peer.pc = null
    peer.sendControl = null
    oldDc?.close()
    oldPc?.close()
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
      this._handleDirectLinkLost(remotePeerId, { dc })
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
        // Fire peer-joined exactly once per peer, regardless of whether HELLO
        // arrived via DataChannel or WS relay.
        if (!peer._joinedFired) {
          peer._joinedFired = true
          this.dispatchEvent(
            new CustomEvent('peer-joined', {
              detail: { id: remoteId, username: msg.username, messageCoreKey: msg.messageCoreKey },
            })
          )
        }
        break
      case 'MSG':
        this.dispatchEvent(
          new CustomEvent('chat-message', { detail: { message: msg.message, channelName: msg.channelName } })
        )
        break
      case 'DM':
        // Encrypted direct message — dispatched as-is; decryption happens in the receiver
        this.dispatchEvent(
          new CustomEvent('dm-message', {
            detail: { from: remoteId, to: msg.to, nonce: msg.nonce, ciphertext: msg.ciphertext },
          })
        )
        break
      case 'HISTORY':
      case 'HISTORY_RES':
        if (Array.isArray(msg.messages)) {
          for (const m of msg.messages) {
            this.dispatchEvent(
              new CustomEvent('chat-message', { detail: { message: m, channelName: msg.channelName } })
            )
          }
        }
        break
      case 'HISTORY_REQ':
        this.dispatchEvent(
          new CustomEvent('history-req', {
            detail: { peerId: remoteId, since: msg.since ?? 0, channelName: msg.channelName },
          })
        )
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
        this.dispatchEvent(
          new CustomEvent('screen-share-start', { detail: { peerId: remoteId, streamId: msg.streamId } })
        )
        break
      case 'SCREEN_SHARE_END':
        this.dispatchEvent(new CustomEvent('screen-share-end', { detail: { peerId: remoteId } }))
        break
      case 'VIDEO_STATE':
        this.dispatchEvent(new CustomEvent('video-state', { detail: { peerId: remoteId, off: msg.off === true } }))
        break
      case 'WORKSPACE_META':
        this.dispatchEvent(new CustomEvent('workspace-meta', { detail: { peerId: remoteId, channels: msg.channels } }))
        break
      case 'MEMBER_HELLO':
        this.dispatchEvent(
          new CustomEvent('member-hello', {
            detail: { peerId: remoteId, pubkey: msg.pubkey, username: msg.username, status: msg.status ?? 'online' },
          })
        )
        break
      case 'PRESENCE_UPDATE':
        this.dispatchEvent(
          new CustomEvent('presence-update', { detail: { peerId: remoteId, pubkey: msg.pubkey, status: msg.status } })
        )
        break
      case 'TYPING':
        this.dispatchEvent(
          new CustomEvent('typing', {
            detail: {
              peerId: remoteId,
              username: msg.username ?? remoteId.slice(0, 8),
              stopped: msg.stopped ?? false,
              channelName: msg.channelName ?? null,
            },
          })
        )
        break
      case 'CHANNEL_NOTIFY':
        this.dispatchEvent(
          new CustomEvent('channel-notify', { detail: { peerId: remoteId, channelName: msg.channelName } })
        )
        break
      case 'REACTION':
        this.dispatchEvent(
          new CustomEvent('reaction', {
            detail: {
              peerId: remoteId,
              messageId: msg.messageId,
              emoji: msg.emoji,
              removed: msg.removed ?? false,
              at: msg.at,
              publicKey: msg.publicKey,
              sig: msg.sig,
              channelName: msg.channelName ?? null,
            },
          })
        )
        break
      case 'MSG_EDIT':
        this.dispatchEvent(
          new CustomEvent('msg-edit', {
            detail: {
              peerId: remoteId,
              originalId: msg.originalId,
              newContent: msg.newContent,
              editedAt: msg.editedAt,
              publicKey: msg.publicKey,
              sig: msg.sig,
              channelName: msg.channelName ?? null,
            },
          })
        )
        break
      case 'MSG_DELETE':
        this.dispatchEvent(
          new CustomEvent('msg-delete', {
            detail: {
              peerId: remoteId,
              originalId: msg.originalId,
              publicKey: msg.publicKey,
              sig: msg.sig,
              channelName: msg.channelName ?? null,
            },
          })
        )
        break
      case 'FILE_META':
        this.dispatchEvent(
          new CustomEvent('file-meta', {
            detail: {
              peerId: remoteId,
              fileId: msg.fileId,
              name: msg.name,
              mimeType: msg.mimeType,
              size: msg.size,
              totalChunks: msg.totalChunks,
              channelName: msg.channelName ?? null,
              senderUsername: msg.senderUsername ?? null,
              senderPublicKey: msg.senderPublicKey ?? null,
              timestamp: msg.timestamp,
              sig: msg.sig,
            },
          })
        )
        break
      case 'FILE_CHUNK':
        this.dispatchEvent(
          new CustomEvent('file-chunk', {
            detail: {
              peerId: remoteId,
              fileId: msg.fileId,
              index: msg.index,
              data: msg.data,
            },
          })
        )
        break
      case 'DM_INVITE':
        this.dispatchEvent(new CustomEvent('dm-invite', { detail: { peerId: remoteId, from: msg.from, to: msg.to } }))
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

  // Everything that leaves through the relay WebSocket goes through here, sealed. Without a key nothing is sent.
  // While the connection is down, signaling is kept (see KEPT_WHILE_OFFLINE) and sent once it is back.
  _sendRelay(type, to, payload, queuedAt = null) {
    if (!this._relayCipher || !this._localPeerId) return false
    if (this._ws?.readyState !== WebSocket.OPEN) {
      this._keepForLater(type, to, payload, queuedAt)
      return false
    }
    const sealed = this._relayCipher.seal(payload, this._localPeerId, to)
    const frame = type === 'signal' ? { type, to, signal: sealed } : { type, ...(to ? { to } : {}), data: sealed }
    this._ws.send(JSON.stringify(frame))
    return true
  }

  _keepForLater(type, to, payload, queuedAt) {
    if (this._leaving) return
    if (type !== 'signal' && !KEPT_WHILE_OFFLINE.has(payload?.type)) return
    this._outbox.push({ type, to, payload, at: queuedAt ?? Date.now() })
    if (this._outbox.length > OUTBOX_MAX) this._outbox.shift()
  }

  /** Sends what was kept while the relay connection was down, in order, leaving out what has become too old. */
  _flushOutbox() {
    const pending = this._outbox
    this._outbox = []
    const now = Date.now()
    for (const item of pending) {
      if (now - item.at > OUTBOX_TTL_MS) continue
      // If the connection drops again in the middle, the rest is kept again (with its original age)
      this._sendRelay(item.type, item.to, item.payload, item.at)
    }
  }

  _sendSignal(to, signal) {
    this._sendRelay('signal', to, signal)
  }

  // Send a HELLO to a specific peer via the WS relay so that peer-joined fires
  // on both sides without waiting for WebRTC DataChannel to open.
  _sendRelayHello(toPeerId) {
    this._sendRelay('relay-data-to', toPeerId, {
      type: 'HELLO',
      username: this._identity?.username ?? '…',
      publicKey: this._localPeerId,
      messageCoreKey: this.messageCoreKey,
      fingerprint: null, // no DTLS for WS-relay path — fingerprint check skipped when null
    })
  }

  // ── WebSocket reconnect ───────────────────────────────────────────────────
  // Called automatically when the signaling WS closes unexpectedly.
  // Re-joins the relay room with the same peerId so peers can rediscover us.
  _reconnectWS() {
    if (this._leaving || !this._localPeerId) return

    const url = signalUrl(this._relayUrl)
    console.info('[swarm] reconnecting WS…', url)

    let ws
    try {
      ws = new WebSocket(url)
    } catch {
      // URL may be invalid; retry later
      this._wsReconnectTimer = setTimeout(() => this._reconnectWS(), 5000)
      return
    }

    this._ws = ws

    ws.addEventListener(
      'open',
      () => {
        ws.send(JSON.stringify({ type: 'join', room: this._relayRoom, peerId: this._localPeerId }))
        console.info('[swarm] WS reconnected, re-joined room', this._relayRoom.slice(0, 16) + '…')
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
      // Back in the room: now what was kept can go
      if (msg.type === 'joined') this._flushOutbox()
      this._handleSignal(msg)
    })

    ws.addEventListener('close', () => {
      if (!this._leaving) {
        // Exponential-ish back-off capped at 10 s
        clearTimeout(this._wsReconnectTimer)
        this._wsReconnectTimer = setTimeout(() => this._reconnectWS(), 5000)
      }
    })

    ws.addEventListener('error', () => {
      // close event will fire next; back-off handled there
    })
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  sendToAll(msg) {
    // Prefer the DataChannel (true P2P, no server ever sees the payload).
    // Only fall back to the WS relay for peers whose DataChannel isn't open —
    // if every known peer already has an open DataChannel, skip the relay
    // entirely so the relay server never sees message content in that case.
    // (Also relay when no peers are known yet — a peer may exist in the room
    // whose HELLO/registration hasn't completed on our side yet.)
    let allHaveOpenDC = this.peers.size > 0
    for (const peer of this.peers.values()) {
      peer.sendControl?.(msg)
      if (peer.dc?.readyState !== 'open') allHaveOpenDC = false
    }
    if (!allHaveOpenDC) this._sendRelay('relay-data', null, msg)
  }

  sendToPeer(peerId, msg) {
    const peer = this.peers.get(peerId)
    // Try DataChannel first (also works for directly-wired test peers where dc=null)
    if (peer?.sendControl) {
      peer.sendControl(msg)
      // If a real DataChannel is open we're done; otherwise fall through to WS relay
      if (peer.dc?.readyState === 'open') return
    }
    // DataChannel not open (or unavailable) — relay via WebSocket
    this._sendRelay('relay-data-to', peerId, msg)
  }

  getPeers() {
    return Array.from(this.peers.values())
  }
  setMessageCoreKey(key) {
    this.messageCoreKey = key
  }

  async leave() {
    this._leaving = true
    this._outbox = []
    clearTimeout(this._wsReconnectTimer)
    // Said before closing: the relay gives a connection that just drops time to come back before telling the room
    if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify({ type: 'leave' }))
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
