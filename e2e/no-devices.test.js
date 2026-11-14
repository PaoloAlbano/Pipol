// @ts-check
/**
 * A call joined by somebody with no camera and no microphone: they still see and hear the others, and the others
 * see an avatar for them.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom } from './helpers.js'

/** Like a computer whose camera and microphone are unplugged. */
function noDevices() {
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
    configurable: true,
    writable: true,
    value: async () => {
      throw new DOMException('Requested device not found', 'NotFoundError')
    },
  })
}

async function videoIsPlaying(page, owner) {
  const tile = page.locator('.video-tile', { hasText: owner })
  await expect(tile).toHaveCount(1, { timeout: 20000 })
  await expect
    .poll(() => tile.locator('video').evaluate((v) => v.readyState >= 2 && !v.paused), { timeout: 20000 })
    .toBe(true)
}

test.describe('Call without camera and microphone', () => {
  test.setTimeout(120_000)

  for (const bobStarts of [false, true]) {
    test(`${bobStarts ? 'starts a call' : 'joins a call'} without devices and sees the others`, async ({ browser }) => {
      const room = `e2e-${Date.now()}-no-devices-${bobStarts ? 'bob' : 'alice'}`
      // Bob's browser has the fake camera of the project: here his devices are taken away
      const ctxAlice = await browser.newContext()
      const ctxBob = await browser.newContext()
      await ctxBob.addInitScript(noDevices)
      const alice = await ctxAlice.newPage()
      const bob = await ctxBob.newPage()

      try {
        await Promise.all([joinQuickRoom(alice, room, 'alice-e2e'), joinQuickRoom(bob, room, 'bob-e2e')])
        await alice.waitForTimeout(2500)

        const [starter, joiner] = bobStarts ? [bob, alice] : [alice, bob]
        await starter.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
        await joiner.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })

        // Bob is told why he cannot use them, and cannot turn them on
        await expect(bob.getByRole('status').filter({ hasText: /watch and listen/i })).toBeVisible({ timeout: 20000 })
        await expect(bob.getByTitle('No camera found').first()).toBeDisabled()
        await expect(bob.getByTitle('No microphone found').first()).toBeDisabled()

        // Alice shows an avatar for Bob; Bob sees her video playing
        await expect(alice.locator('.video-avatar')).toHaveCount(1, { timeout: 20000 })
        await videoIsPlaying(bob, 'alice-e2e')
      } finally {
        await ctxAlice.close()
        await ctxBob.close()
      }
    })
  }
})
