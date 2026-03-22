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

let _localStream = null
let _currentFacingMode = 'user'
let _screenTrack = null

/**
 * Request camera and/or microphone access.
 * Returns the existing stream if already acquired.
 * @param {{ video?: boolean, audio?: boolean }} constraints
 * @returns {Promise<MediaStream>}
 */
export async function getLocalStream({ video = true, audio = true } = {}) {
  if (_localStream) return _localStream
  const quality = getVideoQuality()
  _currentFacingMode = 'user'
  _localStream = await navigator.mediaDevices.getUserMedia({
    audio: audio ? { echoCancellation: true, noiseSuppression: true } : false,
    video: video ? { ...QUALITY_CONSTRAINTS[quality], facingMode: 'user' } : false,
  })
  return _localStream
}

/**
 * Switch between front and back camera (mobile).
 * Stops the current video track and requests the opposite facingMode.
 * @returns {Promise<{ stream: MediaStream, videoTrack: MediaStreamTrack } | null>}
 */
export async function switchCamera() {
  if (!_localStream) return null
  const nextFacing = _currentFacingMode === 'user' ? 'environment' : 'user'
  const quality = getVideoQuality()
  const videoConstraints = { ...QUALITY_CONSTRAINTS[quality] }

  let newStream
  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      video: { ...videoConstraints, facingMode: { exact: nextFacing } },
      audio: false,
    })
  } catch {
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: { ...videoConstraints, facingMode: nextFacing },
        audio: false,
      })
    } catch (err) {
      console.warn('[media] switchCamera failed:', err)
      return null
    }
  }

  const [newVideoTrack] = newStream.getVideoTracks()
  if (!newVideoTrack) return null

  _localStream.getVideoTracks().forEach((t) => t.stop())
  const audioTracks = _localStream.getAudioTracks()
  _localStream = new MediaStream([newVideoTrack, ...audioTracks])
  _currentFacingMode = nextFacing

  return { stream: _localStream, videoTrack: newVideoTrack }
}

/**
 * Apply new video quality constraints to the active stream (mid-call).
 * @param {string} quality '480p' | '720p' | '1080p'
 */
export async function applyVideoQuality(quality) {
  const constraints = QUALITY_CONSTRAINTS[quality]
  if (!constraints || !_localStream) return
  for (const track of _localStream.getVideoTracks()) {
    await track.applyConstraints(constraints).catch(() => {})
  }
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
  if (_localStream) {
    _localStream.getTracks().forEach((track) => track.stop())
    _localStream = null
  }
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
 * Start screen sharing. Replaces the video track in the local stream with
 * the screen capture track, keeping the existing microphone audio.
 * The browser's native picker lets the user choose window or full screen.
 * @returns {Promise<{ stream: MediaStream, screenTrack: MediaStreamTrack } | null>}
 */
export async function startScreenShare() {
  if (!_localStream) return null

  const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  const [screenTrack] = screenStream.getVideoTracks()
  if (!screenTrack) return null

  _localStream.getVideoTracks().forEach((t) => t.stop())
  const audioTracks = _localStream.getAudioTracks()
  _localStream = new MediaStream([screenTrack, ...audioTracks])
  _screenTrack = screenTrack

  return { stream: _localStream, screenTrack }
}

/**
 * Stop screen sharing and restore the camera video track.
 * @returns {Promise<{ stream: MediaStream, videoTrack: MediaStreamTrack } | null>}
 */
export async function stopScreenShare() {
  if (!_screenTrack) return null

  _screenTrack.stop()
  _screenTrack = null

  const quality = getVideoQuality()
  let newCamStream
  try {
    newCamStream = await navigator.mediaDevices.getUserMedia({
      video: { ...QUALITY_CONSTRAINTS[quality], facingMode: _currentFacingMode },
      audio: false,
    })
  } catch (err) {
    console.warn('[media] stopScreenShare: could not restore camera', err)
    return null
  }

  const [newVideoTrack] = newCamStream.getVideoTracks()
  if (!newVideoTrack) return null

  const audioTracks = _localStream?.getAudioTracks() ?? []
  _localStream = new MediaStream([newVideoTrack, ...audioTracks])

  return { stream: _localStream, videoTrack: newVideoTrack }
}

/** Returns true if screen sharing is currently active. */
export function isScreenSharing() {
  return _screenTrack !== null
}
