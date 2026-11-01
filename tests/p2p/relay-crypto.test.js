import { describe, it, expect, afterEach, vi } from 'vitest'
import { RelayCipher, deriveRoomRelayKey, roomRelayId, MAX_CLOCK_SKEW_MS } from '../../src/p2p/relay-crypto.js'
import { deriveWorkspaceRelayKey, deriveSwarmTopic, deriveChannelRoomCode } from '../../src/p2p/workspace.js'

const KEY = new Uint8Array(32).fill(3)
const ROOM = 'room-1'
const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)

function pair(key = KEY, room = ROOM) {
  return { alice: new RelayCipher(key, room), bob: new RelayCipher(key, room) }
}

afterEach(() => vi.useRealTimers())

describe('RelayCipher', () => {
  it('opens what was sealed (broadcast and unicast)', () => {
    const { alice, bob } = pair()
    expect(bob.open(alice.seal({ type: 'MSG', text: 'hi' }, ALICE), ALICE, BOB)).toEqual({ type: 'MSG', text: 'hi' })
    expect(bob.open(alice.seal({ type: 'DM' }, ALICE, BOB), ALICE, BOB)).toEqual({ type: 'DM' })
  })

  it('does not leave the payload readable', () => {
    const sealed = pair().alice.seal({ secret: 'plain-text-marker' }, ALICE)
    expect(JSON.stringify(sealed)).not.toContain('plain-text-marker')
    expect(Object.keys(sealed).sort()).toEqual(['c', 'n', 'v'])
  })

  it('uses a different nonce every time', () => {
    const { alice } = pair()
    expect(alice.seal({ a: 1 }, ALICE).n).not.toBe(alice.seal({ a: 1 }, ALICE).n)
  })

  it('rejects the wrong key', () => {
    const sealed = new RelayCipher(KEY, ROOM).seal({ a: 1 }, ALICE)
    expect(new RelayCipher(new Uint8Array(32).fill(4), ROOM).open(sealed, ALICE, BOB)).toBeNull()
  })

  it('rejects tampered nonce or ciphertext', () => {
    const { alice, bob } = pair()
    const sealed = alice.seal({ a: 1 }, ALICE)
    const flip = (b64) => (b64[0] === 'A' ? 'B' : 'A') + b64.slice(1)
    expect(bob.open({ ...sealed, c: flip(sealed.c) }, ALICE, BOB)).toBeNull()
    expect(bob.open({ ...sealed, n: flip(sealed.n) }, ALICE, BOB)).toBeNull()
  })

  it.each([
    ['null', null],
    ['a string', 'plain'],
    ['a clear-text control message', { type: 'MSG', message: { content: 'hi' } }],
    ['an unknown version', { v: 2, n: 'AAAA', c: 'AAAA' }],
    ['no ciphertext', { v: 1, n: 'AAAA' }],
    ['short fields', { v: 1, n: 'AAAA', c: 'AAAA' }],
  ])('rejects %s', (_name, sealed) => {
    expect(pair().bob.open(sealed, ALICE, BOB)).toBeNull()
  })

  it('rejects a payload moved to another room', () => {
    const sealed = new RelayCipher(KEY, 'room-1').seal({ a: 1 }, ALICE)
    expect(new RelayCipher(KEY, 'room-2').open(sealed, ALICE, BOB)).toBeNull()
  })

  it('rejects a forged sender', () => {
    const { alice, bob } = pair()
    expect(bob.open(alice.seal({ a: 1 }, ALICE), CAROL, BOB)).toBeNull()
  })

  it('rejects a unicast message redirected to somebody else', () => {
    const { alice, bob } = pair()
    expect(bob.open(alice.seal({ a: 1 }, ALICE, CAROL), ALICE, BOB)).toBeNull()
  })

  it('rejects a replay of a message already received', () => {
    const { alice, bob } = pair()
    const sealed = alice.seal({ a: 1 }, ALICE)
    expect(bob.open(sealed, ALICE, BOB)).not.toBeNull()
    expect(bob.open(sealed, ALICE, BOB)).toBeNull()
  })

  it('rejects messages older than one already received from the same sender', () => {
    const { alice, bob } = pair()
    const first = alice.seal({ n: 1 }, ALICE)
    const second = alice.seal({ n: 2 }, ALICE)
    expect(bob.open(second, ALICE, BOB)).toEqual({ n: 2 })
    expect(bob.open(first, ALICE, BOB)).toBeNull()
  })

  it('keeps the replay state per sender', () => {
    const alice = new RelayCipher(KEY, ROOM)
    const carol = new RelayCipher(KEY, ROOM)
    const bob = new RelayCipher(KEY, ROOM)
    expect(bob.open(alice.seal({ a: 1 }, ALICE), ALICE, BOB)).not.toBeNull()
    expect(bob.open(carol.seal({ c: 1 }, CAROL), CAROL, BOB)).not.toBeNull()
  })

  it('accepts many messages sent in the same millisecond, in order', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const { alice, bob } = pair()
    for (let i = 0; i < 5; i++) expect(bob.open(alice.seal({ i }, ALICE), ALICE, BOB)).toEqual({ i })
  })

  it('rejects counters too far from the local clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const { alice, bob } = pair()
    const sealed = alice.seal({ a: 1 }, ALICE)

    vi.setSystemTime(1_800_000_000_000 + MAX_CLOCK_SKEW_MS + 1000)
    expect(bob.open(sealed, ALICE, BOB)).toBeNull()
  })

  it('refuses an invalid key', () => {
    expect(() => new RelayCipher(new Uint8Array(5), ROOM)).toThrow('Invalid relay key')
    expect(() => new RelayCipher(null, ROOM)).toThrow('Invalid relay key')
  })
})

describe('key derivation', () => {
  const SECRET = 'ab'.repeat(32)

  it('derives the same workspace key from the same secret, a different one otherwise', () => {
    expect(deriveWorkspaceRelayKey(SECRET)).toEqual(deriveWorkspaceRelayKey(SECRET))
    expect(deriveWorkspaceRelayKey(SECRET)).not.toEqual(deriveWorkspaceRelayKey('cd'.repeat(32)))
    expect(deriveWorkspaceRelayKey(SECRET)).toHaveLength(32)
  })

  it('keeps the relay key apart from the topic and channel derivations', () => {
    const hex = (bytes) => Buffer.from(bytes).toString('hex')
    expect(hex(deriveWorkspaceRelayKey(SECRET))).not.toBe(deriveSwarmTopic(SECRET))
    expect(hex(deriveWorkspaceRelayKey(SECRET))).not.toContain(deriveChannelRoomCode(SECRET, 'general'))
  })

  it('derives the quick room key from the code, deterministically', async () => {
    const [a, b, c] = await Promise.all([
      deriveRoomRelayKey('word-abc123-word'),
      deriveRoomRelayKey('word-abc123-word'),
      deriveRoomRelayKey('word-abc124-word'),
    ])
    expect(a).toHaveLength(32)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('names the quick room for the relay with a hash that does not contain the code', () => {
    const id = roomRelayId('standup')
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(id).not.toContain('standup')
    expect(roomRelayId('standup')).toBe(id)
    expect(roomRelayId('standup2')).not.toBe(id)
  })

  it('fails clearly when WebCrypto is missing', async () => {
    vi.stubGlobal('crypto', undefined)
    await expect(deriveRoomRelayKey('x')).rejects.toThrow('WebCrypto is not available')
    vi.unstubAllGlobals()
  })
})
