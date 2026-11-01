import { describe, it, expect } from 'vitest'
import * as crypto from 'hypercore-crypto'
import {
  signMessage,
  verifyMessage,
  signOp,
  verifyOp,
  cleanMessage,
  sameMessage,
  hashHex,
  toHex,
  OP_FIELDS,
} from '../../src/p2p/signing.js'

const SCOPE = 'room-1'
const alice = crypto.keyPair()
const bob = crypto.keyPair()

function message(overrides = {}) {
  return {
    id: 'm1',
    type: 'text',
    content: 'hello',
    username: 'alice',
    publicKey: toHex(alice.publicKey),
    timestamp: 1700000000000,
    ...overrides,
  }
}

const signed = (overrides, scope = SCOPE) => {
  const msg = message(overrides)
  return { ...msg, sig: signMessage(scope, msg, alice.secretKey) }
}

describe('messages', () => {
  it('verifies a message signed by its author', () => {
    expect(verifyMessage(SCOPE, signed())).toBe(true)
  })

  it('signs the optional fields too (thread parent, image name and size)', () => {
    const msg = signed({ parentId: 'p1', type: 'image', fileName: 'a.png', fileSize: 3, imageData: 'data:x' })
    expect(verifyMessage(SCOPE, msg)).toBe(true)
    for (const change of [{ parentId: 'p2' }, { fileName: 'b.png' }, { fileSize: 4 }, { imageData: 'data:y' }]) {
      expect(verifyMessage(SCOPE, { ...msg, ...change })).toBe(false)
    }
  })

  it.each([
    ['content', { content: 'hacked' }],
    ['username', { username: 'mallory' }],
    ['timestamp', { timestamp: 1 }],
    ['id', { id: 'm2' }],
    ['type', { type: 'image' }],
    ['author', { publicKey: toHex(bob.publicKey) }],
  ])('rejects a message whose %s was changed', (_name, change) => {
    expect(verifyMessage(SCOPE, { ...signed(), ...change })).toBe(false)
  })

  it('rejects a message signed for another room', () => {
    expect(verifyMessage('room-2', signed())).toBe(false)
  })

  it('rejects a missing, malformed or foreign signature', () => {
    const { sig: _sig, ...unsigned } = signed()
    expect(verifyMessage(SCOPE, unsigned)).toBe(false)
    expect(verifyMessage(SCOPE, { ...signed(), sig: 'abc' })).toBe(false)
    expect(verifyMessage(SCOPE, { ...signed(), sig: 'z'.repeat(128) })).toBe(false)
    const bobs = { ...message(), sig: signMessage(SCOPE, message(), bob.secretKey) }
    expect(verifyMessage(SCOPE, bobs)).toBe(false)
  })

  it('rejects values that are not plain data, a missing field and non-messages', () => {
    expect(verifyMessage(SCOPE, { ...signed(), content: { a: 1 } })).toBe(false)
    expect(verifyMessage(SCOPE, { ...signed(), content: undefined })).toBe(false)
    expect(verifyMessage(SCOPE, null)).toBe(false)
    expect(verifyMessage(SCOPE, 'text')).toBe(false)
    expect(verifyMessage(SCOPE, { ...signed(), publicKey: 'short' })).toBe(false)
  })

  it('rejects a correctly signed message whose fields have the wrong type', () => {
    for (const bad of [
      { content: null },
      { content: 5 },
      { id: 7 },
      { username: null },
      { timestamp: '1700000000000' },
      { timestamp: Infinity },
      { type: true },
      { parentId: 3 },
      { fileSize: '3' },
      { imageData: 9 },
    ]) {
      expect(verifyMessage(SCOPE, signed(bad))).toBe(false)
    }
  })

  it('sameMessage compares every signed field', () => {
    const msg = signed()
    expect(sameMessage(msg, { ...msg, deleted: true })).toBe(true)
    expect(sameMessage(msg, { ...msg, content: 'x' })).toBe(false)
    expect(sameMessage(msg, { ...msg, sig: 'x' })).toBe(false)
  })

  it('does not depend on the order of the keys', () => {
    const msg = signed()
    const shuffled = Object.fromEntries(Object.entries(msg).reverse())
    expect(verifyMessage(SCOPE, shuffled)).toBe(true)
  })

  it('cleanMessage keeps only the signed fields', () => {
    expect(cleanMessage({ ...signed(), deleted: true, edited: true, edit: {}, extra: 1 })).toEqual(signed())
  })
})

