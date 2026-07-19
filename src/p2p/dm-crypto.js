/**
 * dm-crypto.js
 * End-to-end encryption for Direct Messages using NaCl box (ECDH + XSalsa20-Poly1305).
 *
 * Identity keys in this project are Ed25519 (from hypercore-crypto).
 * NaCl box requires Curve25519 keys — sodium provides the conversion functions.
 *
 * Encryption:
 *   1. Convert sender's Ed25519 secretKey (64 bytes) → Curve25519 secretKey (32 bytes)
 *   2. Convert recipient's Ed25519 publicKey (32 bytes) → Curve25519 publicKey (32 bytes)
 *   3. crypto_box_easy(ciphertext, plaintext, nonce, recipientCurve25519PK, senderCurve25519SK)
 *
 * Decryption is symmetric — recipient derives the same shared secret from their
 * secretKey and the sender's publicKey.
 */

import sodium from 'sodium-javascript'
import b4a from 'b4a'

/**
 * Encrypt a message object for a specific recipient.
 *
 * @param {object} message          Plain JS object to send (will be JSON-serialised)
 * @param {Buffer} mySecretKey      Sender's Ed25519 secretKey (64 bytes)
 * @param {Buffer} theirPublicKey   Recipient's Ed25519 publicKey (32 bytes)
 * @returns {{ nonce: string, ciphertext: string }}  Base64-encoded strings
 */
export function encryptDM(message, mySecretKey, theirPublicKey) {
  // Convert Ed25519 → Curve25519
  const senderSK = b4a.allocUnsafe(sodium.crypto_box_SECRETKEYBYTES)
  const recipientPK = b4a.allocUnsafe(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_sk_to_curve25519(senderSK, mySecretKey)
  sodium.crypto_sign_ed25519_pk_to_curve25519(recipientPK, theirPublicKey)

  const nonce = b4a.allocUnsafe(sodium.crypto_box_NONCEBYTES)
  sodium.randombytes_buf(nonce)

  const plaintext = b4a.from(JSON.stringify(message))
  const ciphertext = b4a.allocUnsafe(plaintext.length + sodium.crypto_box_MACBYTES)
  sodium.crypto_box_easy(ciphertext, plaintext, nonce, recipientPK, senderSK)

  return {
    nonce: b4a.toString(nonce, 'base64'),
    ciphertext: b4a.toString(ciphertext, 'base64'),
  }
}

/**
 * Decrypt a DM received from a specific sender.
 *
 * @param {string} nonce            Base64-encoded nonce (from encryptDM)
 * @param {string} ciphertext       Base64-encoded ciphertext (from encryptDM)
 * @param {Buffer} mySecretKey      Recipient's Ed25519 secretKey (64 bytes)
 * @param {Buffer} theirPublicKey   Sender's Ed25519 publicKey (32 bytes)
 * @returns {object|null}           Decrypted message object, or null if decryption failed
 */
export function decryptDM(nonce, ciphertext, mySecretKey, theirPublicKey) {
  try {
    // Convert Ed25519 → Curve25519
    const recipientSK = b4a.allocUnsafe(sodium.crypto_box_SECRETKEYBYTES)
    const senderPK = b4a.allocUnsafe(sodium.crypto_box_PUBLICKEYBYTES)
    sodium.crypto_sign_ed25519_sk_to_curve25519(recipientSK, mySecretKey)
    sodium.crypto_sign_ed25519_pk_to_curve25519(senderPK, theirPublicKey)

    const nonceBytes = b4a.from(nonce, 'base64')
    const ciphertextBytes = b4a.from(ciphertext, 'base64')
    const plaintext = b4a.allocUnsafe(ciphertextBytes.length - sodium.crypto_box_MACBYTES)

    const ok = sodium.crypto_box_open_easy(plaintext, ciphertextBytes, nonceBytes, senderPK, recipientSK)
    if (!ok) return null

    return JSON.parse(b4a.toString(plaintext))
  } catch (err) {
    console.warn('[dm-crypto] decryption failed:', err.message)
    return null
  }
}
