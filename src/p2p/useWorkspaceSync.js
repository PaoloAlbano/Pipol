/**
 * useWorkspaceSync — keeps the channel list in sync across peers.
 *
 * Joins a dedicated swarm room derived from the workspace secret (meta topic).
 * On peer connect: sends the current channel list.
 * On receiving WORKSPACE_META: merges remote channels into local storage and
 * calls onChannelsUpdated() so the UI can re-render.
 *
 * Also exposes broadcastChannels() so App.jsx can push updates after
 * creating a new channel.
 */

import { useEffect, useRef, useCallback } from 'react'
import { RoomSwarm } from './swarm.js'
import { deriveSwarmTopic, mergeChannelList, getWorkspaces, saveWorkspace } from './workspace.js'

export function useWorkspaceSync(workspace, onChannelsUpdated) {
  const swarmRef = useRef(null)
  // Keep a ref so event handlers always see the latest channels without re-subscribing
  const channelsRef = useRef(workspace?.channels ?? [])

  useEffect(() => {
    channelsRef.current = workspace?.channels ?? []
  }, [workspace?.channels])

  useEffect(() => {
    if (!workspace?.secret) return

    const topic = deriveSwarmTopic(workspace.secret)
    const swarm = new RoomSwarm(topic)
    swarmRef.current = swarm

    function onPeerJoined(e) {
      // Send our current channel list to the new peer
      swarm.sendToPeer(e.detail.id, {
        type: 'WORKSPACE_META',
        channels: channelsRef.current,
      })
    }

    function onWorkspaceMeta(e) {
      const received = e.detail.channels
      if (!Array.isArray(received) || received.length === 0) return

      const current = getWorkspaces().find((w) => w.id === workspace.id)
      if (!current) return

      const merged = mergeChannelList(current.channels, received)
      if (merged.length === current.channels.length) return // nothing new

      saveWorkspace({ ...current, channels: merged })
      onChannelsUpdated?.()
    }

    swarm.addEventListener('peer-joined', onPeerJoined)
    swarm.addEventListener('workspace-meta', onWorkspaceMeta)

    swarm.join().catch((err) => console.warn('[workspace-sync] join failed', err))

    return () => {
      swarm.removeEventListener('peer-joined', onPeerJoined)
      swarm.removeEventListener('workspace-meta', onWorkspaceMeta)
      swarm.leave()
      swarmRef.current = null
    }
  }, [workspace?.id, workspace?.secret]) // eslint-disable-line react-hooks/exhaustive-deps

  // Call after creating a channel to immediately push to connected peers
  const broadcastChannels = useCallback((channels) => {
    swarmRef.current?.sendToAll({ type: 'WORKSPACE_META', channels })
  }, [])

  return { broadcastChannels }
}
