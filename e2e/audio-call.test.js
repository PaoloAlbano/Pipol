// @ts-check
/**
 * An audio-only call: the one who joins this way sends no video, the others see an avatar for them, and they still
 * see the video of the others.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom } from './helpers.js'

test.describe('Audio-only call', () => {
  test.setTimeout(120_000)

  test('is started without the camera, and the other who joins sees an avatar and is seen', async ({
    browser,
    browserName,
  }) => {
    const room = `e2e-${Date.now()}-audio-call`
    const ctxAlice = await browser.newContext()
    const ctxBob = await browser.newContext()
    const alice = await ctxAlice.newPage()
    const bob = await ctxBob.newPage()

    try {
      await Promise.all([joinQuickRoom(alice, room, 'alice-e2e'), joinQuickRoom(bob, room, 'bob-e2e')])
      await alice.waitForTimeout(2500)

      await alice.getByRole('button', { name: /start audio call/i }).click({ timeout: 15000 })
      await expect(alice.getByTitle('No camera in this call').first()).toBeDisabled()
      await expect(alice.getByTitle(/mute microphone/i).first()).toBeEnabled()

      await bob.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })

      // Bob shows an avatar for Alice, whose camera is off for the whole call
      await expect(bob.locator('.video-tile')).toHaveCount(2, { timeout: 20000 })
      await expect(bob.locator('.video-avatar')).toHaveCount(1, { timeout: 20000 })

      // Alice sees the video of Bob (as in no-devices.test.js, not checked on WebKit in CI)
      if (browserName !== 'webkit' || !process.env.CI) {
        const tile = alice.locator('.video-tile', { hasText: 'bob-e2e' })
        await expect(tile).toHaveCount(1, { timeout: 20000 })
        await expect
          .poll(() => tile.locator('video').evaluate((v) => v.readyState >= 2 && !v.paused), { timeout: 20000 })
          .toBe(true)
      }
    } finally {
      await ctxAlice.close()
      await ctxBob.close()
    }
  })
})
