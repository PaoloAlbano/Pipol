// @ts-check
/**
 * E2E tests for notification and unread badge behaviour.
 *
 * Scenarios:
 *   1. Unread dot appears in sidebar when a message arrives on an inactive channel
 *   2. Unread dot clears when the channel is opened
 *   3. DM unread dot appears when a DM arrives from another workspace member
 *   4. Browser Notification API is called when a message arrives on an inactive channel
 */
import { test, expect } from '@playwright/test'
import { loginAsGuest, sendMessage, waitForMessage } from './helpers.js'

// ── Shared workspace helpers (duplicated from workspace.test.js to keep tests isolated) ──

async function createWorkspace(page, username) {
  await page.goto('/')
  await loginAsGuest(page, username)

  await page.click('button:has-text("Create workspace →")')

  // Step 1: name
  await expect(page.locator('#cwm-name')).toBeVisible({ timeout: 8000 })
  await page.fill('#cwm-name', `${username}-workspace`)
  await page.click('button:has-text("Next →")')

  // Step 2: accept defaults (general + random channels)
  await page.click('button:has-text("Create workspace")')

  // Step 3: invite link
  await expect(page.locator('.cwm__invite-box')).toBeVisible({ timeout: 8000 })
  const inviteUrl = await page.locator('.cwm__invite-box').textContent()
  await page.click('button:has-text("Go to workspace")')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 15000 })

  return inviteUrl.trim()
}

