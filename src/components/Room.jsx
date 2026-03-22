import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createRoomSwarm } from '../p2p/swarm.js'
import { MessageStore } from '../p2p/autobase.js'
import { WebRTCPeer } from '../webrtc/peer.js'
import {
  getLocalStream,
  stopLocalStream,
  setAudioMuted,
  setVideoMuted,
  pauseVideoTracks,
  resumeVideoTracks,
  switchCamera,
  startScreenShare,
  stopScreenShare,
} from '../webrtc/media.js'
import ChatMessages from './ChatMessages.jsx'
import ChatInput from './ChatInput.jsx'
import VideoGrid from './VideoGrid.jsx'
import VideoControls from './VideoControls.jsx'
import '../styles/room.css'

/**
 * Room view — active chat and optional video call.
 *
 * @param {string}   roomCode
 * @param {object}   identity   { publicKey, secretKey, username }
 * @param {function} onLeave    Callback to return to the Home screen
 */
export default function Room({ roomCode, identity, showStats, onLeave, onOpenSettings }) {
  const [peers, setPeers] = useState([])
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('connecting…')
  const [p2pError, setP2pError] = useState(null)

  // Panel collapse state (auto-reset on mobile)
  const isMobile = () => window.innerWidth <= 560
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(true)
  useEffect(() => {
    const onResize = () => {
      if (isMobile()) setChatOpen(true)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Video call state
  const [callActive, setCallActive] = useState(false)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStreams, setRemoteStreams] = useState({}) // peerId → MediaStream
  const [audioMuted, setAudioMutedState] = useState(false)
  const [videoMuted, setVideoMutedState] = useState(false)
  const [screenSharing, setScreenSharing] = useState(false)
  const [layout, setLayout] = useState('grid') // 'grid' | 'spotlight'
  const [spotlightPeerId, setSpotlightPeerId] = useState(null)
  const [incomingCall, setIncomingCall] = useState(null) // { peerId, username } | null
  const [callPeerIds, setCallPeerIds] = useState(new Set()) // peers currently in a call
  const [peerStats, setPeerStats] = useState({}) // peerId → connection stats

  // Persistent refs (not re-rendered on change)
  const swarmRef = useRef(null)
  const msgStoreRef = useRef(null)
  const rtcPeersRef = useRef({}) // peerId → WebRTCPeer
  const callActiveRef = useRef(false)
  const prevStatsRef = useRef({}) // peerId → { bytesSent, bytesReceived, ts }

  useEffect(() => {
    callActiveRef.current = callActive
  }, [callActive])

  // ── Attach swarm event listeners (reusable on reconnect) ──────────────────
  function attachSwarmListeners(swarm, msgStore) {
    swarm.addEventListener('peer-joined', async (e) => {
      const { id } = e.detail
      // Bidirectional delta sync: ask for messages we don't have yet
      const since = await msgStore.getLastTimestamp()
      swarm.sendToPeer(id, { type: 'HISTORY_REQ', since })
      setPeers(swarm.getPeers())
      setStatus(`${swarm.getPeers().length} peer(s) connected`)
      if (callActiveRef.current) {
        await ensureRTCPeer(id, true)
        swarm.sendToPeer(id, { type: 'CALL_INIT' })
      }
    })

    swarm.addEventListener('peer-left', (e) => {
      const { id } = e.detail
      cleanupRTCPeer(id)
      setPeers(swarm.getPeers())
      const count = swarm.getPeers().length
      setStatus(count > 0 ? `${count} peer(s) connected` : 'waiting for peers…')
      setCallPeerIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      setIncomingCall((prev) => (prev?.peerId === id ? null : prev))
      setSpotlightPeerId((prev) => (prev === id ? null : prev))
    })

    swarm.addEventListener('call-init', async (e) => {
      const { peerId } = e.detail
      const callerName = swarmRef.current?.peers.get(peerId)?.username ?? peerId.slice(0, 8)

      // Track that this peer is in a call
      setCallPeerIds((prev) => new Set([...prev, peerId]))

      if (callActiveRef.current) {
        // Already in the call — connect directly
        await ensureRTCPeer(peerId, false)
      } else {
        // Show modal only the first time (don't re-show if already dismissed)
        setIncomingCall((prev) => prev ?? { peerId, username: callerName })
      }
    })

    swarm.addEventListener('call-end', (e) => {
      const { peerId } = e.detail
      cleanupRTCPeer(peerId)
      setCallPeerIds((prev) => {
        const next = new Set(prev)
        next.delete(peerId)
        return next
      })
      setIncomingCall((prev) => (prev?.peerId === peerId ? null : prev))
    })

    swarm.addEventListener('video-offer', async (e) => {
      if (!callActiveRef.current) return
      const peer = await ensureRTCPeer(e.detail.peerId, false)
      await peer.handleOffer(e.detail.sdp)
    })
    swarm.addEventListener('video-answer', async (e) => {
      if (!callActiveRef.current) return
      rtcPeersRef.current[e.detail.peerId]?.handleAnswer(e.detail.sdp)
    })
    swarm.addEventListener('video-ice', async (e) => {
      if (!callActiveRef.current) return
      rtcPeersRef.current[e.detail.peerId]?.handleIceCandidate(e.detail.candidate)
    })

    swarm.addEventListener('history-req', async (e) => {
      const { peerId, since } = e.detail
      const history = await msgStore.getHistory()
      const newer = history.filter((m) => m.timestamp > since)
      if (newer.length > 0) {
        swarmRef.current.sendToPeer(peerId, { type: 'HISTORY_RES', messages: newer })
      }
    })

    swarm.addEventListener('chat-message', (e) => {
      msgStore.receiveMessage(e.detail.message)
    })

    swarm.addEventListener('screen-share-start', (e) => {
      const { peerId } = e.detail
      setSpotlightPeerId(peerId)
      setLayout('spotlight')
    })

    swarm.addEventListener('screen-share-end', (e) => {
      const { peerId } = e.detail
      setSpotlightPeerId((prev) => (prev === peerId ? null : prev))
      setLayout('grid')
    })

    swarm.addEventListener('error', (e) => {
      console.error('[room] swarm error', e.detail)
      setStatus('⚠ swarm error — check console')
    })
  }

  // ── Initialise P2P stack on mount ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function setup() {
      try {
        // 1. Message store (Hypercore-backed local persistence)
        const msgStore = new MessageStore(roomCode, identity)
        await msgStore.init()
        msgStoreRef.current = msgStore

        msgStore.on('messages', (msgs) => {
          if (!cancelled) setMessages(msgs)
        })

        const history = await msgStore.getHistory()
        if (!cancelled) setMessages(history)

        // 2. Peer discovery via WebRTC swarm
        const swarm = await createRoomSwarm(roomCode, {
          messageCoreKey: msgStore.getLocalCoreKey(),
        })
        swarmRef.current = swarm
        attachSwarmListeners(swarm, msgStore)

        if (!cancelled) setStatus('waiting for peers…')
      } catch (err) {
        console.error('[room] setup error', err)
        if (!cancelled) {
          if (err.code === 'BROWSER_UNSUPPORTED') setP2pError('browser')
          setStatus(`⚠ ${err.message}`)
        }
      }
    }

    setup()

    return () => {
      cancelled = true
      teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode])

  // ── Reconnect when app returns to foreground ───────────────────────────────
  useEffect(() => {
    async function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        pauseVideoTracks()
        return
      }

      // Visible again — resume video
      const tracksAlive = resumeVideoTracks()
      if (!tracksAlive && callActiveRef.current) {
        // OS killed the tracks — get a new stream and replace in all active RTCPeerConnections
        try {
          const newStream = await getLocalStream()
          setLocalStream(newStream)
          const [newVideoTrack] = newStream.getVideoTracks()
          const [newAudioTrack] = newStream.getAudioTracks()
          for (const rtcPeer of Object.values(rtcPeersRef.current)) {
            const senders = rtcPeer._pc?.getSenders() ?? []
            for (const sender of senders) {
              if (sender.track?.kind === 'video' && newVideoTrack) {
                await sender.replaceTrack(newVideoTrack).catch(() => {})
              } else if (sender.track?.kind === 'audio' && newAudioTrack) {
                await sender.replaceTrack(newAudioTrack).catch(() => {})
              }
            }
          }
        } catch (err) {
          console.warn('[room] could not restart video after wake', err)
        }
      }

      const ws = swarmRef.current?._ws
      if (!ws || ws.readyState === WebSocket.OPEN) return

      console.info('[room] app foregrounded, reconnecting swarm…')
      setStatus('reconnecting…')
      try {
        await swarmRef.current.leave().catch(() => {})
        const swarm = await createRoomSwarm(roomCode, {
          messageCoreKey: msgStoreRef.current?.getLocalCoreKey(),
        })
        swarmRef.current = swarm
        attachSwarmListeners(swarm, msgStoreRef.current)
        setStatus('waiting for peers…')
      } catch (err) {
        console.error('[room] reconnect failed', err)
        setStatus(`⚠ reconnect failed: ${err.message}`)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode])

  // ── Stats polling (when overlay is active) ────────────────────────────────
  useEffect(() => {
    if (!showStats || !callActive) return
    async function pollStats() {
      const next = {}
      const now = Date.now()
      for (const [peerId, rtcPeer] of Object.entries(rtcPeersRef.current)) {
        const s = await rtcPeer.getConnectionStats().catch(() => null)
        if (!s) continue
        const prev = prevStatsRef.current[peerId]
        const dt = prev ? (now - prev.ts) / 1000 : null
        next[peerId] = {
          ...s,
          bytesSentPerSec: dt && dt > 0 ? Math.round((s.bytesSent - prev.bytesSent) / dt) : null,
          bytesReceivedPerSec:
            dt && dt > 0 ? Math.round((s.bytesReceived - prev.bytesReceived) / dt) : null,
        }
        prevStatsRef.current[peerId] = {
          bytesSent: s.bytesSent,
          bytesReceived: s.bytesReceived,
          ts: now,
        }
      }
      setPeerStats(next)
    }
    pollStats()
    const id = setInterval(pollStats, 2000)
    return () => clearInterval(id)
  }, [showStats, callActive])

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function ensureRTCPeer(peerId, isInitiator) {
    if (rtcPeersRef.current[peerId]) return rtcPeersRef.current[peerId]

    const stream = localStream || (await getLocalStream())
    const rtcPeer = new WebRTCPeer(peerId, isInitiator, stream)
    rtcPeersRef.current[peerId] = rtcPeer

    rtcPeer.addEventListener('offer', (e) => {
      swarmRef.current?.sendToPeer(peerId, { type: 'VIDEO_OFFER', sdp: e.detail.sdp })
    })

    rtcPeer.addEventListener('answer', (e) => {
      swarmRef.current?.sendToPeer(peerId, { type: 'VIDEO_ANSWER', sdp: e.detail.sdp })
    })

    rtcPeer.addEventListener('ice-candidate', (e) => {
      swarmRef.current?.sendToPeer(peerId, { type: 'VIDEO_ICE', candidate: e.detail.candidate })
    })

    rtcPeer.addEventListener('remote-stream', (e) => {
      setRemoteStreams((prev) => ({ ...prev, [peerId]: e.detail.stream }))
    })

    rtcPeer.addEventListener('closed', () => {
      setRemoteStreams((prev) => {
        const next = { ...prev }
        delete next[peerId]
        return next
      })
    })

    await rtcPeer.init()
    return rtcPeer
  }

  function cleanupRTCPeer(peerId) {
    rtcPeersRef.current[peerId]?.close()
    delete rtcPeersRef.current[peerId]
    setRemoteStreams((prev) => {
      const next = { ...prev }
      delete next[peerId]
      return next
    })
  }

  async function teardown() {
    Object.values(rtcPeersRef.current).forEach((p) => p.close())
    rtcPeersRef.current = {}
    stopLocalStream()
    await msgStoreRef.current?.close().catch(() => {})
    await swarmRef.current?.leave().catch(() => {})
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleSendMessage = useCallback(async (content) => {
    const msg = await msgStoreRef.current?.addMessage(content)
    if (msg) swarmRef.current?.sendToAll({ type: 'MSG', message: msg })
  }, [])

  async function handleStartCall() {
    try {
      const stream = await getLocalStream()
      setLocalStream(stream)
      setCallActive(true)

      // Notify all peers that we're starting a call
      swarmRef.current?.sendToAll({ type: 'CALL_INIT' })

      // Open WebRTC connections to all current peers (mesh)
      for (const peer of swarmRef.current?.getPeers() ?? []) {
        await ensureRTCPeer(peer.id, /* isInitiator */ true)
      }
    } catch (err) {
      console.error('[room] start call error', err)
      if (err.name === 'NotAllowedError') {
        alert('Camera/microphone permission denied.')
      }
    }
  }

  function handleEndCall() {
    swarmRef.current?.sendToAll({ type: 'CALL_END' })
    Object.values(rtcPeersRef.current).forEach((p) => p.close())
    rtcPeersRef.current = {}
    setRemoteStreams({})
    stopLocalStream()
    setLocalStream(null)
    setCallActive(false)
    setAudioMutedState(false)
    setVideoMutedState(false)
    setScreenSharing(false)
    setLayout('grid')
    setSpotlightPeerId(null)
  }

  function handleDeclineCall() {
    setIncomingCall(null)
  }

  async function handleJoinCall() {
    setIncomingCall(null)
    await handleStartCall()
  }

  function handleToggleAudio() {
    const next = !audioMuted
    setAudioMuted(next)
    setAudioMutedState(next)
  }

  function handleToggleVideo() {
    const next = !videoMuted
    setVideoMuted(next)
    setVideoMutedState(next)
  }

  async function handleSwitchCamera() {
    const result = await switchCamera()
    if (!result) return
    setLocalStream(result.stream)
    for (const rtcPeer of Object.values(rtcPeersRef.current)) {
      const senders = rtcPeer._pc?.getSenders() ?? []
      for (const sender of senders) {
        if (sender.track?.kind === 'video') {
          await sender.replaceTrack(result.videoTrack).catch(() => {})
        }
      }
    }
  }

  async function handleToggleScreenShare() {
    if (!screenSharing) {
      let result
      try {
        result = await startScreenShare()
      } catch (err) {
        // User cancelled the picker or permission denied — ignore
        if (err.name !== 'NotAllowedError') console.warn('[room] screen share error', err)
        return
      }
      if (!result) return

      setLocalStream(result.stream)
      setScreenSharing(true)
      swarmRef.current?.sendToAll({ type: 'SCREEN_SHARE_START' })

      // Replace video track in all active RTCPeerConnections
      for (const rtcPeer of Object.values(rtcPeersRef.current)) {
        const senders = rtcPeer._pc?.getSenders() ?? []
        for (const sender of senders) {
          if (sender.track?.kind === 'video') {
            await sender.replaceTrack(result.screenTrack).catch(() => {})
          }
        }
      }

      // Handle user clicking "Stop sharing" in the browser's native bar
      result.screenTrack.addEventListener(
        'ended',
        () => {
          handleToggleScreenShare()
        },
        { once: true }
      )
    } else {
      const result = await stopScreenShare()
      setScreenSharing(false)
      swarmRef.current?.sendToAll({ type: 'SCREEN_SHARE_END' })
      if (!result) return

      setLocalStream(result.stream)

      for (const rtcPeer of Object.values(rtcPeersRef.current)) {
        const senders = rtcPeer._pc?.getSenders() ?? []
        for (const sender of senders) {
          if (sender.track?.kind === 'video') {
            await sender.replaceTrack(result.videoTrack).catch(() => {})
          }
        }
      }
    }
  }

  function handleLeave() {
    if (callActive) handleEndCall()
    teardown()
    onLeave()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const callInProgress = callPeerIds.size > 0 && !callActive

  return (
    <div className={`room-layout ${callActive ? 'room-layout--call' : ''}`}>
      {/* ── Incoming call modal ── */}
      {incomingCall && !callActive && (
        <div className="call-modal-overlay">
          <div className="call-modal">
            <div className="call-modal-icon">📹</div>
            <p className="call-modal-title">{incomingCall.username} has started a video call</p>
            <div className="call-modal-actions">
              <button className="btn btn-primary" onClick={handleJoinCall}>
                Join
              </button>
              <button className="btn btn-secondary" onClick={handleDeclineCall}>
                Decline
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Mobile top bar (visible only on small screens) ── */}
      <div className="room-mobile-header">
        <button className="btn-icon-only" onClick={handleLeave} title="Leave room">
          <img src="/icons/icon.svg" alt="Pipol" width="20" height="20" className="room-home-icon" />
        </button>
        <span className="room-beta-badge">beta</span>
        <button className="btn-icon-only" onClick={onOpenSettings} title="Settings">
          ⚙️
        </button>
        <div className="room-mobile-title">
          <span className="room-code-label">Room</span>
          <span className="room-code-value">{roomCode}</span>
        </div>
        <span className="room-mobile-peers">👥 {peers.length + 1}</span>
        {callInProgress && !callActive && (
          <button className="btn-mobile-call btn-mobile-call--pulse" onClick={handleJoinCall}>
            📹 {callPeerIds.size}
          </button>
        )}
        {!callInProgress && !callActive && (
          <button className="btn-mobile-call" onClick={handleStartCall}>
            📹 Call
          </button>
        )}
        {callActive && (
          <>
            <button className="btn-mobile-call" onClick={handleSwitchCamera} title="Switch camera">
              🔄
            </button>
            <button className="btn-mobile-call btn-mobile-call--danger" onClick={handleEndCall}>
              ✕ End
            </button>
          </>
        )}
      </div>

      {/* ── Left sidebar: participants + controls ── */}
      <aside className={`room-sidebar ${sidebarOpen ? '' : 'room-sidebar--collapsed'}`}>
        <div className="room-sidebar-header">
          <div className="room-sidebar-header-top">
            <button className="btn-icon-only" onClick={handleLeave} title="Leave room">
              <img src="/icons/icon.svg" alt="Pipol" width="20" height="20" className="room-home-icon" />
            </button>
            {sidebarOpen && <span className="room-beta-badge">beta</span>}
            <div className="room-sidebar-header-spacer" />
            {sidebarOpen && (
              <button className="btn-collapse" onClick={onOpenSettings} title="Settings">
                ⚙️
              </button>
            )}
            <button
              className="btn-collapse"
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              {sidebarOpen ? '◀' : '▶'}
            </button>
          </div>
          {sidebarOpen && (
            <div className="room-code-display">
              <span className="room-code-label">Room</span>
              <span className="room-code-value">{roomCode}</span>
            </div>
          )}
        </div>

        <div className="room-status">{status}</div>

        {/* Peer list */}
        <div className="peer-list">
          <div className="peer-list-title">Participants</div>
          <div className="peer-item self">
            <span className="peer-dot online" />
            <span className="peer-name">{identity.username} (you)</span>
          </div>
          {peers.map((p) => (
            <div key={p.id} className="peer-item">
              <span className="peer-dot online" />
              <span className="peer-name">{p.username}</span>
            </div>
          ))}
        </div>

        {/* Call in progress indicator */}
        {callInProgress && (
          <div className="call-in-progress">
            <span className="call-in-progress-dot" />
            <span className="call-in-progress-text">Call in progress · {callPeerIds.size}</span>
            <button className="call-in-progress-join" onClick={handleJoinCall}>
              Join
            </button>
          </div>
        )}

        {/* Call controls */}
        <div className="room-sidebar-footer">
          {!callActive ? (
            <button className="btn btn-call-start" onClick={handleStartCall}>
              📹 Start Video Call
            </button>
          ) : (
            <VideoControls
              audioMuted={audioMuted}
              videoMuted={videoMuted}
              screenSharing={screenSharing}
              onToggleAudio={handleToggleAudio}
              onToggleVideo={handleToggleVideo}
              onSwitchCamera={handleSwitchCamera}
              onToggleScreenShare={handleToggleScreenShare}
              onEndCall={handleEndCall}
            />
          )}
        </div>
      </aside>

      {/* ── Center: video grid (only during call) ── */}
      {callActive && (
        <main className="room-main">
          <VideoGrid
            localStream={localStream}
            remoteStreams={remoteStreams}
            peers={peers}
            localUsername={identity.username}
            showStats={showStats}
            peerStats={peerStats}
            layout={layout}
            spotlightPeerId={spotlightPeerId}
            onLayoutChange={setLayout}
            onSpotlightChange={setSpotlightPeerId}
          />
        </main>
      )}

      {/* ── Right: chat (always visible) ── */}
      <section className={`room-chat ${chatOpen ? '' : 'room-chat--collapsed'}`}>
        <button
          className="btn-collapse-chat"
          onClick={() => setChatOpen((v) => !v)}
          title={chatOpen ? 'Collapse chat' : 'Expand chat'}
        >
          {chatOpen ? '▶' : '◀'}
        </button>
        {chatOpen && (
          <>
            <ChatMessages messages={messages} identity={identity} />
            <ChatInput onSend={handleSendMessage} />
          </>
        )}
      </section>
    </div>
  )
}
