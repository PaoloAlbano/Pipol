// @ts-check
/**
 * P2P chat tests — two browser contexts connected through the local relay.
 *
 * Both browsers use the same relay (localhost:8787 via Vite proxy /signal)
 * and join the same room code, which makes RoomSwarm pair them via WebRTC.
 *
 * Architecture:
 *   Browser A  →  ws://localhost:5173/signal  →  relay:8787  ←  Browser B
 *   (Vite proxy transparently forwards /signal → relay)
 */
import { test, expect, chromium } from '@playwright/test'
import { joinQuickRoom, sendMessage, waitForMessage } from './helpers.js'

// Use a unique room code per test run to avoid cross-test interference
function roomCode(suffix) {
  return `e2e-${Date.now()}-${suffix}`
}

test.describe('P2P quick room — two peers', () => {
  test('message sent by peer A is visible to peer B', async ({ browser }) => {
    const room = roomCode('basic')

    // Two isolated browser contexts = separate localStorage = separate identities
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      // Both join the same room
      await Promise.all([
        joinQuickRoom(pageA, room, 'alice-e2e'),
        joinQuickRoom(pageB, room, 'bob-e2e'),
      ])

      // Wait a moment for WebRTC to establish the data channel
      await pageA.waitForTimeout(2000)

      // Alice sends a message
      const msg = `hello from alice ${Date.now()}`
      await sendMessage(pageA, msg)

      // Alice sees her own message immediately
      await waitForMessage(pageA, msg)

      // Bob eventually receives it via the data channel
      await waitForMessage(pageB, msg, 20000)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('message sent by peer B is visible to peer A', async ({ browser }) => {
    const room = roomCode('reverse')

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([
        joinQuickRoom(pageA, room, 'alice-rev'),
        joinQuickRoom(pageB, room, 'bob-rev'),
      ])

      await pageB.waitForTimeout(2000)

      const msg = `hello from bob ${Date.now()}`
      await sendMessage(pageB, msg)

      await waitForMessage(pageB, msg)
      await waitForMessage(pageA, msg, 20000)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('both peers exchange messages in order', async ({ browser }) => {
    const room = roomCode('exchange')

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([
        joinQuickRoom(pageA, room, 'alice-ex'),
        joinQuickRoom(pageB, room, 'bob-ex'),
      ])

      await pageA.waitForTimeout(2000)

      const msgA = `from alice ${Date.now()}`
      const msgB = `from bob ${Date.now() + 1}`

      await sendMessage(pageA, msgA)
      await waitForMessage(pageB, msgA, 20000)

      await sendMessage(pageB, msgB)
      await waitForMessage(pageA, msgB, 20000)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