async function joinWorkspace(page, username, inviteUrl) {
  await page.goto(inviteUrl)
  await loginAsGuest(page, username)
  await page.click('button.btn-primary:has-text("Join")', { timeout: 10000 })
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 15000 })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Notifications — unread badge', () => {
  test('unread dot appears on #general when Alice is on #random and Bob sends a message', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      const inviteUrl = await createWorkspace(pageA, 'alice-notif')
      await joinWorkspace(pageB, 'bob-notif', inviteUrl)

      // Both see the sidebar; the default workspace has #general and #random.
      // Alice navigates to #random — she leaves #general unattended.
      await pageA.locator('.sidebar__item-name', { hasText: 'random' }).click()
      await expect(pageA.locator('.sidebar__item-name', { hasText: 'random' })).toBeVisible()

      // Bob navigates to #general and sends a message.
      await pageB.locator('.sidebar__item-name', { hasText: 'general' }).click()
      await pageA.waitForTimeout(2000) // let P2P data channel establish

      const msg = `notification test ${Date.now()}`
      await sendMessage(pageB, msg)
      await waitForMessage(pageB, msg)

      // Alice should now see the unread dot on #general (she is on #random).
      await expect(
        pageA.locator('.sidebar__item--unread', { hasText: 'general' })
      ).toBeVisible({ timeout: 20000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('unread dot clears when Alice opens the channel', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      const inviteUrl = await createWorkspace(pageA, 'alice-clr')
      await joinWorkspace(pageB, 'bob-clr', inviteUrl)

      // Alice goes to #random, Bob sends to #general.
      await pageA.locator('.sidebar__item-name', { hasText: 'random' }).click()
      await pageB.locator('.sidebar__item-name', { hasText: 'general' }).click()
      await pageA.waitForTimeout(2000)

      const msg = `clear badge ${Date.now()}`
      await sendMessage(pageB, msg)

      // Wait for the unread dot to appear on Alice's #general.
      await expect(
        pageA.locator('.sidebar__item--unread', { hasText: 'general' })
      ).toBeVisible({ timeout: 20000 })

      // Alice clicks #general — the dot should disappear.
      await pageA.locator('.sidebar__item-name', { hasText: 'general' }).click()

      await expect(
        pageA.locator('.sidebar__item--unread', { hasText: 'general' })
      ).not.toBeVisible({ timeout: 5000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('DM unread dot appears when a DM arrives while the user is not in the DM view', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      const inviteUrl = await createWorkspace(pageA, 'alice-dm-notif')
      await joinWorkspace(pageB, 'bob-dm-notif', inviteUrl)

      // Wait for peers to discover each other (member list populated).
      await pageA.locator('.sidebar__item-name', { hasText: 'general' }).click()
      await pageB.locator('.sidebar__item-name', { hasText: 'general' }).click()
      await pageA.waitForTimeout(3000)

      // Bob opens a DM to Alice first (so Alice sees the DM entry in her sidebar).
      // DMItem renders aria-label="Direct message with <username>"
      const aliceEntry = pageB.locator('[aria-label="Direct message with alice-dm-notif"]')
      await expect(aliceEntry).toBeVisible({ timeout: 20000 })
      await aliceEntry.click()

      // Bob sends a DM to Alice.
      const dmMsg = `dm notif ${Date.now()}`
      await sendMessage(pageB, dmMsg)

      // Alice should see the unread dot on Bob's DM entry.
      // DMItem gets .sidebar__item--unread when peer.unread > 0 and not active.
      await expect(
        pageA.locator('.sidebar__item--unread[aria-label="Direct message with bob-dm-notif"]')
      ).toBeVisible({ timeout: 30000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

test.describe('Notifications — browser Notification API', () => {
  test('Notification constructor is called when a message arrives on an inactive channel', async ({ browser }) => {
    // Grant notification permission and inject a spy before any page scripts run.
    const ctxA = await browser.newContext({ permissions: ['notifications'] })
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    // Inject notification spy into pageA before any app code runs.
    await pageA.addInitScript(() => {
      window.__notificationCalls = []
      class NotificationSpy {
        constructor(title, opts) {
          window.__notificationCalls.push({ title, body: opts?.body })
          this.close = () => {}
        }
        static get permission() { return 'granted' }
        static requestPermission() { return Promise.resolve('granted') }
      }
      window.Notification = NotificationSpy
    })

    try {
      const inviteUrl = await createWorkspace(pageA, 'alice-notifapi')
      await joinWorkspace(pageB, 'bob-notifapi', inviteUrl)

      // Alice goes to #random; Bob sends to #general.
      await pageA.locator('.sidebar__item-name', { hasText: 'random' }).click()
      await pageB.locator('.sidebar__item-name', { hasText: 'general' }).click()
      await pageA.waitForTimeout(2000)

      const msg = `api notif ${Date.now()}`
      await sendMessage(pageB, msg)
      await waitForMessage(pageB, msg)

      // Wait for Alice's app to receive the message and fire the notification.
      await pageA.waitForFunction(
        () => window.__notificationCalls && window.__notificationCalls.length > 0,
        { timeout: 20000 }
      )

      const calls = await pageA.evaluate(() => window.__notificationCalls)
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].title).toContain('general')
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

// ── @mention badge ────────────────────────────────────────────────────────────

test.describe('Notifications — @mention badge', () => {
  test('@mention badge appears when Bob mentions Alice in an inactive channel', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      const inviteUrl = await createWorkspace(pageA, 'alice-mention')
      await joinWorkspace(pageB, 'bob-mention', inviteUrl)

      // Alice navigates to #random; Bob stays on #general.
      await pageA.locator('.sidebar__item-name', { hasText: 'random' }).click()
      await pageB.locator('.sidebar__item-name', { hasText: 'general' }).click()
      await pageA.waitForTimeout(2000)

      // Bob sends a message that mentions Alice by name.
      await sendMessage(pageB, 'hey @alice-mention can you review this?')
      await waitForMessage(pageB, 'hey @alice-mention can you review this?')

      // Alice should see the @ badge inside the #general sidebar item.
      const generalItem = pageA.locator('.sidebar__item').filter({
        has: pageA.locator('.sidebar__item-name', { hasText: 'general' }),
      })
      await expect(generalItem.locator('.sidebar__item-mention')).toBeVisible({ timeout: 20000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('@mention badge clears when Alice opens the mentioned channel', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      const inviteUrl = await createWorkspace(pageA, 'alice-mention-clr')
      await joinWorkspace(pageB, 'bob-mention-clr', inviteUrl)

      await pageA.locator('.sidebar__item-name', { hasText: 'random' }).click()
      await pageB.locator('.sidebar__item-name', { hasText: 'general' }).click()
      await pageA.waitForTimeout(2000)

      await sendMessage(pageB, 'hello @alice-mention-clr!')
      await waitForMessage(pageB, 'hello @alice-mention-clr!')

      // Wait for the @ badge to appear on #general.
      const generalItem = pageA.locator('.sidebar__item').filter({
        has: pageA.locator('.sidebar__item-name', { hasText: 'general' }),
      })
      await expect(generalItem.locator('.sidebar__item-mention')).toBeVisible({ timeout: 20000 })

      // Alice opens #general — the @ badge should disappear.
      await pageA.locator('.sidebar__item-name', { hasText: 'general' }).click()
      await expect(generalItem.locator('.sidebar__item-mention')).not.toBeVisible({ timeout: 5000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

