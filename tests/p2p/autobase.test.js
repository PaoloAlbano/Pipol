/**
 * autobase.test.js
 * Tests for the signed message store:
 *   - receiveMessage accepts only messages signed by their author, and keeps only the signed fields
 *   - edits and deletions apply only when signed by the author of the message
 *   - history given to peers carries the signed operations
 *   - blocks of other peers' Hypercore cores are verified; our own old messages are signed on load
 *
 * Uses fake-indexeddb so persistMessage's IndexedDB calls don't fail.
 */

import { IDBFactory } from 'fake-indexeddb'
import * as crypto from 'hypercore-crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { signMessage, signOp, toHex } from '../../src/p2p/signing.js'

const SCOPE = 'room-test'

const mocks = vi.hoisted(() => ({ store: null }))

vi.mock('../../src/p2p/storage.js', () => ({
  getStore: vi.fn(() => Promise.resolve(mocks.store ?? {})),
  getIdentity: vi.fn(() => ({ username: 'alice' })),
}))

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  mocks.store = null
})

function makeUser(username) {
  const { publicKey, secretKey } = crypto.keyPair()
  return { publicKey, secretKey, username, hex: toHex(publicKey) }
}

const alice = makeUser('alice')
const bob = makeUser('bob')
const carol = makeUser('carol')

async function getMessageStore(user = alice, scope = SCOPE) {
  vi.resetModules()
  const { MessageStore } = await import('../../src/p2p/autobase.js')
  return new MessageStore(scope, user)
}

/** A message written and signed by `author`. */
function makeMsg(author = bob, overrides = {}, scope = SCOPE) {
  const msg = {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    content: 'Hello world',
    username: author.username,
    publicKey: author.hex,
    timestamp: Date.now(),
    type: 'text',
    ...overrides,
  }
  msg.sig = signMessage(scope, msg, author.secretKey)
  return msg
}

const edit = (author, originalId, newContent, editedAt, scope = SCOPE) =>
  signOp('edit', scope, { originalId, newContent, editedAt }, author)
const del = (author, originalId, scope = SCOPE) => signOp('delete', scope, { originalId }, author)

async function shown(store, id) {
  return (await store.getHistory()).find((m) => m.id === id)
}

// ── receiveMessage ────────────────────────────────────────────────────────────

describe('MessageStore — receiveMessage', () => {
  it('adds a message signed by its author', async () => {
    const store = await getMessageStore()
    const msg = makeMsg()
    store.receiveMessage(msg)
    expect(store._channelMessages).toHaveLength(1)
    expect(store._channelMessages[0].id).toBe(msg.id)
  })

  it('ignores duplicate messages (same id)', async () => {
    const store = await getMessageStore()
    const msg = makeMsg(bob, { id: 'dup-1' })
    store.receiveMessage(msg)
    store.receiveMessage(msg)
    expect(store._channelMessages).toHaveLength(1)
  })

  it('ignores messages without id', async () => {
    const store = await getMessageStore()
    store.receiveMessage({ content: 'no id' })
    store.receiveMessage(null)
    expect(store._channelMessages).toHaveLength(0)
  })

  it('drops a message without a signature (for instance from a client that predates signatures)', async () => {
    const store = await getMessageStore()
    const { sig: _sig, ...unsigned } = makeMsg()
    store.receiveMessage(unsigned)
    expect(store._channelMessages).toHaveLength(0)
  })

  it('drops a message that claims another author than the one who signed it', async () => {
    const store = await getMessageStore()
    const forged = { ...makeMsg(bob), publicKey: carol.hex, username: 'carol' }
    store.receiveMessage(forged)
    expect(store._channelMessages).toHaveLength(0)
  })

  it('drops a message whose content was changed after signing', async () => {
    const store = await getMessageStore()
    store.receiveMessage({ ...makeMsg(), content: 'something else' })
    expect(store._channelMessages).toHaveLength(0)
  })

  it('drops a message signed for another room', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, {}, 'another-room'))
    expect(store._channelMessages).toHaveLength(0)
  })

  it('drops a signed text message longer than 10000 chars', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, { content: 'x'.repeat(15000) }))
    expect(store._channelMessages).toHaveLength(0)
  })

  it('accepts image messages regardless of content length, and binds the signature to the image', async () => {
    const store = await getMessageStore()
    const imageData = 'data:image/png;base64,' + 'A'.repeat(20000)
    const msg = makeMsg(bob, { type: 'image', content: '', imageData, fileName: 'a.png', fileSize: 12 })
    store.receiveMessage(msg)
    expect(store._channelMessages[0].imageData).toBe(imageData)

    const other = await getMessageStore()
    other.receiveMessage({ ...msg, id: msg.id, imageData: 'data:image/png;base64,BBBB' })
    expect(other._channelMessages).toHaveLength(0)
  })

  it('keeps only the signed fields: flags added by the sender are dropped', async () => {
    const store = await getMessageStore()
    const msg = makeMsg()
    store.receiveMessage({ ...msg, deleted: true, edited: true, editedAt: 1, evil: 'x' })
    const [kept] = store._channelMessages
    expect(kept.deleted).toBeUndefined()
    expect(kept.edited).toBeUndefined()
    expect(kept.evil).toBeUndefined()
    expect(kept.content).toBe('Hello world')
  })
})

