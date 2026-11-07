// @ts-check
/**
 * A call survives a change of network: the connection restarts ICE (new credentials, new candidates) and the video
 * keeps flowing. The restart is provoked by the "online" event the browser fires when a device gets its network
 * back; both ends restarting at the same time must work too.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom } from './helpers.js'

/** Keeps every RTCPeerConnection of the page, to look at the one that carries the call. */
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

/** ICE username fragment of our side of the call connection: it changes when ICE restarts. */
function callUfrag() {
  const pc = window.__pcs.find(
    (p) => p.connectionState === 'connected' && p.getSenders().some((s) => s.track?.kind === 'video')
  )
  return pc ? /a=ice-ufrag:(\S+)/.exec(pc.localDescription?.sdp ?? '')?.[1] : undefined
}

function callState() {
  const pc = window.__pcs.find(
    (p) => p.getSenders().some((s) => s.track?.kind === 'video') && p.connectionState !== 'closed'
  )
  return pc?.connectionState
}

/** The remote video moves on: its clock advances. */
async function remoteVideoPlays(page) {
  const video = page.locator('.video-tile:not(:has-text("(you)")) video').first()
  const before = await video.evaluate((v) => v.currentTime)
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 15000 }).toBeGreaterThan(before)
}

test.describe('ICE restart', () => {
  test.setTimeout(120_000)

  async function startCall(browser) {
    const room = `e2e-${Date.now()}-restart`
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await ctxA.addInitScript(recordPeerConnections)
    await ctxB.addInitScript(recordPeerConnections)
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
    await pageA.waitForTimeout(2500)
    await pageA.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
    await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })
    await expect.poll(() => pageA.evaluate(callState), { timeout: 30000 }).toBe('connected')
    await expect.poll(() => pageB.evaluate(callState), { timeout: 30000 }).toBe('connected')
    await remoteVideoPlays(pageA)
    await remoteVideoPlays(pageB)
    return { ctxA, ctxB, pageA, pageB }
  }

  test('one side comes back online: new ICE credentials on both sides, video still flowing', async ({ browser }) => {
    const { ctxA, ctxB, pageA, pageB } = await startCall(browser)
    try {
      const before = { a: await pageA.evaluate(callUfrag), b: await pageB.evaluate(callUfrag) }
      expect(before.a).toBeTruthy()

      await pageA.evaluate(() => window.dispatchEvent(new Event('online')))

      await expect.poll(() => pageA.evaluate(callUfrag), { timeout: 20000 }).not.toBe(before.a)
      await expect.poll(() => pageB.evaluate(callUfrag), { timeout: 20000 }).not.toBe(before.b)
      await expect.poll(() => pageA.evaluate(callState), { timeout: 20000 }).toBe('connected')
      await remoteVideoPlays(pageA)
      await remoteVideoPlays(pageB)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('both sides restart at the same time and still end up connected', async ({ browser }) => {
    const { ctxA, ctxB, pageA, pageB } = await startCall(browser)
    try {
      const before = { a: await pageA.evaluate(callUfrag), b: await pageB.evaluate(callUfrag) }

      await Promise.all([pageA, pageB].map((p) => p.evaluate(() => window.dispatchEvent(new Event('online')))))

      await expect.poll(() => pageA.evaluate(callUfrag), { timeout: 20000 }).not.toBe(before.a)
      await expect.poll(() => pageB.evaluate(callUfrag), { timeout: 20000 }).not.toBe(before.b)
      await expect.poll(() => pageA.evaluate(callState), { timeout: 20000 }).toBe('connected')
      await expect.poll(() => pageB.evaluate(callState), { timeout: 20000 }).toBe('connected')
      await remoteVideoPlays(pageA)
      await remoteVideoPlays(pageB)
      // The call is still there on both sides
      await expect(pageA.locator('.video-tile')).toHaveCount(2)
      await expect(pageB.locator('.video-tile')).toHaveCount(2)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
