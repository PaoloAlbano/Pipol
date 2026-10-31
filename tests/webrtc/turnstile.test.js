/**
 * turnstile.test.js
 * Getting a Turnstile token for the relay's /ice endpoint.
 */

import { getTurnstileToken, turnstileSiteKey } from '../../src/webrtc/turnstile.js'

let widgets
let api

beforeEach(() => {
  widgets = []
  api = {
    render: vi.fn((container, options) => {
      widgets.push({ container, options })
      return `widget-${widgets.length}`
    }),
    remove: vi.fn(),
  }
  window.turnstile = api
})

afterEach(() => {
  delete window.turnstile
  vi.unstubAllEnvs()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('turnstileSiteKey', () => {
  it('is empty unless a site key is configured', () => {
    expect(turnstileSiteKey()).toBe('')
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '0xKEY')
    expect(turnstileSiteKey()).toBe('0xKEY')
  })
})

describe('getTurnstileToken', () => {
  it('does nothing, and loads nothing, without a site key', async () => {
    expect(await getTurnstileToken('')).toBeNull()
    expect(api.render).not.toHaveBeenCalled()
  })

  it('renders an invisible widget and resolves with its token, then cleans up', async () => {
    const pending = getTurnstileToken('0xKEY')
    await vi.waitFor(() => expect(widgets).toHaveLength(1))

    expect(widgets[0].options.sitekey).toBe('0xKEY')
    expect(widgets[0].options.appearance).toBe('interaction-only')
    expect(document.body.contains(widgets[0].container)).toBe(true)

    widgets[0].options.callback('the-token')
    expect(await pending).toBe('the-token')
    expect(api.remove).toHaveBeenCalledWith('widget-1')
    expect(document.body.contains(widgets[0].container)).toBe(false)
  })

  it('asks for a new widget, and so a new token, every time', async () => {
    const first = getTurnstileToken('0xKEY')
    await vi.waitFor(() => expect(widgets).toHaveLength(1))
    widgets[0].options.callback('one')
    await first

    const second = getTurnstileToken('0xKEY')
    await vi.waitFor(() => expect(widgets).toHaveLength(2))
    widgets[1].options.callback('two')
    expect(await second).toBe('two')
  })

  it.each([['error-callback'], ['timeout-callback']])('resolves with null on %s', async (callback) => {
    const pending = getTurnstileToken('0xKEY')
    await vi.waitFor(() => expect(widgets).toHaveLength(1))
    widgets[0].options[callback]()
    expect(await pending).toBeNull()
    expect(document.body.contains(widgets[0].container)).toBe(false)
  })

  it('gives up after the timeout', async () => {
    vi.useFakeTimers()
    const pending = getTurnstileToken('0xKEY', 5000)
    await vi.advanceTimersByTimeAsync(5001)
    expect(await pending).toBeNull()
    expect(api.remove).toHaveBeenCalled()
  })

  it('ignores a second callback after it has finished', async () => {
    const pending = getTurnstileToken('0xKEY')
    await vi.waitFor(() => expect(widgets).toHaveLength(1))
    widgets[0].options.callback('first')
    widgets[0].options.callback('second')
    expect(await pending).toBe('first')
    expect(api.remove).toHaveBeenCalledTimes(1)
  })

  it('resolves with null if rendering throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    api.render.mockImplementation(() => {
      throw new Error('bad sitekey')
    })
    expect(await getTurnstileToken('0xKEY')).toBeNull()
    expect(document.body.querySelector('div')).toBeNull()
  })

  it('resolves with null, without throwing, when the script cannot be loaded (blocked by CSP or offline)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete window.turnstile
    const append = vi.spyOn(document.head, 'appendChild').mockImplementation((script) => {
      queueMicrotask(() => script.onerror())
      return script
    })
    expect(await getTurnstileToken('0xKEY')).toBeNull()
    expect(append.mock.calls[0][0].src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
    append.mockRestore()
  })
})
