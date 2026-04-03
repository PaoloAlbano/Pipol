/**
 * storage.js
 * Identity management and Corestore setup.
 *
 * Identity is derived from a (handle, passphrase) pair via PBKDF2 — never stored in clear.
 * The masterSeed lives only in memory and is re-derived on each session.
 * localStorage stores only non-secret metadata: handle, publicKey (hex), username.
 */

import Corestore from 'corestore'
import RAM from 'random-access-memory'
import * as crypto from 'hypercore-crypto'
import b4a from 'b4a'

const webcrypto = globalThis.crypto

const IDENTITY_STORAGE_KEY = 'p2p-chat:identity'
const QUALITY_KEY = 'p2p-chat:video-quality'
const SHOW_STATS_KEY = 'p2p-chat:show-stats'
const RELAY_URL_KEY = 'p2p-chat:relay-url'

export function getVideoQuality() {
  return localStorage.getItem(QUALITY_KEY) || '1080p'
}
export function setVideoQuality(q) {
  localStorage.setItem(QUALITY_KEY, q)
}

export function getShowStats() {
  return localStorage.getItem(SHOW_STATS_KEY) === 'true'
}
export function setShowStats(v) {
  localStorage.setItem(SHOW_STATS_KEY, String(v))
}

/** Returns the custom relay base URL (e.g. "wss://relay.example.com"), or '' if using the default. */
export function getRelayUrl() {
  return localStorage.getItem(RELAY_URL_KEY) || ''
}

/** Persists a custom relay base URL. Pass '' or null to reset to default. */
export function setRelayUrl(url) {
  if (url) {
    localStorage.setItem(RELAY_URL_KEY, url)
  } else {
    localStorage.removeItem(RELAY_URL_KEY)
  }
}

const ONBOARDED_KEY = 'p2p-chat:onboarded'
export function isFirstVisit() {
  return !localStorage.getItem(ONBOARDED_KEY)
}
export function markOnboarded() {
  localStorage.setItem(ONBOARDED_KEY, '1')
}

const ADJECTIVES = [
  'swift',
  'dark',
  'bright',
  'cool',
  'wild',
  'calm',
  'bold',
  'warm',
  'deep',
  'tall',
  'grand',
  'wise',
  'brave',
  'free',
  'sharp',
  'silent',
  'golden',
  'silver',
  'crimson',
  'azure',
  'amber',
  'jade',
  'storm',
  'frost',
]

const NOUNS = [
  'fox',
  'hawk',
  'wolf',
  'bear',
  'lion',
  'deer',
  'crow',
  'swan',
  'owl',
  'cat',
  'ray',
  'elk',
  'bat',
  'ram',
  'seal',
  'lynx',
  'kite',
  'carp',
  'fern',
  'sage',
  'reef',
  'peak',
  'tide',
  'dusk',
]

// Singleton references
let _masterSeed = null // Uint8Array(32), only in memory — never persisted
let _identity = null
let _store = null

