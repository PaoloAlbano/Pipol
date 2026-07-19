// @vitest-environment node

/**
 * dm-crypto.test.js
 * Tests for encryptDM / decryptDM using real sodium-javascript keys.
 *
 * Generates real Ed25519 keypairs so the full ECDH path is exercised —
 * no mocks needed.
 */

import { describe, it, expect } from 'vitest'
import sodium from 'sodium-javascript'
import b4a from 'b4a'
import { encryptDM, decryptDM } from '../../src/p2p/dm-crypto.js'

// ── helpers ───────────────────────────────────────────────────────────────────

// sodium-javascript requires real Node.js Buffers (not Uint8Array subclasses)
// from b4a, which behaves differently in jsdom. Use Buffer directly here.
function generateKeypair() {
  const pk = Buffer.allocUnsafe(sodium.crypto_sign_PUBLICKEYBYTES) // 32 bytes
  const sk = Buffer.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES) // 64 bytes
  sodium.crypto_sign_keypair(pk, sk)
  return { pk, sk }
}

// ── encryptDM ─────────────────────────────────────────────────────────────────

describe('encryptDM', () => {
  it('returns an object with nonce and ciphertext strings', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const result = encryptDM({ text: 'hello' }, alice.sk, bob.pk)
    expect(typeof result.nonce).toBe('string')
    expect(typeof result.ciphertext).toBe('string')
  })

  it('nonce is base64 with the correct byte length when decoded', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const { nonce } = encryptDM({ text: 'test' }, alice.sk, bob.pk)
    const decoded = b4a.from(nonce, 'base64')
    expect(decoded.length).toBe(sodium.crypto_box_NONCEBYTES)
  })

  it('ciphertext is longer than plaintext (MAC overhead)', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const msg = { text: 'hello world' }
    const plainLen = Buffer.byteLength(JSON.stringify(msg))
    const { ciphertext } = encryptDM(msg, alice.sk, bob.pk)
    const cipherLen = b4a.from(ciphertext, 'base64').length
    expect(cipherLen).toBe(plainLen + sodium.crypto_box_MACBYTES)
  })

  it('produces a different nonce each call', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const a = encryptDM({ x: 1 }, alice.sk, bob.pk)
    const b = encryptDM({ x: 1 }, alice.sk, bob.pk)
    expect(a.nonce).not.toBe(b.nonce)
  })
})

// ── decryptDM ─────────────────────────────────────────────────────────────────

describe('decryptDM — roundtrip', () => {
  it('decrypts a message encrypted for the recipient', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const original = { type: 'dm', content: 'Hey Bob!' }

    const { nonce, ciphertext } = encryptDM(original, alice.sk, bob.pk)
    const decrypted = decryptDM(nonce, ciphertext, bob.sk, alice.pk)

    expect(decrypted).toEqual(original)
  })

  it('roundtrip preserves all message fields', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const original = {
      id: 'msg-abc123',
      type: 'text',
      content: 'Hello from Alice',
      timestamp: 1700000000000,
      username: 'alice',
    }

    const { nonce, ciphertext } = encryptDM(original, alice.sk, bob.pk)
    const decrypted = decryptDM(nonce, ciphertext, bob.sk, alice.pk)

    expect(decrypted).toEqual(original)
  })

  it('handles messages with unicode / special characters', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const original = { content: '🎉 Ciao! <script>alert(1)</script> "quoted"' }

    const { nonce, ciphertext } = encryptDM(original, alice.sk, bob.pk)
    const decrypted = decryptDM(nonce, ciphertext, bob.sk, alice.pk)

    expect(decrypted.content).toBe(original.content)
  })
})

describe('decryptDM — failure cases', () => {
  it('returns null when the ciphertext is tampered', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const { nonce, ciphertext } = encryptDM({ text: 'secret' }, alice.sk, bob.pk)

    // Flip a byte in the middle of the ciphertext
    const buf = b4a.from(ciphertext, 'base64')
    buf[Math.floor(buf.length / 2)] ^= 0xff
    const tampered = b4a.toString(buf, 'base64')

    const result = decryptDM(nonce, tampered, bob.sk, alice.pk)
    expect(result).toBeNull()
  })

  it('returns null when decrypting with the wrong recipient key', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const eve = generateKeypair()

    const { nonce, ciphertext } = encryptDM({ text: 'for bob only' }, alice.sk, bob.pk)
    const result = decryptDM(nonce, ciphertext, eve.sk, alice.pk)
    expect(result).toBeNull()
  })

  it('returns null when decrypting with the wrong sender key', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const eve = generateKeypair()

    const { nonce, ciphertext } = encryptDM({ text: 'from alice' }, alice.sk, bob.pk)
    // Bob tries to open it but thinks it came from Eve
    const result = decryptDM(nonce, ciphertext, bob.sk, eve.pk)
    expect(result).toBeNull()
  })

  it('returns null when the nonce is corrupted', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const { ciphertext } = encryptDM({ text: 'test' }, alice.sk, bob.pk)

    // Use a random (wrong) nonce
    const badNonce = b4a.allocUnsafe(sodium.crypto_box_NONCEBYTES)
    sodium.randombytes_buf(badNonce)

    const result = decryptDM(b4a.toString(badNonce, 'base64'), ciphertext, bob.sk, alice.pk)
    expect(result).toBeNull()
  })
})
