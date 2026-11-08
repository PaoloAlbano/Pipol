/**
 * reconnect.test.js
 * The wait before the call tries again to connect to somebody.
 */

import {
  reconnectDelay,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RECONNECT_POLITE_EXTRA_MS,
} from '../../src/webrtc/reconnect.js'

describe('reconnectDelay', () => {
  it('doubles the wait at every try', () => {
    expect([0, 1, 2, 3].map((n) => reconnectDelay(n))).toEqual([2000, 4000, 8000, 16000])
  })

  it('stops growing at the maximum', () => {
    expect(reconnectDelay(4)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelay(10)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelay(1000)).toBe(RECONNECT_MAX_MS)
  })

  it('starts from the base wait, even for a nonsense try number', () => {
    expect(reconnectDelay(-3)).toBe(RECONNECT_BASE_MS)
  })

  it('makes the side that gives way wait a little longer, at every try', () => {
    for (const attempt of [0, 2, 6]) {
      expect(reconnectDelay(attempt, true) - reconnectDelay(attempt, false)).toBe(RECONNECT_POLITE_EXTRA_MS)
    }
  })
})
