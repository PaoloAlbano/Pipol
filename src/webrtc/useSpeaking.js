import { useEffect, useState } from 'react'

/** Sound level (root mean square of the signal, 0–1) above which somebody counts as speaking. */
export const SPEAKING_LEVEL = 0.02
/** How long, in ms, somebody still counts as speaking after the last loud moment (so a pause does not flicker). */
export const SPEAKING_HOLD_MS = 700
const POLL_MS = 120

/** Level of a block of audio as returned by AnalyserNode.getByteTimeDomainData (bytes, silence is 128). */
export function levelOf(bytes) {
  if (!bytes || bytes.length === 0) return 0
  let sum = 0
  for (let i = 0; i < bytes.length; i++) {
    const sample = (bytes[i] - 128) / 128
    sum += sample * sample
  }
  return Math.sqrt(sum / bytes.length)
}

/** Whether somebody counts as speaking now, given when they were last loud. */
export function isSpeaking(lastLoudAt, now) {
  return lastLoudAt > 0 && now - lastLoudAt < SPEAKING_HOLD_MS
}

// One audio context for the whole page: browsers limit how many can exist
let sharedContext = null
function audioContext() {
  const Context = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : undefined
  if (!Context) return null
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new Context()
  if (sharedContext.state === 'suspended') sharedContext.resume?.().catch(() => {})
  return sharedContext
}

/**
 * Whether the person in a stream is speaking, from the sound level of its audio. It only listens: nothing is
 * played. Without audio, or in a browser without Web Audio, it is always false.
 * @param {MediaStream|null} stream
 * @returns {boolean}
 */
export function useSpeaking(stream) {
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    if (typeof stream?.getAudioTracks !== 'function' || stream.getAudioTracks().length === 0) return undefined
    const context = audioContext()
    if (!context) return undefined

    let source
    let analyser
    try {
      source = context.createMediaStreamSource(stream)
      analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
    } catch {
      return undefined
    }

    const bytes = new Uint8Array(analyser.fftSize)
    let lastLoudAt = 0
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(bytes)
      const now = Date.now()
      if (levelOf(bytes) > SPEAKING_LEVEL) lastLoudAt = now
      const next = isSpeaking(lastLoudAt, now)
      setSpeaking((prev) => (prev === next ? prev : next))
    }, POLL_MS)

    return () => {
      clearInterval(timer)
      source.disconnect()
      setSpeaking(false)
    }
  }, [stream])

  return speaking
}
