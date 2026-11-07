// @ts-check
/**
 * The "max" video quality: 60 fps, but only on a direct connection (here both browsers are on the same machine,
 * so it is one). The fallback through a TURN relay is covered by the unit tests, which can fake the route.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom } from './helpers.js'

const QUALITY_KEY = 'p2p-chat:video-quality'

function recordPeerConnections() {
  const Native = window.RTCPeerConnection
  window.__pcs = []
  function Recording(...args) {
    const pc = new Native(...args)
    window.__pcs.push(pc)
    return pc
  }
  Recording.prototype = Native.prototype
  Object.setPrototypeOf(Recording, Native)
  window.RTCPeerConnection = Recording
}

/** What the camera sender of the call connection is allowed to send. */
function cameraEncoding() {
  const pc = window.__pcs.find(
    (p) => p.connectionState === 'connected' && p.getSenders().some((s) => s.track?.kind === 'video')
  )
  const sender = pc?.getSenders().find((s) => s.track?.kind === 'video')
  return sender ? sender.getParameters().encodings?.[0] : undefined
}

test.describe('Video quality', () => {
  test.setTimeout(120_000)

  async function call(browser, quality) {
    const room = `e2e-${Date.now()}-quality-${quality}`
    const contexts = [await browser.newContext(), await browser.newContext()]
    for (const ctx of contexts) {
      await ctx.addInitScript(recordPeerConnections)
      await ctx.addInitScript(([key, value]) => localStorage.setItem(key, value), [QUALITY_KEY, quality])
    }
    const [pageA, pageB] = await Promise.all(contexts.map((c) => c.newPage()))
    await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
    await pageA.waitForTimeout(2500)
    await pageA.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
    await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })
    return { contexts, pageA, pageB }
  }

  test('"max" sends up to 60 fps on a direct connection', async ({ browser }) => {
    const { contexts, pageA, pageB } = await call(browser, 'max')
    try {
      for (const page of [pageA, pageB]) {
        await expect.poll(() => page.evaluate(cameraEncoding), { timeout: 30000 }).toMatchObject({ maxFramerate: 60 })
        const encoding = await page.evaluate(cameraEncoding)
        expect(encoding.maxBitrate).toBeGreaterThanOrEqual(6_000_000)
        expect(encoding.scaleResolutionDownBy).toBe(1)
      }
      // The picture arrives
      const video = pageA.locator('.video-tile:not(:has-text("(you)")) video').first()
      await expect.poll(() => video.evaluate((v) => v.readyState >= 2 && !v.paused), { timeout: 20000 }).toBe(true)
    } finally {
      await Promise.all(contexts.map((c) => c.close()))
    }
  })

  test('the other qualities leave the browser to decide', async ({ browser }) => {
    const { contexts, pageA } = await call(browser, '1080p')
    try {
      const video = pageA.locator('.video-tile:not(:has-text("(you)")) video').first()
      await expect.poll(() => video.evaluate((v) => v.readyState >= 2 && !v.paused), { timeout: 20000 }).toBe(true)
      const encoding = await pageA.evaluate(cameraEncoding)
      expect(encoding?.maxFramerate).toBeUndefined()
      expect(encoding?.maxBitrate).toBeUndefined()
    } finally {
      await Promise.all(contexts.map((c) => c.close()))
    }
  })

  /** Chooses a quality in the settings, as a user would. */
  async function chooseQuality(page, label) {
    await page.getByTitle('Settings').first().click()
    await page.getByText(label, { exact: true }).click()
    await page.getByRole('button', { name: /save/i }).click()
    await expect(page.getByRole('button', { name: /save/i })).toBeHidden({ timeout: 10000 })
  }

  test('changing to "max" in the settings during the call raises the limits, and back lowers them', async ({
    browser,
  }) => {
    const { contexts, pageA } = await call(browser, '1080p')
    try {
      await expect(pageA.locator('.video-tile')).toHaveCount(2, { timeout: 20000 })
      await expect
        .poll(() => pageA.evaluate(() => window.__pcs.some((p) => p.connectionState === 'connected')), {
          timeout: 30000,
        })
        .toBe(true)

      await chooseQuality(pageA, 'Max')
      await expect.poll(() => pageA.evaluate(cameraEncoding), { timeout: 15000 }).toMatchObject({ maxFramerate: 60 })

      await chooseQuality(pageA, '720p')
      await expect
        .poll(() => pageA.evaluate(cameraEncoding).then((e) => e?.maxFramerate), { timeout: 15000 })
        .toBeUndefined()
    } finally {
      await Promise.all(contexts.map((c) => c.close()))
    }
  })
})
