/**
 * sendQuality.test.js
 * What a connection may send for each quality profile.
 */

import { DIRECT_FPS, FALLBACK_FPS, MAX_PROFILE, sendLimits, applySendLimits } from '../../src/webrtc/sendQuality.js'

describe('sendLimits', () => {
  it.each(['480p', '720p', '1080p'])('puts no limits on the %s profile, whatever the route', (profile) => {
    for (const route of ['direct', 'relayed', 'unknown']) {
      expect(sendLimits(profile, route, { height: 2160 })).toBeNull()
    }
  })

  it('lets a direct connection send 60 fps with a bitrate that suits the picture', () => {
    expect(sendLimits(MAX_PROFILE, 'direct', { width: 1280, height: 720 })).toEqual({
      maxFramerate: DIRECT_FPS,
      maxBitrate: 6_000_000,
      scaleResolutionDownBy: 1,
    })
    expect(sendLimits(MAX_PROFILE, 'direct', { width: 1920, height: 1080 }).maxBitrate).toBe(12_000_000)
    expect(sendLimits(MAX_PROFILE, 'direct', { width: 3840, height: 2160 })).toEqual({
      maxFramerate: 60,
      maxBitrate: 25_000_000,
      scaleResolutionDownBy: 1,
    })
  })

  it('brings a relayed connection down to the 1080p profile: 25 fps and at most 1080 lines', () => {
    const limits = sendLimits(MAX_PROFILE, 'relayed', { width: 3840, height: 2160 })
    expect(limits).toEqual({ maxFramerate: FALLBACK_FPS, scaleResolutionDownBy: 2 })
    expect(limits.maxBitrate).toBeUndefined()
  })

  it('scales a 1440p picture to 1080 lines, and leaves a smaller one alone', () => {
    expect(sendLimits(MAX_PROFILE, 'relayed', { height: 1440 }).scaleResolutionDownBy).toBeCloseTo(4 / 3)
    expect(sendLimits(MAX_PROFILE, 'relayed', { height: 1080 }).scaleResolutionDownBy).toBe(1)
    expect(sendLimits(MAX_PROFILE, 'relayed', { height: 720 }).scaleResolutionDownBy).toBe(1)
  })

  it('stays on the safe side while the route is not known yet', () => {
    expect(sendLimits(MAX_PROFILE, 'unknown', { height: 2160 })).toEqual(
      sendLimits(MAX_PROFILE, 'relayed', { height: 2160 })
    )
  })

  it('copes with a camera that has not reported its size', () => {
    expect(sendLimits(MAX_PROFILE, 'relayed', {})).toEqual({ maxFramerate: 25, scaleResolutionDownBy: 1 })
    expect(sendLimits(MAX_PROFILE, 'relayed')).toEqual({ maxFramerate: 25, scaleResolutionDownBy: 1 })
    expect(sendLimits(MAX_PROFILE, 'direct').maxFramerate).toBe(60)
  })
})

describe('applySendLimits', () => {
  function fakeSender(encodings) {
    const sender = {
      params: { encodings },
      getParameters: () => sender.params,
      setParameters: vi.fn(async (p) => {
        sender.params = p
      }),
    }
    return sender
  }

  it('sets the limits on the first encoding', async () => {
    const sender = fakeSender([{ active: true }])
    expect(await applySendLimits(sender, { maxFramerate: 60, maxBitrate: 1, scaleResolutionDownBy: 1 })).toBe(true)
    expect(sender.params.encodings[0]).toEqual({
      active: true,
      maxFramerate: 60,
      maxBitrate: 1,
      scaleResolutionDownBy: 1,
    })
  })

  it('removes limits that no longer apply, and all of them for null', async () => {
    const sender = fakeSender([{ maxFramerate: 60, maxBitrate: 1, scaleResolutionDownBy: 2 }])
    await applySendLimits(sender, { maxFramerate: 25, scaleResolutionDownBy: 2 })
    expect(sender.params.encodings[0]).toEqual({ maxFramerate: 25, scaleResolutionDownBy: 2 })
    await applySendLimits(sender, null)
    expect(sender.params.encodings[0]).toEqual({})
  })

  it('creates the encoding when the browser has none yet', async () => {
    const sender = fakeSender([])
    await applySendLimits(sender, { maxFramerate: 25, scaleResolutionDownBy: 1 })
    expect(sender.params.encodings).toEqual([{ maxFramerate: 25, scaleResolutionDownBy: 1 }])
  })

  it('does not throw when the browser refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = fakeSender([{}])
    sender.setParameters.mockRejectedValue(new Error('InvalidModificationError'))
    expect(await applySendLimits(sender, { maxFramerate: 25, scaleResolutionDownBy: 1 })).toBe(false)
  })
})
