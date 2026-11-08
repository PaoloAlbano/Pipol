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
  it('does nothing when not sharing', () => {
    expect(() => media.stopScreenShare()).not.toThrow()
    expect(media.isScreenSharing()).toBe(false)
  })

  it('isScreenSharing torna false dopo stopScreenShare', async () => {
    await media.getLocalStream()
    await media.startScreenShare()
    media.stopScreenShare()
    expect(media.isScreenSharing()).toBe(false)
  })

  it('stops the screen track on stopScreenShare', async () => {
    await media.getLocalStream()
    const { screenTrack } = await media.startScreenShare()
    media.stopScreenShare()
    expect(screenTrack.stop).toHaveBeenCalled()
    expect(media.getActiveScreenStream()).toBeNull()
  })
})

describe('screen share alongside the camera', () => {
  it('keeps the camera stream and tracks untouched while sharing', async () => {
    const local = await media.getLocalStream()
    await media.startScreenShare()
    expect(media.getActiveLocalStream()).toBe(local)
    expect(fakeVideoTrack.stop).not.toHaveBeenCalled()
  })

  it('exposes the screen as a separate stream', async () => {
    const local = await media.getLocalStream()
    const { stream } = await media.startScreenShare()
    expect(stream).not.toBe(local)
    expect(media.getActiveScreenStream()).toBe(stream)
  })

  it('setVideoMuted only affects the camera while sharing', async () => {
    await media.getLocalStream()
    const { screenTrack } = await media.startScreenShare()
    media.setVideoMuted(true)
    expect(fakeVideoTrack.enabled).toBe(false)
    expect(screenTrack.enabled).toBe(true)
  })

  it('stopLocalStream also stops the screen share', async () => {
    await media.getLocalStream()
    const { screenTrack } = await media.startScreenShare()
    media.stopLocalStream()
    expect(screenTrack.stop).toHaveBeenCalled()
    expect(media.isScreenSharing()).toBe(false)
  })
})

// ── "max" video quality ───────────────────────────────────────────────────────

