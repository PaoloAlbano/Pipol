// @ts-check
/**
 * E2E test helpers for Pipol.
 *
 * Login strategy: "guest" mode (no passphrase needed, ephemeral identity).
 * This is the fastest path through LoginScreen.
 */
import { expect } from '@playwright/test'

/**
 * Log in as a guest with a given display name.
 * Works on a fresh page (no localStorage) or after clearing storage.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export async function loginAsGuest(page, name) {
  // Default mode is 'identity'. Click the guest shortcut button at the bottom.
  await page.click('button.login-guest-btn')
  // Guest form: fill the display name
  await page.fill('#guestName', name)
  await page.click('button[type="submit"]')
  // Wait until the login screen is gone
  await expect(page.locator('.login-screen')).toHaveCount(0, { timeout: 8000 })
}

/**
 * Navigate to a quick room URL and log in as guest.
 * Returns when the Room view is visible (chat input present).
 * @param {import('@playwright/test').Page} page
 * @param {string} roomCode
 * @param {string} username
 */
export async function joinQuickRoom(page, roomCode, username) {
  await page.goto(`/?room=${roomCode}`)
  await loginAsGuest(page, username)
  // ChatInput uses a contenteditable div, not a textarea
  await expect(page.locator('[data-placeholder]')).toBeVisible({ timeout: 10000 })
}

/**
 * Send a chat message via the contenteditable ChatInput.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
export async function sendMessage(page, text) {
  const input = page.locator('[data-placeholder]')
  await input.click()
  await input.fill(text)
  // Enter sends the message (Shift+Enter = newline)
  await page.keyboard.press('Enter')
}

/**
 * Wait for a message with the given text to appear in the chat.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @param {number} [timeout=15000]
 */
export async function waitForMessage(page, text, timeout = 15000) {
  await expect(page.getByText(text, { exact: false })).toBeVisible({ timeout })
}
