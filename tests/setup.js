import '@testing-library/jest-dom'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Unmount React components after each test
afterEach(() => {
  cleanup()
  if (typeof localStorage !== 'undefined') localStorage.clear()
})

// jsdom does not implement scrollIntoView (skip in node environment)
if (typeof window !== 'undefined') {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
}

// jsdom does not have MediaStream — minimal mock compatible with media.js
if (typeof globalThis.MediaStream === 'undefined') {
  globalThis.MediaStream = class MediaStream {
    constructor(tracks = []) {
      this._tracks = [...tracks]
    }
    getTracks() {
      return this._tracks
    }
    getAudioTracks() {
      return this._tracks.filter((t) => t.kind === 'audio')
    }
    getVideoTracks() {
      return this._tracks.filter((t) => t.kind === 'video')
    }
    addTrack(t) {
      this._tracks.push(t)
    }
    removeTrack(t) {
      this._tracks = this._tracks.filter((x) => x !== t)
    }
  }
}
