/**
 * media.js
 * getUserMedia helpers and local stream management.
 *
 * Keeps a single shared local MediaStream reference so that multiple
 * RTCPeerConnections can attach the same tracks without re-requesting
 * camera/mic permissions.
 */

import { getVideoQuality } from '../p2p/storage.js'

const QUALITY_CONSTRAINTS = {
  '480p': {
    width: { ideal: 640, max: 640 },
    height: { ideal: 480, max: 480 },
    frameRate: { ideal: 20, max: 25 },
  },
  '720p': {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 20, max: 25 },
  },
  '1080p': {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 20, max: 25 },
  },
}

// "max": the biggest picture the camera has at (about) 60 fps. Sizes are tried from the top, each demanding a frame
// rate of at least 50, so a camera that does 4K at 30 fps but 1080p at 60 gives 1080p at 60. If none of them gives
// that, the biggest picture the camera has is taken, at the frame rate it can (up to 60).
const MAX_SIZES = [
  { width: { ideal: 3840 }, height: { ideal: 2160 } },
  { width: { ideal: 2560 }, height: { ideal: 1440 } },
  { width: { ideal: 1920 }, height: { ideal: 1080 } },
]
const MAX_CONSTRAINTS = [
  ...MAX_SIZES.map((size) => ({ ...size, frameRate: { min: 50, ideal: 60, max: 60 } })),
  { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60, max: 60 } },
]

/** Camera constraints to try for a quality, best first. */
function cameraConstraints(quality) {
  if (quality === 'max') return MAX_CONSTRAINTS
  return QUALITY_CONSTRAINTS[quality] ? [QUALITY_CONSTRAINTS[quality]] : []
}

const isOverconstrained = (err) => err?.name === 'OverconstrainedError' || err?.name === 'ConstraintNotSatisfiedError'

/** Runs `attempt` with each candidate until one is accepted by the camera; other failures are not retried. */
async function firstAccepted(candidates, attempt) {
  const list = candidates.length > 0 ? candidates : [{}]
  let lastError
  for (const constraints of list) {
    try {
      return await attempt(constraints)
    } catch (err) {
      if (!isOverconstrained(err)) throw err
      lastError = err
    }
  }
  throw lastError
}

/** "max" favours smoothness over sharpness when the encoder has to choose. */
function setContentHint(track, quality) {
  try {
    track.contentHint = quality === 'max' ? 'motion' : ''
  } catch {
    // not supported
  }
}

const qualityListeners = new Set()

/**
 * Calls back when the video quality is changed during a call (so connections can adjust what they send).
 * @param {(quality: string) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onVideoQualityChange(callback) {
  qualityListeners.add(callback)
  return () => qualityListeners.delete(callback)
}

let _localStream = null
let _currentFacingMode = 'user'
let _screenTrack = null
let _screenStream = null
let _missing = { camera: false, microphone: false }

/** A device that is not there, or that cannot be opened now (in use by another app, switched off). */
const isUnavailable = (err) =>
  ['NotFoundError', 'DevicesNotFoundError', 'NotReadableError', 'TrackStartError'].includes(err?.name)

/**
 * What the last stream could not get: a device that is not there (or is busy) does not stop the call, the
 * person joins with the rest.
 * @returns {{ camera: boolean, microphone: boolean }}
 */
export function getMissingDevices() {
  return { ..._missing }
}

/**
 * Camera and microphone one at a time, for when asking for both failed because one of them is missing.
 * Whatever can be opened is kept; with nothing at all the stream is empty (the call can still be watched).
 * Any other error (permission denied...) is not about a missing device and is thrown.
 */
async function openWhatIsThere({ video, audio }, quality, audioConstraints) {
  const tracks = []
  const errors = []
  const attempt = async (kind, open) => {
    try {
      tracks.push(...(await open()).getTracks())
    } catch (err) {
      errors.push(err)
      _missing[kind] = true
    }
  }
  if (video) {
    await attempt('camera', () =>
      firstAccepted(cameraConstraints(quality), (constraints) =>
        navigator.mediaDevices.getUserMedia({ audio: false, video: { ...constraints, facingMode: 'user' } })
      )
    )
  }
  if (audio) {
    await attempt('microphone', () => navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false }))
  }
  const other = errors.find((err) => !isUnavailable(err))
  if (other) {
    tracks.forEach((track) => track.stop())
    throw other
  }
  return new MediaStream(tracks)
}

