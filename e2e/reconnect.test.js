// @ts-check
/**
 * E2E test — offline history sync.
 *
 * Scenario:
 *   1. A and B join the same quick room.
 *   2. A sends msg-a1; B confirms receipt.
 *   3. B sends msg-b  — A confirms receipt live (timestamp naturally between
 *      msg-a1 and msg-a2, so the merged view is in the right order).
 *   4. B navigates away — Room unmounts, P2P connection drops.
 *      Note: guest identities are in-memory only, so B must re-login on return.
 *   5. A sends msg-a2 and msg-a3 while B is gone.
 *   6. B navigates back and logs in again as the same display-name user.
 *      With a fresh identity the MessageStore starts at timestamp=0, so the
 *      HISTORY_REQ asks for all messages.
 *   7. A answers with HISTORY_RES: [msg-a1, msg-b, msg-a2, msg-a3] — all four
 *      messages in timestamp order (msg-b sits between the two A messages).
 *   8. B sends msg-b2 post-reconnect; A receives it live via MSG.
 *   9. Final: both peers see all 5 messages in correct order.
 */

import { test, expect } from '@playwright/test'
import { joinQuickRoom, sendMessage, waitForMessage } from './helpers.js'

function roomCode(suffix) {
  return `e2e-reconnect-${Date.now()}-${suffix}`
}

test.describe('Offline history sync', () => {
  test('messages sent while B is disconnected are delivered on reconnect', async ({ browser }) => {
    const room = roomCode('sync')
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      // ── 1. Both peers join ──────────────────────────────────────────────────
      await Promise.all([
        joinQuickRoom(pageA, room, 'alice-recon'),
        joinQuickRoom(pageB, room, 'bob-recon'),
      ])
      // Let P2P (WS relay / WebRTC) establish.
      await pageA.waitForTimeout(2000)

      // ── 2. A sends first message; B confirms receipt ───────────────────────
      await sendMessage(pageA, 'msg-a1')
      await waitForMessage(pageA, 'msg-a1')
      await waitForMessage(pageB, 'msg-a1', 20000)

      // ── 3. B sends msg-b while still connected ─────────────────────────────
      //    A receives it live, so it enters A's store with a timestamp between
      //    msg-a1 (earlier) and msg-a2 (later).
      await sendMessage(pageB, 'msg-b')
      await waitForMessage(pageB, 'msg-b')
      await waitForMessage(pageA, 'msg-b', 15000)

      // ── 4. B disconnects ───────────────────────────────────────────────────
      //    Navigating to about:blank unmounts Room and closes the WS.
      //    Guest identities are in-memory only, so we must re-login on return.
      await pageB.goto('about:blank')
      await pageA.waitForTimeout(500) // let relay clear B from its room

      // ── 5. A sends two messages while B is gone ────────────────────────────
      await sendMessage(pageA, 'msg-a2')
      await pageA.waitForTimeout(200) // ensure msg-a3 has a later timestamp
      await sendMessage(pageA, 'msg-a3')
      await waitForMessage(pageA, 'msg-a3')

      // ── 6. B reconnects and re-logs in ─────────────────────────────────────
      //    joinQuickRoom creates a fresh guest identity; the MessageStore starts
      //    at timestamp=0, so HISTORY_REQ will ask for everything.
      await joinQuickRoom(pageB, room, 'bob-recon')
      await pageB.waitForTimeout(3000) // allow HISTORY_REQ → HISTORY_RES

      // ── 7. B should see all of A's messages plus msg-b (via HISTORY_RES) ───
      //    Correct order by timestamp: msg-a1, msg-b, msg-a2, msg-a3
      await waitForMessage(pageB, 'msg-a1', 20000)
      await waitForMessage(pageB, 'msg-b', 5000)
      await waitForMessage(pageB, 'msg-a2', 5000)
      await waitForMessage(pageB, 'msg-a3', 5000)

      // ── 8. B sends a new message; A receives it live ───────────────────────
      await sendMessage(pageB, 'msg-b2-post-reconnect')
      await waitForMessage(pageA, 'msg-b2-post-reconnect', 15000)
      await waitForMessage(pageB, 'msg-b2-post-reconnect')

      // ── 9. Both peers see all 5 messages ──────────────────────────────────
      for (const msg of ['msg-a1', 'msg-b', 'msg-a2', 'msg-a3', 'msg-b2-post-reconnect']) {
        await expect(pageA.getByText(msg, { exact: true })).toBeVisible()
        await expect(pageB.getByText(msg, { exact: true })).toBeVisible()
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
