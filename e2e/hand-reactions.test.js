// @ts-check
/**
 * Raised hands and reactions in a call between two browsers: what one does shows on their tile for the other.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom } from './helpers.js'

test.describe('Raised hands and reactions', () => {
  test.setTimeout(90_000)

  test('a raised hand and a reaction show on the tile of whoever sent them', async ({ browser }) => {
    const room = `e2e-${Date.now()}-hand-reactions`
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
      await pageA.waitForTimeout(2500)
      await pageA.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
      await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })
      await expect(pageA.locator('.video-tile')).toHaveCount(2, { timeout: 20000 })

      // Bob raises his hand: Alice sees it on his tile, and he on his own
      await pageB.getByTitle('Raise hand').first().click()
      await expect(pageA.getByRole('img', { name: 'bob-e2e raised a hand' })).toBeVisible({ timeout: 10000 })
      await expect(pageB.getByRole('img', { name: 'bob-e2e raised a hand' })).toBeVisible()

      await pageB.getByTitle('Lower hand').first().click()
      await expect(pageA.getByRole('img', { name: /raised a hand/i })).toHaveCount(0, { timeout: 10000 })

      // Bob sends a reaction: it rises on his tile for Alice, and goes away by itself
      await pageB
        .getByTitle(/send a reaction/i)
        .first()
        .click()
      await pageB.getByRole('menuitem', { name: 'React 🎉' }).click()
      const reaction = pageA.locator('.video-tile', { hasText: 'bob-e2e' }).locator('.video-reaction')
      await expect(reaction).toHaveText('🎉', { timeout: 10000 })
      await expect(reaction).toHaveCount(0, { timeout: 10000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
