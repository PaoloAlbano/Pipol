/**
 * workspace.js
 * Workspace management — creation, invite URL parsing, channel derivation, local persistence.
 *
 * A workspace is identified by a secret (32 random bytes, hex-encoded).
 * All room codes and the swarm topic are derived from that secret — they are
 * not guessable without knowing it.
 *
 * Invite URL format:
 *   https://pipol.dev/?invite=<base64url(JSON)>
 *
 * Invite payload schema (v1):
 *   {
 *     v:        1,                        // schema version
 *     secret:   "<64-char hex>",          // workspace secret
 *     name:     "Acme Corp",              // display name
 *     channels: ["generale", "random"],   // seed channel names
 *     config: {                           // optional — overrides app defaults
 *       relayUrl: "wss://relay.acme.com",
 *       authUrl:  "https://auth.acme.com"
 *     }
 *   }
 *
 * Derivations (BLAKE2b via hypercore-crypto):
 *   swarmTopic(secret)         = BLAKE2b(secretBytes ‖ ":meta")          → 32-byte hex
 *   channelRoomCode(secret, n) = BLAKE2b(secretBytes ‖ ":ch:" ‖ n).hex().slice(0,20)
 *
 * Channel rules:
 *   - Anyone in the workspace can create a channel (append-only CRDT)
 *   - Channels cannot be deleted (only hidden locally)
 *   - Channel list = union of all WORKSPACE_META messages received from peers
 */

import * as crypto from 'hypercore-crypto'
import b4a from 'b4a'

const STORAGE_KEY = 'p2p-chat:workspaces'
const ACTIVE_KEY = 'p2p-chat:active-workspace'
const INVITE_PARAM = 'invite'
const SCHEMA_VERSION = 1

// ─── Derivation ──────────────────────────────────────────────────────────────

/**
 * Derives the Hyperswarm topic for the workspace meta-swarm.
 * @param {string} secret  Hex-encoded 32-byte workspace secret
 * @returns {string}  64-char hex string (32 bytes)
 */
export function deriveSwarmTopic(secret) {
  const buf = b4a.concat([b4a.from(secret, 'hex'), b4a.from(':meta')])
  return b4a.toString(crypto.hash(buf), 'hex')
}

/**
 * Derives the room code for a channel within this workspace.
 * @param {string} secret       Hex-encoded 32-byte workspace secret
 * @param {string} channelName  Lowercase channel name
 * @returns {string}  20-char hex room code
 */
export function deriveChannelRoomCode(secret, channelName) {
  const buf = b4a.concat([b4a.from(secret, 'hex'), b4a.from(':ch:' + channelName.toLowerCase())])
  return b4a.toString(crypto.hash(buf), 'hex').slice(0, 20)
}

// ─── Invite URL ──────────────────────────────────────────────────────────────

/**
 * Creates a new workspace object and returns both the workspace and its invite URL.
 *
 * @param {string}   name      Display name for the workspace
 * @param {string[]} channels  Initial channel names (e.g. ["general", "random"])
 * @param {object}   [config]  Optional { relayUrl, authUrl } overrides
 * @returns {{ workspace: object, inviteUrl: string }}
 */
export function createWorkspace(name, channels = ['general', 'random'], config = null, createdBy = null) {
  const secretBytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const secret = b4a.toString(b4a.from(secretBytes), 'hex')
  const id = globalThis.crypto.randomUUID()
  const now = Date.now()

  const workspace = {
    id,
    name: name.trim(),
    secret,
    createdBy, // hex pubkey of creator — determines who can share invite URLs
    channels: channels.map((n) => ({
      name: n.toLowerCase().trim(),
      topic: '',
      createdAt: now,
      createdBy,
    })),
    config: config ?? null,
    joinedAt: now,
  }

  const inviteUrl = buildInviteUrl(workspace)
  return { workspace, inviteUrl }
}

/**
 * Builds an invite URL from a workspace object.
 * Can be called again at any time to generate a fresh shareable link
 * (useful when channels have been added since the first invite).
 *
 * @param {object} workspace
 * @returns {string}
 */
export function buildInviteUrl(workspace) {
  const payload = {
    v: SCHEMA_VERSION,
    secret: workspace.secret,
    name: workspace.name,
    channels: workspace.channels.map((c) => c.name),
  }
  if (workspace.config) payload.config = workspace.config

  const encoded = toBase64Url(JSON.stringify(payload))
  const base = window.location.origin
  return `${base}/?${INVITE_PARAM}=${encoded}`
}

/**
 * Parses and validates an invite URL or raw invite param value.
 * Returns a workspace-shaped object ready to be passed to saveWorkspace(),
 * with channels populated from the payload seed list.
 *
 * @param {string} urlOrParam  Full URL containing ?invite=… or just the base64url value
 * @returns {{ workspace: object, config: object|null }}
 * @throws {Error} 'invalid-invite' | 'unsupported-version'
 */
