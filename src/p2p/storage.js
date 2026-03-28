/**
 * storage.js
 * Identity management and Corestore setup.
 *
 * Each user has a stable keypair (= Hypercore identity) stored in localStorage.
 * Hypercore data is kept in memory (random-access-memory) for this session.
 * NOTE: messages are lost on page reload — persistent OPFS storage can be
 * added later once the core P2P flow is stable.
 */

import Corestore from 'corestore'
import RAM from 'random-access-memory'
import * as crypto from 'hypercore-crypto'
import b4a from 'b4a'

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
let _identity = null
let _store = null

/**
 * Returns the local user identity, creating it on first call.
 * Identity is persisted in localStorage so it survives page reloads.
 * @returns {{ publicKey: Buffer, secretKey: Buffer, username: string }}
 */
export function getIdentity() {
  if (_identity) return _identity

  const stored = localStorage.getItem(IDENTITY_STORAGE_KEY)
  if (stored) {
    const parsed = JSON.parse(stored)
    _identity = {
      publicKey: b4a.from(parsed.publicKey, 'hex'),
      secretKey: b4a.from(parsed.secretKey, 'hex'),
      username: parsed.username,
    }
    return _identity
  }

  // Generate a new identity
  const keyPair = crypto.keyPair()
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  const username = `${adj}-${noun}`

  _identity = {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    username,
  }

  localStorage.setItem(
    IDENTITY_STORAGE_KEY,
    JSON.stringify({
      publicKey: b4a.toString(keyPair.publicKey, 'hex'),
      secretKey: b4a.toString(keyPair.secretKey, 'hex'),
      username,
    })
  )

  return _identity
}

/**
 * Updates the username in memory and localStorage.
 * @param {string} newUsername
 */
export function setUsername(newUsername) {
  const identity = getIdentity()
  identity.username = newUsername
  const stored = JSON.parse(localStorage.getItem(IDENTITY_STORAGE_KEY))
  stored.username = newUsername
  localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(stored))
}

/**
 * Returns the singleton Corestore backed by RAM.
 * @returns {Promise<Corestore>}
 */
export async function getStore() {
  if (_store) return _store

  const identity = getIdentity()
  _store = new Corestore(RAM, { primaryKey: identity.secretKey })
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
