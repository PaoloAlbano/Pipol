/**
 * autobase.test.js
 * Tests for MessageStore browser-mode helpers:
 *   - receiveMessage (dedup, length truncation, image bypass)
 *   - receiveEdit
 *   - receiveDelete
 *
 * Uses fake-indexeddb so persistMessage's IndexedDB calls don't fail.
 * The Hypercore / Corestore stack is never initialised (init() not called);
 * the methods under test only touch _channelMessages and IndexedDB.
 */

import { IDBFactory } from 'fake-indexeddb'
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/p2p/storage.js', () => ({
  getStore: vi.fn(() => Promise.resolve({})),
  getIdentity: vi.fn(() => ({ username: 'alice', publicKey: new Uint8Array([0xaa, 0xbb]) })),
}))

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

async function getMessageStore() {
  vi.resetModules()
  const { MessageStore } = await import('../../src/p2p/autobase.js')
  const store = new MessageStore('room-test', {
    username: 'alice',
    publicKey: new Uint8Array([0xaa, 0xbb]),
  })
  return store
}

function makeMsg(overrides = {}) {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    content: 'Hello world',
    username: 'bob',
    publicKey: 'bbccdd',
    timestamp: Date.now(),
    type: 'text',
    ...overrides,
  }
}

// ── receiveMessage ────────────────────────────────────────────────────────────

describe('MessageStore — receiveMessage', () => {
  it('adds a valid message to _channelMessages', async () => {
    const store = await getMessageStore()
    const msg = makeMsg()
    store.receiveMessage(msg)
    expect(store._channelMessages).toHaveLength(1)
    expect(store._channelMessages[0].id).toBe(msg.id)
  })

  it('ignores duplicate messages (same id)', async () => {
    const store = await getMessageStore()
    const msg = makeMsg({ id: 'dup-1' })
    store.receiveMessage(msg)
    store.receiveMessage(msg)
    expect(store._channelMessages).toHaveLength(1)
  })

  it('ignores messages without id', async () => {
    const store = await getMessageStore()
    store.receiveMessage({ content: 'no id' })
    expect(store._channelMessages).toHaveLength(0)
  })

  it('truncates text content longer than 10000 chars', async () => {
    const store = await getMessageStore()
    const long = 'x'.repeat(15000)
    store.receiveMessage(makeMsg({ content: long }))
    expect(store._channelMessages[0].content).toHaveLength(10000)
  })

  it('does NOT truncate image messages regardless of content length', async () => {
    const store = await getMessageStore()
    const longData = 'data:image/png;base64,' + 'A'.repeat(20000)
    store.receiveMessage(makeMsg({ type: 'image', content: '', imageData: longData }))
    // content is '' — but the imageData itself is untouched
    expect(store._channelMessages[0].imageData).toBe(longData)
  })
})

// ── receiveEdit ───────────────────────────────────────────────────────────────

describe('MessageStore — receiveEdit', () => {
  it('updates content and marks message as edited', async () => {
    const store = await getMessageStore()
    const msg = makeMsg({ id: 'edit-1', content: 'original' })
    store.receiveMessage(msg)

    store.receiveEdit('edit-1', 'updated content', 9999)

    const updated = store._channelMessages.find((m) => m.id === 'edit-1')
    expect(updated.content).toBe('updated content')
    expect(updated.edited).toBe(true)
    expect(updated.editedAt).toBe(9999)
  })

  it('does nothing when originalId is not found', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg({ id: 'existing' }))
    // Should not throw
    store.receiveEdit('non-existent-id', 'new', 1)
    expect(store._channelMessages).toHaveLength(1)
    expect(store._channelMessages[0].content).toBe('Hello world')
  })

  it('preserves other fields when editing', async () => {
    const store = await getMessageStore()
    const msg = makeMsg({ id: 'edit-2', username: 'bob', publicKey: 'bb' })
    store.receiveMessage(msg)

    store.receiveEdit('edit-2', 'changed', 5000)

    const updated = store._channelMessages.find((m) => m.id === 'edit-2')
    expect(updated.username).toBe('bob')
    expect(updated.publicKey).toBe('bb')
  })
})

// ── receiveDelete ─────────────────────────────────────────────────────────────

describe('MessageStore — receiveDelete', () => {
  it('marks message as deleted and blanks content', async () => {
    const store = await getMessageStore()
    const msg = makeMsg({ id: 'del-1', content: 'sensitive content' })
    store.receiveMessage(msg)

    store.receiveDelete('del-1')

    const deleted = store._channelMessages.find((m) => m.id === 'del-1')
    expect(deleted.deleted).toBe(true)
    expect(deleted.content).toBe('')
  })

  it('does nothing when originalId is not found', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg({ id: 'existing' }))
    store.receiveDelete('ghost-id')
    expect(store._channelMessages[0].deleted).toBeUndefined()
  })

  it('preserves other metadata when deleting', async () => {
    const store = await getMessageStore()
    const msg = makeMsg({ id: 'del-2', username: 'carol', timestamp: 12345 })
    store.receiveMessage(msg)

    store.receiveDelete('del-2')

    const deleted = store._channelMessages.find((m) => m.id === 'del-2')
    expect(deleted.username).toBe('carol')
    expect(deleted.timestamp).toBe(12345)
  })
})
