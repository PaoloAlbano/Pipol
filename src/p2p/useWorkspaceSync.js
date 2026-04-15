/**
 * useWorkspaceSync — keeps channels and member presence in sync across peers.
 *
 * Joins a dedicated swarm room derived from the workspace secret (meta topic).
 *
 * Discovery strategy (two-layer):
 *   1. WebSocket relay (always):  MEMBER_HELLO / WORKSPACE_META / PRESENCE_UPDATE
 *      are broadcast via the relay WS immediately on join and on relay-peer-joined.
 *      This guarantees discovery works even when WebRTC ICE fails (symmetric NAT, mobile).
 *   2. WebRTC DataChannel (when ICE succeeds): same messages sent again as belt-and-
 *      suspenders. Also used for per-channel chat (Room component).
 *
 * Messages:
 *   WORKSPACE_META  { channels[] }              — channel list sync (append-only)
 *   MEMBER_HELLO    { pubkey, username, status } — sent on join / to new peers
 *   PRESENCE_UPDATE { pubkey, status }           — sent on visibilitychange
 *   CHANNEL_NOTIFY  { channelName }              — increment unread for inactive channel
 *   DM_INVITE       { from, to }                 — open DM with sender if we are 'to'
 *
 * Returns:
 *   broadcastChannels(channels)    — push channel list to all peers immediately
 *   members                        — Map<pubkey, { pubkey, username, status, lastSeen }>
 *   notifyChannel(name)            — broadcast channel activity (unread bump)
 *   sendDMInvite(targetPubkey)     — notify a peer that we want to DM them
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { RoomSwarm } from './swarm.js'
import { deriveSwarmTopic, mergeChannelList, getWorkspaces, saveWorkspace, getEffectiveConfig } from './workspace.js'

function pubkeyToHex(publicKey) {
  if (!publicKey) return null
  return Array.from(publicKey)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function useWorkspaceSync(workspace, identity, onChannelsUpdated, onChannelNotify, onDMInvite) {
  const swarmRef = useRef(null)
  const channelsRef = useRef(workspace?.channels ?? [])
  const identityRef = useRef(identity)
  const onChannelNotifyRef = useRef(onChannelNotify)
  const onDMInviteRef = useRef(onDMInvite)

  // members: Map<pubkey, { pubkey, username, status, lastSeen }>
  const membersRef = useRef(new Map())
  const [members, setMembers] = useState(() => new Map())

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
    onDMInviteRef.current = onDMInvite
  }, [onDMInvite])

  useEffect(() => {
    if (!workspace?.secret) return
    if (!identity) return

    const topic = deriveSwarmTopic(workspace.secret)
    const { relayUrl } = getEffectiveConfig(workspace.config)
    const swarm = new RoomSwarm(topic, { relayUrl: relayUrl || null })
    swarmRef.current = swarm

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
      for (const [pubkey, member] of membersRef.current) {
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

    function onDMInviteEvent(e) {
      const { from, to } = e.detail
      const myPubkey = pubkeyToHex(identityRef.current?.publicKey)
      // Only act if this invite is addressed to us
      if (from && to && myPubkey && to === myPubkey && from !== myPubkey) {
        onDMInviteRef.current?.(from)
      }
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
    swarm.addEventListener('dm-invite', onDMInviteEvent)
    document.addEventListener('visibilitychange', onVisibilityChange)

    // Join and announce ourselves
    swarm
      .join()
      .then(() => {
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
      swarm.removeEventListener('dm-invite', onDMInviteEvent)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      membersRef.current.clear()
      setMembers(new Map())
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

  const sendDMInvite = useCallback((targetPubkey) => {
    const myPubkey = pubkeyToHex(identityRef.current?.publicKey)
    if (!myPubkey) return
    swarmRef.current?.sendToAll({ type: 'DM_INVITE', from: myPubkey, to: targetPubkey })
  }, [])

  return { broadcastChannels, members, notifyChannel, sendDMInvite }
}
