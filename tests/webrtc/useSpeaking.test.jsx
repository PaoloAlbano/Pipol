/**
 * useSpeaking.test.jsx
 * Detects who is speaking from the sound level of a stream, with a fake Web Audio.
 */

import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { useSpeaking, levelOf, isSpeaking, SPEAKING_LEVEL, SPEAKING_HOLD_MS } from '../../src/webrtc/useSpeaking.js'

const SILENCE = 128
let level // byte value the fake analyser reports
let created
let sources

class FakeAudioContext {
  constructor() {
    this.state = 'running'
    created.push(this)
  }
  createMediaStreamSource() {
    const source = { connect: vi.fn(), disconnect: vi.fn() }
    sources.push(source)
    return source
  }
  createAnalyser() {
    return {
      fftSize: 0,
      getByteTimeDomainData: (bytes) => bytes.fill(level),
    }
  }
}

function audioStream() {
  return { getAudioTracks: () => [{}] }
}

function Probe({ stream }) {
  return <div data-testid="speaking">{String(useSpeaking(stream))}</div>
}

beforeEach(() => {
  vi.useFakeTimers()
  level = SILENCE
  created = []
  sources = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('levelOf', () => {
  it('is 0 for silence and for no data', () => {
    expect(levelOf(new Uint8Array(64).fill(128))).toBe(0)
    expect(levelOf(new Uint8Array(0))).toBe(0)
    expect(levelOf(null)).toBe(0)
  })

  it('grows with the amplitude', () => {
    const quiet = levelOf(new Uint8Array(64).fill(132))
    const loud = levelOf(new Uint8Array(64).fill(200))
    expect(quiet).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(quiet)
    expect(levelOf(new Uint8Array(64).fill(0))).toBeCloseTo(1)
  })
})

describe('isSpeaking', () => {
  it('is true shortly after a loud moment and false after the hold time', () => {
    expect(isSpeaking(1000, 1000 + SPEAKING_HOLD_MS - 1)).toBe(true)
    expect(isSpeaking(1000, 1000 + SPEAKING_HOLD_MS)).toBe(false)
  })

  it('is false when there was never a loud moment', () => {
    expect(isSpeaking(0, 5000)).toBe(false)
  })
})

describe('useSpeaking', () => {
  it('is false in silence', () => {
    render(<Probe stream={audioStream()} />)
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByTestId('speaking')).toHaveTextContent('false')
  })

  it('turns on when the level goes above the threshold', () => {
    render(<Probe stream={audioStream()} />)
    level = 128 + Math.ceil(SPEAKING_LEVEL * 128) + 10
    act(() => vi.advanceTimersByTime(250))
    expect(screen.getByTestId('speaking')).toHaveTextContent('true')
  })

  it('stays on through a short pause and turns off after it', () => {
    render(<Probe stream={audioStream()} />)
    level = 200
    act(() => vi.advanceTimersByTime(250))
    level = SILENCE
    act(() => vi.advanceTimersByTime(SPEAKING_HOLD_MS / 2))
    expect(screen.getByTestId('speaking')).toHaveTextContent('true')
    act(() => vi.advanceTimersByTime(SPEAKING_HOLD_MS))
    expect(screen.getByTestId('speaking')).toHaveTextContent('false')
  })

  it('is false without a stream or without audio', () => {
    const { rerender } = render(<Probe stream={null} />)
    expect(screen.getByTestId('speaking')).toHaveTextContent('false')
    rerender(<Probe stream={{ getAudioTracks: () => [] }} />)
    expect(screen.getByTestId('speaking')).toHaveTextContent('false')
    expect(created).toHaveLength(0)
  })

  it('is false in a browser without Web Audio', () => {
    vi.stubGlobal('AudioContext', undefined)
    level = 200
    render(<Probe stream={audioStream()} />)
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByTestId('speaking')).toHaveTextContent('false')
  })

  it('shares one audio context between streams', () => {
    render(
      <>
        <Probe stream={audioStream()} />
        <Probe stream={audioStream()} />
      </>
    )
    expect(new Set(created).size).toBe(created.length)
    expect(created.length).toBeLessThanOrEqual(1)
  })

  it('disconnects and resets when the stream goes away', () => {
    const stream = audioStream()
    const { rerender } = render(<Probe stream={stream} />)
    level = 200
    act(() => vi.advanceTimersByTime(250))
    expect(screen.getByTestId('speaking')).toHaveTextContent('true')
    rerender(<Probe stream={null} />)
    expect(sources[0].disconnect).toHaveBeenCalled()
    expect(screen.getByTestId('speaking')).toHaveTextContent('false')
  })
})