// ── Edits ─────────────────────────────────────────────────────────────────────

describe('MessageStore — receiveEdit', () => {
  it("applies the author's edit and marks the message as edited", async () => {
    const store = await getMessageStore()
    const msg = makeMsg(bob, { id: 'edit-1', content: 'original' })
    store.receiveMessage(msg)

    store.receiveEdit(edit(bob, 'edit-1', 'updated content', 9999))

    const m = await shown(store, 'edit-1')
    expect(m.content).toBe('updated content')
    expect(m.edited).toBe(true)
    expect(m.editedAt).toBe(9999)
    expect(m.username).toBe('bob')
  })

  it('ignores an edit signed by somebody who is not the author', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, { id: 'edit-2', content: 'original' }))

    store.receiveEdit(edit(carol, 'edit-2', 'carol was here', 9999))

    expect((await shown(store, 'edit-2')).content).toBe('original')
  })

  it('applies an edit that arrives before the message, but never one by another member', async () => {
    const store = await getMessageStore()
    store.receiveEdit(edit(carol, 'late-1', 'carol was here', 5000))
    store.receiveEdit(edit(bob, 'late-1', 'by the author', 6000))
    store.receiveMessage(makeMsg(bob, { id: 'late-1', content: 'original' }))

    expect((await shown(store, 'late-1')).content).toBe('by the author')
  })

  it('keeps the latest edit and ignores older ones', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, { id: 'edit-3', content: 'original' }))

    store.receiveEdit(edit(bob, 'edit-3', 'second', 2000))
    store.receiveEdit(edit(bob, 'edit-3', 'first', 1000))

    expect((await shown(store, 'edit-3')).content).toBe('second')
  })

  it('rejects a tampered edit, one signed for another room and one without signature', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, { id: 'edit-4', content: 'original' }))

    store.receiveEdit({ ...edit(bob, 'edit-4', 'ok', 1000), newContent: 'tampered' })
    store.receiveEdit(edit(bob, 'edit-4', 'other room', 1000, 'another-room'))
    store.receiveEdit({ originalId: 'edit-4', newContent: 'unsigned', editedAt: 1000, publicKey: bob.hex })

    expect((await shown(store, 'edit-4')).content).toBe('original')
  })

  it('does not throw for a message it does not know', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, { id: 'existing' }))
    expect(() => store.receiveEdit(edit(bob, 'non-existent-id', 'new', 1))).not.toThrow()
    expect((await shown(store, 'existing')).content).toBe('Hello world')
  })
})

// ── Deletions ─────────────────────────────────────────────────────────────────

