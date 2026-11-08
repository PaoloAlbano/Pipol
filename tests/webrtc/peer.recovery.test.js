/**
 * peer.recovery.test.js
 * WebRTCPeer: ICE restarts when a connection drops or the network changes, and what the camera is allowed to send
 * for the video quality profile (60 fps only on direct connections with "max").
 */

import {
  WebRTCPeer,
  DISCONNECT_GRACE_MS,
  RESTART_RETRY_MS,
  MAX_ICE_RESTARTS,
  NETWORK_CHANGE_DEBOUNCE_MS,
  ROUTE_LOG_DELAY_MS,
  ROUTE_LOG_DELAY_MS,
  QUALITY_POLL_MS,
} from '../../src/webrtc/peer.js'

// The peer subscribes to quality changes of the media module: capture the callback to fire it from the tests
const media = vi.hoisted(() => ({ listeners: new Set() }))
vi.mock('../../src/webrtc/media.js', () => ({
  onVideoQualityChange: (cb) => {
    media.listeners.add(cb)
    return () => media.listeners.delete(cb)
  },
}))

let pcs

class FakePC {
  constructor() {
    this.signalingState = 'stable'
    this.connectionState = 'new'
    this.remoteDescription = null
    this.localDescription = null
    this.senders = []
    this.offerOptions = []
    this.route = { local: 'host', remote: 'host' }
    this.closed = false
    pcs.push(this)
  }
  addTrack(track, stream) {
    const sender = {
      track,
      stream,
      params: { encodings: [{}] },
      getParameters() {
        return this.params
      },
      setParameters: vi.fn(async function (p) {
        this.params = p
      }),
      replaceTrack: vi.fn(async function (t) {
        this.track = t
      }),
    }
    this.senders.push(sender)
    return sender
  }
  removeTrack() {}
  async createOffer(options) {
    this.offerOptions.push(options)
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
  async getStats() {
    const { local, remote } = this.route
    return new Map([
      ['t', { type: 'transport', id: 't', selectedCandidatePairId: 'p' }],
      ['p', { type: 'candidate-pair', id: 'p', state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { type: 'local-candidate', id: 'l', candidateType: local }],
      ['r', { type: 'remote-candidate', id: 'r', candidateType: remote }],
    ])
  }
  close() {
    this.closed = true
  }
  /** Moves the connection to a state, as the browser does. */
  setState(state) {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
}

function track(kind, settings = { width: 1920, height: 1080 }) {
  return { kind, getSettings: () => settings }
}
function stream(...tracks) {
  return { id: 's', getTracks: () => tracks, getVideoTracks: () => tracks.filter((t) => t.kind === 'video') }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  pcs = []
  media.listeners.clear()
  localStorage.clear()
  globalThis.RTCPeerConnection = FakePC
  globalThis.RTCSessionDescription = class {
    constructor(init) {
      Object.assign(this, init)
    }
  }
  globalThis.RTCIceCandidate = class {}
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete navigator.connection
})

const advance = (ms) => vi.advanceTimersByTimeAsync(ms)

/** A peer whose first offer/answer exchange is done, with its connection connected. */
async function establishedPeer({ quality = '1080p', videoSettings } = {}) {
  const peer = new WebRTCPeer('p', true, stream(track('audio'), track('video', videoSettings)), null, true, undefined, {
    quality,
  })
  const offers = []
  peer.addEventListener('offer', (e) => offers.push(e.detail.sdp))
  const closed = vi.fn()
  peer.addEventListener('closed', closed)
  await peer.init()
  await peer.handleAnswer({ type: 'answer', sdp: 'a' })
  const pc = pcs[0]
  pc.setState('connected')
  await advance(0)
  offers.length = 0
  pc.offerOptions.length = 0
  return { peer, pc, offers, closed }
}

const restarts = (pc) => pc.offerOptions.filter((o) => o?.iceRestart).length

// ── ICE restarts ──────────────────────────────────────────────────────────────

describe('WebRTCPeer — ICE restart', () => {
  it('restarts ICE when the connection stays disconnected', async () => {
    const { pc, offers } = await establishedPeer()
    pc.setState('disconnected')

    await advance(DISCONNECT_GRACE_MS - 1)
    expect(offers).toHaveLength(0)
    await advance(1)

    expect(pc.offerOptions).toEqual([{ iceRestart: true }])
    expect(offers).toHaveLength(1)
  })

  it('does nothing when the connection heals by itself', async () => {
    const { pc, offers } = await establishedPeer()
    pc.setState('disconnected')
    await advance(DISCONNECT_GRACE_MS / 2)
    pc.setState('connected')
    await advance(DISCONNECT_GRACE_MS * 2)

    expect(offers).toHaveLength(0)
  })

  it('restarts ICE at once when the connection fails, instead of closing the call', async () => {
    const { pc, closed } = await establishedPeer()
    pc.setState('failed')
    await advance(0)

    expect(restarts(pc)).toBe(1)
    expect(closed).not.toHaveBeenCalled()
    expect(pc.closed).toBe(false)
  })

  it('closes a connection that fails before it ever worked', async () => {
    const peer = new WebRTCPeer('p', true, stream(track('audio')), null, true, undefined, { quality: '1080p' })
    const closed = vi.fn()
    peer.addEventListener('closed', closed)
    await peer.init() // offer sent, never answered
    pcs[0].setState('failed')

    expect(closed).toHaveBeenCalledOnce()
  })

  it('tries again when the restart did not bring the connection back, and gives up after a few times', async () => {
    const { peer, pc, closed } = await establishedPeer()
    pc.setState('failed')
    await advance(0)
    expect(restarts(pc)).toBe(1)

    // The other side answers each restart, but the connection stays failed: one more try per RESTART_RETRY_MS
    for (let attempt = 2; attempt <= MAX_ICE_RESTARTS; attempt++) {
      await peer.handleAnswer({ type: 'answer', sdp: 'a' })
      await advance(RESTART_RETRY_MS)
      expect(restarts(pc)).toBe(attempt)
    }
    expect(closed).not.toHaveBeenCalled()
    await peer.handleAnswer({ type: 'answer', sdp: 'a' })
    await advance(RESTART_RETRY_MS)
    expect(closed).toHaveBeenCalledOnce()
    expect(restarts(pc)).toBe(MAX_ICE_RESTARTS)
  })

  it('sends its offer again when the restart got no answer (the signaling dropped with the network)', async () => {
    const { pc, offers } = await establishedPeer()
    pc.setState('failed')
    await advance(0)
    expect(offers).toHaveLength(1)

    await advance(RESTART_RETRY_MS) // still waiting for the answer
    expect(offers).toHaveLength(2)
    expect(offers[1]).toBe(offers[0])
    expect(restarts(pc)).toBe(1) // the same offer, not a new restart
  })

  it('gets all its tries back once the connection works again', async () => {
    const { pc, closed } = await establishedPeer()
    for (let i = 0; i < MAX_ICE_RESTARTS - 1; i++) {
      pc.setState('failed')
      await advance(0)
    }
    pc.setState('connected')
    await advance(0)

    for (let i = 0; i < MAX_ICE_RESTARTS; i++) {
      pc.setState('failed')
      await advance(0)
      pc.signalingState = 'stable'
    }
    expect(closed).not.toHaveBeenCalled()
  })

  it('does not close a connection that keeps working through the restart', async () => {
    const { peer, pc, closed } = await establishedPeer()
    expect(peer.requestIceRestart('test')).toBe(true)
    await advance(RESTART_RETRY_MS * 3)

    expect(closed).not.toHaveBeenCalled()
    expect(restarts(pc)).toBe(1)
  })

  it('waits for the connection to be idle, then sends the restart', async () => {
    const { peer, pc, offers } = await establishedPeer()
    pc.signalingState = 'have-remote-offer' // answering something right now

    peer.requestIceRestart('test')
    await advance(0)
    expect(offers).toHaveLength(0)

    pc.signalingState = 'have-local-offer'
    await peer.handleAnswer({ type: 'answer', sdp: 'a2' }) // the exchange ends, the restart goes out
    expect(offers).toHaveLength(1)
    expect(restarts(pc)).toBe(1)
  })

  it('asks for a restart only once per offer: the next offer is a normal one', async () => {
    const { peer, pc } = await establishedPeer()
    peer.requestIceRestart('test')
    await advance(0)
    pc.signalingState = 'stable'

    await peer.addScreenStream(stream(track('video')))
    expect(pc.offerOptions.map((o) => Boolean(o?.iceRestart))).toEqual([true, false])
  })

  it('cannot restart before the first exchange, or once closed', async () => {
    const fresh = new WebRTCPeer('p', true, stream(track('audio')), null, true, undefined, { quality: '1080p' })
    await fresh.init()
    expect(fresh.requestIceRestart()).toBe(false)

    const { peer } = await establishedPeer()
    peer.close()
    expect(peer.requestIceRestart()).toBe(false)
  })

  it('sends nothing after it is closed, even if timers and network events are pending', async () => {
    const { peer, pc, offers } = await establishedPeer()
    pc.setState('disconnected')
    window.dispatchEvent(new Event('online'))
    peer.close()

    await advance(RESTART_RETRY_MS * 3)
    window.dispatchEvent(new Event('online'))
    await advance(NETWORK_CHANGE_DEBOUNCE_MS * 2)

    expect(offers).toHaveLength(0)
  })
})

// ── Network changes ───────────────────────────────────────────────────────────

describe('WebRTCPeer — network changes', () => {
  it('restarts ICE when the device comes back online, even if the connection still looks fine', async () => {
    const { pc } = await establishedPeer()
    window.dispatchEvent(new Event('online'))

    await advance(NETWORK_CHANGE_DEBOUNCE_MS - 1)
    expect(restarts(pc)).toBe(0)
    await advance(1)
    expect(restarts(pc)).toBe(1)
  })

  it('acts once for a burst of changes', async () => {
    const { pc } = await establishedPeer()
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new Event('online'))
      await advance(NETWORK_CHANGE_DEBOUNCE_MS / 2)
    }
    await advance(NETWORK_CHANGE_DEBOUNCE_MS)

    expect(restarts(pc)).toBe(1)
  })

  describe('connection type (Network Information API)', () => {
    function fakeConnection(type) {
      const connection = Object.assign(new EventTarget(), { type })
      Object.defineProperty(navigator, 'connection', { value: connection, configurable: true })
      return connection
    }

    it('restarts ICE when the type changes, from Wi-Fi to cellular', async () => {
      const connection = fakeConnection('wifi')
      const { pc } = await establishedPeer()

      connection.type = 'cellular'
      connection.dispatchEvent(new Event('change'))
      await advance(NETWORK_CHANGE_DEBOUNCE_MS)

      expect(restarts(pc)).toBe(1)
    })

    it('ignores changes that are not a change of network (speed, signal)', async () => {
      const connection = fakeConnection('wifi')
      const { pc } = await establishedPeer()

      connection.dispatchEvent(new Event('change'))
      await advance(NETWORK_CHANGE_DEBOUNCE_MS * 2)

      expect(restarts(pc)).toBe(0)
    })

    it('ignores a browser that does not tell the type', async () => {
      const connection = fakeConnection(undefined)
      const { pc } = await establishedPeer()

      connection.dispatchEvent(new Event('change'))
      await advance(NETWORK_CHANGE_DEBOUNCE_MS * 2)

      expect(restarts(pc)).toBe(0)
    })

    it('stops listening once closed', async () => {
      const connection = fakeConnection('wifi')
      const { peer, pc } = await establishedPeer()
      peer.close()

      connection.type = 'cellular'
      connection.dispatchEvent(new Event('change'))
      await advance(NETWORK_CHANGE_DEBOUNCE_MS * 2)

      expect(restarts(pc)).toBe(0)
    })
  })
})

