// @ts-check
/**
 * E2E: chat when WebRTC cannot connect, so every message goes through the relay WebSocket.
 *
 * The browsers are given a RTCPeerConnection that may only use relay candidates and has no TURN server, which
 * is what a symmetric NAT without TURN looks like: the data channel never opens. The test checks that chat
 * still works through the relay (messages, edits) and that the relay only ever receives sealed payloads.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom, sendMessage, waitForMessage } from './helpers.js'

const BLOCK_WEBRTC = () => {
  const Native = window.RTCPeerConnection
  window.__openDataChannels = 0
  window.RTCPeerConnection = class extends Native {
    constructor(config = {}) {
      super({ ...config, iceServers: [], iceTransportPolicy: 'relay' })
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args)
      channel.addEventListener('open', () => window.__openDataChannels++)
      return channel
    }
  }
}

/** A browser context with no usable WebRTC, and the frames it sends to the relay recorded. */
async function newBlockedPage(browser) {
  const context = await browser.newContext()
  await context.addInitScript(BLOCK_WEBRTC)
  const page = await context.newPage()
  /** @type {string[]} */
  const sent = []
  page.on('websocket', (ws) => {
    if (ws.url().includes('/signal')) ws.on('framesent', (frame) => sent.push(String(frame.payload)))
  })
  return { context, page, sent }
}

async function openMessageMenu(page, text) {
  const row = page.locator('.message-row', { hasText: text }).last()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await row.getByRole('button', { name: 'Message actions' }).click({ force: true })
}

test.describe('Chat through the relay (no WebRTC)', () => {
  test('messages and edits reach the other peer, and the relay only sees sealed data', async ({ browser }) => {
    const room = `e2e-relay-${Date.now()}`
    const a = await newBlockedPage(browser)
    const b = await newBlockedPage(browser)

    try {
      await Promise.all([joinQuickRoom(a.page, room, 'alice-relay'), joinQuickRoom(b.page, room, 'bob-relay')])
      await a.page.waitForTimeout(2000)

      const fromAlice = `through the relay ${Date.now()} alice`
      const fromBob = `through the relay ${Date.now()} bob`

      await sendMessage(a.page, fromAlice)
      await waitForMessage(b.page, fromAlice, 20000)
      await sendMessage(b.page, fromBob)
      await waitForMessage(a.page, fromBob, 20000)

      // Alice edits her message: a signed operation, also carried by the relay
      await openMessageMenu(a.page, fromAlice)
      await a.page.getByRole('menuitem', { name: /edit/i }).click()
      const edited = `edited through the relay ${Date.now()}`
      await a.page.locator('.message-edit-textarea').fill(edited)
      await a.page.getByRole('button', { name: /save/i }).click()
      await waitForMessage(b.page, edited, 20000)

      // WebRTC really was out of the picture: no data channel ever opened
      expect(await a.page.evaluate(() => window.__openDataChannels)).toBe(0)
      expect(await b.page.evaluate(() => window.__openDataChannels)).toBe(0)

      // The relay saw the room only as a hash, and none of the content, names or call setup
      const frames = [...a.sent, ...b.sent]
      expect(frames.length).toBeGreaterThan(0)
      const join = frames.map((f) => JSON.parse(f)).find((f) => f.type === 'join')
      expect(join.room).toMatch(/^[0-9a-f]{64}$/)
      const seen = frames.join('\n')
      for (const secret of [room, fromAlice, fromBob, edited, 'alice-relay', 'bob-relay', 'fingerprint', 'v=0']) {
        expect(seen).not.toContain(secret)
      }
    } finally {
      await a.context.close()
      await b.context.close()
    }
  })
})
