/**
 * useCallShortcuts.test.jsx
 * Keys of a call: M, V and H, and push-to-talk on Space; never while typing, never with a modifier.
 */

import { renderHook, fireEvent } from '@testing-library/react'
import { useCallShortcuts } from '../../src/webrtc/useCallShortcuts.js'

function setup({ active = true, pipWindow = null, ...over } = {}) {
  const handlers = {
    toggleAudio: vi.fn(),
    toggleVideo: vi.fn(),
    toggleHand: vi.fn(),
    talk: { start: vi.fn(() => true), end: vi.fn() },
    ...over,
  }
  const view = renderHook((props) => useCallShortcuts(props.active, handlers, props.pipWindow), {
    initialProps: { active, pipWindow },
  })
  return { handlers, ...view }
}

const space = { key: ' ', code: 'Space' }

function element(tag, attrs = {}) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useCallShortcuts — the keys', () => {
  it('M mutes, V turns the camera off, H raises the hand', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { key: 'm' })
    fireEvent.keyDown(window, { key: 'v' })
    fireEvent.keyDown(window, { key: 'h' })
    expect(handlers.toggleAudio).toHaveBeenCalledOnce()
    expect(handlers.toggleVideo).toHaveBeenCalledOnce()
    expect(handlers.toggleHand).toHaveBeenCalledOnce()
  })

  it('does not care about capital letters', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { key: 'M' })
    expect(handlers.toggleAudio).toHaveBeenCalledOnce()
  })

  it('takes the key away from the page when it uses it, and leaves the others', () => {
    setup()
    expect(fireEvent.keyDown(window, { key: 'm' })).toBe(false) // preventDefault was called
    expect(fireEvent.keyDown(window, { key: 'x' })).toBe(true)
  })

  it('does nothing outside a call', () => {
    const { handlers } = setup({ active: false })
    fireEvent.keyDown(window, { key: 'm' })
    fireEvent.keyDown(window, { ...space })
    expect(handlers.toggleAudio).not.toHaveBeenCalled()
    expect(handlers.talk.start).not.toHaveBeenCalled()
  })

  it('stops when the call ends', () => {
    const { handlers, rerender } = setup()
    rerender({ active: false, pipWindow: null })
    fireEvent.keyDown(window, { key: 'm' })
    expect(handlers.toggleAudio).not.toHaveBeenCalled()
  })

  it('does not repeat a toggle while the key is held', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { key: 'm' })
    fireEvent.keyDown(window, { key: 'm', repeat: true })
    expect(handlers.toggleAudio).toHaveBeenCalledOnce()
  })

  it('leaves out what the device does not have', () => {
    const { handlers } = setup({ toggleAudio: undefined, talk: undefined })
    expect(fireEvent.keyDown(window, { key: 'm' })).toBe(true) // not taken
    expect(fireEvent.keyDown(window, { ...space })).toBe(true)
    fireEvent.keyDown(window, { key: 'v' })
    expect(handlers.toggleVideo).toHaveBeenCalledOnce()
  })

  it('leaves the keys of the browser alone', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'm', metaKey: true })
    fireEvent.keyDown(window, { key: 'v', altKey: true })
    fireEvent.keyDown(window, { key: 'h', ctrlKey: true })
    expect(handlers.toggleAudio).not.toHaveBeenCalled()
    expect(handlers.toggleVideo).not.toHaveBeenCalled()
    expect(handlers.toggleHand).not.toHaveBeenCalled()
  })
})

describe('useCallShortcuts — while typing', () => {
  it.each([
    ['an input', () => element('input')],
    ['a text area', () => element('textarea')],
    ['a select', () => element('select')],
    ['the message box (contenteditable)', () => element('div', { contenteditable: 'true' })],
    ['an empty contenteditable', () => element('div', { contenteditable: '' })],
  ])('does nothing in %s', (_name, make) => {
    const { handlers } = setup()
    const el = make()
    fireEvent.keyDown(el, { key: 'm' })
    fireEvent.keyDown(el, { key: 'h' })
    fireEvent.keyDown(el, { ...space })
    expect(handlers.toggleAudio).not.toHaveBeenCalled()
    expect(handlers.toggleHand).not.toHaveBeenCalled()
    expect(handlers.talk.start).not.toHaveBeenCalled()
  })

  it('works on a key pressed on the page itself', () => {
    const { handlers } = setup()
    fireEvent.keyDown(element('div'), { key: 'm' })
    expect(handlers.toggleAudio).toHaveBeenCalledOnce()
  })

  it('does nothing while the text is being composed', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { key: 'm', isComposing: true })
    expect(handlers.toggleAudio).not.toHaveBeenCalled()
  })
})

