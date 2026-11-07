/**
 * useElementSize.test.jsx
 * Measures an element with a ResizeObserver, with a fallback where there is no layout (jsdom).
 */

import React, { useRef } from 'react'
import { render, screen, act } from '@testing-library/react'
import { useElementSize } from '../../src/components/useElementSize.js'

let observers
let rect

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.disconnect = vi.fn()
    this.observe = vi.fn()
    observers.push(this)
  }
}

function Probe({ fallback }) {
  const ref = useRef(null)
  const { width, height } = useElementSize(ref, fallback)
  return (
    <div ref={ref} data-testid="box">
      {width}x{height}
    </div>
  )
}

beforeEach(() => {
  observers = []
  rect = { width: 0, height: 0 }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useElementSize', () => {
  it('uses the fallback until the element has a size', () => {
    render(<Probe />)
    expect(screen.getByTestId('box')).toHaveTextContent('960x540')
  })

  it('uses the given fallback', () => {
    render(<Probe fallback={{ width: 100, height: 50 }} />)
    expect(screen.getByTestId('box')).toHaveTextContent('100x50')
  })

  it('measures the element at once', () => {
    rect = { width: 640, height: 360 }
    render(<Probe />)
    expect(screen.getByTestId('box')).toHaveTextContent('640x360')
  })

  it('follows the element when it is resized', () => {
    rect = { width: 640, height: 360 }
    render(<Probe />)
    rect = { width: 800, height: 450 }
    act(() => observers[0].callback())
    expect(screen.getByTestId('box')).toHaveTextContent('800x450')
  })

  it('does not re-render for a change below one pixel', () => {
    rect = { width: 640, height: 360 }
    const sizes = []
    function Recording() {
      const ref = useRef(null)
      sizes.push(useElementSize(ref))
      return <div ref={ref} />
    }
    render(<Recording />)
    const first = sizes.at(-1)
    rect = { width: 640.4, height: 360.3 }
    act(() => observers[0].callback())
    expect(sizes.at(-1)).toBe(first)
  })

  it('keeps the last size when the element collapses to nothing', () => {
    rect = { width: 640, height: 360 }
    render(<Probe />)
    rect = { width: 0, height: 0 }
    act(() => observers[0].callback())
    expect(screen.getByTestId('box')).toHaveTextContent('640x360')
  })

  it('stops observing on unmount', () => {
    const { unmount } = render(<Probe />)
    unmount()
    expect(observers[0].disconnect).toHaveBeenCalled()
  })

  it('observes with the ResizeObserver of the window the element is in', () => {
    const windowObservers = []
    class WindowObserver extends FakeResizeObserver {
      constructor(callback) {
        super(callback)
        windowObservers.push(this)
      }
    }
    const spy = vi.spyOn(document, 'defaultView', 'get').mockReturnValue({ ResizeObserver: WindowObserver })
    try {
      render(<Probe />)
      expect(windowObservers).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('works without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    rect = { width: 500, height: 300 }
    render(<Probe />)
    expect(screen.getByTestId('box')).toHaveTextContent('500x300')
  })
})
