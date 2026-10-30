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

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]

export class WebRTCPeer extends EventTarget {
  /**
   * @param {string}       peerId       Remote peer identifier (hex public key)
   * @param {boolean}      isInitiator  True if this peer sends the SDP offer
   * @param {MediaStream}  localStream  Our camera/mic stream
   * @param {MediaStream|null} screenStream  Active screen-share stream, sent alongside the camera
   */
  constructor(peerId, isInitiator, localStream, screenStream = null) {
    super()
    this.peerId = peerId
    this.isInitiator = isInitiator
    this.localStream = localStream
    this.screenStream = screenStream

    this._pc = null
    this._senders = { video: null, audio: null, screen: null }
    this._initialDone = false // first offer/answer exchange completed
    this._needsNegotiation = false // tracks added/removed after the first exchange
    this._makingOffer = false
    this._pendingCandidates = [] // ICE candidates queued before remoteDescription is set
    this._closed = false
  }

  /** Initialise the RTCPeerConnection and, if initiator, create+send an offer. */
  async init() {
    this._pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

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
      if (state === 'failed' || state === 'closed') this.close()
    }

    this._pc.oniceconnectionstatechange = () => {
      if (this._pc?.iceConnectionState === 'failed') {
        // Attempt ICE restart
        this._pc.restartIce()
      }
    }

    if (this.isInitiator) {
      await this._sendOffer()
    }
  }

  async _sendOffer() {
    this._makingOffer = true
    try {
      const offer = await this._pc.createOffer()
      await this._pc.setLocalDescription(offer)
      this.dispatchEvent(new CustomEvent('offer', { detail: { sdp: this._pc.localDescription } }))
    } finally {
      this._makingOffer = false
    }
  }

  /**
   * Handle an SDP offer from the remote peer (responder side, or a
   * renegotiation initiated by either side). Creates and emits an answer.
   * On glare the non-initiator is "polite" and yields; the initiator ignores the offer.
   * @param {RTCSessionDescriptionInit} sdp
   */
  async handleOffer(sdp) {
    if (this._closed) return
    const collision = this._makingOffer || this._pc.signalingState !== 'stable'
    if (collision && this.isInitiator) return
    // Our own pending offer is rolled back by the incoming one — send it again afterwards
    if (collision && this._initialDone) this._needsNegotiation = true

    // Setting a remote offer while we have a local one implicitly rolls ours back
    await this._pc.setRemoteDescription(new RTCSessionDescription(sdp))
    await this._flushPendingCandidates()

    const answer = await this._pc.createAnswer()
    await this._pc.setLocalDescription(answer)
    this.dispatchEvent(new CustomEvent('answer', { detail: { sdp: this._pc.localDescription } }))
    this._initialDone = true
    await this._flushRenegotiation()
  }

  /**
   * Handle an SDP answer from the remote peer.
   * @param {RTCSessionDescriptionInit} sdp
   */
  async handleAnswer(sdp) {
    if (this._closed) return
    if (this._pc.signalingState !== 'have-local-offer') return
    await this._pc.setRemoteDescription(new RTCSessionDescription(sdp))
    await this._flushPendingCandidates()
    this._initialDone = true
    await this._flushRenegotiation()
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

  /** Cleanly close this peer connection. */
  close() {
    if (this._closed) return
    this._closed = true
    this._pc?.close()
    this._pc = null
    this.dispatchEvent(new CustomEvent('closed'))
  }

  get connectionState() {
    return this._pc?.connectionState ?? 'closed'
  }

  /**
   * Returns stats for the active ICE candidate pair.
   * @returns {Promise<{ localType, remoteType, localAddress, remoteAddress, rtt, bytesSent, bytesReceived } | null>}
   */
  async getConnectionStats() {
    if (!this._pc) return null
    const report = await this._pc.getStats()

    let activePair = null
    const candidates = {}

    for (const s of report.values()) {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        activePair = s
      }
      if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
        candidates[s.id] = s
      }
    }

    if (!activePair) return null

    const local = candidates[activePair.localCandidateId]
    const remote = candidates[activePair.remoteCandidateId]

    return {
      localType: local?.candidateType ?? '?',
      remoteType: remote?.candidateType ?? '?',
      localAddress: local?.address ?? '',
      remoteAddress: remote?.address ?? '',
      rtt: activePair.currentRoundTripTime != null ? Math.round(activePair.currentRoundTripTime * 1000) : null,
      bytesSent: activePair.bytesSent ?? 0,
      bytesReceived: activePair.bytesReceived ?? 0,
    }
  }
}
