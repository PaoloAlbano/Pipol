// @ts-check
/**
 * Keyboard shortcuts of a call: M, V and H, push-to-talk on Space, and none of them while typing a message.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom, startCall, joinCall } from './helpers.js'

test.describe('Call shortcuts', () => {
  test.setTimeout(90_000)

  test('toggle the microphone, the camera and the hand, and push-to-talk, but not while typing', async ({
    browser,
  }) => {
    const room = `e2e-${Date.now()}-shortcuts`
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
      await pageA.waitForTimeout(2500)
      await startCall(pageA)
      await joinCall(pageB)
      await expect(pageA.locator('.video-tile')).toHaveCount(2, { timeout: 20000 })

      // Alice's keys: the page itself has the focus, not the message box
      await pageA.locator('.video-stage').click({ position: { x: 5, y: 5 } })

      await pageA.keyboard.press('m')
      await expect(pageA.getByTitle(/^unmute microphone/i).first()).toBeVisible()
      await pageA.keyboard.press('m')
      await expect(pageA.getByTitle(/^mute microphone/i).first()).toBeVisible()

      await pageA.keyboard.press('v')
      await expect(pageB.locator('.video-avatar')).toHaveCount(1, { timeout: 10000 })
      await pageA.keyboard.press('v')
      await expect(pageB.locator('.video-avatar')).toHaveCount(0, { timeout: 10000 })

      await pageA.keyboard.press('h')
      await expect(pageB.getByRole('img', { name: 'alice-e2e raised a hand' })).toBeVisible({ timeout: 10000 })
      await pageA.keyboard.press('h')
      await expect(pageB.getByRole('img', { name: /raised a hand/i })).toHaveCount(0, { timeout: 10000 })

      // Push-to-talk: muted, the microphone is open only while Space is held
      await pageA.keyboard.press('m')
      await expect(pageA.getByTitle(/^unmute microphone/i).first()).toBeVisible()
      await pageA.keyboard.down('Space')
      await expect(pageA.getByTitle(/^mute microphone/i).first()).toBeVisible()
      await pageA.keyboard.up('Space')
      await expect(pageA.getByTitle(/^unmute microphone/i).first()).toBeVisible()

      // Typing a message with these letters does not press anything
      await pageA.locator('[data-placeholder]').click()
      await pageA.keyboard.type('mvh ')
      await expect(pageA.getByTitle(/^unmute microphone/i).first()).toBeVisible()
      await expect(pageB.getByRole('img', { name: /raised a hand/i })).toHaveCount(0)
      await expect(pageB.locator('.video-avatar')).toHaveCount(0)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