export function parseInviteUrl(urlOrParam) {
  let encoded = urlOrParam
  try {
    const url = new URL(urlOrParam)
    encoded = url.searchParams.get(INVITE_PARAM) ?? urlOrParam
  } catch {
    // not a full URL — treat as raw param value
  }

  let payload
  try {
    payload = JSON.parse(fromBase64Url(encoded))
  } catch {
    throw new Error('invalid-invite')
  }

  if (!payload || typeof payload !== 'object') throw new Error('invalid-invite')
  if (payload.v !== SCHEMA_VERSION) throw new Error('unsupported-version')
  if (typeof payload.secret !== 'string' || payload.secret.length !== 64) throw new Error('invalid-invite')
  if (typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('invalid-invite')
  if (!Array.isArray(payload.channels) || payload.channels.length === 0) throw new Error('invalid-invite')

  const now = Date.now()
  const workspace = {
    id: globalThis.crypto.randomUUID(),
    name: payload.name.trim(),
    secret: payload.secret,
    channels: payload.channels.map((n) => ({
      name: String(n).toLowerCase().trim(),
      topic: '',
      createdAt: now,
      createdBy: null,
    })),
    config: payload.config ?? null,
    joinedAt: now,
  }

  return { workspace, config: payload.config ?? null }
}

/**
 * Extracts the invite param from the current page URL, if present.
 * Returns null if not found.
 * @returns {string|null}
 */
export function getInviteParamFromUrl() {
  return new URLSearchParams(window.location.search).get(INVITE_PARAM)
}

// ─── Channel list merge (CRDT append-only) ───────────────────────────────────

/**
 * Merges a received channel list from a peer into the local channel list.
 * Append-only: channels are only added, never removed.
 * Deduplication is by channel name (case-insensitive).
 *
 * @param {object[]} local     Local channel array
 * @param {object[]} received  Channel array received from WORKSPACE_META peer message
 * @returns {object[]}  Merged array (new reference if changed, same reference if not)
 */
export function mergeChannelList(local, received) {
  if (!Array.isArray(received) || received.length === 0) return local

  const existingNames = new Set(local.map((c) => c.name.toLowerCase()))
  const toAdd = received.filter((c) => c?.name && !existingNames.has(c.name.toLowerCase()))

  if (toAdd.length === 0) return local
  return [...local, ...toAdd]
}

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Returns the effective configuration for a workspace, falling back to
 * Vite env vars and then to sensible defaults.
 *
 * Priority: workspace.config > VITE_ env vars > auto-derive from window.location
 *
 * @param {object|null} workspaceConfig  The `config` field from the workspace object
 * @returns {{ relayUrl: string, authUrl: string }}
 */
export function getEffectiveConfig(workspaceConfig) {
  const relayUrl =
    workspaceConfig?.relayUrl ||
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DHT_RELAY_URL) ||
    (() => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${proto}//${window.location.host}`
    })()

  const authUrl =
    workspaceConfig?.authUrl || (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AUTH_URL) || null

  return { relayUrl, authUrl }
}

// ─── Local persistence ───────────────────────────────────────────────────────

/**
 * Returns all workspaces saved in localStorage.
 * @returns {object[]}
 */
export function getWorkspaces() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

/**
 * Saves (or updates) a workspace in localStorage.
 * Matches by `id` — updates in place if found, appends if new.
 * @param {object} workspace
 */
export function saveWorkspace(workspace) {
  const all = getWorkspaces()
  const idx = all.findIndex((w) => w.id === workspace.id)
  if (idx >= 0) {
    all[idx] = workspace
  } else {
    all.push(workspace)
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

/**
 * Removes a workspace from localStorage by id.
 * @param {string} id
 */
export function removeWorkspace(id) {
  const all = getWorkspaces().filter((w) => w.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  if (getActiveWorkspaceId() === id) setActiveWorkspaceId(null)
}

/**
 * Returns the id of the currently active workspace, or null.
 * @returns {string|null}
 */
export function getActiveWorkspaceId() {
  return localStorage.getItem(ACTIVE_KEY) || null
}

/**
 * Sets the active workspace id.
 * @param {string|null} id
 */
export function setActiveWorkspaceId(id) {
  if (id) {
    localStorage.setItem(ACTIVE_KEY, id)
  } else {
    localStorage.removeItem(ACTIVE_KEY)
  }
}

/**
 * Returns the active workspace object, or null if none is set / not found.
 * @returns {object|null}
 */
export function getActiveWorkspace() {
  const id = getActiveWorkspaceId()
  if (!id) return null
  return getWorkspaces().find((w) => w.id === id) ?? null
}

/**
 * Adds a channel to a workspace and persists the change.
 * No-op if a channel with that name already exists.
 *
 * @param {string} workspaceId
 * @param {string} channelName
 * @param {string} [createdByPubKey]
 * @returns {object|null}  The updated workspace, or null if workspace not found
 */
export function addChannel(workspaceId, channelName, createdByPubKey = null) {
  const all = getWorkspaces()
  const ws = all.find((w) => w.id === workspaceId)
  if (!ws) return null

  const name = channelName.toLowerCase().trim()
  if (ws.channels.some((c) => c.name === name)) return ws

  ws.channels.push({ name, topic: '', createdAt: Date.now(), createdBy: createdByPubKey })
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  return ws
}

/**
 * Updates the topic of a channel within a workspace.
 *
 * @param {string} workspaceId
 * @param {string} channelName
 * @param {string} topic
 * @returns {object|null}  Updated workspace or null
 */
export function setChannelTopic(workspaceId, channelName, topic) {
  const all = getWorkspaces()
  const ws = all.find((w) => w.id === workspaceId)
  if (!ws) return null

  const channel = ws.channels.find((c) => c.name === channelName.toLowerCase())
  if (!channel) return null

  channel.topic = topic
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  return ws
}

// ─── base64url helpers ───────────────────────────────────────────────────────

function toBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function fromBase64Url(str) {
  const padded = str
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(str.length / 4) * 4, '=')
  return decodeURIComponent(escape(atob(padded)))
}
