/**
 * peer.js
 * RTCPeerConnection wrapper for a single remote peer.
 *
 * Topology: full mesh — one WebRTCPeer instance per remote participant.
 *
 * Signaling flow (Hyperbeam carries SDP + ICE):
 *   Initiator                      Responder
 *   ─────────                      ─────────
 *   createOffer()
 *   setLocalDescription(offer)
 *   ──── offer ──────────────────▶ handleOffer()
 *                                  setRemoteDescription(offer)
 *                                  createAnswer()
 *                                  setLocalDescription(answer)
 *   handleAnswer() ◀───────────── ──── answer ────────────────
 *   setRemoteDescription(answer)
 *   ◀──────── ICE ──────────────▶  (bidirectional)
 *
 * ICE candidates sent before setRemoteDescription are queued and flushed
 * once the remote description is set.
 */

import { DEFAULT_ICE_SERVERS } from './ice.js'
import { getVideoQuality } from '../p2p/storage.js'
import { onVideoQualityChange } from './media.js'
import { MAX_PROFILE, sendLimits, applySendLimits } from './sendQuality.js'
import { sdpFingerprint } from './sdp.js'

/** A connection that stays "disconnected" this long (ms) without healing by itself gets an ICE restart. */
export const DISCONNECT_GRACE_MS = 4000
/** After an ICE restart that did not bring the connection back within this time (ms), try again. */
export const RESTART_RETRY_MS = 10_000
/** ICE restarts in a row before giving up and closing the connection. */
export const MAX_ICE_RESTARTS = 4
/** A change of network is acted on after this long (ms) without further changes. */
export const NETWORK_CHANGE_DEBOUNCE_MS = 1000
/** A connection that has not connected after this long (ms) is given up (the caller can try again). */
export const CONNECT_TIMEOUT_MS = 25_000
/** An offer nobody has answered after this long (ms) is sent once more: the first may have been lost. */
export const OFFER_RESEND_MS = 8000
/** How often (ms) the health of a connected call is looked at. */
export const HEALTH_POLL_MS = 3000
/** A connection is weak when the round trip takes longer than this (ms) or this share of the packets is lost. */
export const POOR_RTT_MS = 500
export const POOR_LOSS_RATIO = 0.1
/** Checks in a row needed to call a connection weak, and to call it fine again (so the label does not flicker). */
export const HEALTH_SAMPLES = 2

/** The route of a new connection is written to the console this long (ms) after it connects, once the pairs settled. */
export const ROUTE_LOG_DELAY_MS = 3000
/** How often (ms) the route of a connection is checked, to raise or lower what the "max" profile sends. */
export const QUALITY_POLL_MS = 3000

export class WebRTCPeer extends EventTarget {
  /**
   * @param {string}       peerId       Remote peer identifier (hex public key)
   * @param {boolean}      isInitiator  True if this peer sends the SDP offer
   * @param {MediaStream}  localStream  Our camera/mic stream
   * @param {MediaStream|null} screenStream  Active screen-share stream, sent alongside the camera
   * @param {boolean}      [polite]     Who yields when both sides send an offer at once. Must differ
   *                                    between the two ends; defaults to the non-initiator.
   * @param {RTCConfiguration} [rtcConfig]  ICE servers and policy (see webrtc/ice.js)
   * @param {{ quality?: string }} [options]  `quality`: video quality profile (default: the user's setting)
   */
  constructor(
    peerId,
    isInitiator,
    localStream,
    screenStream = null,
    polite = !isInitiator,
    rtcConfig = { iceServers: DEFAULT_ICE_SERVERS },
    { quality } = {}
  ) {
    super()
    this.peerId = peerId
    this.isInitiator = isInitiator
    this.polite = polite
    this.rtcConfig = rtcConfig
    this.localStream = localStream
    this.screenStream = screenStream

    this._pc = null
    this._senders = { video: null, audio: null, screen: null }
    this._initialDone = false // first offer/answer exchange completed
    this._needsNegotiation = false // tracks added/removed after the first exchange
    this._makingOffer = false
    this._pendingCandidates = [] // ICE candidates queued before remoteDescription is set
    this._closed = false
    this._chain = Promise.resolve() // offers and answers are handled one at a time, in order of arrival

    this._iceRestartPending = false // the next offer restarts ICE
    this._restartAttempts = 0
    this._disconnectTimer = null
    this._retryTimer = null
    this._networkTimer = null
    this._networkCleanup = null

    this._quality = quality ?? getVideoQuality()
    this._appliedLimits = JSON.stringify(null) // what the video sender has been told (nothing yet)
    this._qualityTimer = null
    this._unsubscribeQuality = null
    this._routeLogTimer = null

    this._status = 'connecting' // 'connecting' | 'connected' | 'poor' | 'reconnecting' | 'closed'
    this._everConnected = false
    this._connectTimer = null
    this._resendTimer = null
    this._healthTimer = null
    this._health = { lost: 0, received: 0, bad: 0, good: 0 }
  }

