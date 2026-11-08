// @ts-check
/**
 * A call whose connection fails for good connects again by itself, and the tile says what is going on meanwhile.
 *
 * The failure is simulated on one side: its call connection is made to report "failed" (the real one keeps
 * working, as the other side's does). That side restarts ICE a few times, gives up, makes a new connection, and
 * the other side, which never noticed anything, replaces its old connection when the new offer arrives.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom, sendMessage, waitForMessage } from './helpers.js'

/** Keeps every RTCPeerConnection of the page, and tells which ones carry the call (those with our camera). */
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

  // Not counting the ones we made fail
  window.__liveCall = () =>
    window.__pcs.filter(
      (p) => !p.__failed && p.connectionState !== 'closed' && p.getSenders().some((s) => s.track?.kind === 'video')
    )
  // The connection of the chat (it has the data channel and no camera)
  window.__chatLink = () =>
    window.__pcs.filter(
      (p) =>
        !p.__failed &&
        p.connectionState !== 'closed' &&
        p.sctp &&
        !p.getSenders().some((s) => s.track?.kind === 'video')
    )
}

const callState = () => window.__liveCall()[0]?.connectionState

/** Makes the connection of the chat report "failed", as it does on a phone that cannot reach the other peer. */
function failTheChatLink() {
  const pc = window.__chatLink()[0]
  pc.__failed = true
  Object.defineProperty(pc, 'connectionState', { get: () => 'failed', configurable: true })
  pc.dispatchEvent(new Event('connectionstatechange'))
}

/** Makes the call connection report "failed", as if ICE had given up on it. */
function failTheCall() {
  const pc = window.__liveCall()[0]
  pc.__failed = true
  Object.defineProperty(pc, 'connectionState', { get: () => 'failed', configurable: true })
  pc.dispatchEvent(new Event('connectionstatechange'))
}

async function remoteVideoPlays(page) {
  const video = page.locator('.video-tile:not(:has-text("(you)")) video').first()
  await expect(video).toHaveCount(1, { timeout: 20000 })
  const before = await video.evaluate((v) => v.currentTime)
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 20000 }).toBeGreaterThan(before)
}

test.describe('Reconnecting', () => {
  test.setTimeout(180_000)

  test('a call whose connection fails connects again by itself, saying so on the tile', async ({ browser }) => {
    const room = `e2e-${Date.now()}-reconnect`
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await ctxA.addInitScript(recordPeerConnections)
    await ctxB.addInitScript(recordPeerConnections)
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
      await pageA.waitForTimeout(2500)
      await pageA.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
      await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })
      await expect.poll(() => pageA.evaluate(callState), { timeout: 30000 }).toBe('connected')
      await expect.poll(() => pageB.evaluate(callState), { timeout: 30000 }).toBe('connected')
      await remoteVideoPlays(pageA)
      await remoteVideoPlays(pageB)

      await pageA.evaluate(failTheCall)

      // While it is being recovered, Alice's tile of Bob says so
      await expect(pageA.getByText('Reconnecting…')).toBeVisible({ timeout: 15000 })

      // After the restarts did not help, a new connection is made, and the picture comes back on both sides
      await expect(pageA.getByText('Reconnecting…')).toBeHidden({ timeout: 120000 })
      await expect.poll(() => pageA.evaluate(callState), { timeout: 30000 }).toBe('connected')
      await expect.poll(() => pageB.evaluate(callState), { timeout: 30000 }).toBe('connected')
      await remoteVideoPlays(pageA)
      await remoteVideoPlays(pageB)
      await expect(pageA.locator('.video-tile')).toHaveCount(2)
      await expect(pageB.locator('.video-tile')).toHaveCount(2)
      expect(await pageA.evaluate(() => window.__liveCall().length)).toBe(1)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('the call and the chat go on when the WebRTC link of the chat fails (a phone on 4G)', async ({ browser }) => {
    const room = `e2e-${Date.now()}-chat-link`
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    await ctxA.addInitScript(recordPeerConnections)
    await ctxB.addInitScript(recordPeerConnections)
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
      await pageA.waitForTimeout(2500)
      await pageA.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
      await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })
      await expect.poll(() => pageA.evaluate(callState), { timeout: 30000 }).toBe('connected')
      await expect.poll(() => pageB.evaluate(callState), { timeout: 30000 }).toBe('connected')
      await expect.poll(() => pageA.evaluate(() => window.__chatLink().length), { timeout: 30000 }).toBe(1)
      await remoteVideoPlays(pageA)

      // The link of the chat to the other peer cannot be kept. Only the chat needs it: the call and the
      // presence in the room must not be taken for the peer leaving.
      await pageA.evaluate(failTheChatLink)
      await pageA.waitForTimeout(3000)

      await expect(pageA.locator('.video-tile')).toHaveCount(2)
      await expect(pageA.locator('.peer-item')).toHaveCount(2)
      await expect(pageA.getByText('Reconnecting…')).toHaveCount(0)
      expect(await pageA.evaluate(callState)).toBe('connected')
      await remoteVideoPlays(pageA)

      // The chat goes on, through the relay
      const toBob = `hello bob ${Date.now()}`
      await sendMessage(pageA, toBob)
      await waitForMessage(pageB, toBob, 20000)
      const toAlice = `hello alice ${Date.now()}`
      await sendMessage(pageB, toAlice)
      await waitForMessage(pageA, toAlice, 20000)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('once the call works nothing is left over the tiles', async ({ browser }) => {
    const room = `e2e-${Date.now()}-connecting`
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
      await pageA.waitForTimeout(2500)
      await pageA.getByRole('button', { name: /start video call/i }).click({ timeout: 15000 })
      await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20000 })

      // Whatever the speed, once it works nothing is left over the tiles
      await remoteVideoPlays(pageA)
      await expect(pageA.locator('.video-status')).toHaveCount(0)
      await expect(pageB.locator('.video-status')).toHaveCount(0)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
