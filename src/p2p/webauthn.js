/**
 * webauthn.js
 * Biometric unlock via WebAuthn passkeys.
 *
 * Security model:
 *   At setup, a 32-byte secret is generated and placed in `user.id`. The
 *   authenticator stores this in its secure enclave (TPM / Secure Enclave /
 *   TrustZone). At unlock, the browser returns it as `response.userHandle`
 *   only after a successful biometric assertion.
 *
 *   That secret is the HKDF key material for the AES-GCM key that encrypts
 *   { handle, passphrase } in localStorage. It is never written to disk.
 *
 *   An attacker with full localStorage access has: credentialId, salt, iv,
 *   ciphertext — but NOT the userHandle. They cannot derive the AES key
 *   offline. The biometric is a cryptographic requirement, not just UX.
 *
 * Requires `residentKey: 'required'` (discoverable credential / passkey) to
 * guarantee the authenticator returns `userHandle` in the assertion response.
 *
 * Platform support:
 *   - macOS Touch ID / Face ID (Safari, Chrome) ✓
 *   - iOS Face ID / Touch ID (Safari 17+, Chrome) ✓
 *   - Windows Hello ✓
 *   - Android biometric / Google Password Manager ✓
 */

const STORAGE_KEY = 'p2p-chat:biometric'

// App-specific info for HKDF — non-secret, domain-separated.
const HKDF_INFO = new TextEncoder().encode('pipol-biometric-passphrase-v1')

function getRpId() {
  return window.location.hostname.replace(/^www\./, '')
}

function b64Encode(buf) {
  // Avoid spread (...new Uint8Array) which causes stack overflow on large buffers.
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function b64Decode(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0))
}

/**
 * Derives an AES-GCM-256 key from `material` via HKDF-SHA-256.
 * `salt` is a random value stored in localStorage alongside the ciphertext.
 */
async function deriveAesKey(material, salt) {
  const keyMaterial = await crypto.subtle.importKey('raw', material, { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Returns true if the browser supports WebAuthn with a platform authenticator.
 */
export async function isBiometricUnlockAvailable() {
  if (!window.PublicKeyCredential) return false
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/**
 * Returns true if biometric unlock has been set up on this device.
 */
export function hasBiometricUnlock() {
  return !!localStorage.getItem(STORAGE_KEY)
}

/**
 * Removes the biometric unlock configuration from this device.
 */
export function removeBiometricUnlock() {
  localStorage.removeItem(STORAGE_KEY)
}

/**
 * Registers a passkey and encrypts (handle + passphrase) for later retrieval.
 *
 * `user.id` is a randomly generated 32-byte secret. The authenticator stores
 * it in the secure enclave and returns it as `response.userHandle` after every
 * successful biometric assertion — it is never written to localStorage.
 *
 * @param {string} passphrase  The user's passphrase (plain text, only in memory)
 * @param {{ handle: string, username: string }} meta
 * @throws 'cancelled'     if the user dismissed the biometric prompt
 * @throws 'not-supported' if the platform authenticator is unavailable
 * @throws 'create-failed' on unexpected authenticator errors
 */
export async function setupBiometricUnlock(passphrase, meta) {
  // This secret becomes the userHandle stored in the secure enclave.
  // It is used as HKDF key material — never saved to localStorage.
  const secret = crypto.getRandomValues(new Uint8Array(32))

  let credential
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Pipol', id: getRpId() },
        user: {
          id: secret, // ← key material, stored in the secure enclave
          name: meta.handle,
          displayName: meta.username,
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' }, // ES256  (preferred)
          { alg: -257, type: 'public-key' }, // RS256  (Windows Hello fallback)
        ],
        authenticatorSelection: {
          // 'platform' forces Touch ID / Face ID / Windows Hello / Android biometric.
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          // 'required' creates a discoverable credential (passkey), which
          // guarantees the authenticator returns userHandle in the assertion.
          residentKey: 'required',
        },
        attestation: 'none',
      },
    })
  } catch (err) {
    console.warn('[webauthn] create() failed:', err?.name, err?.message)
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
      throw new Error('cancelled')
    }
    if (err?.name === 'NotSupportedError' || err?.name === 'ConstraintError') {
      throw new Error('not-supported')
    }
    throw new Error('create-failed')
  }

  // Derive AES key from the secret (same bytes the authenticator will return as userHandle).
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const encKey = await deriveAesKey(secret, salt)

  // Encrypt { handle, passphrase }.
  const payload = new TextEncoder().encode(JSON.stringify({ handle: meta.handle, passphrase }))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, payload)

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      credentialId: b64Encode(credential.rawId),
      salt: b64Encode(salt),
      iv: b64Encode(iv),
      ciphertext: b64Encode(ciphertext),
    })
  )
}

/**
 * Authenticates with the stored passkey and returns the decrypted credentials.
 *
 * @returns {Promise<{ handle: string, passphrase: string }>}
 * @throws 'no-biometric-setup' | 'cancelled' | 'userhandle-unavailable' | 'decrypt-failed'
 */
export async function unlockWithBiometrics() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('no-biometric-setup')

  const { credentialId, salt: saltB64, iv: ivB64, ciphertext: ctB64 } = JSON.parse(raw)

  let assertion
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: getRpId(),
        allowCredentials: [{ id: b64Decode(credentialId), type: 'public-key' }],
        userVerification: 'required',
      },
    })
  } catch (err) {
    console.warn('[webauthn] get() failed:', err?.name, err?.message)
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
      throw new Error('cancelled')
    }
    throw new Error('cancelled')
  }

  try {
    const userHandle = assertion.response?.userHandle
    if (!userHandle) throw new Error('userhandle-unavailable')
    const decKey = await deriveAesKey(new Uint8Array(userHandle), b64Decode(saltB64))
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64Decode(ivB64) }, decKey, b64Decode(ctB64))
    return JSON.parse(new TextDecoder().decode(plaintext))
  } catch (err) {
    if (err.message === 'userhandle-unavailable') throw err
    throw new Error('decrypt-failed')
  }
}
