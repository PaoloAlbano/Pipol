/**
 * peer.test.js
 * Tests WebRTCPeer track bookkeeping and screen-share renegotiation
 * against a minimal fake RTCPeerConnection.
 */

import { WebRTCPeer } from '../../src/webrtc/peer.js'

let pcs

class FakePC {
  constructor() {
    this.signalingState = 'stable'
    this.remoteDescription = null
    this.localDescription = null
    this.senders = []
    pcs.push(this)
  }
  addTrack(track, stream) {
    const sender = { track, stream, replaceTrack: vi.fn().mockResolvedValue(undefined) }
    this.senders.push(sender)
    return sender
  }
  removeTrack(sender) {
    this.senders = this.senders.filter((s) => s !== sender)
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' }
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer' }
  }
  async setLocalDescription(desc) {
    this.localDescription = desc
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable'
  }
  async addIceCandidate() {}
  close() {}
}

function track(kind) {
  return { kind }
}
function stream(...tracks) {
  return {
    id: `s-${Math.random()}`,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  }
}

beforeEach(() => {
  pcs = []
  globalThis.RTCPeerConnection = FakePC
  globalThis.RTCSessionDescription = class {
    constructor(init) {
      Object.assign(this, init)
    }
  }
  globalThis.RTCIceCandidate = class {}
})

async function connectedInitiator(screen = null) {
  const peer = new WebRTCPeer('p', true, stream(track('audio'), track('video')), screen)
  const offers = []
  peer.addEventListener('offer', (e) => offers.push(e.detail.sdp))
  await peer.init()
  await peer.handleAnswer({ type: 'answer', sdp: 'a' })
  return { peer, offers, pc: pcs[0] }
}

describe('WebRTCPeer — screen share', () => {
  it('sends the screen stream in the initial offer when already sharing', async () => {
    const screen = stream(track('video'))
    const { pc } = await connectedInitiator(screen)
    expect(pc.senders.filter((s) => s.stream === screen)).toHaveLength(1)
    expect(pc.senders).toHaveLength(3)
  })

  it('adds the screen as an extra sender and renegotiates, keeping the camera sender', async () => {
    const { peer, offers, pc } = await connectedInitiator()
    expect(offers).toHaveLength(1)
    const screen = stream(track('video'))
    await peer.addScreenStream(screen)
    expect(pc.senders).toHaveLength(3)
    expect(offers).toHaveLength(2)
  })

  it('removes the screen sender and renegotiates when sharing stops', async () => {
    const { peer, offers, pc } = await connectedInitiator()
    const screen = stream(track('video'))
    await peer.addScreenStream(screen)
    await peer.handleAnswer({ type: 'answer', sdp: 'a' })
    await peer.removeScreenStream()
    expect(pc.senders).toHaveLength(2)
    expect(offers).toHaveLength(3)
  })

  it('defers renegotiation until the pending offer is answered', async () => {
    const peer = new WebRTCPeer('p', true, stream(track('audio'), track('video')))
    const offers = []
    peer.addEventListener('offer', (e) => offers.push(e.detail.sdp))
    await peer.init()
    await peer.addScreenStream(stream(track('video')))
    expect(offers).toHaveLength(1)
    await peer.handleAnswer({ type: 'answer', sdp: 'a' })
    expect(offers).toHaveLength(2)
  })

  it('replaceVideoTrack only touches the camera sender', async () => {
    const { peer, pc } = await connectedInitiator()
    const screen = stream(track('video'))
    await peer.addScreenStream(screen)
    const newCam = track('video')
    await peer.replaceVideoTrack(newCam)
    const [audio, cam, scr] = pc.senders
    expect(cam.replaceTrack).toHaveBeenCalledWith(newCam)
    expect(audio.replaceTrack).not.toHaveBeenCalled()
    expect(scr.replaceTrack).not.toHaveBeenCalled()
  })

  it('initiator ignores a colliding offer', async () => {
    const { peer, pc } = await connectedInitiator()
    pc.signalingState = 'have-local-offer'
    const answers = []
    peer.addEventListener('answer', (e) => answers.push(e.detail.sdp))
    await peer.handleOffer({ type: 'offer', sdp: 'x' })
    expect(answers).toHaveLength(0)
  })

  it('exposes the remote track together with the stream', async () => {
    const peer = new WebRTCPeer('p', false, stream(track('audio')))
    await peer.init()
    const received = []
    peer.addEventListener('remote-stream', (e) => received.push(e.detail))
    const s = { id: 'remote' }
    pcs[0].ontrack({ track: track('video'), streams: [s] })
    expect(received[0].stream).toBe(s)
  })

  it('the polite side rolls back and answers a colliding offer', async () => {
    const peer = new WebRTCPeer('p', true, stream(track('audio'), track('video')), null, true)
    const answers = []
    peer.addEventListener('answer', (e) => answers.push(e.detail.sdp))
    await peer.init() // sends its own offer -> have-local-offer
    await peer.handleOffer({ type: 'offer', sdp: 'x' })
    expect(answers).toHaveLength(1)
    expect(peer.established).toBe(true)
  })

  it('the impolite side wins even when it is not the initiator', async () => {
    const peer = new WebRTCPeer('p', false, stream(track('audio')), null, false)
    await peer.init()
    pcs[0].signalingState = 'have-local-offer'
    const answers = []
    peer.addEventListener('answer', (e) => answers.push(e.detail.sdp))
    await peer.handleOffer({ type: 'offer', sdp: 'x' })
    expect(answers).toHaveLength(0)
  })

  it('is established only after the first answer', async () => {
    const peer = new WebRTCPeer('p', true, stream(track('audio')))
    await peer.init()
    expect(peer.established).toBe(false)
    await peer.handleAnswer({ type: 'answer', sdp: 'a' })
    expect(peer.established).toBe(true)
  })
})