describe('MessageStore — receiveDelete', () => {
  it("applies the author's deletion: content blanked, message flagged, metadata kept", async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, { id: 'del-1', content: 'sensitive content', timestamp: 12345 }))

    store.receiveDelete(del(bob, 'del-1'))

    const m = await shown(store, 'del-1')
    expect(m.deleted).toBe(true)
    expect(m.content).toBe('')
    expect(m.username).toBe('bob')
    expect(m.timestamp).toBe(12345)
  })

  it('ignores a deletion signed by somebody who is not the author', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, { id: 'del-2', content: 'keep me' }))

    store.receiveDelete(del(carol, 'del-2'))

    const m = await shown(store, 'del-2')
    expect(m.deleted).toBeUndefined()
    expect(m.content).toBe('keep me')
  })

  it('wins over an edit, whatever the order', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, { id: 'del-3', content: 'original' }))
    store.receiveDelete(del(bob, 'del-3'))
    store.receiveEdit(edit(bob, 'del-3', 'back from the dead', 9000))

    const m = await shown(store, 'del-3')
    expect(m.deleted).toBe(true)
    expect(m.content).toBe('')
  })

  it('does nothing for an unknown message and for a forged deletion', async () => {
    const store = await getMessageStore()
    store.receiveMessage(makeMsg(bob, { id: 'existing' }))
    store.receiveDelete(del(bob, 'ghost-id'))
    store.receiveDelete({ ...del(bob, 'existing'), sig: 'f'.repeat(128) })
    expect((await shown(store, 'existing')).deleted).toBeUndefined()
  })
})

// ── Our own messages, edits and deletions ─────────────────────────────────────

describe('MessageStore — our own messages', () => {
  async function ownStore() {
    const store = await getMessageStore(alice)
    store._localCore = { append: vi.fn(() => Promise.resolve()) }
    return store
  }

  it('signs what it writes', async () => {
    const store = await ownStore()
    const msg = await store.addMessage('hi there')
    const other = await getMessageStore(bob)
    other.receiveMessage(msg)
    expect(other._channelMessages).toHaveLength(1)
    expect(other._channelMessages[0].publicKey).toBe(alice.hex)
  })

  it('edits and deletes them with signed operations the others accept', async () => {
    const store = await ownStore()
    const msg = await store.addMessage('first version')
    const other = await getMessageStore(bob)
    other.receiveMessage(msg)

    const editOp = store.createEdit(msg.id, 'second version')
    expect((await shown(store, msg.id)).content).toBe('second version')
    other.receiveEdit(editOp)
    expect((await shown(other, msg.id)).content).toBe('second version')

    const delOp = store.createDelete(msg.id)
    other.receiveDelete(delOp)
    expect((await shown(store, msg.id)).deleted).toBe(true)
    expect((await shown(other, msg.id)).deleted).toBe(true)
  })

  it('numbers its edits so two in the same millisecond are both applied in order', async () => {
    const store = await ownStore()
    const msg = await store.addMessage('v0')
    vi.spyOn(Date, 'now').mockReturnValue(5000)
    const first = store.createEdit(msg.id, 'v1')
    const second = store.createEdit(msg.id, 'v2')
    vi.restoreAllMocks()
    expect(second.editedAt).toBeGreaterThan(first.editedAt)
    expect((await shown(store, msg.id)).content).toBe('v2')
  })

  it('cannot edit or delete the message of somebody else', async () => {
    const store = await ownStore()
    store.receiveMessage(makeMsg(bob, { id: 'bobs', content: 'bob wrote this' }))
    store.createEdit('bobs', 'hijacked')
    store.createDelete('bobs')
    const m = await shown(store, 'bobs')
    expect(m.content).toBe('bob wrote this')
    expect(m.deleted).toBeUndefined()
  })
})

// ── History given to peers ────────────────────────────────────────────────────

