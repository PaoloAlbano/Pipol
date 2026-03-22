/**
 * media.test.js
 * Tests the local stream management utilities: mute, stop, screen share.
 *
 * navigator.mediaDevices is replaced with a fake that returns
 * streams/tracks controllable by the test.
 */

// ── Helpers to build fake stream/track ────────────────────────────────────────

function makeFakeTrack(kind = 'audio') {
  return {
    kind,
    enabled: true,
    readyState: 'live',
    stop: vi.fn(),
    addEventListener: vi.fn(),
  }
}

function makeFakeStream(tracks = []) {
  const all = [...tracks]
  return {
    getTracks: () => all,
    getAudioTracks: () => all.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => all.filter((t) => t.kind === 'video'),
  }
}

// ── Setup: mock mediaDevices + reset module between tests ─────────────────────

let media
let fakeAudioTrack, fakeVideoTrack, fakeStream

beforeEach(async () => {
  fakeAudioTrack = makeFakeTrack('audio')
  fakeVideoTrack = makeFakeTrack('video')
  fakeStream = makeFakeStream([fakeAudioTrack, fakeVideoTrack])

  // Mock getUserMedia
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(fakeStream),
      getDisplayMedia: vi.fn().mockResolvedValue(makeFakeStream([makeFakeTrack('video')])),
    },
  })

  vi.resetModules()
  media = await import('../../src/webrtc/media.js')
})

// ── getLocalStream ─────────────────────────────────────────────────────────────

describe('getLocalStream', () => {
  it('richiede accesso a camera e microfono', async () => {
    await media.getLocalStream()
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce()
  })

  it('restituisce sempre lo stesso stream (singleton)', async () => {
    const s1 = await media.getLocalStream()
    const s2 = await media.getLocalStream()
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce()
    expect(s1).toBe(s2)
  })

  it('getActiveLocalStream restituisce null prima di getLocalStream', () => {
    expect(media.getActiveLocalStream()).toBeNull()
  })

  it('getActiveLocalStream restituisce lo stream dopo getLocalStream', async () => {
    await media.getLocalStream()
    expect(media.getActiveLocalStream()).toBe(fakeStream)
  })
})

// ── setAudioMuted ──────────────────────────────────────────────────────────────

describe('setAudioMuted', () => {
  it('disabilita le tracce audio quando muted=true', async () => {
    await media.getLocalStream()
    media.setAudioMuted(true)
    expect(fakeAudioTrack.enabled).toBe(false)
  })

  it('riabilita le tracce audio quando muted=false', async () => {
    await media.getLocalStream()
    media.setAudioMuted(true)
    media.setAudioMuted(false)
    expect(fakeAudioTrack.enabled).toBe(true)
  })

  it('non tocca le tracce video', async () => {
    await media.getLocalStream()
    media.setAudioMuted(true)
    expect(fakeVideoTrack.enabled).toBe(true)
  })

  it('non lancia errori se chiamato senza stream attivo', () => {
    expect(() => media.setAudioMuted(true)).not.toThrow()
  })
})

// ── setVideoMuted ──────────────────────────────────────────────────────────────

describe('setVideoMuted', () => {
  it('disabilita le tracce video quando muted=true', async () => {
    await media.getLocalStream()
    media.setVideoMuted(true)
    expect(fakeVideoTrack.enabled).toBe(false)
  })

  it('riabilita le tracce video quando muted=false', async () => {
    await media.getLocalStream()
    media.setVideoMuted(true)
    media.setVideoMuted(false)
    expect(fakeVideoTrack.enabled).toBe(true)
  })

  it('non tocca le tracce audio', async () => {
    await media.getLocalStream()
    media.setVideoMuted(true)
    expect(fakeAudioTrack.enabled).toBe(true)
  })
})

// ── stopLocalStream ────────────────────────────────────────────────────────────

describe('stopLocalStream', () => {
  it('chiama stop() su tutte le tracce', async () => {
    await media.getLocalStream()
    media.stopLocalStream()
    expect(fakeAudioTrack.stop).toHaveBeenCalledOnce()
    expect(fakeVideoTrack.stop).toHaveBeenCalledOnce()
  })

  it('azzera il riferimento allo stream', async () => {
    await media.getLocalStream()
    media.stopLocalStream()
    expect(media.getActiveLocalStream()).toBeNull()
  })

  it('è idempotente (non lancia se chiamato due volte)', async () => {
    await media.getLocalStream()
    media.stopLocalStream()
    expect(() => media.stopLocalStream()).not.toThrow()
  })
})

// ── pauseVideoTracks / resumeVideoTracks ───────────────────────────────────────

describe('pauseVideoTracks / resumeVideoTracks', () => {
  it('pause disabilita le tracce video', async () => {
    await media.getLocalStream()
    media.pauseVideoTracks()
    expect(fakeVideoTrack.enabled).toBe(false)
  })

  it('resume riabilita le tracce video vive', async () => {
    await media.getLocalStream()
    media.pauseVideoTracks()
    const alive = media.resumeVideoTracks()
    expect(alive).toBe(true)
    expect(fakeVideoTrack.enabled).toBe(true)
  })

  it('resume restituisce false e azzera stream se le tracce sono morte', async () => {
    fakeVideoTrack.readyState = 'ended'
    await media.getLocalStream()
    const alive = media.resumeVideoTracks()
    expect(alive).toBe(false)
    expect(media.getActiveLocalStream()).toBeNull()
  })

  it('resumeVideoTracks restituisce false senza stream attivo', () => {
    expect(media.resumeVideoTracks()).toBe(false)
  })
})

// ── startScreenShare ───────────────────────────────────────────────────────────

describe('startScreenShare', () => {
  it("restituisce null se non c'è uno stream locale attivo", async () => {
    const result = await media.startScreenShare()
    expect(result).toBeNull()
  })

  it('chiama getDisplayMedia dopo getLocalStream', async () => {
    await media.getLocalStream()
    await media.startScreenShare()
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledOnce()
  })

  it('restituisce stream e screenTrack', async () => {
    await media.getLocalStream()
    const result = await media.startScreenShare()
    expect(result).toHaveProperty('stream')
    expect(result).toHaveProperty('screenTrack')
  })

  it('isScreenSharing è true dopo startScreenShare', async () => {
    await media.getLocalStream()
    await media.startScreenShare()
    expect(media.isScreenSharing()).toBe(true)
  })
})

// ── stopScreenShare ────────────────────────────────────────────────────────────

describe('stopScreenShare', () => {
  it('restituisce null se non si sta condividendo', async () => {
    const result = await media.stopScreenShare()
    expect(result).toBeNull()
  })

  it('isScreenSharing torna false dopo stopScreenShare', async () => {
    await media.getLocalStream()
    await media.startScreenShare()
    await media.stopScreenShare()
    expect(media.isScreenSharing()).toBe(false)
  })
})