describe('"max" video quality', () => {
  const overconstrained = () => Object.assign(new Error('no such mode'), { name: 'OverconstrainedError' })
  const videoOf = (call) => call[0].video

  beforeEach(() => {
    localStorage.setItem('p2p-chat:video-quality', 'max')
  })
  afterEach(() => localStorage.removeItem('p2p-chat:video-quality'))

  it('asks first for the biggest picture at 60 fps (at least 50)', async () => {
    await media.getLocalStream()
    const [first] = navigator.mediaDevices.getUserMedia.mock.calls
    expect(videoOf(first)).toMatchObject({
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { min: 50, ideal: 60, max: 60 },
      facingMode: 'user',
    })
  })

  it('goes down to a smaller picture that the camera can do at 60 fps', async () => {
    navigator.mediaDevices.getUserMedia
      .mockRejectedValueOnce(overconstrained())
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(fakeStream)
    await media.getLocalStream()

    const heights = navigator.mediaDevices.getUserMedia.mock.calls.map((c) => videoOf(c).height.ideal)
    expect(heights).toEqual([2160, 1440, 1080])
    expect(media.getActiveLocalStream()).toBe(fakeStream)
  })

  it('takes the biggest picture the camera has when it cannot do 60 fps at any size', async () => {
    navigator.mediaDevices.getUserMedia
      .mockRejectedValueOnce(overconstrained())
      .mockRejectedValueOnce(overconstrained())
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(fakeStream)
    await media.getLocalStream()

    const last = videoOf(navigator.mediaDevices.getUserMedia.mock.calls.at(-1))
    expect(last.frameRate).toEqual({ ideal: 60, max: 60 })
    expect(last.height).toEqual({ ideal: 2160 })
    expect(media.getActiveLocalStream()).toBe(fakeStream)
  })

  it('does not go on asking when the failure is not about the constraints (permission denied)', async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
    await expect(media.getLocalStream()).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce()
  })

  it('tells the encoder to favour smoothness (motion)', async () => {
    await media.getLocalStream()
    expect(fakeVideoTrack.contentHint).toBe('motion')
  })

  it('does not set that hint for the other qualities', async () => {
    localStorage.setItem('p2p-chat:video-quality', '1080p')
    await media.getLocalStream()
    expect(fakeVideoTrack.contentHint).toBe('')
  })

  it('applies "max" to the running camera during a call, going down the sizes as needed', async () => {
    await media.getLocalStream()
    fakeVideoTrack.applyConstraints = vi.fn().mockRejectedValueOnce(overconstrained()).mockResolvedValue(undefined)

    await media.applyVideoQuality('max')

    expect(fakeVideoTrack.applyConstraints).toHaveBeenCalledTimes(2)
    expect(fakeVideoTrack.applyConstraints.mock.calls[1][0].height.ideal).toBe(1440)
    expect(fakeVideoTrack.contentHint).toBe('motion')
  })

  it('goes back to a normal profile during a call', async () => {
    await media.getLocalStream()
    fakeVideoTrack.applyConstraints = vi.fn().mockResolvedValue(undefined)

    await media.applyVideoQuality('720p')

    expect(fakeVideoTrack.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({ height: { ideal: 720, max: 720 } })
    )
    expect(fakeVideoTrack.contentHint).toBe('')
  })

  it('lets the connections know about a change of quality, until they stop listening', async () => {
    await media.getLocalStream()
    fakeVideoTrack.applyConstraints = vi.fn().mockResolvedValue(undefined)
    const seen = vi.fn()
    const stop = media.onVideoQualityChange(seen)

    await media.applyVideoQuality('720p')
    expect(seen).toHaveBeenCalledWith('720p')

    stop()
    await media.applyVideoQuality('max')
    expect(seen).toHaveBeenCalledOnce()
  })

  it('keeps going when the camera refuses every size', async () => {
    await media.getLocalStream()
    fakeVideoTrack.applyConstraints = vi.fn().mockRejectedValue(overconstrained())
    await expect(media.applyVideoQuality('max')).resolves.toBeUndefined()
  })

  it('uses the same sizes when switching camera', async () => {
    await media.getLocalStream()
    const newTrack = makeFakeTrack('video')
    navigator.mediaDevices.getUserMedia.mockClear()
    navigator.mediaDevices.getUserMedia
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(makeFakeStream([newTrack]))

    const result = await media.switchCamera()

    expect(result.videoTrack).toBe(newTrack)
    const calls = navigator.mediaDevices.getUserMedia.mock.calls.map((c) => videoOf(c).height.ideal)
    expect(calls).toEqual([2160, 1440])
    expect(newTrack.contentHint).toBe('motion')
  })
})

// ── switching camera ──────────────────────────────────────────────────────────

