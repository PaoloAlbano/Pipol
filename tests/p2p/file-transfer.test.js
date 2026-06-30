/**
 * file-transfer.test.js
 * Unit tests for sendImageFile validation and FileReceiver chunk assembly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileReceiver } from '../../src/p2p/file-transfer.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFile({ type = 'image/jpeg', size = 1024, name = 'photo.jpg' } = {}) {
  const buf = new Uint8Array(size)
  return new File([buf], name, { type })
}

function makeIdentity(hex = 'aabb') {
  return { username: 'alice', publicKey: hex }
}

// ── sendImageFile ─────────────────────────────────────────────────────────────

describe('sendImageFile — validation', () => {
  let sendImageFile

  beforeEach(async () => {
    ;({ sendImageFile } = await import('../../src/p2p/file-transfer.js'))
  })

  it('throws for an unsupported MIME type', async () => {
    const swarm = { sendToAll: vi.fn() }
    const file = makeFile({ type: 'application/pdf' })
    await expect(sendImageFile(swarm, file, null, makeIdentity())).rejects.toThrow(/unsupported file type/i)
  })

  it('throws for a file larger than 5 MB', async () => {
    const swarm = { sendToAll: vi.fn() }
    const bigFile = makeFile({ type: 'image/jpeg', size: 6 * 1024 * 1024 })
    await expect(sendImageFile(swarm, bigFile, null, makeIdentity())).rejects.toThrow(/too large/i)
  })

  it('accepts a valid jpeg under 5 MB', async () => {
    const swarm = { sendToAll: vi.fn() }
    // Create a minimal valid JPEG (just a small placeholder)
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const file = new File([jpegBytes], 'test.jpg', { type: 'image/jpeg' })
    const msg = await sendImageFile(swarm, file, 'general', makeIdentity())
    expect(msg.type).toBe('image')
    expect(msg.imageData).toBeTruthy()
    expect(swarm.sendToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'FILE_META' }))
    expect(swarm.sendToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'FILE_CHUNK' }))
  })

  it('sets channelName on FILE_META message', async () => {
    const swarm = { sendToAll: vi.fn() }
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const file = new File([jpegBytes], 'test.jpg', { type: 'image/jpeg' })
    await sendImageFile(swarm, file, 'design', makeIdentity())
    const metaCall = swarm.sendToAll.mock.calls.find((c) => c[0].type === 'FILE_META')
    expect(metaCall[0].channelName).toBe('design')
  })

  it('accepts all allowed MIME types', async () => {
    const types = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    for (const type of types) {
      const swarm = { sendToAll: vi.fn() }
      const file = new File([new Uint8Array(4)], 'img', { type })
      await expect(sendImageFile(swarm, file, null, makeIdentity())).resolves.not.toThrow()
    }
  })
})

// ── FileReceiver ──────────────────────────────────────────────────────────────

describe('FileReceiver — single chunk assembly', () => {
  it('returns null from onChunk until all chunks received', () => {
    const rx = new FileReceiver()
    rx.onMeta({
      fileId: 'f1',
      name: 'a.jpg',
      mimeType: 'image/jpeg',
      size: 4,
      totalChunks: 2,
      channelName: 'ch',
      peerId: 'peer-1',
    })
    const result1 = rx.onChunk({ fileId: 'f1', index: 0, data: 'AAA', peerId: 'peer-1' })
    expect(result1).toBeNull()
  })

  it('returns assembled message when last chunk arrives', () => {
    const rx = new FileReceiver()
    const identity = makeIdentity('aabb')
    rx.onMeta({
      fileId: 'f2',
      name: 'b.png',
      mimeType: 'image/png',
      size: 6,
      totalChunks: 1,
      channelName: 'ch',
      peerId: 'p',
      identity,
    })
    const msg = rx.onChunk({ fileId: 'f2', index: 0, data: 'data:image/png;base64,abc', peerId: 'p' })
    expect(msg).not.toBeNull()
    expect(msg.type).toBe('image')
    expect(msg.imageData).toBe('data:image/png;base64,abc')
    expect(msg.fileName).toBe('b.png')
  })

  it('returns null for unknown fileId', () => {
    const rx = new FileReceiver()
    const result = rx.onChunk({ fileId: 'unknown', index: 0, data: 'x', peerId: 'p' })
    expect(result).toBeNull()
  })
})

describe('FileReceiver — multi-chunk assembly', () => {
  it('assembles chunks in order and returns the full message', () => {
    const rx = new FileReceiver()
    const identity = makeIdentity('ccdd')
    rx.onMeta({
      fileId: 'f3',
      name: 'c.gif',
      mimeType: 'image/gif',
      size: 9,
      totalChunks: 3,
      channelName: null,
      peerId: 'p',
      identity,
    })
    rx.onChunk({ fileId: 'f3', index: 0, data: 'AAA', peerId: 'p' })
    rx.onChunk({ fileId: 'f3', index: 1, data: 'BBB', peerId: 'p' })
    const msg = rx.onChunk({ fileId: 'f3', index: 2, data: 'CCC', peerId: 'p' })
    expect(msg.imageData).toBe('AAABBBCCC')
  })

  it('ignores duplicate chunks', () => {
    const rx = new FileReceiver()
    const identity = makeIdentity()
    rx.onMeta({
      fileId: 'f4',
      name: 'd.jpg',
      mimeType: 'image/jpeg',
      size: 6,
      totalChunks: 2,
      channelName: null,
      peerId: 'p',
      identity,
    })
    rx.onChunk({ fileId: 'f4', index: 0, data: 'AAA', peerId: 'p' })
    rx.onChunk({ fileId: 'f4', index: 0, data: 'DUPE', peerId: 'p' }) // duplicate — ignored
    const msg = rx.onChunk({ fileId: 'f4', index: 1, data: 'BBB', peerId: 'p' })
    expect(msg.imageData).toBe('AAABBB')
  })
})

describe('FileReceiver — evict', () => {
  it('removes in-progress transfers for a disconnected peer', () => {
    const rx = new FileReceiver()
    rx.onMeta({
      fileId: 'f5',
      name: 'e.jpg',
      mimeType: 'image/jpeg',
      size: 4,
      totalChunks: 2,
      channelName: null,
      peerId: 'leaving-peer',
    })
    rx.evict('leaving-peer')
    const result = rx.onChunk({ fileId: 'f5', index: 0, data: 'x', peerId: 'leaving-peer' })
    expect(result).toBeNull()
  })

  it('does not affect transfers from other peers', () => {
    const rx = new FileReceiver()
    const identity = makeIdentity()
    rx.onMeta({
      fileId: 'fa',
      name: 'a.jpg',
      mimeType: 'image/jpeg',
      size: 1,
      totalChunks: 1,
      channelName: null,
      peerId: 'stay',
      identity,
    })
    rx.onMeta({
      fileId: 'fb',
      name: 'b.jpg',
      mimeType: 'image/jpeg',
      size: 1,
      totalChunks: 1,
      channelName: null,
      peerId: 'go',
      identity,
    })
    rx.evict('go')
    const msg = rx.onChunk({ fileId: 'fa', index: 0, data: 'X', peerId: 'stay' })
    expect(msg).not.toBeNull()
  })
})
