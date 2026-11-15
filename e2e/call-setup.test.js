// @ts-check
/**
 * What a call is started with: left off in the window before joining, a camera is not asked for, the others see an
 * avatar, and it can be turned on later in the call.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom, startCall, joinCall } from './helpers.js'

async function videoIsPlaying(page, owner) {
  const tile = page.locator('.video-tile', { hasText: owner })
  await expect(tile).toHaveCount(1, { timeout: 20000 })
  await expect
    .poll(() => tile.locator('video').evaluate((v) => v.readyState >= 2 && !v.paused), { timeout: 20000 })
    .toBe(true)
}

test.describe('Starting a call', () => {
  test.setTimeout(120_000)

  test('a camera left off is not used, and can be turned on during the call', async ({ browser, browserName }) => {
    const room = `e2e-${Date.now()}-call-setup`
    const ctxAlice = await browser.newContext()
    const ctxBob = await browser.newContext()
    const alice = await ctxAlice.newPage()
    const bob = await ctxBob.newPage()
    // As in no-devices.test.js, the playback of a video is not checked on WebKit in CI
    const checksPlayback = browserName !== 'webkit' || !process.env.CI

    try {
      await Promise.all([joinQuickRoom(alice, room, 'alice-e2e'), joinQuickRoom(bob, room, 'bob-e2e')])
      await alice.waitForTimeout(2500)

      // Alice starts with the camera off; Bob joins with everything on
      await startCall(alice, { camera: false })
      await expect(alice.getByTitle('Turn on camera').first()).toBeVisible()
      await joinCall(bob)

      await expect(bob.locator('.video-tile')).toHaveCount(2, { timeout: 20000 })
      await expect(bob.locator('.video-avatar')).toHaveCount(1, { timeout: 20000 }) // Alice's
      if (checksPlayback) await videoIsPlaying(alice, 'bob-e2e')

      // Alice turns her camera on: Bob sees her video instead of the avatar
      await alice.getByTitle('Turn on camera').first().click()
      await expect(alice.getByTitle(/turn off camera/i).first()).toBeVisible({ timeout: 10000 })
      await expect(bob.locator('.video-avatar')).toHaveCount(0, { timeout: 20000 })
      if (checksPlayback) await videoIsPlaying(bob, 'alice-e2e')
    } finally {
      await ctxAlice.close()
      await ctxBob.close()
    }
  })

  test('is asked again the next time, with the same choice', async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await joinQuickRoom(page, `e2e-${Date.now()}-call-defaults`, 'alice-e2e')
      await startCall(page, { camera: false, microphone: false })
      await expect(page.getByTitle('Turn on camera').first()).toBeVisible()
      await page
        .getByTitle(/leave video call/i)
        .first()
        .click()

      await page.getByRole('button', { name: /start call/i }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('switch', { name: 'Camera' })).toHaveAttribute('aria-checked', 'false')
      await expect(dialog.getByRole('switch', { name: 'Microphone' })).toHaveAttribute('aria-checked', 'false')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toHaveCount(0)
    } finally {
      await ctx.close()
    }
  })
})
