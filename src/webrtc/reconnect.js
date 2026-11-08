/**
 * reconnect.js
 * When the connection to somebody in the call is given up (it failed, or never connected), the call tries again
 * with a growing wait, for as long as that person is still in the call.
 */

export const RECONNECT_BASE_MS = 2000
export const RECONNECT_MAX_MS = 30_000
/** Both sides notice the failure: the one that gives way waits a little longer so they do not offer at once. */
export const RECONNECT_POLITE_EXTRA_MS = 1500

/**
 * Wait before the next try: 2 s, 4 s, 8 s, 16 s, then 30 s every time.
 * @param {number} attempt  Tries made so far (0 for the first)
 * @param {boolean} [polite]  True for the side that gives way when both offer at the same time
 */
export function reconnectDelay(attempt, polite = false) {
  const wait = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(attempt, 0), RECONNECT_MAX_MS)
  return wait + (polite ? RECONNECT_POLITE_EXTRA_MS : 0)
}