/**
 * Request camera and/or microphone access.
 * Returns the existing stream if already acquired.
 * If the camera or the microphone is missing the stream has what is left, down to nothing (see getMissingDevices).
 * @param {{ video?: boolean, audio?: boolean }} constraints
 * @returns {Promise<MediaStream>}
 */
export async function getLocalStream({ video = true, audio = true } = {}) {
  if (_localStream) return _localStream
  const quality = getVideoQuality()
  _currentFacingMode = 'user'
  _missing = { camera: false, microphone: false }
  const audioConstraints = audio ? { echoCancellation: true, noiseSuppression: true } : false
  let stream
  try {
    stream = video
      ? await firstAccepted(cameraConstraints(quality), (constraints) =>
          navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: { ...constraints, facingMode: 'user' },
          })
        )
      : await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false })
  } catch (err) {
    if (!isUnavailable(err)) throw err
    stream = await openWhatIsThere({ video, audio }, quality, audioConstraints)
  }
  stream.getVideoTracks().forEach((track) => setContentHint(track, quality))
  _localStream = stream
  return _localStream
}

/** The camera after the one in use (cycling), for phones that do not say which camera faces which way. */
async function nextCameraId(currentId) {
  const devices = (await navigator.mediaDevices.enumerateDevices?.()) ?? []
  const cameras = devices.filter((d) => d.kind === 'videoinput' && d.deviceId)
  if (cameras.length < 2) return null
  const index = cameras.findIndex((d) => d.deviceId === currentId)
  return cameras[(index + 1) % cameras.length].deviceId
}

/**
 * Switch between front and back camera (mobile).
 *
 * The camera in use is released first: many phones cannot open a second camera while one is open, which made the
 * switch fail. Then the other camera is asked for by the way it faces, and, for phones that do not report that (or
 * give the same camera again), by moving on to the next camera of the device. If no other camera can be opened, the
 * one we had is opened again so the call keeps its picture (`switched` is false then).
 * @returns {Promise<{ stream: MediaStream, videoTrack: MediaStreamTrack, switched: boolean } | null>}
 */
export async function switchCamera() {
  if (!_localStream) return null
  const quality = getVideoQuality()
  const candidates = cameraConstraints(quality)
  const open = (video) =>
    firstAccepted(candidates, (constraints) =>
      navigator.mediaDevices.getUserMedia({ video: { ...constraints, ...video }, audio: false })
    )

  const oldTracks = _localStream.getVideoTracks()
  const currentId = oldTracks[0]?.getSettings?.()?.deviceId
  const nextFacing = _currentFacingMode === 'user' ? 'environment' : 'user'
  oldTracks.forEach((t) => t.stop())

  const attempts = [
    () => open({ facingMode: { exact: nextFacing } }),
    () => open({ facingMode: nextFacing }),
    async () => {
      const id = await nextCameraId(currentId)
      if (!id) throw new Error('no other camera')
      return open({ deviceId: { exact: id } })
    },
  ]

  let newStream = null
  for (const attempt of attempts) {
    try {
      const stream = await attempt()
      // Asking for a facing mode may just give the same camera again: that is not a switch
      if (!currentId || stream.getVideoTracks()[0]?.getSettings?.()?.deviceId !== currentId) {
        newStream = stream
        break
      }
      stream.getTracks().forEach((t) => t.stop())
    } catch {
      // try the next way
    }
  }

  const switched = newStream !== null
  if (!switched) {
    console.warn('[media] no other camera could be opened, keeping the current one')
    try {
      newStream = await open(currentId ? { deviceId: { exact: currentId } } : { facingMode: _currentFacingMode })
    } catch (err) {
      console.warn('[media] could not reopen the camera:', err)
      return null
    }
  }

  const [newVideoTrack] = newStream.getVideoTracks()
  if (!newVideoTrack) return null
  setContentHint(newVideoTrack, quality)

  const audioTracks = _localStream.getAudioTracks()
  _localStream = new MediaStream([newVideoTrack, ...audioTracks])
  if (switched) _currentFacingMode = newVideoTrack.getSettings?.()?.facingMode || nextFacing

  return { stream: _localStream, videoTrack: newVideoTrack, switched }
}

