// @ts-check
/**
 * Screen share between two browsers (fake camera and microphone, a canvas as the screen):
 * somebody who joins, or comes back to, the call while another is sharing has to see the screen.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom } from './helpers.js'

/** getDisplayMedia that needs no picker: a canvas whose colour changes, captured as a stream. */
function fakeScreen() {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const ctx = canvas.getContext('2d')
    setInterval(() => {
      ctx.fillStyle = `hsl(${Math.floor(Math.random() * 360)} 70% 50%)`
      ctx.fillRect(0, 0, 640, 360)
    }, 100)
    return canvas.captureStream(15)
  }
}

async function screenIsPlaying(page) {
  const tile = page.locator('.video-tile', { hasText: '(screen)' })
  await expect(tile).toHaveCount(1, { timeout: 20000 })
  await expect
    .poll(() => tile.locator('video').evaluate((v) => v.readyState >= 2 && !v.paused), { timeout: 20000 })
    .toBe(true)
}

test.describe('Screen share', () => {
  test.setTimeout(120_000)

  test('is seen by somebody who joins the call, and again after they leave and come back', async ({ browser }) => {
    const room = `e2e-${Date.now()}-screen`
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await ctxA.addInitScript(fakeScreen)
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
      await pageA.waitForTimeout(2500)

      // Alice starts the call and shares her screen before Bob is in the call
      await pageA.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
      await pageA.getByTitle(/share screen/i).first().click()
      await expect(pageA.getByTitle(/stop screen share/i).first()).toBeVisible()

      // Bob joins: he sees the screen
      await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })
      await screenIsPlaying(pageB)

      // Bob leaves and joins again while Alice keeps sharing
      await pageB.getByTitle(/leave video call/i).first().click()
      await expect(pageB.locator('.video-tile')).toHaveCount(0)
      await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })
      await screenIsPlaying(pageB)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
