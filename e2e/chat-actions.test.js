// @ts-check
/**
 * E2E tests for chat interactions: edit, delete, reactions, file send.
 * Uses two Chromium contexts connected through the local relay.
 */
import { test, expect } from '@playwright/test'
import { joinQuickRoom, sendMessage, waitForMessage } from './helpers.js'
import { createReadStream } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

function roomCode(suffix) {
  return `e2e-actions-${Date.now()}-${suffix}`
}

/** Hover a message bubble to reveal action buttons, return the bubble locator */
async function hoverMessage(page, text) {
  const bubble = page.locator('.message-bubble', { hasText: text }).last()
  await bubble.hover()
  return bubble
}

// ── Edit message ──────────────────────────────────────────────────────────────

test.describe('Edit message', () => {
  test('edited message is visible to both peers', async ({ browser }) => {
    const room = roomCode('edit')
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([
        joinQuickRoom(pageA, room, 'alice-edit'),
        joinQuickRoom(pageB, room, 'bob-edit'),
      ])
      await pageA.waitForTimeout(2000)

      // Alice sends original message
      await sendMessage(pageA, 'original message')
      await waitForMessage(pageA, 'original message')
      await waitForMessage(pageB, 'original message', 20000)

      // Alice hovers her message and clicks Edit
      await hoverMessage(pageA, 'original message')
      await pageA.getByRole('button', { name: 'Edit message' }).click()

      // Edit textarea appears pre-filled; clear and type new content
      const editArea = pageA.locator('.message-edit-textarea')
      await editArea.clear()
      await editArea.fill('edited message')
      await pageA.getByRole('button', { name: /save/i }).click()

      // Alice sees the edit + "(edited)" label
      await waitForMessage(pageA, 'edited message')
      await expect(pageA.locator('.message-edited-label').first()).toBeVisible()

      // Bob sees the edited version
      await waitForMessage(pageB, 'edited message', 20000)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

// ── Delete message ────────────────────────────────────────────────────────────

test.describe('Delete message', () => {
  test('deleted message shows placeholder for both peers', async ({ browser }) => {
    const room = roomCode('delete')
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([
        joinQuickRoom(pageA, room, 'alice-del'),
        joinQuickRoom(pageB, room, 'bob-del'),
      ])
      await pageA.waitForTimeout(2000)

      await sendMessage(pageA, 'message to delete')
      await waitForMessage(pageA, 'message to delete')
      await waitForMessage(pageB, 'message to delete', 20000)

      // Alice hovers and deletes
      await hoverMessage(pageA, 'message to delete')
      await pageA.getByRole('button', { name: 'Delete message' }).click()

      // Alice sees "Message deleted" placeholder
      await expect(pageA.locator('.message-deleted-label').first()).toBeVisible({ timeout: 5000 })
      // Original text is gone
      await expect(pageA.getByText('message to delete')).toHaveCount(0, { timeout: 5000 })

      // Bob also sees deletion
      await expect(pageB.locator('.message-deleted-label').first()).toBeVisible({ timeout: 20000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

// ── Reactions ─────────────────────────────────────────────────────────────────

test.describe('Reactions', () => {
  test('reaction added by peer A is visible to peer B', async ({ browser }) => {
    const room = roomCode('react')
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([
        joinQuickRoom(pageA, room, 'alice-react'),
        joinQuickRoom(pageB, room, 'bob-react'),
      ])
      await pageA.waitForTimeout(2000)

      // Bob sends a message; Alice will react to it
      await sendMessage(pageB, 'react to this')
      await waitForMessage(pageA, 'react to this', 20000)

      // Alice hovers Bob's message and clicks the reaction trigger
      await hoverMessage(pageA, 'react to this')
      await pageA.getByRole('button', { name: 'Add reaction' }).click()

      // Pick the first emoji in the picker
      const firstEmoji = pageA.locator('.reaction-picker__emoji').first()
      const emojiText = await firstEmoji.textContent()
      await firstEmoji.click()

      // Reaction pill appears on Alice's side
      await expect(pageA.locator('.reaction-pill').first()).toBeVisible({ timeout: 5000 })

      // Bob sees the same reaction pill
      await expect(pageB.locator('.reaction-pill').first()).toBeVisible({ timeout: 20000 })
      await expect(pageB.locator('.reaction-pill').first()).toContainText(emojiText ?? '👍')
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

// ── File / image send ─────────────────────────────────────────────────────────

test.describe('File send', () => {
  test('image received by peer B shows sender name', async ({ browser }) => {
    const room = roomCode('file')

    // Create a minimal 1×1 PNG in /tmp
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d494844520000000100000001080200000090' +
        '7753de0000000c4944415408d76360f8cfc00000000200016b68e48a0000000049454e44ae426082',
      'hex'
    )
    const imgPath = join(tmpdir(), 'playwright-test-img.png')
    await writeFile(imgPath, pngBytes)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await Promise.all([
        joinQuickRoom(pageA, room, 'alice-file'),
        joinQuickRoom(pageB, room, 'bob-file'),
      ])
      // Wait longer for WebRTC data channel to be fully established
      await pageA.waitForTimeout(4000)

      // Use Playwright's file chooser interception
      const [fileChooser] = await Promise.all([
        pageA.waitForEvent('filechooser'),
        pageA.getByRole('button', { name: 'Attach image' }).click(),
      ])
      await fileChooser.setFiles(imgPath)

      // Alice sees the image in her own chat
      await expect(pageA.locator('.message-image').first()).toBeVisible({ timeout: 10000 })

      // Bob receives the image
      await expect(pageB.locator('.message-image').first()).toBeVisible({ timeout: 30000 })

      // Bob sees the sender's name (alice-file) next to the image
      const senderLabel = pageB.locator('.message-sender')
      await expect(senderLabel.filter({ hasText: 'alice-file' })).toBeVisible({ timeout: 10000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
