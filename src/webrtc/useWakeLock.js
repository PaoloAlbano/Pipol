import { useEffect } from 'react'

/**
 * Keeps the screen on while `active` (a call): a phone that dims and locks its screen in the middle of a call
 * stops the camera and drops the connection. Where the browser has no Screen Wake Lock, nothing happens.
 *
 * The browser lets go of the lock by itself whenever the page is hidden (another tab or app), so it is asked for
 * again when the page is visible again.
 * @param {boolean} active
 */
export function useWakeLock(active) {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !navigator.wakeLock) return undefined

    let lock = null
    let asking = false
    let stopped = false

    async function acquire() {
      if (stopped || lock || asking || document.visibilityState !== 'visible') return
      asking = true
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        if (stopped) {
          sentinel.release().catch(() => {})
          return
        }
        lock = sentinel
        sentinel.addEventListener('release', () => {
          if (lock === sentinel) lock = null
        })
      } catch (err) {
        // Refused (battery saver, no permission): the call goes on, with the screen left to the system
        console.debug('[wakelock] not granted:', err?.name ?? err)
      } finally {
        asking = false
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') acquire()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    acquire()

    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      lock?.release().catch(() => {})
      lock = null
    }
  }, [active])
}
