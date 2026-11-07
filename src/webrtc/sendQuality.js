/**
 * sendQuality.js
 * What a connection is allowed to send for a video quality profile.
 *
 * The "max" profile captures the best the camera can do (up to 4K at 60 fps). That only makes sense when the media
 * goes straight from one device to the other: through a TURN relay (which costs bandwidth and adds delay) a
 * connection falls back to what the "1080p" profile sends. Every other profile sends whatever the browser decides.
 */

export const MAX_PROFILE = 'max'

/** Frame rate of a direct connection with the "max" profile. */
export const DIRECT_FPS = 60
/** The 1080p profile: up to 1920×1080 at 25 fps (see QUALITY_CONSTRAINTS in media.js). */
export const FALLBACK_FPS = 25
export const FALLBACK_HEIGHT = 1080

// Upper bound of the bitrate on a direct connection, by the height of the picture; the browser still follows what
// the network allows. The defaults of the browsers are lower than what 60 fps at these sizes needs.
const DIRECT_BITRATE_BY_HEIGHT = [
  [720, 6_000_000],
  [1080, 12_000_000],
  [Infinity, 25_000_000],
]

/**
 * @param {string} profile  '480p' | '720p' | '1080p' | 'max'
 * @param {'direct'|'relayed'|'unknown'} route  How the media reaches the other side (unknown until measured)
 * @param {{ width?: number, height?: number }} [captured]  Size of the picture the camera delivers
 * @returns {{ maxFramerate: number, maxBitrate?: number, scaleResolutionDownBy: number } | null}
 *   The limits of the video encoding, or null for no limits (the browser's own).
 */
export function sendLimits(profile, route, captured = {}) {
  if (profile !== MAX_PROFILE) return null

  const height = Number(captured.height) || 0
  if (route === 'direct') {
    const [, maxBitrate] = DIRECT_BITRATE_BY_HEIGHT.find(([upTo]) => height <= upTo)
    return { maxFramerate: DIRECT_FPS, maxBitrate, scaleResolutionDownBy: 1 }
  }

  // Not known to be direct: stay on the safe side
  return {
    maxFramerate: FALLBACK_FPS,
    scaleResolutionDownBy: height > FALLBACK_HEIGHT ? height / FALLBACK_HEIGHT : 1,
  }
}

/**
 * Applies limits to a video sender (null clears them). Never throws: a browser that refuses keeps its defaults.
 * @param {RTCRtpSender} sender
 * @param {ReturnType<typeof sendLimits>} limits
 * @returns {Promise<boolean>} whether the parameters were applied
 */
export async function applySendLimits(sender, limits) {
  try {
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    const [encoding] = params.encodings
    for (const key of ['maxFramerate', 'maxBitrate', 'scaleResolutionDownBy']) {
      if (limits?.[key] != null) encoding[key] = limits[key]
      else delete encoding[key]
    }
    await sender.setParameters(params)
    return true
  } catch (err) {
    console.warn('[webrtc] could not set the video limits', err?.message ?? err)
    return false
  }
}
