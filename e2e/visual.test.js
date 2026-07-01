// @ts-check
/**
 * Visual regression tests using Playwright's built-in screenshot comparison.
 *
 * FIRST RUN:  pnpm e2e --update-snapshots
 *   → creates baseline PNG files in e2e/__snapshots__/
 *
 * SUBSEQUENT RUNS:  pnpm e2e
 *   → compares against baseline; fails if pixels differ beyond threshold
 *
 * REFRESH BASELINE after intentional UI changes:
 *   pnpm e2e e2e/visual.test.js --update-snapshots
 */
import { test, expect } from '@playwright/test'
import { loginAsGuest, joinQuickRoom } from './helpers.js'

// Consistent viewport for all visual tests
const DESKTOP = { width: 1280, height: 800 }
const MOBILE = { width: 390, height: 844 }

// Allow small pixel-level differences (antialiasing, font rendering)
const THRESHOLD = { maxDiffPixelRatio: 0.02 }

// ── Login screen ──────────────────────────────────────────────────────────────

test.describe('Visual — Login screen', () => {
  test('login screen desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/')
    await expect(page.locator('.login-screen')).toBeVisible()
    await expect(page).toHaveScreenshot('login-desktop.png', THRESHOLD)
  })

  test('login screen mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await page.goto('/')
    await expect(page.locator('.login-screen')).toBeVisible()
    await expect(page).toHaveScreenshot('login-mobile.png', THRESHOLD)
  })

  test('guest login form', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/')
    await page.click('button.login-guest-btn')
    await expect(page.locator('#guestName')).toBeVisible()
    await expect(page).toHaveScreenshot('login-guest-form.png', THRESHOLD)
  })
})

// ── Home screen ───────────────────────────────────────────────────────────────

test.describe('Visual — Home screen', () => {
  test('home screen after login desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/')
    await loginAsGuest(page, 'visual-alice')
    await expect(page.locator('.home-card')).toBeVisible({ timeout: 8000 })
    await expect(page).toHaveScreenshot('home-desktop.png', THRESHOLD)
  })

  test('home screen mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await page.goto('/')
    await loginAsGuest(page, 'visual-alice-mobile')
    await expect(page.locator('.home-card')).toBeVisible({ timeout: 8000 })
    await expect(page).toHaveScreenshot('home-mobile.png', THRESHOLD)
  })
})

// ── Quick Room ────────────────────────────────────────────────────────────────

test.describe('Visual — Quick Room', () => {
  test('empty room desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await joinQuickRoom(page, 'visual-room', 'visual-alice')
    // Wait for layout to settle
    await page.waitForTimeout(500)
    await expect(page).toHaveScreenshot('room-empty-desktop.png', THRESHOLD)
  })

  test('empty room mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await joinQuickRoom(page, 'visual-room-mobile', 'visual-alice-mob')
    await page.waitForTimeout(500)
    await expect(page).toHaveScreenshot('room-empty-mobile.png', THRESHOLD)
  })

  test('room with messages desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await joinQuickRoom(page, 'visual-room-msgs', 'alice-visual-msg')

    // Send a few messages to populate the chat
    const input = page.locator('[data-placeholder]')
    await input.click()
    await input.fill('First message from alice')
    await page.keyboard.press('Enter')
    await input.fill('Second message with more text')
    await page.keyboard.press('Enter')

    await expect(page.getByText('Second message')).toBeVisible()
    await page.waitForTimeout(300)
    await expect(page).toHaveScreenshot('room-with-messages-desktop.png', THRESHOLD)
  })
})

// ── Settings modal ────────────────────────────────────────────────────────────

test.describe('Visual — Settings modal', () => {
  test('settings modal desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/')
    await loginAsGuest(page, 'visual-settings')
    await expect(page.locator('.home-card')).toBeVisible({ timeout: 8000 })

    // Open settings from home screen
    await page.getByRole('button', { name: 'Open settings' }).click()
    await expect(page.locator('.settings-modal, .modal-overlay')).toBeVisible({ timeout: 5000 })
    await page.waitForTimeout(300)
    await expect(page).toHaveScreenshot('settings-modal-desktop.png', THRESHOLD)
  })
})

// ── Chat message variants ─────────────────────────────────────────────────────

test.describe('Visual — Chat message styles', () => {
  test('own and remote messages alignment', async ({ browser }) => {
    const room = `visual-alignment-${Date.now()}`
    const ctxA = await browser.newContext({ viewport: DESKTOP })
    const ctxB = await browser.newContext({ viewport: DESKTOP })
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([
        joinQuickRoom(pageA, room, 'alice-vis'),
        joinQuickRoom(pageB, room, 'bob-vis'),
      ])
      await pageA.waitForTimeout(2000)

      // Alice sends a message
      const inputA = pageA.locator('[data-placeholder]')
      await inputA.click()
      await inputA.fill('Hello from Alice')
      await pageA.keyboard.press('Enter')

      // Bob sends a reply
      await expect(pageB.getByText('Hello from Alice')).toBeVisible({ timeout: 15000 })
      const inputB = pageB.locator('[data-placeholder]')
      await inputB.click()
      await inputB.fill('Hi Alice!')
      await pageB.keyboard.press('Enter')

      // Wait for both messages to appear on Alice's side
      await expect(pageA.getByText('Hi Alice!')).toBeVisible({ timeout: 15000 })
      await pageA.waitForTimeout(300)

      // Screenshot Bob's view (has both own and remote bubbles)
      await expect(pageB).toHaveScreenshot('chat-bubbles-alignment.png', THRESHOLD)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