// ── Video quality ─────────────────────────────────────────────────────────────

describe('WebRTCPeer — what the camera sends', () => {
  const camera = (pc) => pc.senders.find((s) => s.track.kind === 'video')

  it('lets a direct connection send 60 fps with the "max" profile', async () => {
    const { pc } = await establishedPeer({ quality: 'max', videoSettings: { width: 3840, height: 2160 } })
    expect(camera(pc).params.encodings[0]).toEqual({
      maxFramerate: 60,
      maxBitrate: 25_000_000,
      scaleResolutionDownBy: 1,
    })
  })

  it('brings a connection through a TURN relay down to the 1080p profile', async () => {
    const peer = new WebRTCPeer(
      'p',
      true,
      stream(track('audio'), track('video', { width: 3840, height: 2160 })),
      null,
      true,
      undefined,
      {
        quality: 'max',
      }
    )
    await peer.init()
    pcs[0].route = { local: 'relay', remote: 'host' }
    await peer.handleAnswer({ type: 'answer', sdp: 'a' })
    pcs[0].setState('connected')
    await advance(0)

    expect(camera(pcs[0]).params.encodings[0]).toEqual({ maxFramerate: 25, scaleResolutionDownBy: 2 })
  })

  it('also falls back when only the other side relays', async () => {
    const peer = new WebRTCPeer('p', true, stream(track('audio'), track('video')), null, true, undefined, {
      quality: 'max',
    })
    await peer.init()
    pcs[0].route = { local: 'host', remote: 'relay' }
    await peer.handleAnswer({ type: 'answer', sdp: 'a' })
    pcs[0].setState('connected')
    await advance(0)

    expect(camera(pcs[0]).params.encodings[0].maxFramerate).toBe(25)
  })

  it('raises and lowers the limits when the route changes during the call', async () => {
    const { pc } = await establishedPeer({ quality: 'max' })
    expect(camera(pc).params.encodings[0].maxFramerate).toBe(60)

    pc.route = { local: 'relay', remote: 'host' } // the network changed, TURN is all that is left
    await advance(QUALITY_POLL_MS)
    expect(camera(pc).params.encodings[0].maxFramerate).toBe(25)

    pc.route = { local: 'host', remote: 'host' }
    await advance(QUALITY_POLL_MS)
    expect(camera(pc).params.encodings[0].maxFramerate).toBe(60)
  })

  it('does not touch the limits of the other profiles', async () => {
    for (const quality of ['480p', '720p', '1080p']) {
      pcs = []
      const { pc } = await establishedPeer({ quality })
      await advance(QUALITY_POLL_MS * 3)
      expect(camera(pc).setParameters).not.toHaveBeenCalled()
    }
  })

  it('does not ask the browser again when nothing changed', async () => {
    const { pc } = await establishedPeer({ quality: 'max' })
    const calls = camera(pc).setParameters.mock.calls.length
    await advance(QUALITY_POLL_MS * 4)
    expect(camera(pc).setParameters.mock.calls.length).toBe(calls)
  })

  it('does not limit the screen share', async () => {
    const { peer, pc } = await establishedPeer({ quality: 'max' })
    await peer.addScreenStream(stream(track('video')))
    await advance(QUALITY_POLL_MS * 2)
    const screen = pc.senders[2]
    expect(screen.setParameters).not.toHaveBeenCalled()
  })

  it('changes with the profile during the call', async () => {
    const { peer, pc } = await establishedPeer({ quality: '1080p' })
    peer.setQualityProfile('max')
    await advance(0)
    expect(camera(pc).params.encodings[0].maxFramerate).toBe(60)

    peer.setQualityProfile('720p')
    await advance(0)
    expect(camera(pc).params.encodings[0]).toEqual({})
  })

  it('follows a change of the quality setting made in the media module', async () => {
    const { pc } = await establishedPeer({ quality: '1080p' })
    media.listeners.forEach((cb) => cb('max'))
    await advance(0)
    expect(camera(pc).params.encodings[0].maxFramerate).toBe(60)
  })

  it('uses the quality setting of the user by default', async () => {
    localStorage.setItem('p2p-chat:video-quality', 'max')
    const peer = new WebRTCPeer('p', true, stream(track('audio'), track('video')))
    await peer.init()
    await peer.handleAnswer({ type: 'answer', sdp: 'a' })
    pcs[0].setState('connected')
    await advance(0)

    expect(camera(pcs[0]).params.encodings[0].maxFramerate).toBe(60)
  })

  it('works the limits out again for the new picture after switching camera', async () => {
    const { peer, pc } = await establishedPeer({ quality: 'max', videoSettings: { width: 1920, height: 1080 } })
    expect(camera(pc).params.encodings[0].maxBitrate).toBe(12_000_000)

    await peer.replaceVideoTrack(track('video', { width: 1280, height: 720 }))
    await advance(0)

    expect(camera(pc).params.encodings[0].maxBitrate).toBe(6_000_000)
  })

  it('stops checking the route and listening for changes once closed', async () => {
    const { peer, pc } = await establishedPeer({ quality: 'max' })
    peer.close()
    const calls = camera(pc).setParameters.mock.calls.length
    pc.route = { local: 'relay', remote: 'relay' }
    await advance(QUALITY_POLL_MS * 3)
    media.listeners.forEach((cb) => cb('720p'))

    expect(camera(pc).setParameters.mock.calls.length).toBe(calls)
    expect(media.listeners.size).toBe(0)
  })

  it('keeps the call going when the browser refuses the limits', async () => {
    const peer = new WebRTCPeer('p', true, stream(track('audio'), track('video')), null, true, undefined, {
      quality: 'max',
    })
    await peer.init()
    camera(pcs[0]).setParameters.mockRejectedValue(new Error('refused'))
    await peer.handleAnswer({ type: 'answer', sdp: 'a' })
    pcs[0].setState('connected')
    await advance(0)

    expect(pcs[0].closed).toBe(false)
  })
})

// ── Route in the console ──────────────────────────────────────────────────────

describe('WebRTCPeer — route in the console', () => {
  const routeLines = () => console.info.mock.calls.map((c) => c[0]).filter((m) => String(m).includes('route:'))

  it('says which pair carries the media once the connection has settled', async () => {
    const { pc } = await establishedPeer()
    pc.route = { local: 'relay', remote: 'host' }
    console.info.mockClear()

    pc.setState('connected')
    await advance(ROUTE_LOG_DELAY_MS - 1)
    expect(routeLines()).toHaveLength(0)
    await advance(1)

    expect(routeLines()).toHaveLength(1)
    expect(routeLines()[0]).toContain('relay<->host=succeeded*')
  })

  it('says nothing for a connection closed in the meantime', async () => {
    const { peer, pc } = await establishedPeer()
    console.info.mockClear()
    pc.setState('connected')
    peer.close()
    await advance(ROUTE_LOG_DELAY_MS * 2)

    expect(routeLines()).toHaveLength(0)
  })
})
