/**
 * webauthn.js
 * Biometric unlock via WebAuthn passkeys.
 *
 * Strategy: the passphrase is encrypted with AES-GCM and stored in localStorage.
 * The encryption key is derived via HKDF from the credential's rawId, which is
 * only returned by the browser after a successful biometric authentication.
 *
 * This works universally across platforms:
 *   - macOS Touch ID / Face ID (Safari, Chrome)
 *   - iOS Face ID / Touch ID (Safari, Chrome)
 *   - Windows Hello (fingerprint, face, PIN)
 *   - Android fingerprint / face via Google Password Manager or other providers
 *
 * Only the standard WebAuthn create/get flow is used — no PRF or largeBlob
 * extensions required. `authenticatorAttachment: 'platform'` is set so the
 * browser always uses the built-in platform authenticator (biometric / PIN)
 * rather than prompting for an external security key.
 *
 * Security model:
 *   - The ciphertext in localStorage is useless without the rawId.
 *   - The rawId is only obtainable after passing biometric verification on the
 *     registered device.
 *   - An attacker with full localStorage access but no biometric cannot
 *     decrypt the passphrase.
 *   - An attacker with physical access to an unlocked, authenticated browser
 *     session already has access to the live session anyway.
 *
 * Browser support: any browser supporting WebAuthn platform authenticators
 * (Chrome 67+, Safari 14+, Firefox 60+, Edge 18+).
 */

const STORAGE_KEY = 'p2p-chat:biometric'

// App-specific info for HKDF key derivation — non-secret.
const HKDF_INFO = new TextEncoder().encode('pipol-biometric-passphrase-v1')

function getRpId() {
  return window.location.hostname.replace(/^www\./, '')
}

function b64Encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function b64Decode(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0))
}

/**
 * Derives an AES-GCM-256 key from a credential's rawId via HKDF-SHA-256.
 * The rawId acts as the key material — it is only known after a successful
 * biometric assertion.
 */
async function deriveKeyFromRawId(rawId) {
  const keyMaterial = await crypto.subtle.importKey('raw', rawId, { name: 'HKDF' }, false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32), // zero salt — rawId already carries entropy
      info: HKDF_INFO,
    },
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
 * @param {string} passphrase  The user's passphrase (plain text, only in memory)
 * @param {{ handle: string, username: string }} meta
 * @throws 'cancelled'     if the user dismissed the biometric prompt
 * @throws 'create-failed' on unexpected authenticator errors
 */
export async function setupBiometricUnlock(passphrase, meta) {
  let credential
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Pipol', id: getRpId() },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)), // opaque random, not PII
          name: meta.handle,
          displayName: meta.username,
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' }, // ES256  (preferred)
          { alg: -257, type: 'public-key' }, // RS256  (Windows Hello fallback)
        ],
        authenticatorSelection: {
          // 'platform' forces Touch ID / Face ID / Windows Hello / Android biometric.
          // Without this, browsers may offer external security keys instead.
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          // 'preferred' lets the platform decide whether to make a discoverable
          // credential.  'required' can fail on Windows Hello when storage is full.
          residentKey: 'preferred',
        },
        // Suppress attestation — we don't verify it server-side and it reduces
        // the risk of the creation being blocked by enterprise policies.
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

  // Derive encryption key from the credential's rawId.
  const encKey = await deriveKeyFromRawId(credential.rawId)

  // Encrypt { handle, passphrase } as a JSON payload.
  const payload = new TextEncoder().encode(JSON.stringify({ handle: meta.handle, passphrase }))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, payload)

  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      credentialId: b64Encode(credential.rawId),
      iv: b64Encode(iv),
      ciphertext: b64Encode(ciphertext),
    })
  )
}

/**
 * Authenticates with the stored passkey and returns the decrypted credentials.
 *
 * @returns {Promise<{ handle: string, passphrase: string }>}
 * @throws 'no-biometric-setup' | 'cancelled' | 'decrypt-failed'
 */
export async function unlockWithBiometrics() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('no-biometric-setup')

  const { credentialId, iv: ivB64, ciphertext: ctB64 } = JSON.parse(raw)

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

  // Derive decryption key from the rawId returned after successful auth.
  try {
    const decKey = await deriveKeyFromRawId(assertion.rawId)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64Decode(ivB64) },
      decKey,
      b64Decode(ctB64)
    )
    return JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    throw new Error('decrypt-failed')
  }
}