describe('MessageStore — getSignedHistory', () => {
  it('carries the signed edit and delete operations, and the receiver verifies them', async () => {
    const store = await getMessageStore(alice)
    store.receiveMessage(makeMsg(bob, { id: 'h-1', content: 'one' }))
    store.receiveMessage(makeMsg(bob, { id: 'h-2', content: 'two' }))
    store.receiveEdit(edit(bob, 'h-1', 'one, edited', 7000))
    store.receiveDelete(del(bob, 'h-2'))

    const history = await store.getSignedHistory()
    const fresh = await getMessageStore(carol)
    history.forEach((m) => fresh.receiveMessage(m))

    const one = await shown(fresh, 'h-1')
    expect(one.content).toBe('one, edited')
    expect(one.edited).toBe(true)
    expect((await shown(fresh, 'h-2')).deleted).toBe(true)
  })

  it('keeps the original signed content, so the signature still verifies after an edit', async () => {
    const store = await getMessageStore(alice)
    store.receiveMessage(makeMsg(bob, { id: 'h-3', content: 'original' }))
    store.receiveEdit(edit(bob, 'h-3', 'edited', 7000))
    const [m] = await store.getSignedHistory()
    expect(m.content).toBe('original')
    expect(m.edit.newContent).toBe('edited')
  })

  it('does not hand out a forged edit attached to a message', async () => {
    const store = await getMessageStore(alice)
    const msg = makeMsg(bob, { id: 'h-4', content: 'original' })
    store.receiveMessage({
      ...msg,
      edit: { newContent: 'forged', editedAt: 9000, publicKey: bob.hex, sig: 'a'.repeat(128) },
    })
    expect((await shown(store, 'h-4')).content).toBe('original')
    expect((await store.getSignedHistory())[0].edit).toBeUndefined()
  })

  it('learns an edit from a copy of a message it already has', async () => {
    const store = await getMessageStore(alice)
    const msg = makeMsg(bob, { id: 'h-5', content: 'original' })
    store.receiveMessage(msg)
    const { edit: op } = { edit: edit(bob, 'h-5', 'later edit', 8000) }
    const { originalId: _o, ...body } = op
    store.receiveMessage({ ...msg, edit: body })
    expect((await shown(store, 'h-5')).content).toBe('later edit')
  })

  it('leaves out messages that are not signed', async () => {
    const store = await getMessageStore(alice)
    store._channelMessages.push({ id: 'old', content: 'from before signatures', publicKey: bob.hex, timestamp: 1 })
    expect(await store.getSignedHistory()).toEqual([])
    expect((await store.getHistory()).map((m) => m.id)).toEqual(['old'])
  })
})

// ── Hypercore blocks and persisted messages ───────────────────────────────────

