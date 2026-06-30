/**
 * notifications.js
 * Browser Notification API + App Badge helpers.
 *
 * - Notifications are only shown when the document is hidden (tab in background).
 * - Badge count reflects the total number of unread messages across all channels.
 * - Both APIs degrade gracefully when unsupported or when permission is denied.
 */

const ICON = '/icons/icon-192.png'

// ── Permission ────────────────────────────────────────────────────────────────

/** @returns {'granted'|'denied'|'default'|'unsupported'} */
export function getNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/**
 * Request notification permission from the user.
 * Should be called from a user gesture (e.g. button click).
 * @returns {Promise<'granted'|'denied'|'default'>}
 */
export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  return Notification.requestPermission()
}

// ── Show notification ─────────────────────────────────────────────────────────

/**
 * Show a desktop notification — only if permission is granted AND the tab is hidden.
 * @param {string} title
 * @param {string} body
 */
export function showNotification(title, body) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && !document.hidden) return
  try {
    const n = new Notification(title, { body, icon: ICON, silent: false })
    setTimeout(() => n.close(), 6000)
  } catch {
    // Notification constructor can throw in some environments (e.g. Firefox private mode)
  }
}

// ── App badge ─────────────────────────────────────────────────────────────────

/**
 * Update the app icon badge with the given unread count.
 * Clears the badge when count === 0.
 * @param {number} count
 */
export function updateAppBadge(count) {
  if (typeof navigator === 'undefined') return
  if (count > 0) {
    navigator.setAppBadge?.(count).catch(() => {})
  } else {
    navigator.clearAppBadge?.().catch(() => {})
  }
}