describe('switchCamera', () => {
  const overconstrained = () => Object.assign(new Error('no such camera'), { name: 'OverconstrainedError' })

  function camera(deviceId, facingMode) {
    const track = makeFakeTrack('video')
    track.getSettings = () => ({ deviceId, ...(facingMode ? { facingMode } : {}) })
    return track
  }
  const streamOf = (track) => makeFakeStream([track])
  const gUM = () => navigator.mediaDevices.getUserMedia
  const facingOf = (call) => call[0].video.facingMode

  let front, back, mic

  /** Starts with the front camera, as a phone does. */
  async function startWithFront() {
    front = camera('front-id', 'user')
    back = camera('back-id', 'environment')
    mic = makeFakeTrack('audio')
    gUM().mockReset()
    gUM().mockResolvedValueOnce(makeFakeStream([mic, front]))
    await media.getLocalStream()
    gUM().mockReset()
    navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'videoinput', deviceId: 'front-id' },
      { kind: 'videoinput', deviceId: 'back-id' },
      { kind: 'audioinput', deviceId: 'mic-id' },
    ])
  }

  it('does nothing without a running stream', async () => {
    expect(await media.switchCamera()).toBeNull()
  })

  it('lets go of the current camera before opening the other (many phones cannot open two)', async () => {
    await startWithFront()
    gUM().mockResolvedValue(streamOf(back))

    await media.switchCamera()

    expect(front.stop).toHaveBeenCalled()
    expect(front.stop.mock.invocationCallOrder[0]).toBeLessThan(gUM().mock.invocationCallOrder[0])
  })

  it('opens the camera that faces the other way and keeps the microphone', async () => {
    await startWithFront()
    gUM().mockResolvedValue(streamOf(back))

    const result = await media.switchCamera()

    expect(facingOf(gUM().mock.calls[0])).toEqual({ exact: 'environment' })
    expect(result).toMatchObject({ videoTrack: back, switched: true })
    expect(result.stream.getTracks()).toEqual([back, mic])
    expect(media.getActiveLocalStream()).toBe(result.stream)
  })

  it('goes back to the front camera on the next switch', async () => {
    await startWithFront()
    gUM().mockResolvedValueOnce(streamOf(back))
    await media.switchCamera()

    gUM().mockResolvedValueOnce(streamOf(camera('front-id', 'user')))
    await media.switchCamera()

    expect(facingOf(gUM().mock.calls[1])).toEqual({ exact: 'user' })
  })

  it('asks again without "exact" when the phone refuses it', async () => {
    await startWithFront()
    gUM().mockRejectedValueOnce(overconstrained()).mockResolvedValueOnce(streamOf(back))

    const result = await media.switchCamera()

    expect(facingOf(gUM().mock.calls[1])).toBe('environment')
    expect(result.switched).toBe(true)
  })

  it('moves on to the next camera of the device when the facing mode just gives the same one', async () => {
    await startWithFront()
    gUM()
      .mockResolvedValueOnce(streamOf(camera('front-id', 'user'))) // "exact environment" gives the front again
      .mockResolvedValueOnce(streamOf(camera('front-id', 'user'))) // and so does the plain request
      .mockResolvedValueOnce(streamOf(back))

    const result = await media.switchCamera()

    expect(gUM().mock.calls[2][0].video.deviceId).toEqual({ exact: 'back-id' })
    expect(result).toMatchObject({ videoTrack: back, switched: true })
  })

  it('stops the pictures it did not use', async () => {
    await startWithFront()
    const sameAgain = camera('front-id', 'user')
    gUM().mockResolvedValueOnce(streamOf(sameAgain)).mockResolvedValueOnce(streamOf(sameAgain))
    gUM().mockResolvedValueOnce(streamOf(back))

    await media.switchCamera()

    expect(sameAgain.stop).toHaveBeenCalled()
  })

  it('opens the camera it had again when no other can be opened, so the call keeps its picture', async () => {
    await startWithFront()
    navigator.mediaDevices.enumerateDevices.mockResolvedValue([{ kind: 'videoinput', deviceId: 'front-id' }])
    const again = camera('front-id', 'user')
    gUM()
      .mockRejectedValueOnce(overconstrained())
      .mockRejectedValueOnce(overconstrained())
      .mockResolvedValueOnce(streamOf(again))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await media.switchCamera()

    expect(result).toMatchObject({ videoTrack: again, switched: false })
    expect(gUM().mock.calls.at(-1)[0].video.deviceId).toEqual({ exact: 'front-id' })
    expect(media.getActiveLocalStream().getTracks()).toEqual([again, mic])
  })

  it('gives up when even the old camera cannot be reopened', async () => {
    await startWithFront()
    navigator.mediaDevices.enumerateDevices.mockResolvedValue([])
    gUM().mockRejectedValue(overconstrained())
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await media.switchCamera()).toBeNull()
  })

  it('keeps the facing it reports, not the one it asked for', async () => {
    await startWithFront()
    // The phone answers "environment" with a camera that says it faces the user (a wrongly labelled device)
    gUM().mockResolvedValueOnce(streamOf(camera('other-id', 'user')))
    await media.switchCamera()

    gUM().mockResolvedValueOnce(streamOf(camera('third-id', 'environment')))
    await media.switchCamera()

    expect(facingOf(gUM().mock.calls[1])).toEqual({ exact: 'environment' })
  })
})
