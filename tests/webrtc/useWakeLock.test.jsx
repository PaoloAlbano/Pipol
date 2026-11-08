/**
 * useWakeLock.test.jsx
 * The screen stays on during a call, and the lock is asked for again after the browser takes it away.
 */

import React from 'react'
import { render, act } from '@testing-library/react'
import { useWakeLock } from '../../src/webrtc/useWakeLock.js'

let locks
let request

function fakeLock() {
  const lock = Object.assign(new EventTarget(), { released: false })
  lock.release = vi.fn(async () => {
    lock.released = true
    lock.dispatchEvent(new Event('release'))
  })
  locks.push(lock)
  return lock
}

function Probe({ active }) {
  useWakeLock(active)
  return null
}

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

const flush = () => act(async () => {})

beforeEach(() => {
  locks = []
  request = vi.fn(async () => fakeLock())
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true })
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  setVisibility('visible')
})

afterEach(() => {
  delete navigator.wakeLock
  vi.restoreAllMocks()
})

describe('useWakeLock', () => {
  it('asks to keep the screen on while active', async () => {
    render(<Probe active />)
    await flush()
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('screen')
  })

  it('asks for nothing while not active', async () => {
    render(<Probe active={false} />)
    await flush()
    expect(request).not.toHaveBeenCalled()
  })

  it('lets go when it is no longer active', async () => {
    const { rerender } = render(<Probe active />)
    await flush()
    rerender(<Probe active={false} />)
    await flush()
    expect(locks[0].released).toBe(true)
  })

  it('lets go when the component goes away', async () => {
    const { unmount } = render(<Probe active />)
    await flush()
    unmount()
    expect(locks[0].released).toBe(true)
  })

  it('takes it again when the page is visible again after the browser took it away', async () => {
    render(<Probe active />)
    await flush()

    // Hidden page: the browser releases the lock by itself
    setVisibility('hidden')
    await act(async () => locks[0].release())
    expect(request).toHaveBeenCalledOnce()

    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(locks[1].released).toBe(false)
  })

  it('does not ask while the page is hidden', async () => {
    setVisibility('hidden')
    render(<Probe active />)
    await flush()
    expect(request).not.toHaveBeenCalled()

    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not ask twice when it already has the lock', async () => {
    render(<Probe active />)
    await flush()
    setVisibility('visible')
    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not ask twice while the first request is still pending', async () => {
    let grant
    request.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)))
    render(<Probe active />)
    setVisibility('visible')
    setVisibility('visible')
    expect(request).toHaveBeenCalledOnce()

    await act(async () => grant(fakeLock()))
    expect(request).toHaveBeenCalledOnce()
  })

  it('releases a lock that is granted after it was no longer wanted', async () => {
    let grant
    request.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)))
    const { unmount } = render(<Probe active />)
    unmount()

    const late = fakeLock()
    await act(async () => grant(late))
    expect(late.released).toBe(true)
  })

  it('keeps going when the browser refuses, and tries again the next time the page is shown', async () => {
    request.mockRejectedValueOnce(Object.assign(new Error('battery saver'), { name: 'NotAllowedError' }))
    render(<Probe active />)
    await flush()
    expect(locks).toHaveLength(0)

    setVisibility('visible')
    await flush()
    expect(locks).toHaveLength(1)
  })

  it('does nothing in a browser without Screen Wake Lock', async () => {
    delete navigator.wakeLock
    expect(() => render(<Probe active />)).not.toThrow()
    await flush()
  })

  it('stops listening to the page once it goes away', async () => {
    const { unmount } = render(<Probe active />)
    await flush()
    unmount()
    setVisibility('hidden')
    setVisibility('visible')
    await flush()
    expect(request).toHaveBeenCalledOnce()
  })
})
