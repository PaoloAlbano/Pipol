/**
 * useWorkspaceSync — keeps channels and member presence in sync across peers.
 *
 * Joins a dedicated swarm room derived from the workspace secret (meta topic).
 * This single swarm carries ALL workspace traffic: presence, channel messages,
 * and encrypted DMs. Channel swarms and per-DM swarms are no longer used.
 *
 * Messages:
 *   WORKSPACE_META  { channels[] }               — channel list sync (append-only)
 *   MEMBER_HELLO    { pubkey, username, status }  — sent on join / to new peers
 *   PRESENCE_UPDATE { pubkey, status }            — sent on visibilitychange
 *   CHANNEL_NOTIFY  { channelName }               — increment unread for inactive channel
 *   MSG             { channelName, message }       — channel message (in clear)
 *   DM              { to, nonce, ciphertext }      — encrypted direct message
 *
 * Returns:
 *   swarmRef           — ref to the RoomSwarm (passed to Room for text + video signaling)
 *   broadcastChannels  — push channel list to all peers immediately
 *   members            — Map<pubkey, { pubkey, username, status, lastSeen }>
 *   notifyChannel      — broadcast channel activity (unread bump)
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { RoomSwarm } from './swarm.js'
import { deriveSwarmTopic, mergeChannelList, getWorkspaces, saveWorkspace, getEffectiveConfig } from './workspace.js'
import { encryptDM } from './dm-crypto.js'

function pubkeyToHex(publicKey) {
  if (!publicKey) return null
  return Array.from(publicKey)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function useWorkspaceSync(workspace, identity, onChannelsUpdated, onChannelNotify, onDMOpen) {
  const swarmRef = useRef(null)
  const channelsRef = useRef(workspace?.channels ?? [])
  const identityRef = useRef(identity)
  const onChannelNotifyRef = useRef(onChannelNotify)
  const onDMOpenRef = useRef(onDMOpen)

  // members: Map<pubkey, { pubkey, username, status, lastSeen }>
  const membersRef = useRef(new Map())
  const [members, setMembers] = useState(() => new Map())
  // Reactive swarm — null until joined; exposed so Room can depend on it
  const [swarm, setSwarmState] = useState(null)

  useEffect(() => {
    channelsRef.current = workspace?.channels ?? []
  }, [workspace?.channels])

  useEffect(() => {
    identityRef.current = identity
  }, [identity])

  useEffect(() => {
    onChannelNotifyRef.current = onChannelNotify
  }, [onChannelNotify])

  useEffect(() => {
    onDMOpenRef.current = onDMOpen
  }, [onDMOpen])

  useEffect(() => {
    if (!workspace?.secret) return
    if (!identity) return

    const topic = deriveSwarmTopic(workspace.secret)
    const { relayUrl } = getEffectiveConfig(workspace.config)
    const swarm = new RoomSwarm(topic, { relayUrl: relayUrl || null })
    swarmRef.current = swarm
    // Capture membersRef.current at effect start so the cleanup can safely clear it
    // even if the ref has been reassigned by a subsequent render.
    const membersMap = membersRef.current
    // ── helpers ──────────────────────────────────────────────────────────────

    function myHello(status = 'online') {
      const id = identityRef.current
      const pubkey = pubkeyToHex(id?.publicKey)
      if (!pubkey) return null
      return { type: 'MEMBER_HELLO', pubkey, username: id?.username ?? 'unknown', status }
    }

    function upsertMember(pubkey, update) {
      const existing = membersRef.current.get(pubkey) ?? {
        pubkey,
        username: pubkey.slice(0, 8),
        status: 'online',
        lastSeen: Date.now(),
      }
      membersRef.current.set(pubkey, { ...existing, ...update, lastSeen: Date.now() })
      setMembers(new Map(membersRef.current))
    }

    // ── event handlers ─────────────────────────────────────────────────────

    function onPeerJoined(e) {
      const { id } = e.detail
      // Send our channel list
      swarm.sendToPeer(id, { type: 'WORKSPACE_META', channels: channelsRef.current })
      // Send our presence
      const hello = myHello()
      if (hello) swarm.sendToPeer(id, hello)
    }

    function onPeerLeft(e) {
      const { id } = e.detail
      // Mark offline but keep in list (we know their pubkey from MEMBER_HELLO)
      for (const [pubkey] of membersRef.current) {
        // Match by peerId which is their pubkey hex
        if (pubkey === id) {
          upsertMember(pubkey, { status: 'offline' })
          break
        }
      }
    }

    function onWorkspaceMeta(e) {
      const received = e.detail.channels
      if (!Array.isArray(received) || received.length === 0) return

      const current = getWorkspaces().find((w) => w.id === workspace.id)
      if (!current) return

      const merged = mergeChannelList(current.channels, received)
      if (merged.length === current.channels.length) return

      saveWorkspace({ ...current, channels: merged })
      onChannelsUpdated?.()
    }

    function onMemberHello(e) {
      const { pubkey, username, status } = e.detail
      if (!pubkey) return
      upsertMember(pubkey, { pubkey, username, status: status ?? 'online' })
    }

    function onPresenceUpdate(e) {
      const { pubkey, status } = e.detail
      if (!pubkey || !status) return
      upsertMember(pubkey, { status })
    }

    function onChannelNotifyEvent(e) {
      const { channelName } = e.detail
      if (channelName) onChannelNotifyRef.current?.(channelName)
    }

    // Incoming encrypted DM: try to decrypt. If it succeeds, it's for us.
    // Notify App so it can open the DM room for that sender.
    // (The actual message content is handled by the DM Room component.)
    function onDMMessageEvent(e) {
      const { from, to } = e.detail
      const myPubkey = pubkeyToHex(identityRef.current?.publicKey)
      if (!from || to !== myPubkey) return
      const senderMember = membersRef.current.get(from)
      if (!senderMember) return
      // We don't have the sender's raw public key Buffer here — signal App to open the DM
      // Room which will do the full decryption once mounted.
      onDMOpenRef.current?.(from)
    }

    function onVisibilityChange() {
      const status = document.visibilityState === 'hidden' ? 'away' : 'online'
      const pubkey = pubkeyToHex(identityRef.current?.publicKey)
      if (pubkey) swarm.sendToAll({ type: 'PRESENCE_UPDATE', pubkey, status })
    }

    // ── subscribe ────────────────────────────────────────────────────────────

    swarm.addEventListener('peer-joined', onPeerJoined)
    swarm.addEventListener('peer-left', onPeerLeft)
    swarm.addEventListener('workspace-meta', onWorkspaceMeta)
    swarm.addEventListener('member-hello', onMemberHello)
    swarm.addEventListener('presence-update', onPresenceUpdate)
    swarm.addEventListener('channel-notify', onChannelNotifyEvent)
    swarm.addEventListener('dm-message', onDMMessageEvent)
    document.addEventListener('visibilitychange', onVisibilityChange)

    // Join and announce ourselves
    swarm
      .join()
      .then(() => {
        setSwarmState(swarm) // expose to consumers (e.g. Room)
        const hello = myHello()
        if (hello) swarm.sendToAll(hello)
      })
      .catch((err) => console.warn('[workspace-sync] join failed', err))

    // Periodic re-announce: re-sends MEMBER_HELLO every 30s to catch peers
    // that joined while our DataChannel was still negotiating.
    const reannounceTimer = setInterval(() => {
      const hello = myHello()
      if (hello) swarm.sendToAll(hello)
    }, 30_000)

    return () => {
      clearInterval(reannounceTimer)
      swarm.removeEventListener('peer-joined', onPeerJoined)
      swarm.removeEventListener('peer-left', onPeerLeft)
      swarm.removeEventListener('workspace-meta', onWorkspaceMeta)
      swarm.removeEventListener('member-hello', onMemberHello)
      swarm.removeEventListener('presence-update', onPresenceUpdate)
      swarm.removeEventListener('channel-notify', onChannelNotifyEvent)
      swarm.removeEventListener('dm-message', onDMMessageEvent)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      membersMap.clear()
      setMembers(new Map())
      setSwarmState(null)
      swarm.leave()
      swarmRef.current = null
    }
  }, [workspace?.id, workspace?.secret, identity]) // eslint-disable-line react-hooks/exhaustive-deps

  const broadcastChannels = useCallback((channels) => {
    swarmRef.current?.sendToAll({ type: 'WORKSPACE_META', channels })
  }, [])

  const notifyChannel = useCallback((channelName) => {
    swarmRef.current?.sendToAll({ type: 'CHANNEL_NOTIFY', channelName })
  }, [])

  /**
   * Send an encrypted direct message to a specific peer.
   * @param {string} toPubkeyHex   Recipient's pubkey as hex string
   * @param {Buffer} theirPublicKey Recipient's raw Ed25519 public key Buffer
   * @param {object} message        The message object to encrypt and send
   */
  const sendDM = useCallback((toPubkeyHex, theirPublicKey, message) => {
    const id = identityRef.current
    if (!id?.secretKey || !theirPublicKey) return
    const { nonce, ciphertext } = encryptDM(message, id.secretKey, theirPublicKey)
    swarmRef.current?.sendToAll({ type: 'DM', to: toPubkeyHex, nonce, ciphertext })
  }, [])

  return { swarm, swarmRef, broadcastChannels, members, notifyChannel, sendDM }
}
