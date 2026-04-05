/**
 * kdf.js
 * Key derivation function: Argon2id (m=32 MB, t=3, p=1).
 *
 * Runs in a dedicated Web Worker to avoid blocking the main thread.
 * The worker is created fresh for each call and terminated when done.
 */

/**
 * Derives a 32-byte key from a passphrase and a salt using Argon2id.
 *
 * @param {string}     passphrase
 * @param {Uint8Array} salt  — 32-byte value (e.g. SHA-256 of the identity salt string)
 * @returns {Promise<Uint8Array>}  — 32-byte derived key
 */
export function deriveKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./argon2-worker.js', import.meta.url), { type: 'module' })

    worker.onmessage = ({ data }) => {
      worker.terminate()
      if (data.error) reject(new Error(data.error))
      else resolve(new Uint8Array(data.hash))
    }

    worker.onerror = (err) => {
      worker.terminate()
      reject(new Error(err.message || 'Argon2 worker error'))
    }

    // Pass salt as a plain array — Uint8Arrays are structured-cloned,
    // but being explicit avoids issues with transferable semantics.
    worker.postMessage({ pass: passphrase, salt: Array.from(salt) })
  })
}
