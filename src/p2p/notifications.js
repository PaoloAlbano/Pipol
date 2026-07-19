/**
 * notifications.js
 * Browser Notification API + App Badge helpers.
 *
 * - Notifications fire whenever permission is granted and the message is for a non-active channel.
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
 * Show a desktop notification — only if permission is granted.
 * Prefers ServiceWorkerRegistration.showNotification() (required by Chrome in
 * PWA/installed context); falls back to the synchronous Notification constructor
 * for environments without a service worker.
 * @param {string} title
 * @param {string} body
 */
export function showNotification(title, body) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return

  // Preferred path: delegate to the service worker so it works in installed
  // PWAs and avoids Chrome's deprecation of the synchronous Notification API.
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, { body, icon: ICON, silent: false }))
      .catch(() => _showDirect(title, body))
    return
  }

  _showDirect(title, body)
}

function _showDirect(title, body) {
  try {
    const n = new Notification(title, { body, icon: ICON, silent: false })
    setTimeout(() => n.close(), 6000)
  } catch {
    // Some environments (Firefox private mode, secure-context restrictions) can
    // still throw; nothing we can do.
  }
}

/**
 * Check whether a message text contains a @mention of the given username.
 * Matches word-boundary @username (case-insensitive), ignoring punctuation at the end.
 * @param {string} text
 * @param {string} username
 * @returns {boolean}
 */
export function containsMention(text, username) {
  if (!text || !username) return false
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\B@${escaped}(?=[^\\w]|$)`, 'i').test(text)
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