  /**
   * How the connection is doing, for the UI: 'connecting' (never connected yet), 'connected', 'poor' (connected but
   * weak), 'reconnecting' (it worked and is being recovered) or 'closed'. Changes are announced with a 'status' event.
   */
  get status() {
    return this._status
  }

  _setStatus(status) {
    if (this._status === status) return
    this._status = status
    this.dispatchEvent(new CustomEvent('status', { detail: { status } }))
  }

  /**
   * Swaps in fresh ICE servers (new TURN credentials) on a live connection, so a long call keeps its relay.
   * @param {{ iceServers: object[] }} config
   */
  updateIceServers(config) {
    if (!this._pc || this._closed) return
    this.rtcConfig = config
    try {
      this._pc.setConfiguration({ ...this._pc.getConfiguration(), iceServers: config.iceServers })
    } catch (err) {
      console.warn('[webrtc] could not update ICE servers', err)
    }
  }

  /** Fingerprint of the connection of the other side, once we have its description. */
  get remoteFingerprint() {
    return sdpFingerprint(this._pc?.remoteDescription)
  }

  /** True once the first offer/answer exchange has completed. */
  get established() {
    return this._initialDone
  }

  /** Initialise the RTCPeerConnection and, if initiator, create+send an offer. */
  async init() {
    this._pc = new RTCPeerConnection(this.rtcConfig)

    // Add all local tracks (audio + video)
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        const sender = this._pc.addTrack(track, this.localStream)
        this._senders[track.kind === 'audio' ? 'audio' : 'video'] = sender
      }
    }
    if (this.screenStream) {
      const [screenTrack] = this.screenStream.getVideoTracks()
      if (screenTrack) this._senders.screen = this._pc.addTrack(screenTrack, this.screenStream)
    }

    // Remote track received → expose via 'remote-stream' event
    this._pc.ontrack = (event) => {
      if (this._closed) return
      this.dispatchEvent(
        new CustomEvent('remote-stream', {
          detail: { stream: event.streams[0] ?? new MediaStream([event.track]), track: event.track },
        })
      )
    }

    // ICE candidate gathered → send to remote via Hyperbeam
    this._pc.onicecandidate = (event) => {
      if (this._closed || !event.candidate) return
      this.dispatchEvent(
        new CustomEvent('ice-candidate', {
          detail: { candidate: event.candidate.toJSON() },
        })
      )
    }

    this._pc.onconnectionstatechange = () => {
      const state = this._pc?.connectionState
      console.info(`[webrtc] ${this.peerId.slice(0, 12)}… state: ${state}`)
      this.dispatchEvent(new CustomEvent('connection-state', { detail: { state } }))
      if (state === 'connected') this._onConnected()
      else if (state === 'disconnected') this._armDisconnectTimer()
      else if (state === 'failed') this._onFailed()
      else if (state === 'closed')
        this.close('failed') // closed from outside: we did not ask for it
      else if (this._everConnected) this._setStatus('reconnecting') // 'connecting' again after it had worked
    }

    this._watchNetwork()
    this._armConnectTimers()
    this._unsubscribeQuality = onVideoQualityChange((quality) => this.setQualityProfile(quality))

    if (this.isInitiator) {
      await this._sendOffer()
    }
  }

  async _sendOffer() {
    this._makingOffer = true
    try {
      const iceRestart = this._iceRestartPending
      const offer = await this._pc.createOffer(iceRestart ? { iceRestart: true } : undefined)
      if (this._closed) return // closed while the offer was being created: never send a stale one
      await this._pc.setLocalDescription(offer)
      if (this._closed) return
      if (iceRestart) this._iceRestartPending = false
      this.dispatchEvent(new CustomEvent('offer', { detail: { sdp: this._pc.localDescription } }))
    } finally {
      this._makingOffer = false
    }
  }

  /**
   * Handle an SDP offer from the remote peer (responder side, or a
   * renegotiation initiated by either side). Creates and emits an answer.
   * On glare the polite side yields (its own offer is rolled back); the other side ignores the offer.
   * @param {RTCSessionDescriptionInit} sdp
   */
  handleOffer(sdp) {
    return this._inOrder(() => this._handleOffer(sdp))
  }

  async _handleOffer(sdp) {
    if (this._closed) return
    const collision = this._makingOffer || this._pc.signalingState !== 'stable'
    if (collision && !this.polite) return
    // Our own pending offer is rolled back by the incoming one — send it again afterwards
    if (collision && this._initialDone) this._needsNegotiation = true

    // Setting a remote offer while we have a local one implicitly rolls ours back
    await this._pc.setRemoteDescription(new RTCSessionDescription(sdp))
    await this._flushPendingCandidates()

    const answer = await this._pc.createAnswer()
    await this._pc.setLocalDescription(answer)
    this.dispatchEvent(new CustomEvent('answer', { detail: { sdp: this._pc.localDescription } }))
    this._initialDone = true
    // The offer had no place for a track of ours (the screen we are already sharing): offer it ourselves
    if (this._hasTrackWithoutPlace()) this._needsNegotiation = true
    await this._flushRenegotiation()
  }

  // ── Recovering a connection ───────────────────────────────────────────────────

  /**
   * Starts a new ICE negotiation on the live connection, to find a working path again (after the network changed,
   * for instance a phone moving from Wi-Fi to 4G). The call keeps going: the tracks are not renegotiated.
   * The offer waits for the connection to be idle. Tried again if it does not help, up to MAX_ICE_RESTARTS times.
   * @param {string} [reason]
   * @returns {boolean} false when it cannot be done (closed, not yet connected once, or tried too many times)
   */
  requestIceRestart(reason = 'manual') {
    if (this._closed || !this._pc || !this._initialDone) return false
    if (this._restartAttempts >= MAX_ICE_RESTARTS) return false
    this._restartAttempts++
    if (this._everConnected) this._setStatus('reconnecting')
    console.info(`[webrtc] ${this.peerId.slice(0, 12)}… restarting ICE (${reason}, attempt ${this._restartAttempts})`)
    this._armRetryTimer()

    // Our offer is still waiting for an answer: it may have been lost on the way (the signaling connection drops
    // together with the network), so it is sent again
    if (this._pc.signalingState === 'have-local-offer' && !this._makingOffer && this._pc.localDescription) {
      this.dispatchEvent(new CustomEvent('offer', { detail: { sdp: this._pc.localDescription } }))
      return true
    }

    this._iceRestartPending = true
    this._needsNegotiation = true
    this._flushRenegotiation().catch((err) => console.warn('[webrtc] ICE restart failed', err))
    return true
  }

  /** A connection that never gets there is given up, after one more try of its offer in case that was lost. */
  _armConnectTimers() {
    this._resendTimer = setTimeout(() => {
      if (this._closed || !this._pc || this._initialDone) return
      if (this._pc.signalingState === 'have-local-offer' && !this._makingOffer && this._pc.localDescription) {
        this.dispatchEvent(new CustomEvent('offer', { detail: { sdp: this._pc.localDescription } }))
      }
    }, OFFER_RESEND_MS)
    this._connectTimer = setTimeout(() => {
      if (this._closed || this._everConnected) return
      console.warn(`[webrtc] ${this.peerId.slice(0, 12)}… did not connect in time`)
      this.close('timeout')
    }, CONNECT_TIMEOUT_MS)
  }

  _onConnected() {
    this._everConnected = true
    clearTimeout(this._connectTimer)
    clearTimeout(this._resendTimer)
    clearTimeout(this._disconnectTimer)
    clearTimeout(this._retryTimer)
    this._restartAttempts = 0
    this._health = { lost: 0, received: 0, bad: 0, good: 0 }
    this._setStatus('connected')
    this._manageHealthPolling()
    this._syncQuality().catch(() => {})
    this._managePolling()
    clearTimeout(this._routeLogTimer)
    this._routeLogTimer = setTimeout(() => this._logRoute(), ROUTE_LOG_DELAY_MS)
  }

  /**
   * Writes to the console which candidate pair carries the media and the state of the others (the one in use is
   * starred), to see why a connection goes through a TURN relay when a direct path was expected.
   */
  async _logRoute() {
    if (this._closed || !this._pc) return
    try {
      const items = [...(await this._pc.getStats()).values()]
      const byId = Object.fromEntries(items.map((s) => [s.id, s]))
      const selectedId = items.find((s) => s.type === 'transport')?.selectedCandidatePairId
      const kind = (id) => byId[id]?.candidateType ?? '?'
      const pairs = items
        .filter((s) => s.type === 'candidate-pair')
        .map(
          (p) =>
            `${kind(p.localCandidateId)}<->${kind(p.remoteCandidateId)}=${p.state}${p.id === selectedId ? '*' : ''}`
        )
      console.info(`[webrtc] ${this.peerId.slice(0, 12)}… route: ${pairs.join(', ') || 'no pairs'}`)
    } catch {
      // statistics not available
    }
  }

  _onFailed() {
    clearTimeout(this._disconnectTimer)
    // A connection that never worked has nothing to restart
    if (!this.requestIceRestart('failed')) this.close('failed')
  }

  _armDisconnectTimer() {
    clearTimeout(this._disconnectTimer)
    this._disconnectTimer = setTimeout(() => {
      if (this._pc?.connectionState !== 'disconnected') return
      if (this._everConnected) this._setStatus('reconnecting')
      this.requestIceRestart('disconnected')
    }, DISCONNECT_GRACE_MS)
  }

  _armRetryTimer() {
    clearTimeout(this._retryTimer)
    this._retryTimer = setTimeout(() => {
      if (this._closed || !this._pc) return
      if (this._pc.connectionState === 'connected') {
        this._restartAttempts = 0
      } else if (!this.requestIceRestart('retry')) {
        this.close('failed')
      }
    }, RESTART_RETRY_MS)
  }

  /** Restarts ICE when the device changes network (it comes back online, or the connection type changes). */
  _watchNetwork() {
    const schedule = (reason) => {
      clearTimeout(this._networkTimer)
      this._networkTimer = setTimeout(() => this.requestIceRestart(reason), NETWORK_CHANGE_DEBOUNCE_MS)
    }
    const onOnline = () => schedule('online')
    globalThis.addEventListener?.('online', onOnline)

    const connection = globalThis.navigator?.connection
    let type = connection?.type
    const onChange = () => {
      if (connection.type === undefined || connection.type === type) return
      type = connection.type
      schedule('network-change')
    }
    connection?.addEventListener?.('change', onChange)

    this._networkCleanup = () => {
      clearTimeout(this._networkTimer)
      globalThis.removeEventListener?.('online', onOnline)
      connection?.removeEventListener?.('change', onChange)
    }
  }

  // ── Health of the connection ──────────────────────────────────────────────────

  _manageHealthPolling() {
    const wanted = this._pc?.connectionState === 'connected' && !this._closed
    if (wanted && !this._healthTimer) {
      this._healthTimer = setInterval(() => this._checkHealth().catch(() => {}), HEALTH_POLL_MS)
    } else if (!wanted && this._healthTimer) {
      clearInterval(this._healthTimer)
      this._healthTimer = null
    }
  }

  /** Looks at the round trip time and at the packets lost since the last check, to tell a weak connection. */
  async _checkHealth() {
    if (this._closed || !this._pc || this._pc.connectionState !== 'connected') return
    const items = [...(await this._pc.getStats()).values()]
    if (this._closed) return

    const selectedId = items.find((s) => s.type === 'transport')?.selectedCandidatePairId
    const pair = items.find((s) => s.type === 'candidate-pair' && s.id === selectedId)
    const rttMs = pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null

    let lost = 0
    let received = 0
    for (const s of items) {
      if (s.type !== 'inbound-rtp') continue
      lost += Math.max(s.packetsLost ?? 0, 0)
      received += s.packetsReceived ?? 0
    }
    const h = this._health
    const newLost = Math.max(lost - h.lost, 0)
    const newTotal = newLost + Math.max(received - h.received, 0)
    h.lost = lost
    h.received = received

    const lossy = newTotal >= 30 && newLost / newTotal >= POOR_LOSS_RATIO
    const slow = rttMs != null && rttMs > POOR_RTT_MS
    if (lossy || slow) {
      h.bad++
      h.good = 0
    } else {
      h.good++
      h.bad = 0
    }
    if (this._status === 'connected' && h.bad >= HEALTH_SAMPLES) this._setStatus('poor')
    else if (this._status === 'poor' && h.good >= HEALTH_SAMPLES) this._setStatus('connected')
  }

  // ── What the camera sends ─────────────────────────────────────────────────────

  /**
   * Changes the video quality profile of this connection (see sendQuality.js).
   * @param {string} profile '480p' | '720p' | '1080p' | 'max'
   */
  setQualityProfile(profile) {
    if (this._closed || profile === this._quality) return
    this._quality = profile
    this._syncQuality().catch(() => {})
    this._managePolling()
  }

  /** Tells the camera sender what it may send, given the profile and how the media reaches the other side. */
  async _syncQuality() {
    const sender = this._senders.video
    if (this._closed || !this._pc || !sender?.track) return

    let route = 'unknown'
    if (this._quality === MAX_PROFILE && this._pc.connectionState === 'connected') {
      const stats = await this.getConnectionStats().catch(() => null)
      if (this._closed) return
      if (stats) route = stats.relayed ? 'relayed' : 'direct'
    }

    const limits = sendLimits(this._quality, route, sender.track.getSettings?.() ?? {})
    const key = JSON.stringify(limits)
    if (key === this._appliedLimits) return
    if (await applySendLimits(sender, limits)) this._appliedLimits = key
  }

  /** The route can change during a call, so with the "max" profile it is looked at now and then. */
  _managePolling() {
    const wanted = this._quality === MAX_PROFILE && this._pc?.connectionState === 'connected' && !this._closed
    if (wanted && !this._qualityTimer) {
      this._qualityTimer = setInterval(() => this._syncQuality().catch(() => {}), QUALITY_POLL_MS)
    } else if (!wanted && this._qualityTimer) {
      clearInterval(this._qualityTimer)
      this._qualityTimer = null
    }
  }

  /** True when a track we send is not part of the negotiated session yet (it has no m-line, so no `mid`). */
  _hasTrackWithoutPlace() {
    return (this._pc?.getTransceivers?.() ?? []).some((t) => t.mid == null && t.sender?.track)
  }

  /**
   * Handle an SDP answer from the remote peer.
   * @param {RTCSessionDescriptionInit} sdp
   */
  handleAnswer(sdp) {
    return this._inOrder(() => this._handleAnswer(sdp))
  }

  async _handleAnswer(sdp) {
    if (this._closed) return
    if (this._pc.signalingState !== 'have-local-offer') return
    await this._pc.setRemoteDescription(new RTCSessionDescription(sdp))
    await this._flushPendingCandidates()
    this._initialDone = true
    await this._flushRenegotiation()
  }

  /**
   * Runs a signalling step after the ones before it have finished. An answer and the offer that follows it arrive
   * back to back: handled at the same time, the offer would find the connection still waiting for the answer.
   */
  _inOrder(task) {
    const run = this._chain.then(task)
    this._chain = run.catch(() => {})
    return run
  }

  /** Sends a new offer if tracks changed and the connection is idle. */
  async _flushRenegotiation() {
    if (this._closed || !this._needsNegotiation || !this._initialDone) return
    if (this._makingOffer || this._pc.signalingState !== 'stable') return
    this._needsNegotiation = false
    await this._sendOffer()
  }

  /**
   * Swap the camera video track without renegotiating.
   * @param {MediaStreamTrack} track
   */
  async replaceVideoTrack(track) {
    await this._senders.video?.replaceTrack(track).catch(() => {})
    // The new camera may deliver another size: work out the limits again
    this._appliedLimits = this._quality === MAX_PROFILE ? null : JSON.stringify(null)
    this._syncQuality().catch(() => {})
  }

  /**
   * Swap the microphone track without renegotiating.
   * @param {MediaStreamTrack} track
   */
  async replaceAudioTrack(track) {
    await this._senders.audio?.replaceTrack(track).catch(() => {})
  }

  /**
   * Start sending a screen-share stream next to the camera (renegotiates).
   * @param {MediaStream} stream
   */
  async addScreenStream(stream) {
    if (this._closed || !this._pc || this._senders.screen) return
    const [track] = stream.getVideoTracks()
    if (!track) return
    this.screenStream = stream
    this._senders.screen = this._pc.addTrack(track, stream)
    this._needsNegotiation = true
    await this._flushRenegotiation()
  }

  /** Stop sending the screen-share stream (renegotiates). */
  async removeScreenStream() {
    this.screenStream = null
    const sender = this._senders.screen
    if (this._closed || !this._pc || !sender) return
    this._senders.screen = null
    try {
      this._pc.removeTrack(sender)
    } catch (err) {
      console.warn('[webrtc] removeTrack error', err)
      return
    }
    this._needsNegotiation = true
    await this._flushRenegotiation()
  }

  /**
   * Handle an incoming ICE candidate from the remote peer.
   * Queues it if remote description is not yet set.
   * @param {RTCIceCandidateInit} candidate
   */
  async handleIceCandidate(candidate) {
    if (this._closed) return
    if (this._pc.remoteDescription) {
      await this._pc
        .addIceCandidate(new RTCIceCandidate(candidate))
        .catch((err) => console.warn('[webrtc] addIceCandidate error', err))
    } else {
      this._pendingCandidates.push(candidate)
    }
  }

  async _flushPendingCandidates() {
    for (const c of this._pendingCandidates) {
      await this._pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
    }
    this._pendingCandidates = []
  }

  /**
   * Close this peer connection. The 'closed' event says why: 'closed' when the caller asked for it, 'failed' or
   * 'timeout' when the connection could not be kept (so the caller may want to connect again).
   * @param {'closed'|'failed'|'timeout'} [reason]
   */
  close(reason = 'closed') {
    if (this._closed) return
    this._closed = true
    clearTimeout(this._disconnectTimer)
    clearTimeout(this._retryTimer)
    clearTimeout(this._connectTimer)
    clearTimeout(this._resendTimer)
    clearInterval(this._healthTimer)
    this._healthTimer = null
    clearTimeout(this._routeLogTimer)
    clearInterval(this._qualityTimer)
    this._qualityTimer = null
    this._networkCleanup?.()
    this._unsubscribeQuality?.()
    this._pc?.close()
    this._pc = null
    this._setStatus('closed')
    this.dispatchEvent(new CustomEvent('closed', { detail: { reason } }))
  }

  get connectionState() {
    return this._pc?.connectionState ?? 'closed'
  }

  /**
   * Returns stats for the active ICE candidate pair.
   * `relayed` is true when the media goes through a TURN server (either side's candidate is a relay).
   * @returns {Promise<{ localType, remoteType, relayed, relayProtocol, localAddress, remoteAddress, rtt, bytesSent, bytesReceived } | null>}
   */
  async getConnectionStats() {
    if (!this._pc) return null
    const report = await this._pc.getStats()

    // The browser says which pair carries the media (`selectedCandidatePairId`); older ones only flag a nominated pair
    let selectedId = null
    const pairs = []
    const candidates = {}

    for (const s of report.values()) {
      if (s.type === 'transport' && s.selectedCandidatePairId) selectedId = s.selectedCandidatePairId
      if (s.type === 'candidate-pair') pairs.push(s)
      if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
        candidates[s.id] = s
      }
    }

    const latest = (test) => pairs.filter(test).at(-1)
    const activePair =
      pairs.find((p) => p.id === selectedId) ??
      latest((p) => p.nominated && p.state === 'succeeded') ??
      latest((p) => p.state === 'succeeded' && (p.bytesReceived > 0 || p.bytesSent > 0)) ??
      null

    if (!activePair) return null

    const local = candidates[activePair.localCandidateId]
    const remote = candidates[activePair.remoteCandidateId]

    return {
      localType: local?.candidateType ?? '?',
      remoteType: remote?.candidateType ?? '?',
      relayed: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
      relayProtocol: local?.candidateType === 'relay' ? (local.relayProtocol ?? null) : null,
      localAddress: local?.address ?? '',
      remoteAddress: remote?.address ?? '',
      rtt: activePair.currentRoundTripTime != null ? Math.round(activePair.currentRoundTripTime * 1000) : null,
      bytesSent: activePair.bytesSent ?? 0,
      bytesReceived: activePair.bytesReceived ?? 0,
    }
  }
}