describe('MessageStore — Hypercore cores and local storage', () => {
  const fakeCore = (blocks) => ({ length: blocks.length, get: (i) => Promise.resolve(blocks[i]) })

  it("shows only the blocks of other peers' cores that are signed by the author", async () => {
    const store = await getMessageStore(alice)
    const good = makeMsg(bob, { id: 'core-ok' })
    const { sig: _s, ...unsigned } = makeMsg(bob, { id: 'core-unsigned' })
    const forged = { ...makeMsg(bob, { id: 'core-forged' }), publicKey: carol.hex }
    store._remoteCores.set('k', fakeCore([good, unsigned, forged]))

    expect((await store.getHistory()).map((m) => m.id)).toEqual(['core-ok'])
  })

  it('verifies each block once', async () => {
    const store = await getMessageStore(alice)
    store._remoteCores.set('k', fakeCore([makeMsg(bob, { id: 'core-1' })]))
    await store.getHistory()
    expect(store._verifiedBlocks.size).toBe(1)
    await store.getHistory()
    expect(store._verifiedBlocks.size).toBe(1)
  })

  it('does not trust a block just because its id and signature were already verified', async () => {
    const genuine = makeMsg(bob, { id: 'core-same', content: 'what bob wrote' })
    const forged = { ...genuine, content: 'what mallory wants you to read' }

    for (const order of [
      [genuine, forged],
      [forged, genuine],
    ]) {
      const store = await getMessageStore(alice)
      store._remoteCores.set('mallory', fakeCore([order[0]]))
      store._remoteCores.set('bob', fakeCore([order[1]]))
      const history = await store.getHistory()
      expect(history.map((m) => m.content)).toEqual(['what bob wrote'])
    }
  })

  it('drops signed messages and operations whose fields have the wrong type, without throwing', async () => {
    const store = await getMessageStore()
    for (const bad of [{ content: null }, { content: 42 }, { content: { a: 1 } }, { timestamp: 'now' }, { type: 1 }]) {
      expect(() => store.receiveMessage(makeMsg(bob, bad))).not.toThrow()
    }
    expect(store._channelMessages).toHaveLength(0)

    store.receiveMessage(makeMsg(bob, { id: 'typed', content: 'ok' }))
    expect(() => store.receiveEdit(edit(bob, 'typed', 123, 1000))).not.toThrow()
    expect(() => store.receiveEdit(edit(bob, 'typed', 'text', 'later'))).not.toThrow()
    expect((await shown(store, 'typed')).content).toBe('ok')
  })

  it('keeps a message and a message of somebody else with the same id apart', async () => {
    const store = await getMessageStore()
    const theirs = makeMsg(bob, { id: 'shared-id', content: 'bob wrote this' })
    const impostor = makeMsg(carol, { id: 'shared-id', content: 'carol reuses the id' })
    store.receiveMessage(impostor) // arrives first, e.g. in a history sync
    store.receiveMessage(theirs)

    const history = await store.getHistory()
    expect(history.map((m) => m.content).sort()).toEqual(['bob wrote this', 'carol reuses the id'])

    store.receiveEdit(edit(bob, 'shared-id', 'bob edited', 5000))
    const byAuthor = Object.fromEntries((await store.getHistory()).map((m) => [m.username, m.content]))
    expect(byAuthor).toEqual({ bob: 'bob edited', carol: 'carol reuses the id' })
  })

  it('applies edits to messages that live in a core', async () => {
    const store = await getMessageStore(alice)
    store._remoteCores.set('k', fakeCore([makeMsg(bob, { id: 'core-2', content: 'in a core' })]))
    store.receiveEdit(edit(bob, 'core-2', 'edited in a core', 4000))
    store.receiveEdit(edit(carol, 'core-2', 'carol was here', 5000))
    expect((await shown(store, 'core-2')).content).toBe('edited in a core')
  })

  it('signs our own messages from before signatures, and only those', async () => {
    const { persistMessage } = await import('../../src/p2p/db.js')
    const mine = {
      id: 'old-mine',
      content: 'mine',
      username: 'alice',
      publicKey: alice.hex,
      timestamp: 1,
      type: 'text',
    }
    const theirs = {
      id: 'old-theirs',
      content: 'theirs',
      username: 'bob',
      publicKey: bob.hex,
      timestamp: 2,
      type: 'text',
    }
    await persistMessage(SCOPE, mine)
    await persistMessage(SCOPE, theirs)

    const store = await getMessageStore(alice)
    mocks.store = { get: () => ({ ready: () => Promise.resolve(), on() {}, key: new Uint8Array(32), length: 0 }) }
    await store.init()

    const signed = await store.getSignedHistory()
    expect(signed.map((m) => m.id)).toEqual(['old-mine'])
    const other = await getMessageStore(bob)
    other.receiveMessage(signed[0])
    expect(other._channelMessages).toHaveLength(1)
    expect((await store.getHistory()).map((m) => m.id)).toEqual(['old-mine', 'old-theirs'])
  })

  it('restores stored edits and deletions after a restart', async () => {
    const store = await getMessageStore(alice)
    mocks.store = { get: () => ({ ready: () => Promise.resolve(), on() {}, key: new Uint8Array(32), length: 0 }) }
    await store.init()
    store.receiveMessage(makeMsg(bob, { id: 'kept-1', content: 'original' }))
    store.receiveMessage(makeMsg(bob, { id: 'kept-2', content: 'to delete' }))
    store.receiveEdit(edit(bob, 'kept-1', 'edited text', 3000))
    store.receiveDelete(del(bob, 'kept-2'))
    await new Promise((r) => setTimeout(r, 50)) // let the IndexedDB writes finish

    const reopened = await getMessageStore(alice)
    await reopened.init()
    expect((await shown(reopened, 'kept-1')).content).toBe('edited text')
    expect((await shown(reopened, 'kept-2')).deleted).toBe(true)
  })
})
