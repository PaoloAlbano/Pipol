/**
 * signing.js
 * Ed25519 signatures with the user's identity key, so that the author of a message, an edit, a deletion or a
 * reaction can be verified by anybody who receives it (live, relayed by another peer or from the history),
 * not only by the peer it came from.
 *
 * What is signed is an ordered list, never an object, so the bytes do not depend on key order:
 *   [DOMAIN, kind, scope, publicKey, ...values]
 * `kind` keeps a signature of one kind from being used as another, `scope` (the room code of the channel,
 * conversation or quick room) keeps a signature from being replayed in another room.
 *
 * Messages carry their signature in `sig`. Edits, deletions and reactions are small signed operations
 * `{ ...fields, publicKey, sig }` (see OP_FIELDS).
 */

import * as crypto from 'hypercore-crypto'
import b4a from 'b4a'

const DOMAIN = 'pipol/sig/v1'
const HEX_KEY = /^[0-9a-f]{64}$/
const HEX_SIG = /^[0-9a-f]{128}$/

/** Fields of a message that are authentic once `sig` verifies. Everything else is dropped on receipt. */
const MESSAGE_FIELDS = [
  'id',
  'type',
  'content',
  'username',
  'publicKey',
  'timestamp',
  'parentId',
  'fileName',
  'fileSize',
  'imageData',
  'sig',
]

/** Signed fields of each kind of operation, in signing order. */
export const OP_FIELDS = {
  edit: ['originalId', 'newContent', 'editedAt'],
  delete: ['originalId'],
  reaction: ['messageId', 'emoji', 'removed', 'at'],
}

/** @param {Uint8Array|string} key @returns {string} lowercase hex */
export function toHex(key) {
  return typeof key === 'string' ? key : b4a.toString(key, 'hex')
}

/** Hex BLAKE2b hash of a string (used to bind an image to the signature of its message). */
export function hashHex(text) {
  return b4a.toString(crypto.hash(b4a.from(text)), 'hex')
}

const isPrimitive = (v) => ['string', 'number', 'boolean'].includes(typeof v) || v === null

const isString = (v) => typeof v === 'string'
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const optional = (check) => (v) => v === undefined || v === null || check(v)

/** What each signed field must be, so that a correctly signed but malformed message never gets further. */
const MESSAGE_TYPES = {
  id: isString,
  type: isString,
  username: isString,
  timestamp: isNumber,
  content: isString,
  parentId: optional(isString),
  fileName: optional(isString),
  fileSize: optional(isNumber),
  imageData: optional(isString),
}

const OP_TYPES = {
  originalId: isString,
  newContent: isString,
  editedAt: isNumber,
  messageId: isString,
  emoji: isString,
  removed: (v) => typeof v === 'boolean',
  at: isNumber,
}

function payload(kind, scope, publicKey, values) {
  return b4a.from(JSON.stringify([DOMAIN, kind, scope, publicKey, ...values]))
}

function signValues(kind, scope, publicKey, values, secretKey) {
  return b4a.toString(crypto.sign(payload(kind, scope, publicKey, values), secretKey), 'hex')
}

function verifyValues(kind, scope, publicKey, values, sig) {
  try {
    if (!HEX_KEY.test(publicKey) || !HEX_SIG.test(sig) || !values.every(isPrimitive)) return false
    return crypto.verify(payload(kind, scope, publicKey, values), b4a.from(sig, 'hex'), b4a.from(publicKey, 'hex'))
  } catch {
    return false
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────

function messageValues(msg) {
  return [
    msg.id,
    msg.type,
    msg.username,
    msg.timestamp,
    msg.content,
    msg.parentId ?? null,
    msg.fileName ?? null,
    msg.fileSize ?? null,
    typeof msg.imageData === 'string' ? hashHex(msg.imageData) : null,
  ]
}

/**
 * @param {string}     scope      Room code of the conversation
 * @param {object}     msg        Message whose `publicKey` is the author's key (hex)
 * @param {Uint8Array} secretKey  Author's Ed25519 secret key
 * @returns {string} hex signature
 */
export function signMessage(scope, msg, secretKey) {
  return signValues('msg', scope, msg.publicKey, messageValues(msg), secretKey)
}

/** @returns {boolean} true if `msg.sig` is a valid signature of the message by `msg.publicKey` */
export function verifyMessage(scope, msg) {
  if (!msg || typeof msg.publicKey !== 'string' || typeof msg.sig !== 'string') return false
  if (!Object.entries(MESSAGE_TYPES).every(([field, valid]) => valid(msg[field]))) return false
  return verifyValues('msg', scope, msg.publicKey, messageValues(msg), msg.sig)
}

/** Copy of a received message with only the signed fields (no `edited`, `deleted`, … injected by the sender). */
export function cleanMessage(raw) {
  const msg = {}
  for (const field of MESSAGE_FIELDS) {
    if (raw[field] !== undefined) msg[field] = raw[field]
  }
  return msg
}

/** @returns {boolean} true if both messages have the same value in every signed field (and the signature) */
export function sameMessage(a, b) {
  return MESSAGE_FIELDS.every((field) => a[field] === b[field])
}

// ── Operations (edit, delete, reaction) ───────────────────────────────────────

/**
 * @param {'edit'|'delete'|'reaction'} kind
 * @param {string} scope
 * @param {object} fields    The fields listed in OP_FIELDS[kind]
 * @param {{ publicKey: Uint8Array|string, secretKey: Uint8Array }} identity
 * @returns {object} `fields` plus `publicKey` (hex) and `sig`
 */
export function signOp(kind, scope, fields, identity) {
  const publicKey = toHex(identity.publicKey)
  const values = OP_FIELDS[kind].map((f) => fields[f])
  return { ...fields, publicKey, sig: signValues(kind, scope, publicKey, values, identity.secretKey) }
}

/** @returns {boolean} true if the operation was signed by `op.publicKey` for this scope */
export function verifyOp(kind, scope, op) {
  if (!op || typeof op.publicKey !== 'string' || typeof op.sig !== 'string') return false
  if (!OP_FIELDS[kind]?.every((field) => OP_TYPES[field](op[field]))) return false
  const values = OP_FIELDS[kind].map((f) => op[f])
  return verifyValues(kind, scope, op.publicKey, values, op.sig)
}
