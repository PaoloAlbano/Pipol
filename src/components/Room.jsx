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
export default function Room({
  roomCode,
  identity,
  showStats,
  onLeave,
  onOpenSettings,
  embedded = false,
  relayUrl = null,
}) {
  const [peers, setPeers] = useState([])
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('connecting…')
  const [relayUnreachable, setRelayUnreachable] = useState(false)

  // Typing indicators
  const typingPeersRef = useRef(new Map()) // peerId → { username, timer }
  const [typingUsers, setTypingUsers] = useState([]) // usernames currently typing
  const typingThrottleRef = useRef(null) // throttle our own TYPING broadcasts

  // Panel collapse state (auto-reset on mobile)
  const isMobile = () => window.innerWidth <= 560
  const [mobileView, setMobileView] = useState(() => isMobile())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(true)
  useEffect(() => {
    const onResize = () => {
      setMobileView(isMobile())
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
  const retryTimerRef = useRef(null)
  const pipWindowRef = useRef(null) // Document PiP window
  const pipBtnsRef = useRef(null) // { aBtn, vBtn } for label sync
  const pipHandlersRef = useRef(null) // always-fresh toggle handlers
  const openDocPiPRef = useRef(null) // always-fresh openDocumentPiP fn
  const [pipActive, setPipActive] = useState(false)
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false)

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
      // Clear typing indicator for departed peer
      if (typingPeersRef.current.has(id)) {
        clearTimeout(typingPeersRef.current.get(id)?.timer)
        typingPeersRef.current.delete(id)
        setTypingUsers(Array.from(typingPeersRef.current.values()).map((p) => p.username))
      }
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

    swarm.addEventListener('typing', (e) => {
      const { peerId, username, stopped } = e.detail
      const existing = typingPeersRef.current.get(peerId)
      if (existing?.timer) clearTimeout(existing.timer)
      if (stopped) {
        typingPeersRef.current.delete(peerId)
      } else {
        const timer = setTimeout(() => {
          typingPeersRef.current.delete(peerId)
          setTypingUsers(Array.from(typingPeersRef.current.values()).map((p) => p.username))
        }, 3000)
        typingPeersRef.current.set(peerId, { username, timer })
      }
      setTypingUsers(Array.from(typingPeersRef.current.values()).map((p) => p.username))
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

        // 2. Peer discovery via WebRTC swarm (with auto-retry on relay failure)
        async function connectSwarm() {
          if (cancelled) return
          try {
            const swarm = await createRoomSwarm(roomCode, {
              messageCoreKey: msgStore.getLocalCoreKey(),
              relayUrl,
            })
            if (cancelled) {
              swarm.leave()
              return
            }
            swarmRef.current = swarm
            attachSwarmListeners(swarm, msgStore)
            setRelayUnreachable(false)
            setStatus('waiting for peers…')
          } catch (err) {
            if (cancelled) return
            if (err.code === 'BROWSER_UNSUPPORTED') {
              setStatus(`⚠ ${err.message}`)
              return
            }
            console.warn('[room] relay unreachable, retrying in 10s…', err.message)
            setStatus('relay unreachable — retrying in 10s…')
            setRelayUnreachable(true)
            retryTimerRef.current = setTimeout(connectSwarm, 10_000)
          }
        }

        await connectSwarm()
      } catch (err) {
        console.error('[room] setup error', err)
        if (!cancelled) setStatus(`⚠ ${err.message}`)
      }
    }

    setup()

    return () => {
      cancelled = true
      clearTimeout(retryTimerRef.current)
      teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode])

  // ── Reconnect when app returns to foreground ───────────────────────────────
  useEffect(() => {
    async function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        // Keep video tracks alive so PiP can display them
        if (!callActiveRef.current) pauseVideoTracks()
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
          relayUrl,
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
          bytesReceivedPerSec: dt && dt > 0 ? Math.round((s.bytesReceived - prev.bytesReceived) / dt) : null,
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

  // ── Picture-in-Picture ────────────────────────────────────────────────────

  // Keep a stable ref to the latest toggle handlers so PiP event listeners
  // never call stale closures (handlers capture audioMuted/videoMuted by value).
  pipHandlersRef.current = {
    audio: handleToggleAudio,
    video: handleToggleVideo,
    end: handleEndCall,
  }

  function getPiPVideo() {
    const all = [...document.querySelectorAll('.video-element')]
    const playing = (v) => !v.paused && v.readyState >= 2
    return (
      document.querySelector('.video-spotlight-main video') ||
      all.find((v) => !v.muted && playing(v)) ||
      all.find((v) => playing(v)) ||
      all.find((v) => !v.muted && v.readyState >= 1) ||
      all.find((v) => v.readyState >= 1)
    )
  }

  // Opens a Document PiP window and moves the already-playing video element into it.
  // Chrome's recommended pattern: move the existing DOM element rather than
  // creating a new one with srcObject (new elements don't inherit playback state).
  // Assigned to openDocPiPRef.current on every render so event listeners are always fresh.
  async function openDocumentPiP(videoEl) {
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 360, height: 240 })
      pipWindowRef.current = win
      setPipActive(true)

      // ── Set up PiP window ────────────────────────────────────────────────
      const doc = win.document
      doc.documentElement.style.cssText = 'height:100vh;margin:0;padding:0'
      doc.body.style.cssText =
        'margin:0;padding:0;background:#111;height:100vh;display:flex;flex-direction:column;overflow:hidden;font-family:sans-serif'

      // ── Save original position so we can restore on close ────────────────
      const origParent = videoEl.parentElement
      const origNext = videoEl.nextSibling
      const origStyle = videoEl.style.cssText

      // Insert a placeholder where the video was so the tile doesn't collapse
      const placeholder = document.createElement('div')
      placeholder.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#555;font-size:11px;pointer-events:none'
      placeholder.textContent = '📺 In PiP'
      origParent.insertBefore(placeholder, videoEl)

      // ── Video wrapper ────────────────────────────────────────────────────
      const wrapper = doc.createElement('div')
      wrapper.style.cssText = 'flex:1;min-height:0;position:relative;overflow:hidden;background:#000'

      videoEl.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
      wrapper.appendChild(videoEl) // move the playing element into PiP

      // Derive label from the sibling .video-label span in the original tile
      const labelText = origParent.querySelector('.video-label')?.textContent ?? (videoEl.muted ? 'You' : 'Remote')
      const lbl = doc.createElement('span')
      lbl.style.cssText =
        'position:absolute;bottom:4px;left:6px;font-size:10px;color:#fff;background:rgba(0,0,0,.6);padding:1px 5px;border-radius:3px;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      lbl.textContent = labelText
      wrapper.appendChild(lbl)
      doc.body.appendChild(wrapper)

      // ── Controls bar ─────────────────────────────────────────────────────
      const bar = doc.createElement('div')
      bar.style.cssText = 'flex-shrink:0;display:flex;justify-content:center;gap:10px;padding:8px;background:#1a1a1a'

      function makeBtn(icon, text, active) {
        const b = doc.createElement('button')
        b.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 14px;background:${active ? '#374151' : 'transparent'};color:#d1d5db;border:1px solid ${active ? '#9ca3af' : '#374151'};border-radius:8px;cursor:pointer;min-width:60px`
        b.innerHTML = `<span style="font-size:16px">${icon}</span><span style="font-size:10px;color:#9ca3af">${text}</span>`
        return b
      }

      const aBtn = makeBtn(audioMuted ? '🔇' : '🎙️', audioMuted ? 'Unmute' : 'Mute', audioMuted)
      aBtn.addEventListener('click', () => pipHandlersRef.current.audio())

      const vBtn = makeBtn(videoMuted ? '📵' : '📷', videoMuted ? 'Cam on' : 'Cam off', videoMuted)
      vBtn.addEventListener('click', () => pipHandlersRef.current.video())

      const endBtn = makeBtn('✕', 'End call', false)
      endBtn.style.background = '#7f1d1d'
      endBtn.style.borderColor = '#991b1b'
      endBtn.addEventListener('click', () => {
        win.close()
        pipHandlersRef.current.end()
      })

      bar.appendChild(aBtn)
      bar.appendChild(vBtn)
      bar.appendChild(endBtn)
      doc.body.appendChild(bar)
      pipBtnsRef.current = { aBtn, vBtn }

      // ── Restore on close ─────────────────────────────────────────────────
      win.addEventListener('pagehide', () => {
        // Move the video element back to its original position
        videoEl.style.cssText = origStyle
        if (origNext && origNext.parentNode === origParent) {
          origParent.insertBefore(videoEl, origNext)
        } else {
          origParent.appendChild(videoEl)
        }
        placeholder.remove()
        pipWindowRef.current = null
        pipBtnsRef.current = null
        setPipActive(false)
      })
    } catch (err) {
      console.warn('[pip] documentPictureInPicture failed', err.message)
    }
  }
  openDocPiPRef.current = openDocumentPiP

  // Manual toggle button handler
  async function handleTogglePiP() {
    if (pipWindowRef.current && !pipWindowRef.current.closed) {
      pipWindowRef.current.close()
      return
    }

    const videoEl = getPiPVideo()
    if (!videoEl) return

    if (!('documentPictureInPicture' in window)) {
      // Fallback: standard video PiP (browser-native controls, no mute buttons)
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture().catch(() => {})
        return
      }
      try {
        await videoEl.requestPictureInPicture()
        setPipActive(true)
        videoEl.addEventListener('leavepictureinpicture', () => setPipActive(false), { once: true })
      } catch (err) {
        console.warn('[pip] requestPictureInPicture failed', err.message)
      }
      return
    }

    await openDocPiPRef.current(videoEl)
  }

  // Auto-trigger: when the tab/window is hidden, open Document PiP automatically
  // (same behaviour as Google Meet). Chrome 123+ allows documentPictureInPicture
  // from visibilitychange without a prior user gesture.
  // Falls back to standard video PiP on unsupported browsers.
  useEffect(() => {
    if (!callActive) return
    function onVisibilityChange() {
      if (document.visibilityState !== 'hidden') return
      if (pipWindowRef.current && !pipWindowRef.current.closed) return
      const video = getPiPVideo()
      if (!video) return

      if ('documentPictureInPicture' in window) {
        openDocPiPRef.current(video)
      } else if (!document.pictureInPictureElement) {
        video.requestPictureInPicture().catch((err) => {
          console.warn('[pip] auto-trigger failed:', err.message)
        })
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [callActive])

  // Close PiP when the call ends
  useEffect(() => {
    if (!callActive) {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
      if (pipWindowRef.current && !pipWindowRef.current.closed) pipWindowRef.current.close()
    }
  }, [callActive])

  // Sync Document PiP button labels when mute state changes
  useEffect(() => {
    const btns = pipBtnsRef.current
    if (!btns || !pipWindowRef.current || pipWindowRef.current.closed) return
    function syncBtn(btn, icon, text, active) {
      btn.style.background = active ? '#374151' : 'transparent'
      btn.style.borderColor = active ? '#9ca3af' : '#374151'
      btn.innerHTML = `<span style="font-size:16px">${icon}</span><span style="font-size:10px;color:#9ca3af">${text}</span>`
    }
    syncBtn(btns.aBtn, audioMuted ? '🔇' : '🎙️', audioMuted ? 'Unmute' : 'Mute', audioMuted)
    syncBtn(btns.vBtn, videoMuted ? '📵' : '📷', videoMuted ? 'Cam on' : 'Cam off', videoMuted)
  }, [audioMuted, videoMuted])

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Creates or retrieves a WebRTC peer connection for a given peer ID.
   * This is an idempotent operation — if a connection already exists, it returns it immediately.
   *
   * @param {string} peerId - The remote peer's ID
   * @param {boolean} isInitiator - Whether this peer initiates the WebRTC handshake (creates offer)
   * @returns {Promise<WebRTCPeer>} The WebRTC peer connection instance
   */
  async function ensureRTCPeer(peerId, isInitiator) {
    // Return existing connection if already established (avoid duplicates)
    if (rtcPeersRef.current[peerId]) return rtcPeersRef.current[peerId]

    // Get or create local media stream
    const stream = localStream || (await getLocalStream())

    // Create new WebRTC peer connection
    const rtcPeer = new WebRTCPeer(peerId, isInitiator, stream)
    rtcPeersRef.current[peerId] = rtcPeer

    // ── Event handlers for WebRTC signaling ────────────────────────────────

    // When an SDP offer is generated, send it to the remote peer via swarm
    rtcPeer.addEventListener('offer', (e) => {
      swarmRef.current?.sendToPeer(peerId, { type: 'VIDEO_OFFER', sdp: e.detail.sdp })
    })

    // When an SDP answer is generated, send it to the remote peer via swarm
    rtcPeer.addEventListener('answer', (e) => {
      swarmRef.current?.sendToPeer(peerId, { type: 'VIDEO_ANSWER', sdp: e.detail.sdp })
    })

    // When new ICE candidates are discovered, send them to the remote peer via swarm
    rtcPeer.addEventListener('ice-candidate', (e) => {
      swarmRef.current?.sendToPeer(peerId, { type: 'VIDEO_ICE', candidate: e.detail.candidate })
    })

    // ── Event handlers for stream lifecycle ────────────────────────────────

    // When remote stream is available, update React state to trigger re-render
    rtcPeer.addEventListener('remote-stream', (e) => {
      setRemoteStreams((prev) => ({ ...prev, [peerId]: e.detail.stream }))
    })

    // When connection closes, remove the remote stream from state
    rtcPeer.addEventListener('closed', () => {
      setRemoteStreams((prev) => {
        const next = { ...prev }
        delete next[peerId]
        return next
      })
    })

    // Initialize the peer connection (triggers offer/answer exchange if initiator)
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
    // Clear our typing state when we send + notify peers immediately
    clearTimeout(typingThrottleRef.current)
    typingThrottleRef.current = null
    swarmRef.current?.sendToAll({ type: 'TYPING', username: identity?.username ?? 'unknown', stopped: true })
    const msg = await msgStoreRef.current?.addMessage(content)
    if (msg) swarmRef.current?.sendToAll({ type: 'MSG', message: msg })
  }, [identity?.username])

  const handleTypingNotification = useCallback(() => {
    if (typingThrottleRef.current) return // already sent recently
    swarmRef.current?.sendToAll({ type: 'TYPING', username: identity?.username ?? 'unknown' })
    typingThrottleRef.current = setTimeout(() => {
      typingThrottleRef.current = null
    }, 2000)
  }, [identity?.username])

  async function handleStartCall() {
    try {
      const stream = await getLocalStream()
      setLocalStream(stream)
      setCallActive(true)

      navigator.mediaDevices?.enumerateDevices().then((devices) => {
        const videoInputs = devices.filter((d) => d.kind === 'videoinput')
        setHasMultipleCameras(videoInputs.length > 1)
      })

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
      {relayUnreachable && <div className="room-relay-banner">Cannot reach relay server — retrying…</div>}
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
      {/* ── Mobile top bar (mounted only on small screens, not in embedded mode) ── */}
      {mobileView && !embedded && (
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
          {callActive && hasMultipleCameras && (
            <button className="btn-mobile-call" onClick={handleSwitchCamera} title="Switch camera">
              🔄
            </button>
          )}
          {callActive && (
            <button className="btn-mobile-call btn-mobile-call--danger" onClick={handleEndCall}>
              ✕ End
            </button>
          )}
        </div>
      )}

      {/* ── Left sidebar: participants + controls (hidden when embedded in WorkspaceLayout) ── */}
      {!embedded && (
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

          {/* GitHub link */}
          {sidebarOpen && (
            <a
              href="https://github.com/PaoloAlbano/Pipol"
              target="_blank"
              rel="noopener noreferrer"
              className="room-github-link"
            >
              <svg className="room-github-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.741 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
              View on GitHub
            </a>
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
                pipActive={pipActive}
                onToggleAudio={handleToggleAudio}
                onToggleVideo={handleToggleVideo}
                onSwitchCamera={hasMultipleCameras ? handleSwitchCamera : undefined}
                onToggleScreenShare={navigator.mediaDevices?.getDisplayMedia ? handleToggleScreenShare : undefined}
                onTogglePiP={handleTogglePiP}
                onEndCall={handleEndCall}
              />
            )}
          </div>
        </aside>
      )}

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
        {!embedded && (
          <button
            className="btn-collapse-chat"
            onClick={() => setChatOpen((v) => !v)}
            title={chatOpen ? 'Collapse chat' : 'Expand chat'}
          >
            {chatOpen ? '▶' : '◀'}
          </button>
        )}
        {chatOpen && (
          <>
            <ChatMessages messages={messages} identity={identity} typingUsers={typingUsers} peers={peers} />
            <ChatInput onSend={handleSendMessage} onTyping={handleTypingNotification} peers={peers} />
          </>
        )}
      </section>
    </div>
  )
}