/** Generates a random adjective-noun username. */
export function generateUsername() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj}-${noun}`
}

/** Returns the 32-byte masterSeed for this session, or null if not yet derived. */
export function getMasterSeed() {
  return _masterSeed
}

/**
 * Restores the in-memory identity from a masterSeed obtained externally
 * (e.g. decrypted by WebAuthn PRF). Verifies the derived public key against
 * the stored metadata before accepting the seed.
 *
 * @param {Uint8Array} masterSeed
 * @throws {Error} 'no-stored-identity' | 'seed-mismatch'
 */
export function restoreFromMasterSeed(masterSeed) {
  const storedMeta = getStoredIdentityMeta()
  if (!storedMeta) throw new Error('no-stored-identity')

  const keyPair = crypto.keyPair(masterSeed.slice(0, 32))
  const pubKeyHex = b4a.toString(keyPair.publicKey, 'hex')

  if (storedMeta.publicKey !== pubKeyHex) throw new Error('seed-mismatch')

  _masterSeed = masterSeed
  _store = null
  _identity = {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    username: storedMeta.username,
  }
}

/**
 * Creates a temporary guest identity — random keypair, nothing saved to localStorage.
 * The identity is lost when the page is closed or the session is locked.
 * @param {string} displayName
 */
export function createGuestIdentity(displayName) {
  const masterSeed = webcrypto.getRandomValues(new Uint8Array(32))
  const keyPair = crypto.keyPair(masterSeed.slice(0, 32))
  _masterSeed = masterSeed
  _store = null
  _identity = {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    username: displayName,
    isGuest: true,
  }
}

/**
 * Clears all session secrets from memory without touching localStorage.
 * After this call getIdentity() returns null and the user must re-derive
 * their identity by entering their passphrase again.
 */
export function lockSession() {
  _masterSeed = null
  _identity = null
  _store = null
}

/**
 * Returns the non-secret identity metadata stored in localStorage, or null.
 * Format: { handle, publicKey (hex), username, method }
 */
export function getStoredIdentityMeta() {
  const raw = localStorage.getItem(IDENTITY_STORAGE_KEY)
  if (!raw) return null
  const parsed = JSON.parse(raw)
  // Discard legacy format that stored secretKey in clear
  if (!parsed.method) return null
  return parsed
}

/**
 * Returns the in-memory identity for the current session.
 * Returns null if deriveIdentityA() has not been called yet this session.
 * @returns {{ publicKey: Buffer, secretKey: Buffer, username: string } | null}
 */
export function getIdentity() {
  if (!_masterSeed) return null
  return _identity
}

/**
 * Derives the user identity from a handle + passphrase (Option A).
 *
 * - If the handle matches an existing stored identity, verifies the passphrase
 *   by comparing the derived public key against the stored one.
 * - If the handle is new, creates and persists the identity metadata.
 *
 * masterSeed = PBKDF2(passphrase, SHA-256("pipol:" + handle), 600_000, SHA-256)
 *
 * @param {string} handle     Any stable identifier (email, username, …)
 * @param {string} passphrase Must score ≥ 3 on the strength meter for new accounts
 * @returns {Promise<{ isNewAccount: boolean }>}
 * @throws {Error} 'wrong-passphrase' if handle exists but passphrase is incorrect
 */
export async function deriveIdentityA(handle, passphrase) {
  const normHandle = handle.toLowerCase().trim()

  // Normalise origin: strip leading "www." so pipol.app and www.pipol.app share the same salt.
  // Each distinct deployment (different domain) produces a different identity space by design.
  const { protocol, hostname, port } = window.location
  const normHostname = hostname.replace(/^www\./, '')
  const normOrigin = `${protocol}//${normHostname}${port ? ':' + port : ''}`

  // salt = SHA-256("pipol:" + origin + ":" + handle)
  const saltBytes = new TextEncoder().encode(`pipol:${normOrigin}:${normHandle}`)
  const saltHash = await webcrypto.subtle.digest('SHA-256', saltBytes)

  // masterSeed = PBKDF2(passphrase, salt, 600_000 iter, SHA-256, 256 bits)
  const keyMaterial = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const derived = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltHash, iterations: 600_000, hash: 'SHA-256' },
    keyMaterial,
    256
  )
  const masterSeed = new Uint8Array(derived)

  // Ed25519 keypair from first 32 bytes of masterSeed
  const keyPair = crypto.keyPair(masterSeed.slice(0, 32))
  const pubKeyHex = b4a.toString(keyPair.publicKey, 'hex')

  const storedMeta = getStoredIdentityMeta()
  const isNewAccount = !storedMeta || storedMeta.handle !== normHandle

  if (!isNewAccount) {
    if (storedMeta.publicKey !== pubKeyHex) {
      throw new Error('wrong-passphrase')
    }
  }

  // Commit to memory
  _masterSeed = masterSeed
  _store = null // reset store so it re-initialises with new primaryKey

  const username = isNewAccount ? generateUsername() : storedMeta.username

  if (isNewAccount) {
    localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({ handle: normHandle, publicKey: pubKeyHex, username, method: 'A' })
    )
  }

  _identity = {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    username,
  }

  return { isNewAccount }
}

/**
 * Updates the username in memory and localStorage.
 * @param {string} newUsername
 */
export function setUsername(newUsername) {
  if (!_identity) return
  _identity.username = newUsername
  const stored = JSON.parse(localStorage.getItem(IDENTITY_STORAGE_KEY) || 'null')
  if (stored) {
    stored.username = newUsername
    localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(stored))
  }
}

/**
 * Returns the singleton Corestore backed by RAM.
 * Requires deriveIdentityA() to have been called first.
 * @returns {Promise<Corestore>}
 */
export async function getStore() {
  if (_store) return _store
  if (!_masterSeed) throw new Error('[storage] identity not derived — call deriveIdentityA first')

  _store = new Corestore(RAM, { primaryKey: _masterSeed })
  await _store.ready()
  console.info('[storage] Corestore ready (in-memory)')
  return _store
}

/**
 * Generates a random human-readable room code (e.g. "cloud-river-stone").
 * @returns {string}
 */
export function generateRoomCode() {
  const words = [
    'apple',
    'ocean',
    'cloud',
    'stone',
    'river',
    'flame',
    'tower',
    'night',
    'storm',
    'forest',
    'valley',
    'castle',
    'bridge',
    'garden',
    'temple',
    'silver',
    'crystal',
    'thunder',
    'voyage',
    'anchor',
    'compass',
    'diamond',
    'feather',
    'glacier',
    'harvest',
    'island',
    'lantern',
    'marble',
    'orchid',
    'rainbow',
    'sunrise',
    'willow',
    'copper',
    'nebula',
    'canyon',
    'meadow',
  ]
  const pick = () => words[Math.floor(Math.random() * words.length)]
  return `${pick()}-${pick()}-${pick()}`
}
