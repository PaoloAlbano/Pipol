/**
 * argon2-worker.js
 * Web Worker that runs Argon2id key derivation off the main thread.
 * Spawned by kdf.js — do not import directly.
 */

import { argon2id } from 'hash-wasm'

self.onmessage = async ({ data }) => {
  const { pass, salt } = data
  try {
    const hash = await argon2id({
      password: pass,
      salt: new Uint8Array(salt),
      parallelism: 1,
      iterations: 3,
      memorySize: 32768, // 32 MB
      hashLength: 32,
      outputType: 'binary',
    })
    self.postMessage({ hash: Array.from(hash) })
  } catch (err) {
    self.postMessage({ error: err.message ?? 'argon2 failed' })
  }
}
