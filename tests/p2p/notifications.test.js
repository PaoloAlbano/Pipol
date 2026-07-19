/**
 * notifications.test.js
 * Tests for the Notification API + App Badge helpers in notifications.js.
 *
 * All browser globals (Notification, navigator, document.hidden) are mocked
 * manually because jsdom does not implement the Notification API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── helpers ───────────────────────────────────────────────────────────────────

function stubNotification(permission = 'default') {
  const MockNotification = vi.fn(function (title, opts) {
    this.title = title
    this.opts = opts
    this.close = vi.fn()
  })
  MockNotification.permission = permission
  MockNotification.requestPermission = vi.fn(() => Promise.resolve(permission))
  globalThis.Notification = MockNotification
  return MockNotification
}

function removeNotification() {
  delete globalThis.Notification
}

function setDocumentHidden(hidden) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

// ── getNotificationPermission ─────────────────────────────────────────────────

describe('getNotificationPermission', () => {
  afterEach(() => {
    removeNotification()
  })

  it('returns "unsupported" when Notification is not defined', async () => {
    removeNotification()
    vi.resetModules()
    const { getNotificationPermission } = await import('../../src/p2p/notifications.js')
    expect(getNotificationPermission()).toBe('unsupported')
  })

  it('returns "default" when permission is default', async () => {
    stubNotification('default')
    vi.resetModules()
    const { getNotificationPermission } = await import('../../src/p2p/notifications.js')
    expect(getNotificationPermission()).toBe('default')
  })

  it('returns "granted" when permission is granted', async () => {
    stubNotification('granted')
    vi.resetModules()
    const { getNotificationPermission } = await import('../../src/p2p/notifications.js')
    expect(getNotificationPermission()).toBe('granted')
  })

  it('returns "denied" when permission is denied', async () => {
    stubNotification('denied')
    vi.resetModules()
    const { getNotificationPermission } = await import('../../src/p2p/notifications.js')
    expect(getNotificationPermission()).toBe('denied')
  })
})

// ── requestNotificationPermission ────────────────────────────────────────────

describe('requestNotificationPermission', () => {
  afterEach(() => {
    removeNotification()
  })

  it('returns "denied" when Notification API is unavailable', async () => {
    removeNotification()
    vi.resetModules()
    const { requestNotificationPermission } = await import('../../src/p2p/notifications.js')
    await expect(requestNotificationPermission()).resolves.toBe('denied')
  })

  it('returns "granted" immediately when permission is already granted', async () => {
    stubNotification('granted')
    vi.resetModules()
    const { requestNotificationPermission } = await import('../../src/p2p/notifications.js')
    await expect(requestNotificationPermission()).resolves.toBe('granted')
  })

  it('calls requestPermission and returns its result when permission is default', async () => {
    const mock = stubNotification('default')
    mock.requestPermission = vi.fn(() => Promise.resolve('granted'))
    vi.resetModules()
    const { requestNotificationPermission } = await import('../../src/p2p/notifications.js')
    const result = await requestNotificationPermission()
    expect(result).toBe('granted')
  })
})

// ── showNotification ──────────────────────────────────────────────────────────

describe('showNotification', () => {
  afterEach(() => {
    removeNotification()
    setDocumentHidden(false)
    vi.restoreAllMocks()
  })

  it('does nothing when Notification API is unavailable', async () => {
    removeNotification()
    vi.resetModules()
    const { showNotification } = await import('../../src/p2p/notifications.js')
    // Should not throw
    expect(() => showNotification('title', 'body')).not.toThrow()
  })

  it('does nothing when permission is not granted', async () => {
    const mock = stubNotification('default')
    vi.resetModules()
    const { showNotification } = await import('../../src/p2p/notifications.js')
    showNotification('title', 'body')
    expect(mock).not.toHaveBeenCalled()
  })

  it('creates a Notification when permission granted (tab visible)', async () => {
    vi.useFakeTimers()
    const mock = stubNotification('granted')
    vi.resetModules()
    const { showNotification } = await import('../../src/p2p/notifications.js')
    setDocumentHidden(false)
    showNotification('Hello', 'World')
    expect(mock).toHaveBeenCalledWith('Hello', expect.objectContaining({ body: 'World' }))
    vi.useRealTimers()
  })

  it('creates a Notification when permission granted and tab is hidden', async () => {
    vi.useFakeTimers()
    const mock = stubNotification('granted')
    vi.resetModules()
    const { showNotification } = await import('../../src/p2p/notifications.js')
    setDocumentHidden(true)
    showNotification('Hello', 'World')
    expect(mock).toHaveBeenCalledWith('Hello', expect.objectContaining({ body: 'World' }))
    vi.useRealTimers()
  })

  it('auto-closes the notification after 6 seconds', async () => {
    vi.useFakeTimers()
    const mock = stubNotification('granted')
    let closeFn
    mock.mockImplementation(function () {
      this.close = vi.fn()
      closeFn = this.close
    })
    vi.resetModules()
    const { showNotification } = await import('../../src/p2p/notifications.js')
    showNotification('A', 'B')
    vi.advanceTimersByTime(6000)
    expect(closeFn).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})

// ── updateAppBadge ────────────────────────────────────────────────────────────

describe('updateAppBadge', () => {
  beforeEach(() => {
    navigator.setAppBadge = vi.fn(() => Promise.resolve())
    navigator.clearAppBadge = vi.fn(() => Promise.resolve())
  })

  afterEach(() => {
    delete navigator.setAppBadge
    delete navigator.clearAppBadge
  })

  it('calls setAppBadge with the count when count > 0', async () => {
    vi.resetModules()
    const { updateAppBadge } = await import('../../src/p2p/notifications.js')
    updateAppBadge(3)
    expect(navigator.setAppBadge).toHaveBeenCalledWith(3)
  })

  it('calls clearAppBadge when count is 0', async () => {
    vi.resetModules()
    const { updateAppBadge } = await import('../../src/p2p/notifications.js')
    updateAppBadge(0)
    expect(navigator.clearAppBadge).toHaveBeenCalledTimes(1)
  })

  it('does not throw when setAppBadge is not available', async () => {
    delete navigator.setAppBadge
    delete navigator.clearAppBadge
    vi.resetModules()
    const { updateAppBadge } = await import('../../src/p2p/notifications.js')
    expect(() => updateAppBadge(5)).not.toThrow()
    expect(() => updateAppBadge(0)).not.toThrow()
  })
})

// ── containsMention ──────────────────────────────────────────────────────────

describe('containsMention', () => {
  let containsMention

  beforeEach(async () => {
    vi.resetModules()
    ;({ containsMention } = await import('../../src/p2p/notifications.js'))
  })

  it('detects a plain @mention', () => {
    expect(containsMention('hello @swift-fox!', 'swift-fox')).toBe(true)
  })

  it('detects @mention at the end of a sentence', () => {
    expect(containsMention('ping @alice', 'alice')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(containsMention('Hey @Alice', 'alice')).toBe(true)
    expect(containsMention('Hey @ALICE', 'Alice')).toBe(true)
  })

  it('requires a word boundary — does not match a partial username', () => {
    expect(containsMention('hey @alice123', 'alice')).toBe(false)
  })

  it('does not match a plain word without @', () => {
    expect(containsMention('alice said hello', 'alice')).toBe(false)
  })

  it('returns false for empty text', () => {
    expect(containsMention('', 'alice')).toBe(false)
  })

  it('returns false for null text', () => {
    expect(containsMention(null, 'alice')).toBe(false)
  })

  it('returns false for empty username', () => {
    expect(containsMention('hello @alice', '')).toBe(false)
  })

  it('returns false for null username', () => {
    expect(containsMention('hello @alice', null)).toBe(false)
  })

  it('escapes regex special characters in username', () => {
    expect(containsMention('hi @a.b+c', 'a.b+c')).toBe(true)
    expect(containsMention('hi @axbxc', 'a.b+c')).toBe(false)
  })

  it('detects mention followed by punctuation', () => {
    expect(containsMention('@bob, come here', 'bob')).toBe(true)
    expect(containsMention('hello @bob.', 'bob')).toBe(true)
  })
})
