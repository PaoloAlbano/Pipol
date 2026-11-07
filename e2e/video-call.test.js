// @ts-check
/**
 * Video call between two browsers (fake camera and microphone): what the others see when a camera goes off.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom } from './helpers.js'

test.describe('Video call', () => {
  test.setTimeout(90_000)

  test('shows an avatar for a peer whose camera is off, and the video again when it is back on', async ({
    browser,
  }) => {
    const room = `e2e-${Date.now()}-camera-off`
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
      await pageA.waitForTimeout(2500)

      await pageA.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
      await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })

      // Alice sees Bob's tile (hers is the other one), with his video
      await expect(pageA.locator('.video-tile')).toHaveCount(2, { timeout: 20000 })
      await expect(pageA.locator('.video-avatar')).toHaveCount(0)

      await pageB.getByTitle(/turn off camera/i).first().click()
      await expect(pageA.locator('.video-avatar')).toHaveCount(1, { timeout: 10000 })
      // Bob's own avatar shows too
      await expect(pageB.locator('.video-avatar')).toHaveCount(1)

      await pageB.getByTitle(/turn on camera/i).first().click()
      await expect(pageA.locator('.video-avatar')).toHaveCount(0, { timeout: 10000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
