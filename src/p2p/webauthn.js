/**
 * webauthn.js
 * WebAuthn PRF extension — biometric unlock for the masterSeed (Option C).
 *
 * The passkey acts as a hardware-backed KDF:
 *   prfOutput   = passkey.get({ extensions: { prf: { eval: { first: prfSalt } } } })
 *   masterSeed  = AES-GCM-decrypt(key=prfOutput, ciphertext=storedBlob)
 *
 * The masterSeed never touches localStorage in clear — only its AES-GCM encrypted
 * form does. Without the passkey (and its private key stored in the OS secure enclave)
 * the ciphertext is useless.
 *
 * Browser support (2026): Chrome 132+, Edge 132+, Safari 18.2+ partial, Firefox ✗
 */

const STORAGE_KEY = 'p2p-chat:biometric'

// Stable PRF evaluation salt — non-secret, same for every user of this app.
// Computed once and cached.
let _prfSalt = null
async function getPRFSalt() {
  if (_prfSalt) return _prfSalt
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('pipol-biometric-unlock-v1')
  )
  _prfSalt = new Uint8Array(buf)
  return _prfSalt
}

// rpId = registrable domain, www-stripped, so pipol.app and www.pipol.app share one rpId.
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
 * Returns true if the browser has a platform authenticator available.
 * Does NOT guarantee PRF support — that is only detectable by attempting
 * a registration and checking the extension result.
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
 * Registers a new passkey and encrypts masterSeed with its PRF output.
 * Call this after a successful Option A login to enable biometric unlock.
 *
 * @param {Uint8Array} masterSeed  The 32-byte masterSeed from deriveIdentityA()
 * @param {{ handle: string, username: string }} meta
 * @throws 'prf-not-supported' if the browser/authenticator does not support PRF
 * @throws 'cancelled' if the user dismissed the prompt
 */
export async function setupBiometricUnlock(masterSeed, meta) {
  const salt = await getPRFSalt()

  let credential
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Pipol', id: getRpId() },
        user: {
          id: new TextEncoder().encode(meta.handle),
          name: meta.handle,
          displayName: meta.username,
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' }, // ES256
          { alg: -257, type: 'public-key' }, // RS256
        ],
        authenticatorSelection: {
          userVerification: 'required',
          residentKey: 'preferred',
        },
        extensions: {
          prf: { eval: { first: salt } },
        },
      },
    })
  } catch {
    throw new Error('cancelled')
  }

  const prfResult = credential.getClientExtensionResults()?.prf?.results?.first
  if (!prfResult) throw new Error('prf-not-supported')

  // Encrypt masterSeed with PRF output (32 bytes → AES-256-GCM key)
  const encKey = await crypto.subtle.importKey('raw', prfResult, { name: 'AES-GCM' }, false, [
    'encrypt',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, masterSeed)

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
 * Uses the stored passkey to decrypt and return the masterSeed.
 *
 * @returns {Promise<Uint8Array>} masterSeed
 * @throws 'no-biometric-setup' | 'prf-not-supported' | 'cancelled' | 'decrypt-failed'
 */
export async function unlockWithBiometrics() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('no-biometric-setup')

  const { credentialId, iv: ivB64, ciphertext: ctB64 } = JSON.parse(raw)
  const salt = await getPRFSalt()

  let assertion
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: getRpId(),
        allowCredentials: [{ id: b64Decode(credentialId), type: 'public-key' }],
        userVerification: 'required',
        extensions: {
          prf: { eval: { first: salt } },
        },
      },
    })
  } catch {
    throw new Error('cancelled')
  }

  const prfResult = assertion.getClientExtensionResults()?.prf?.results?.first
  if (!prfResult) throw new Error('prf-not-supported')

  try {
    const decKey = await crypto.subtle.importKey('raw', prfResult, { name: 'AES-GCM' }, false, [
      'decrypt',
    ])
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64Decode(ivB64) },
      decKey,
      b64Decode(ctB64)
    )
    return new Uint8Array(plaintext)
  } catch {
    throw new Error('decrypt-failed')
  }
}