describe('operations', () => {
  const identity = { publicKey: alice.publicKey, secretKey: alice.secretKey }
  const fields = {
    edit: { originalId: 'm1', newContent: 'new', editedAt: 5 },
    delete: { originalId: 'm1' },
    reaction: { messageId: 'm1', emoji: '👍', removed: false, at: 5 },
  }

  it.each(Object.keys(OP_FIELDS))('signs and verifies a %s', (kind) => {
    const op = signOp(kind, SCOPE, fields[kind], identity)
    expect(op.publicKey).toBe(toHex(alice.publicKey))
    expect(verifyOp(kind, SCOPE, op)).toBe(true)
  })

  it.each(Object.keys(OP_FIELDS))('rejects a %s with a changed field, another room or another signer', (kind) => {
    const op = signOp(kind, SCOPE, fields[kind], identity)
    const field = OP_FIELDS[kind][OP_FIELDS[kind].length - 1]
    const changed = typeof op[field] === 'number' ? op[field] + 1 : typeof op[field] === 'boolean' ? !op[field] : 'x'
    expect(verifyOp(kind, SCOPE, { ...op, [field]: changed })).toBe(false)
    expect(verifyOp(kind, 'room-2', op)).toBe(false)
    expect(verifyOp(kind, SCOPE, { ...op, publicKey: toHex(bob.publicKey) })).toBe(false)
  })

  it('does not let a signature of one kind pass as another', () => {
    const edit = signOp('edit', SCOPE, fields.edit, identity)
    const asDelete = { originalId: edit.originalId, publicKey: edit.publicKey, sig: edit.sig }
    expect(verifyOp('delete', SCOPE, asDelete)).toBe(false)
    const message = signed()
    expect(verifyOp('delete', SCOPE, { originalId: message.id, publicKey: message.publicKey, sig: message.sig })).toBe(
      false
    )
  })

  it('rejects missing fields, wrong types and malformed operations', () => {
    const op = signOp('edit', SCOPE, fields.edit, identity)
    expect(verifyOp('edit', SCOPE, { ...op, newContent: undefined })).toBe(false)
    expect(verifyOp('edit', SCOPE, { ...op, editedAt: null })).toBe(false)
    expect(verifyOp('edit', SCOPE, null)).toBe(false)
    expect(verifyOp('edit', SCOPE, { ...op, sig: 'nope' })).toBe(false)
    expect(verifyOp('unknown', SCOPE, op)).toBe(false)
    const wrongTypes = [
      signOp('edit', SCOPE, { ...fields.edit, newContent: 5 }, identity),
      signOp('edit', SCOPE, { ...fields.edit, editedAt: 'x' }, identity),
      signOp('reaction', SCOPE, { ...fields.reaction, removed: 'no' }, identity),
      signOp('reaction', SCOPE, { ...fields.reaction, emoji: 1 }, identity),
    ]
    expect(verifyOp('edit', SCOPE, wrongTypes[0])).toBe(false)
    expect(verifyOp('edit', SCOPE, wrongTypes[1])).toBe(false)
    expect(verifyOp('reaction', SCOPE, wrongTypes[2])).toBe(false)
    expect(verifyOp('reaction', SCOPE, wrongTypes[3])).toBe(false)
  })

  it('accepts the public key as hex or bytes when signing', () => {
    const op = signOp('delete', SCOPE, fields.delete, { publicKey: toHex(alice.publicKey), secretKey: alice.secretKey })
    expect(verifyOp('delete', SCOPE, op)).toBe(true)
  })
})

describe('helpers', () => {
  it('hashes text to 64 hex characters, deterministically', () => {
    expect(hashHex('a')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashHex('a')).toBe(hashHex('a'))
    expect(hashHex('a')).not.toBe(hashHex('b'))
  })
})