/**
 * Apply new video quality constraints to the active stream (mid-call).
 * @param {string} quality '480p' | '720p' | '1080p' | 'max'
 */
export async function applyVideoQuality(quality) {
  const candidates = cameraConstraints(quality)
  if (candidates.length === 0 || !_localStream) return
  for (const track of _localStream.getVideoTracks()) {
    await firstAccepted(candidates, (constraints) => track.applyConstraints(constraints)).catch(() => {})
    setContentHint(track, quality)
  }
  qualityListeners.forEach((callback) => callback(quality))
}

/** Pause all video tracks (reduces GPU/camera usage when backgrounded). */
export function pauseVideoTracks() {
  _localStream?.getVideoTracks().forEach((t) => {
    t.enabled = false
  })
}

/** Resume video tracks. Returns true if tracks are alive, false if they need restart. */
export function resumeVideoTracks() {
  if (!_localStream) return false
  // A call joined without camera or microphone has nothing that the system could take away
  if (_localStream.getTracks().length === 0) return true
  const videoTracks = _localStream.getVideoTracks()
  // If there are no video tracks (video muted) we use the audio tracks to
  // determine whether the stream is still alive.
  const tracksToCheck = videoTracks.length > 0 ? videoTracks : _localStream.getAudioTracks()
  if (tracksToCheck.length === 0) return false
  const allAlive = tracksToCheck.every((t) => t.readyState === 'live')
  if (allAlive) {
    videoTracks.forEach((t) => {
      t.enabled = true
    })
    return true
  }
  // Tracks were killed by the OS — caller must restart the stream
  _localStream = null
  return false
}

/**
 * Stop all tracks and clear the local stream reference.
 * Call this when the user ends the call or leaves the room.
 */
export function stopLocalStream() {
  stopScreenShare()
  if (_localStream) {
    _localStream.getTracks().forEach((track) => track.stop())
    _localStream = null
  }
  _missing = { camera: false, microphone: false }
}

/**
 * Returns the current local stream without requesting access.
 * @returns {MediaStream | null}
 */
export function getActiveLocalStream() {
  return _localStream
}

/**
 * Mute or unmute the local audio track.
 * @param {boolean} muted
 */
export function setAudioMuted(muted) {
  _localStream?.getAudioTracks().forEach((t) => {
    t.enabled = !muted
  })
}

/**
 * Mute or unmute the local video track.
 * @param {boolean} muted
 */
export function setVideoMuted(muted) {
  _localStream?.getVideoTracks().forEach((t) => {
    t.enabled = !muted
  })
}

/**
 * Start screen sharing. The screen is captured as a separate video-only stream
 * so the camera + microphone stream keeps running untouched.
 * The browser's native picker lets the user choose window or full screen.
 * @returns {Promise<{ stream: MediaStream, screenTrack: MediaStreamTrack } | null>}
 */
export async function startScreenShare() {
  if (!_localStream) return null
  if (_screenStream) return { stream: _screenStream, screenTrack: _screenTrack }

  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: 1920, height: 1080, frameRate: 30 },
    audio: false,
  })
  const [screenTrack] = screenStream.getVideoTracks()
  if (!screenTrack) return null

  _screenStream = screenStream
  _screenTrack = screenTrack

  return { stream: screenStream, screenTrack }
}

/** Stop screen sharing. The camera stream is unaffected. */
export function stopScreenShare() {
  _screenTrack?.stop()
  _screenTrack = null
  _screenStream = null
}

/**
 * Returns the active screen-share stream, if any.
 * @returns {MediaStream | null}
 */
export function getActiveScreenStream() {
  return _screenStream
}

/** Returns true if screen sharing is currently active. */
export function isScreenSharing() {
  return _screenTrack !== null
}
