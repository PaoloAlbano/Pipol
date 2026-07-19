// @ts-check
/**
 * E2E tests for workspace flow:
 *  - Peer A creates a workspace
 *  - Peer B joins via the invite URL
 *  - They exchange messages in a channel
 *
 * Also covers DM (Direct Message) between two workspace members.
 */
import { test, expect } from '@playwright/test'
import { loginAsGuest, sendMessage, waitForMessage } from './helpers.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Log in as guest, create a workspace via Home screen, and return the invite URL.
 * @param {import('@playwright/test').Page} page
 * @param {string} username
 * @returns {Promise<string>} inviteUrl
 */
async function createWorkspace(page, username) {
  await page.goto('/')
  await loginAsGuest(page, username)

  // Home screen — "Create" tab is active by default
  await page.click('button:has-text("Create workspace →")')

  // Step 1: workspace name
  await expect(page.locator('#cwm-name')).toBeVisible({ timeout: 8000 })
  await page.fill('#cwm-name', `${username}-workspace`)
  await page.click('button:has-text("Next →")')

  // Step 2: channels — accept defaults and proceed
  await page.click('button:has-text("Create workspace")')

  // Step 3: invite link is now visible
  await expect(page.locator('.cwm__invite-box')).toBeVisible({ timeout: 8000 })
  const inviteUrl = await page.locator('.cwm__invite-box').textContent()

  // Close modal → go to workspace
  await page.click('button:has-text("Go to workspace")')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 15000 })

  return inviteUrl.trim()
}

/**
 * Log in as guest and join a workspace via an invite URL.
 * @param {import('@playwright/test').Page} page
 * @param {string} username
 * @param {string} inviteUrl
 */
async function joinWorkspace(page, username, inviteUrl) {
  await page.goto(inviteUrl)
  await loginAsGuest(page, username)
  // After login with invite param, an InviteConfirmModal appears — click Join
  await page.click('button.btn-primary:has-text("Join")', { timeout: 10000 })
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 15000 })
}

// ── Workspace creation & join ─────────────────────────────────────────────────

test.describe('Workspace — create and join', () => {
  test('peer A creates workspace, peer B joins via invite and sees the sidebar', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      const inviteUrl = await createWorkspace(pageA, 'alice-ws')

      await joinWorkspace(pageB, 'bob-ws', inviteUrl)

      // Bob should see at least a #general channel in the sidebar
      await expect(pageB.locator('.sidebar__item-name', { hasText: 'general' })).toBeVisible({ timeout: 8000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('message in workspace channel is received by joined peer', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      const inviteUrl = await createWorkspace(pageA, 'alice-ch')
      await joinWorkspace(pageB, 'bob-ch', inviteUrl)

      // Both are in the workspace. Alice selects #general (already selected by default)
      await pageA.locator('.sidebar__item-name', { hasText: 'general' }).click()
      await pageB.locator('.sidebar__item-name', { hasText: 'general' }).click()

      // Wait for P2P data channel
      await pageA.waitForTimeout(3000)

      const msg = `workspace hello ${Date.now()}`
      await sendMessage(pageA, msg)
      await waitForMessage(pageA, msg)
      await waitForMessage(pageB, msg, 25000)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

// ── Channel creation ──────────────────────────────────────────────────────────

test.describe('Channel creation', () => {
  test('new channel appears in sidebar after creation', async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()

    try {
      await createWorkspace(page, 'alice-newch')

      // Click the "+" button to create a new channel (sidebar button)
      await page.locator('.sidebar__section-add[aria-label="Create channel"]').click()

      // CreateChannelModal opens — type a channel name
      await page.fill('#ch-name-input', 'announcements')
      await page.locator('.ccm__btn--create').click()

      // New channel appears in sidebar
      await expect(page.locator('.sidebar__item-name', { hasText: 'announcements' })).toBeVisible({ timeout: 8000 })
    } finally {
      await ctx.close()
    }
  })
})

// ── Direct Message ────────────────────────────────────────────────────────────

test.describe('Direct Message', () => {
  test('DM from peer A is received by peer B', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    // Capture console output to diagnose P2P handshake issues on failure
    pageA.on('console', (msg) => {
      if (msg.type() === 'warn' || msg.type() === 'error') console.log('[pageA]', msg.text())
    })
    pageB.on('console', (msg) => {
      if (msg.type() === 'warn' || msg.type() === 'error') console.log('[pageB]', msg.text())
    })

    try {
      const inviteUrl = await createWorkspace(pageA, 'alice-dm')
      await joinWorkspace(pageB, 'bob-dm', inviteUrl)

      // Wait for presence sync — both peers need to appear in each other's DM list.
      // Requires MEMBER_HELLO exchange over the workspace WebRTC swarm.
      const bobEntry = pageA.locator('.sidebar__item-name', { hasText: 'bob-dm' })
      await expect(bobEntry).toBeVisible({ timeout: 60000 })

      // Alice also needs to appear in Bob's sidebar (symmetric MEMBER_HELLO)
      const aliceEntry = pageB.locator('.sidebar__item-name', { hasText: 'alice-dm' })
      await expect(aliceEntry).toBeVisible({ timeout: 60000 })

      // Bob opens DM with Alice FIRST so his DM room is mounted and listening
      await aliceEntry.click()

      // Alice opens DM with Bob and sends a message
      await bobEntry.click()
      const dmMsg = `dm hello ${Date.now()}`
      await sendMessage(pageA, dmMsg)
      await waitForMessage(pageA, dmMsg)

      // Bob sees the message in his already-open DM room
      await waitForMessage(pageB, dmMsg, 30000)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
