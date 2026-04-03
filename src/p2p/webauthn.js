/**
 * webauthn.js
 * Biometric unlock for the masterSeed via WebAuthn passkeys.
 *
 * Two mechanisms are attempted in parallel during registration; whichever
 * the authenticator supports is used and recorded as `method` in localStorage.
 *
 * ┌─────────────────┬───────────────────────────────────────────────────────┐
 * │ method: 'prf'   │ PRF extension: masterSeed is AES-GCM encrypted with   │
 * │                 │ the PRF output. The seed never touches storage in      │
 * │                 │ clear. Supported by: macOS Touch ID, iOS Face ID,      │
 * │                 │ YubiKey 5+.                                            │
 * ├─────────────────┼───────────────────────────────────────────────────────┤
 * │ method:         │ largeBlob extension: masterSeed is written directly    │
 * │ 'largeBlob'     │ into the authenticator's blob storage, which requires  │
 * │                 │ user verification to read. Supported by: Android       │
 * │                 │ (device-bound passkeys), Windows Hello, YubiKey 5+.   │
 * └─────────────────┴───────────────────────────────────────────────────────┘
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
 * Returns true if the browser + platform authenticator are available for
 * biometric unlock setup.
 *
 * Note: getClientCapabilities() reports 'extension:prf' based on what the
 * *browser* supports in principle, but whether the chosen authenticator
 * actually returns a PRF result can only be determined by attempting
 * registration. Windows Hello and Google Password Manager both declare
 * prf=true at the browser level but do not return a PRF result in practice.
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
 * Registers a new passkey and stores enough data to recover masterSeed later.
 * Both PRF and largeBlob extensions are requested simultaneously; whichever
 * the authenticator supports is used (PRF takes priority).
 *
 * @param {Uint8Array} masterSeed  The 32-byte masterSeed from deriveIdentityA()
 * @param {{ handle: string, username: string }} meta
 * @throws 'authenticator-no-prf-no-largeblob' if neither extension is supported
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
          largeBlob: { support: 'preferred' },
        },
      },
    })
  } catch (err) {
    // NotAllowedError = user cancelled or timed out.
    // Some authenticators (e.g. Windows Hello) may also throw on unsupported
    // extension combos — log the real error to help debugging.
    console.warn('[webauthn] create() failed:', err?.name, err?.message)
    const isUserCancel =
      err?.name === 'NotAllowedError' ||
      err?.name === 'AbortError' ||
      err instanceof DOMException
    throw new Error(isUserCancel ? 'cancelled' : 'create-failed')
  }

  const ext = credential.getClientExtensionResults()
  const prfResult = ext?.prf?.results?.first
  const largeBlobSupported = ext?.largeBlob?.supported === true

  if (prfResult) {
    // PRF path: encrypt masterSeed with PRF output, store ciphertext in localStorage
    const encKey = await crypto.subtle.importKey('raw', prfResult, { name: 'AES-GCM' }, false, [
      'encrypt',
    ])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, masterSeed)

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        method: 'prf',
        credentialId: b64Encode(credential.rawId),
        iv: b64Encode(iv),
        ciphertext: b64Encode(ciphertext),
      })
    )
    return
  }

  if (largeBlobSupported) {
    // largeBlob path: write masterSeed directly into the authenticator blob.
    // We need a get() with largeBlob.write immediately after create() while
    // the session is fresh — some authenticators require this in the same gesture.
    // We store a marker in localStorage; the actual seed lives in the passkey blob.
    let writeAssertion
    try {
      writeAssertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: getRpId(),
          allowCredentials: [{ id: credential.rawId, type: 'public-key' }],
          userVerification: 'required',
          extensions: {
            largeBlob: { write: masterSeed },
          },
        },
      })
    } catch (err) {
      console.warn('[webauthn] largeBlob write get() failed:', err?.name, err?.message)
      throw new Error('cancelled')
    }

    const written = writeAssertion.getClientExtensionResults()?.largeBlob?.written
    if (!written) throw new Error('authenticator-no-prf-no-largeblob')

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        method: 'largeBlob',
        credentialId: b64Encode(credential.rawId),
      })
    )
    return
  }

  throw new Error('authenticator-no-prf-no-largeblob')
}

/**
 * Uses the stored passkey to recover and return the masterSeed.
 *
 * @returns {Promise<Uint8Array>} masterSeed
 * @throws 'no-biometric-setup' | 'no-seed-in-blob' | 'cancelled' | 'decrypt-failed'
 */
export async function unlockWithBiometrics() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) throw new Error('no-biometric-setup')

  const stored = JSON.parse(raw)
  const { method, credentialId } = stored

  if (method === 'largeBlob') {
    let assertion
    try {
      assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: getRpId(),
          allowCredentials: [{ id: b64Decode(credentialId), type: 'public-key' }],
          userVerification: 'required',
          extensions: {
            largeBlob: { read: true },
          },
        },
      })
    } catch {
      throw new Error('cancelled')
    }

    const blob = assertion.getClientExtensionResults()?.largeBlob?.blob
    if (!blob || blob.byteLength === 0) throw new Error('no-seed-in-blob')
    return new Uint8Array(blob)
  }

  // Default: PRF path (method === 'prf' or legacy entries without method field)
  const salt = await getPRFSalt()
  const { iv: ivB64, ciphertext: ctB64 } = stored

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