describe('useCallShortcuts — push-to-talk', () => {
  it('talks while Space is held, and stops when it is let go', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { ...space })
    expect(handlers.talk.start).toHaveBeenCalledOnce()
    expect(handlers.talk.end).not.toHaveBeenCalled()

    fireEvent.keyUp(window, { ...space })
    expect(handlers.talk.end).toHaveBeenCalledOnce()
  })

  it('starts once while the key repeats', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { ...space })
    fireEvent.keyDown(window, { ...space, repeat: true })
    fireEvent.keyDown(window, { ...space, repeat: true })
    expect(handlers.talk.start).toHaveBeenCalledOnce()
  })

  it('takes Space from the page (it would scroll) while it is the push-to-talk key, including when it repeats', () => {
    setup()
    expect(fireEvent.keyDown(window, { ...space })).toBe(false)
    expect(fireEvent.keyDown(window, { ...space, repeat: true })).toBe(false)
  })

  it('leaves Space to the page when there is nothing to talk with, so it still scrolls', () => {
    setup({ talk: { start: vi.fn(() => false), end: vi.fn() } })
    expect(fireEvent.keyDown(window, { ...space })).toBe(true)
    expect(fireEvent.keyDown(window, { ...space, repeat: true })).toBe(true)
  })

  it('does not start again when Space is pressed a second time without being let go', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { ...space })
    fireEvent.keyDown(window, { ...space })
    expect(handlers.talk.start).toHaveBeenCalledOnce()
  })

  it('has nothing to stop when there was nothing to start (the microphone is open already)', () => {
    const { handlers } = setup({ talk: { start: vi.fn(() => false), end: vi.fn() } })
    fireEvent.keyDown(window, { ...space })
    fireEvent.keyUp(window, { ...space })
    expect(handlers.talk.end).not.toHaveBeenCalled()
  })

  it('keeps talking when another key is let go', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { ...space })
    fireEvent.keyUp(window, { key: 'x', code: 'KeyX' })
    expect(handlers.talk.end).not.toHaveBeenCalled()
  })

  it('ignores a Space let go that was not ours', () => {
    const { handlers } = setup()
    fireEvent.keyUp(window, { ...space })
    expect(handlers.talk.end).not.toHaveBeenCalled()
  })

  it('leaves Space to a button or link that has the focus', () => {
    const { handlers } = setup()
    const button = element('button')
    fireEvent.keyDown(button, { ...space })
    fireEvent.keyDown(element('a', { href: '#' }), { ...space })
    expect(handlers.talk.start).not.toHaveBeenCalled()
  })

  it('closes the microphone when the window loses the focus with the key held', () => {
    const { handlers } = setup()
    fireEvent.keyDown(window, { ...space })
    fireEvent.blur(window)
    expect(handlers.talk.end).toHaveBeenCalledOnce()
    fireEvent.keyUp(window, { ...space }) // already closed
    expect(handlers.talk.end).toHaveBeenCalledOnce()
  })

  it('closes the microphone when the call ends with the key held', () => {
    const { handlers, rerender } = setup()
    fireEvent.keyDown(window, { ...space })
    rerender({ active: false, pipWindow: null })
    expect(handlers.talk.end).toHaveBeenCalledOnce()
  })

  it('closes the microphone when the page goes away with the key held', () => {
    const { handlers, unmount } = setup()
    fireEvent.keyDown(window, { ...space })
    unmount()
    expect(handlers.talk.end).toHaveBeenCalledOnce()
  })
})

describe('useCallShortcuts — the Picture-in-Picture window', () => {
  it('listens there as well, and stops when the window goes away or the hook is unmounted', () => {
    const pip = new EventTarget()
    const key = (type, init) => pip.dispatchEvent(Object.assign(new Event(type), init))
    const { handlers, rerender, unmount } = setup({ pipWindow: pip })

    key('keydown', { key: 'm' })
    expect(handlers.toggleAudio).toHaveBeenCalledOnce()

    rerender({ active: true, pipWindow: null })
    key('keydown', { key: 'm' })
    expect(handlers.toggleAudio).toHaveBeenCalledOnce()

    rerender({ active: true, pipWindow: pip })
    key('keydown', { key: 'h' })
    expect(handlers.toggleHand).toHaveBeenCalledOnce()
    unmount()
    key('keydown', { key: 'h' })
    expect(handlers.toggleHand).toHaveBeenCalledOnce()
  })
})

describe('useCallShortcuts — the handlers of the last render', () => {
  it('calls the newest ones without binding the keys again', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ fn }) => useCallShortcuts(true, { toggleAudio: fn }), {
      initialProps: { fn: first },
    })
    rerender({ fn: second })
    fireEvent.keyDown(window, { key: 'm' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })
})
