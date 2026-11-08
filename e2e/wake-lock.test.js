// @ts-check
/**
 * The screen stays on during a call. The browser's Screen Wake Lock is replaced by a fake that records what is asked
 * of it (headless browsers do not grant a real one), so this checks that the app asks when the call starts and lets
 * go when it ends.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom } from './helpers.js'

function fakeWakeLock() {
  window.__locks = []
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async (type) => {
        const lock = Object.assign(new EventTarget(), { type, released: false })
        lock.release = async () => {
          lock.released = true
          lock.dispatchEvent(new Event('release'))
        }
        window.__locks.push(lock)
        return lock
      },
    },
  })
}

const held = () => window.__locks.filter((l) => !l.released).map((l) => l.type)

test.describe('Screen wake lock', () => {
  test('is held during the call and released when it ends', async ({ browser }) => {
    const ctx = await browser.newContext()
    await ctx.addInitScript(fakeWakeLock)
    const page = await ctx.newPage()

    try {
      await joinQuickRoom(page, `e2e-${Date.now()}-wakelock`, 'alice-e2e')
      await page.waitForTimeout(1500)
      expect(await page.evaluate(held)).toEqual([])

      await page.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
      await expect.poll(() => page.evaluate(held), { timeout: 10000 }).toEqual(['screen'])

      await page
        .getByTitle(/leave video call/i)
        .first()
        .click()
      await expect.poll(() => page.evaluate(held), { timeout: 10000 }).toEqual([])
    } finally {
      await ctx.close()
    }
  })
})
