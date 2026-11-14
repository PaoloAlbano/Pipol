import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { createRoomSwarm } from '../p2p/swarm.js'
import { MessageStore } from '../p2p/autobase.js'
import { decryptDM, encryptDM } from '../p2p/dm-crypto.js'
import { sendImageFile, FileReceiver } from '../p2p/file-transfer.js'
import { signOp, verifyOp } from '../p2p/signing.js'
import { WebRTCPeer } from '../webrtc/peer.js'
import { sdpFingerprint } from '../webrtc/sdp.js'
import { reconnectDelay } from '../webrtc/reconnect.js'
import { useWakeLock } from '../webrtc/useWakeLock.js'
import {
  getLocalStream,
  getMissingDevices,
  stopLocalStream,
  setAudioMuted,
  setVideoMuted,
  pauseVideoTracks,
  resumeVideoTracks,
  switchCamera,
  startScreenShare,
  stopScreenShare,
  getActiveScreenStream,
} from '../webrtc/media.js'
import ChatMessages from './ChatMessages.jsx'
import ChatInput from './ChatInput.jsx'
import VideoGrid from './VideoGrid.jsx'
import VideoControls from './VideoControls.jsx'
import ThreadPanel from './ThreadPanel.jsx'
import { containsMention } from '../p2p/notifications.js'
import '../styles/room.css'

/** Copies the styles of a document into another one (a new window starts without any). */
function copyStyleSheets(from, to) {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement('style')
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n')
      ;(to.head ?? to.documentElement).appendChild(style)
    } catch {
      // A sheet from another origin cannot be read: link it instead
      if (!sheet.href) continue
      const link = to.createElement('link')
      link.rel = 'stylesheet'
      link.href = sheet.href
      ;(to.head ?? to.documentElement).appendChild(link)
    }
  }
}

/** How long a message typed before the message store is ready waits for it (ms). */
const NO_MISSING_DEVICES = { camera: false, microphone: false }

function missingDevicesNotice({ camera, microphone }) {
  if (camera && microphone) return 'No camera or microphone found: you joined to watch and listen.'
  if (camera) return 'No camera found (or it is in use): you joined without video.'
  if (microphone) return 'No microphone found (or it is in use): you joined without audio.'
  return ''
}

const STORE_WAIT_MS = 10_000

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

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
  mirrorVideo = true,
  onLeave,
  onOpenSettings,
  embedded = false,
  relayUrl = null,
  onMessageSent,
  onPeerMessage = null, // called when a message arrives from a remote peer
  // Meta-swarm props (workspace rooms). When provided, no per-room swarm is created.
  swarm: swarmProp = null, // RoomSwarm from useWorkspaceSync
  channelName = null, // e.g. 'generale' — used to filter messages
  isDM = false, // true when this Room is a DM conversation
  dmPeerPublicKey = null, // Buffer: recipient's Ed25519 publicKey (DM only)
  dmPeerPubkeyHex = null, // hex string of dmPeerPublicKey
  // External call control (used by ChannelHeader in embedded / workspace mode)
  startCallTrigger = 0, // increment to programmatically start a call
  onCallActiveChange = null, // (isActive: boolean) => void
}) {
  const [peers, setPeers] = useState([])
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('connecting…')
  const [relayUnreachable, setRelayUnreachable] = useState(false)

  // Typing indicators
  const typingPeersRef = useRef(new Map()) // peerId → { username, timer }
  const [typingUsers, setTypingUsers] = useState([]) // usernames currently typing
  const typingThrottleRef = useRef(null) // throttle our own TYPING broadcasts

  // Reactions: messageId → { emoji → Set<userPubkeyHex> }
  const [reactions, setReactions] = useState(() => new Map())
  const reactionStampsRef = useRef(new Map()) // `${messageId}|${emoji}|${user}` → time of the latest reaction seen
  const myPubkeyHexRef = useRef(
    identity?.publicKey
      ? Array.from(identity.publicKey)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      : null
  )

  /**
   * Applies a signed reaction (ours or a peer's). It must be signed by the user it is attributed to, and a
   * reaction older than the latest one seen for the same user, message and emoji is ignored, so replaying an
   * old "remove" or "add" cannot flip it back.
   */
  const applyReaction = useCallback(
    (op) => {
      if (!verifyOp('reaction', roomCode, op)) return
      const stampKey = `${op.messageId}|${op.emoji}|${op.publicKey}`
      if ((reactionStampsRef.current.get(stampKey) ?? 0) >= op.at) return
      reactionStampsRef.current.set(stampKey, op.at)
      setReactions((prev) => {
        const next = new Map(prev)
        if (!next.has(op.messageId)) next.set(op.messageId, new Map())
        const emojiMap = new Map(next.get(op.messageId))
        const users = new Set(emojiMap.get(op.emoji) ?? [])
        if (op.removed) {
          users.delete(op.publicKey)
          if (users.size === 0) emojiMap.delete(op.emoji)
          else emojiMap.set(op.emoji, users)
        } else {
          users.add(op.publicKey)
          emojiMap.set(op.emoji, users)
        }
        next.set(op.messageId, emojiMap)
        return next
      })
    },
    [roomCode]
  )

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
  const [callStartedAt, setCallStartedAt] = useState(null) // timestamp when call started
  const [callElapsed, setCallElapsed] = useState('') // formatted HH:MM:SS or MM:SS
  const [localStream, setLocalStream] = useState(null)
  const [remoteStreams, setRemoteStreams] = useState({}) // peerId → camera/mic MediaStream
  const [remoteScreens, setRemoteScreens] = useState({}) // peerId → screen-share MediaStream
  const [audioMuted, setAudioMutedState] = useState(false)
  const [videoMuted, setVideoMutedState] = useState(false)
  const videoMutedRef = useRef(false) // read by ensureRTCPeer, which may run from a stale closure
  const [missingDevices, setMissingDevices] = useState(NO_MISSING_DEVICES) // what this device could not give
  const [callNotice, setCallNotice] = useState('')
  const [remoteVideoOff, setRemoteVideoOff] = useState({}) // peerId → true while their camera is off
  const [peerStatus, setPeerStatus] = useState({}) // peerId → 'connecting' | 'connected' | 'poor' | 'reconnecting'
  const callPeerIdsRef = useRef(new Set()) // the same as callPeerIds, for code that outlives a render
  const storeReadyRef = useRef(deferred()) // resolves with the message store once it is open
  const reconnectRef = useRef({}) // peerId → { attempts, timer, connected }
  const [screenSharing, setScreenSharing] = useState(false)
  const [layout, setLayout] = useState('grid') // 'grid' | 'spotlight'
  const [spotlightPeerId, setSpotlightPeerId] = useState(null)
  const [incomingCall, setIncomingCall] = useState(null) // { peerId, username } | null
  const [callPeerIds, setCallPeerIds] = useState(new Set()) // peers currently in a call
  const [peerStats, setPeerStats] = useState({}) // peerId → connection stats

  // Persistent refs (not re-rendered on change)
  const swarmRef = useRef(null)
  const msgStoreRef = useRef(null)
  const swarmDetachRef = useRef(null) // cleanup fn returned by attachSwarmListeners
  const rtcPeersRef = useRef({}) // peerId → WebRTCPeer
  const remoteScreenIdsRef = useRef({}) // peerId → id of the MediaStream carrying their screen
  const callActiveRef = useRef(false)
  const prevStatsRef = useRef({}) // peerId → { bytesSent, bytesReceived, ts }
  const retryTimerRef = useRef(null)
  const fileReceiverRef = useRef(new FileReceiver()) // receives chunked file transfers
  const pipWindowRef = useRef(null) // Document PiP window
  const pipBtnsRef = useRef(null) // { aBtn, vBtn } for label sync
  const pipHandlersRef = useRef(null) // always-fresh toggle handlers
  const openDocPiPRef = useRef(null) // always-fresh openDocumentPiP fn
  const [pipActive, setPipActive] = useState(false)
  const [pipHost, setPipHost] = useState(null) // element of the Document PiP window the call is drawn into
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false)

  // Thread state
  const [activeThread, setActiveThread] = useState(null) // message object | null

  const threadReplies = useMemo(
    () => (activeThread ? messages.filter((m) => m.parentId === activeThread.id) : []),
    [messages, activeThread]
  )

  useEffect(() => {
    callActiveRef.current = callActive
  }, [callActive])

  useEffect(() => {
    callPeerIdsRef.current = callPeerIds
  }, [callPeerIds])

  // Notify parent when call starts/ends (used by ChannelHeader in embedded mode)
  useEffect(() => {
    onCallActiveChange?.(callActive)
  }, [callActive, onCallActiveChange])

  // Start call when triggered externally (e.g. ChannelHeader 📹 button)
  useEffect(() => {
    if (startCallTrigger > 0 && !callActiveRef.current) handleStartCall()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startCallTrigger])

  // The screen stays on during a call (a phone that locks itself stops the camera and drops the call)
  useWakeLock(callActive)

  // ── Keep TURN credentials valid during a call ─────────────────────────────
  // Credentials expire (the relay's /ice endpoint hands out short-lived ones): renew them on the live
  // connections before that happens, otherwise the TURN allocation of a long call would be dropped.
  useEffect(() => {
    if (!callActive) return
    let timer = null
    let cancelled = false

    async function renew() {
      const swarm = swarmRef.current
      if (!swarm?.refreshIceConfig) return
      const config = await swarm.refreshIceConfig().catch(() => null)
      if (cancelled || !config) return
      for (const peer of Object.values(rtcPeersRef.current)) peer.updateIceServers?.(config)
      if (config.refreshInMs) timer = setTimeout(renew, config.refreshInMs)
    }

    const first = swarmRef.current?.rtcConfiguration?.refreshInMs
    if (first) timer = setTimeout(renew, first)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [callActive])

  // ── Call duration timer ───────────────────────────────────────────────────
  useEffect(() => {
    if (!callStartedAt) return
    function tick() {
      const secs = Math.floor((Date.now() - callStartedAt) / 1000)
      const h = Math.floor(secs / 3600)
      const m = Math.floor((secs % 3600) / 60)
      const s = secs % 60
      const pad = (n) => String(n).padStart(2, '0')
      setCallElapsed(h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => {
      clearInterval(id)
      setCallElapsed('')
    }
  }, [callStartedAt])

  // ── Attach swarm event listeners (reusable on reconnect) ──────────────────
  // Returns a detach function that removes every listener — MUST be called on unmount.
  function attachSwarmListeners(swarm, msgStore) {
    async function onPeerJoined(e) {
      const { id } = e.detail
      const since = await msgStore.getLastTimestamp()
      swarm.sendToPeer(id, { type: 'HISTORY_REQ', channelName: channelName ?? roomCode, since })
      setPeers(swarm.getPeers())
      setStatus(`${swarm.getPeers().length} peer(s) connected`)
      if (callActiveRef.current) {
        await ensureRTCPeer(id, true)
        swarm.sendToPeer(id, { type: 'CALL_INIT' })
      }
    }

    function onPeerLeft(e) {
      const { id } = e.detail
      clearReconnect(id)
      cleanupRTCPeer(id)
      setPeers(swarm.getPeers())
      const count = swarm.getPeers().length
      setStatus(count > 0 ? `${count} peer(s) connected` : 'waiting for peers…')
      setCallPeerIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      clearRemoteVideoOff(id)
      setIncomingCall((prev) => (prev?.peerId === id ? null : prev))
      setSpotlightPeerId((prev) => (prev === id ? null : prev))
      if (typingPeersRef.current.has(id)) {
        clearTimeout(typingPeersRef.current.get(id)?.timer)
        typingPeersRef.current.delete(id)
        setTypingUsers(Array.from(typingPeersRef.current.values()).map((p) => p.username))
      }
    }

    async function onCallInit(e) {
      const { peerId } = e.detail
      const callerName = swarmRef.current?.peers.get(peerId)?.username ?? peerId.slice(0, 8)
      setCallPeerIds((prev) => new Set([...prev, peerId]))
      if (callActiveRef.current) {
        // Our own offer was sent while they were not in the call yet, so they dropped it.
        // Start over with a fresh offer now that they have joined.
        if (rtcPeersRef.current[peerId] && !rtcPeersRef.current[peerId].established) {
          resetRTCPeer(peerId)
          await ensureRTCPeer(peerId, true)
        } else {
          await ensureRTCPeer(peerId, false)
        }
      } else {
        setIncomingCall((prev) => prev ?? { peerId, username: callerName })
      }
    }

    function onCallEnd(e) {
      const { peerId } = e.detail
      clearReconnect(peerId)
      cleanupRTCPeer(peerId)
      clearRemoteVideoOff(peerId)
      setCallPeerIds((prev) => {
        const next = new Set(prev)
        next.delete(peerId)
        return next
      })
      setIncomingCall((prev) => (prev?.peerId === peerId ? null : prev))
    }

    async function onVideoOffer(e) {
      if (!callActiveRef.current) return
      const { peerId } = e.detail
      const existing = rtcPeersRef.current[peerId]
      // Both sides offered at once: the polite side drops its unanswered connection and answers on a
      // fresh one. A rollback while ICE is gathering can leave the connection stuck in "new".
      if (existing?.polite && existing.isInitiator && !existing.established) resetRTCPeer(peerId)
      // An offer from a connection we have never seen: they made a new one (after theirs failed, before we noticed
      // that ours did). The old one cannot take it, so it is replaced.
      else if (existing?.established) {
        const offered = sdpFingerprint(e.detail.sdp)
        if (offered && existing.remoteFingerprint && offered !== existing.remoteFingerprint) resetRTCPeer(peerId)
      }
      const peer = await ensureRTCPeer(peerId, false)
      await peer.handleOffer(e.detail.sdp)
    }
    async function onVideoAnswer(e) {
      if (!callActiveRef.current) return
      rtcPeersRef.current[e.detail.peerId]?.handleAnswer(e.detail.sdp)
    }
    async function onVideoIce(e) {
      if (!callActiveRef.current) return
      rtcPeersRef.current[e.detail.peerId]?.handleIceCandidate(e.detail.candidate)
    }

    async function onHistoryReq(e) {
      const { peerId, since, channelName: reqChannel } = e.detail
      const myKey = channelName ?? roomCode
      if (reqChannel && reqChannel !== myKey) return
      const history = await msgStore.getSignedHistory()
      const newer = history.filter((m) => m.timestamp > since)
      if (newer.length > 0) {
        swarmRef.current.sendToPeer(peerId, { type: 'HISTORY_RES', channelName: myKey, messages: newer })
      }
    }

    function onChatMessage(e) {
      if (isDM) return
      if (channelName && e.detail.channelName !== channelName) return
      msgStore.receiveMessage(e.detail.message)
      if (onPeerMessage) {
        const msg = e.detail.message
        const mentioned = containsMention(msg.content, identity?.username)
        onPeerMessage(mentioned ? { ...msg, mentioned: true } : msg)
      }
    }

    function onDMMessage(e) {
      const { from, to, nonce, ciphertext } = e.detail
      const myPubkeyHex = identity?.publicKey
        ? Array.from(identity.publicKey)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        : null
      const isFromPeer = from === dmPeerPubkeyHex
      const isToUs = to === myPubkeyHex
      if (!isFromPeer || !isToUs) return
      if (!dmPeerPublicKey || !identity?.secretKey) return
      const message = decryptDM(nonce, ciphertext, identity.secretKey, dmPeerPublicKey)
      if (!message) return
      // Edits, deletions and reactions of a DM travel inside the encrypted payload too
      if (message.op === 'edit') msgStore.receiveEdit(message)
      else if (message.op === 'delete') msgStore.receiveDelete(message)
      else if (message.op === 'reaction') applyReaction(message)
      else msgStore.receiveMessage(message)
    }

    function onVideoState(e) {
      const { peerId, off } = e.detail
      setRemoteVideoOff((prev) => {
        if (Boolean(prev[peerId]) === off) return prev
        const next = { ...prev }
        if (off) next[peerId] = true
        else delete next[peerId]
        return next
      })
    }

    function onScreenShareStart(e) {
      // Announced before the renegotiation so ontrack can tell screen from camera
      remoteScreenIdsRef.current[e.detail.peerId] = e.detail.streamId
      setSpotlightPeerId(e.detail.peerId)
      setLayout('spotlight')
    }
    function onScreenShareEnd(e) {
      delete remoteScreenIdsRef.current[e.detail.peerId]
      setRemoteScreens((prev) => {
        if (!prev[e.detail.peerId]) return prev
        const next = { ...prev }
        delete next[e.detail.peerId]
        return next
      })
      setSpotlightPeerId((prev) => (prev === e.detail.peerId ? null : prev))
      setLayout('grid')
    }
    function onSwarmError(e) {
      console.warn('[room] signaling lost, reconnecting…', e.detail)
      setStatus('reconnecting…')
    }
    function onReaction(e) {
      // In a DM, reactions only arrive inside the encrypted DM payload
      if (isDM) return
      if (channelName && e.detail.channelName !== channelName) return
      applyReaction(e.detail)
    }
    function onMsgEdit(e) {
      // In a DM, edits only arrive inside the encrypted DM payload
      if (isDM) return
      if (channelName && e.detail.channelName !== channelName) return
      msgStore.receiveEdit(e.detail)
    }
    function onMsgDelete(e) {
      if (isDM) return
      if (channelName && e.detail.channelName !== channelName) return
      msgStore.receiveDelete(e.detail)
    }
    function onTyping(e) {
      const { peerId, username, stopped, channelName: typingChannel } = e.detail
      // For channel rooms: ignore typing events from other channels
      if (!isDM && channelName && typingChannel !== channelName) return
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
    }

    function onFileMeta(e) {
      const { channelName: rxChannel } = e.detail
      if (!isDM && channelName && rxChannel !== channelName) return
      fileReceiverRef.current.onMeta({ ...e.detail, identity: null })
    }

    function onFileChunk(e) {
      const msg = fileReceiverRef.current.onChunk(e.detail)
      if (msg) msgStore.receiveMessage(msg)
    }

    swarm.addEventListener('peer-joined', onPeerJoined)
    swarm.addEventListener('peer-left', onPeerLeft)
    swarm.addEventListener('call-init', onCallInit)
    swarm.addEventListener('call-end', onCallEnd)
    swarm.addEventListener('video-offer', onVideoOffer)
    swarm.addEventListener('video-answer', onVideoAnswer)
    swarm.addEventListener('video-ice', onVideoIce)
    swarm.addEventListener('history-req', onHistoryReq)
    swarm.addEventListener('chat-message', onChatMessage)
    if (isDM) swarm.addEventListener('dm-message', onDMMessage)
    swarm.addEventListener('video-state', onVideoState)
    swarm.addEventListener('screen-share-start', onScreenShareStart)
    swarm.addEventListener('screen-share-end', onScreenShareEnd)
    swarm.addEventListener('error', onSwarmError)
    swarm.addEventListener('typing', onTyping)
    swarm.addEventListener('reaction', onReaction)
    swarm.addEventListener('msg-edit', onMsgEdit)
    swarm.addEventListener('msg-delete', onMsgDelete)
    swarm.addEventListener('file-meta', onFileMeta)
    swarm.addEventListener('file-chunk', onFileChunk)

    return function detach() {
      swarm.removeEventListener('peer-joined', onPeerJoined)
      swarm.removeEventListener('peer-left', onPeerLeft)
      swarm.removeEventListener('call-init', onCallInit)
      swarm.removeEventListener('call-end', onCallEnd)
      swarm.removeEventListener('video-offer', onVideoOffer)
      swarm.removeEventListener('video-answer', onVideoAnswer)
      swarm.removeEventListener('video-ice', onVideoIce)
      swarm.removeEventListener('history-req', onHistoryReq)
      swarm.removeEventListener('chat-message', onChatMessage)
      if (isDM) swarm.removeEventListener('dm-message', onDMMessage)
      swarm.removeEventListener('video-state', onVideoState)
      swarm.removeEventListener('screen-share-start', onScreenShareStart)
      swarm.removeEventListener('screen-share-end', onScreenShareEnd)
      swarm.removeEventListener('error', onSwarmError)
      swarm.removeEventListener('typing', onTyping)
      swarm.removeEventListener('reaction', onReaction)
      swarm.removeEventListener('msg-edit', onMsgEdit)
      swarm.removeEventListener('msg-delete', onMsgDelete)
      swarm.removeEventListener('file-meta', onFileMeta)
      swarm.removeEventListener('file-chunk', onFileChunk)
    }
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
        storeReadyRef.current.resolve(msgStore)

        msgStore.on('messages', (msgs) => {
          if (!cancelled) setMessages(msgs)
        })

        const history = await msgStore.getHistory()
        if (!cancelled) setMessages(history)

        // 2. Peer discovery — use the meta swarm prop when available (workspace rooms),
        //    otherwise create a per-room swarm (legacy direct rooms).
        if (swarmProp) {
          swarmRef.current = swarmProp
          swarmDetachRef.current = attachSwarmListeners(swarmProp, msgStore)
          setRelayUnreachable(false)
          const connectedPeers = swarmProp.getPeers()
          setStatus(connectedPeers.length > 0 ? `${connectedPeers.length} peer(s) connected` : 'waiting for peers…')
          // Catch-up: peers already in the swarm when Room mounts won't fire 'peer-joined',
          // so we send HISTORY_REQ to them directly.
          if (connectedPeers.length > 0) {
            const since = await msgStore.getLastTimestamp()
            for (const p of connectedPeers) {
              swarmProp.sendToPeer(p.id, { type: 'HISTORY_REQ', channelName: channelName ?? roomCode, since })
            }
          }
          return
        }

        // 2b. Fallback: create a dedicated swarm (direct room join, no workspace)
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
            swarmDetachRef.current = attachSwarmListeners(swarm, msgStore)
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
  }, [roomCode, swarmProp])

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
            if (newVideoTrack) await rtcPeer.replaceVideoTrack(newVideoTrack)
            if (newAudioTrack) await rtcPeer.replaceAudioTrack(newAudioTrack)
          }
        } catch (err) {
          console.warn('[room] could not restart video after wake', err)
        }
      }

      const ws = swarmRef.current?._ws
      // If we're using the shared meta swarm (swarmProp), its reconnection is
      // handled by useWorkspaceSync — don't create a second swarm here.
      if (swarmProp) return
      if (!ws || ws.readyState === WebSocket.OPEN) return

      console.info('[room] app foregrounded, reconnecting swarm…')
      setStatus('reconnecting…')
      try {
        await swarmRef.current.leave().catch(() => {})
        swarmDetachRef.current?.()
        const swarm = await createRoomSwarm(roomCode, {
          messageCoreKey: msgStoreRef.current?.getLocalCoreKey(),
          relayUrl,
        })
        swarmRef.current = swarm
        swarmDetachRef.current = attachSwarmListeners(swarm, msgStoreRef.current)
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
      document.querySelector('.video-tile--main video') ||
      all.find((v) => !v.muted && playing(v)) ||
      all.find((v) => playing(v)) ||
      all.find((v) => !v.muted && v.readyState >= 1) ||
      all.find((v) => v.readyState >= 1)
    )
  }

  // Opens a Document PiP window showing the whole call, laid out like the main window (see the portal below).
  // The window gets its own silent copy of the tiles: the sound keeps coming from the videos of the page.
  // Assigned to openDocPiPRef.current on every render so event listeners are always fresh.
  async function openDocumentPiP() {
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 420, height: 320 })
      pipWindowRef.current = win
      setPipActive(true)

      // ── Set up PiP window ────────────────────────────────────────────────
      const doc = win.document
      copyStyleSheets(document, doc)
      doc.documentElement.style.cssText = 'height:100vh;margin:0;padding:0'
      doc.body.style.cssText =
        'margin:0;padding:0;background:#111;height:100vh;display:flex;flex-direction:column;overflow:hidden;font-family:sans-serif'

      // ── The call ─────────────────────────────────────────────────────────
      const host = doc.createElement('div')
      host.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;background:#000'
      doc.body.appendChild(host)

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

      setPipHost(host)

      // ── Clean up on close ────────────────────────────────────────────────
      win.addEventListener('pagehide', () => {
        setPipHost(null)
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

    await openDocPiPRef.current()
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
        openDocPiPRef.current()
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
    const screenStream = getActiveScreenStream()
    // Deterministic tie-break so exactly one side yields if both send an offer at once
    const myId = myPubkeyHexRef.current
    const polite = myId ? myId < peerId : !isInitiator
    const rtcPeer = new WebRTCPeer(
      peerId,
      isInitiator,
      stream,
      screenStream,
      polite,
      swarmRef.current?.rtcConfiguration
    )
    rtcPeersRef.current[peerId] = rtcPeer

    // Late joiner while we are sharing: announce the screen stream before the SDP exchange
    if (screenStream) {
      swarmRef.current?.sendToPeer(peerId, { type: 'SCREEN_SHARE_START', streamId: screenStream.id })
    }
    // Late joiner while our camera is off: it cannot see that from the video
    if (videoMutedRef.current) swarmRef.current?.sendToPeer(peerId, { type: 'VIDEO_STATE', off: true })

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
      const { stream } = e.detail
      if (remoteScreenIdsRef.current[peerId] === stream.id) {
        setRemoteScreens((prev) => ({ ...prev, [peerId]: stream }))
      } else {
        setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }))
      }
    })

    // How the connection is doing, shown on the tile of that peer
    setPeerStatus((prev) => ({
      ...prev,
      [peerId]: prev[peerId] === 'reconnecting' ? 'reconnecting' : (rtcPeer.status ?? 'connecting'),
    }))
    rtcPeer.addEventListener('status', (e) => {
      if (e.detail.status === 'closed') return // a closing is handled by the 'closed' event below
      setPeerStatus((prev) => ({ ...prev, [peerId]: e.detail.status }))
      if (e.detail.status === 'connected') {
        // It works: the next failure starts again from the short waits
        const entry = reconnectRef.current[peerId]
        reconnectRef.current[peerId] = { attempts: 0, timer: entry?.timer ?? null, connected: true }
      }
    })

    // When connection closes, remove the remote streams from state
    rtcPeer.addEventListener('closed', (e) => {
      delete remoteScreenIdsRef.current[peerId]
      setRemoteStreams((prev) => {
        const next = { ...prev }
        delete next[peerId]
        return next
      })
      setRemoteScreens((prev) => {
        const next = { ...prev }
        delete next[peerId]
        return next
      })
      // A closed connection must not stay in the list: it would be returned for the next call to that peer
      const isCurrent = rtcPeersRef.current[peerId] === rtcPeer
      if (isCurrent) delete rtcPeersRef.current[peerId]
      // One that could not be kept (not one we closed ourselves) is tried again while the peer is in the call
      if (isCurrent && (e.detail?.reason === 'failed' || e.detail?.reason === 'timeout')) scheduleReconnect(peerId)
    })

    // Initialize the peer connection (triggers offer/answer exchange if initiator)
    await rtcPeer.init()
    return rtcPeer
  }

  function clearRemoteVideoOff(peerId) {
    setRemoteVideoOff((prev) => {
      if (!prev[peerId]) return prev
      const next = { ...prev }
      delete next[peerId]
      return next
    })
  }

  function clearReconnect(peerId) {
    const entry = reconnectRef.current[peerId]
    if (entry) clearTimeout(entry.timer)
    delete reconnectRef.current[peerId]
    setPeerStatus((prev) => {
      if (!(peerId in prev)) return prev
      const next = { ...prev }
      delete next[peerId]
      return next
    })
  }

  function clearAllReconnects() {
    Object.keys(reconnectRef.current).forEach(clearReconnect)
    setPeerStatus({})
  }

  const isInCallWith = (peerId) =>
    callActiveRef.current && callPeerIdsRef.current.has(peerId) && Boolean(swarmRef.current?.peers?.has(peerId))

  /**
   * Connects to a peer again after the connection to them was given up, with a growing wait, for as long as they
   * are in the call. Both sides may do it: whoever offers first wins (see onVideoOffer).
   */
  function scheduleReconnect(peerId) {
    if (!isInCallWith(peerId)) return
    const entry = (reconnectRef.current[peerId] ??= { attempts: 0, timer: null, connected: false })
    if (entry.timer) return
    const polite = myPubkeyHexRef.current ? myPubkeyHexRef.current < peerId : false
    setPeerStatus((prev) => ({ ...prev, [peerId]: entry.connected ? 'reconnecting' : 'connecting' }))
    entry.timer = setTimeout(
      async () => {
        entry.timer = null
        // They left, or the other side has already connected to us in the meantime
        if (!isInCallWith(peerId) || rtcPeersRef.current[peerId]) return
        entry.attempts++
        try {
          await ensureRTCPeer(peerId, true)
        } catch (err) {
          console.warn('[room] could not reconnect to', peerId.slice(0, 8), err)
          scheduleReconnect(peerId)
        }
      },
      reconnectDelay(entry.attempts, polite)
    )
  }

  // Replaces the connection with a peer by a new one: what they announced about their screen share still holds
  function resetRTCPeer(peerId) {
    const screenId = remoteScreenIdsRef.current[peerId]
    cleanupRTCPeer(peerId)
    if (screenId) remoteScreenIdsRef.current[peerId] = screenId
  }

  function cleanupRTCPeer(peerId) {
    rtcPeersRef.current[peerId]?.close()
    delete rtcPeersRef.current[peerId]
    delete remoteScreenIdsRef.current[peerId]
    setRemoteStreams((prev) => {
      const next = { ...prev }
      delete next[peerId]
      return next
    })
    setRemoteScreens((prev) => {
      const next = { ...prev }
      delete next[peerId]
      return next
    })
  }

  async function teardown() {
    clearAllReconnects()
    swarmDetachRef.current?.()
    swarmDetachRef.current = null
    Object.values(rtcPeersRef.current).forEach((p) => p.close())
    rtcPeersRef.current = {}
    stopLocalStream()
    await msgStoreRef.current?.close().catch(() => {})
    // Only leave the swarm if we created it (not the meta swarm managed by useWorkspaceSync)
    if (!swarmProp) await swarmRef.current?.leave().catch(() => {})
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * The message store, waiting a little if it is still being opened: a message typed right after the room (or a
   * direct message) is opened must not be lost because the store was not ready yet.
   */
  const getStore = useCallback(async () => {
    if (msgStoreRef.current) return msgStoreRef.current
    let timer
    const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(null), STORE_WAIT_MS)))
    const store = await Promise.race([storeReadyRef.current.promise, timeout])
    clearTimeout(timer)
    if (!store) console.warn('[room] the message store did not open in time: message not sent')
    return store
  }, [])

  const handleSendMessage = useCallback(
    async (content) => {
      // Clear our typing state when we send + notify peers immediately
      clearTimeout(typingThrottleRef.current)
      typingThrottleRef.current = null
      swarmRef.current?.sendToAll({ type: 'TYPING', username: identity?.username ?? 'unknown', stopped: true })
      const msg = await (await getStore())?.addMessage(content)
      if (msg) {
        if (isDM) {
          // Encrypt and send as DM — only the recipient can decrypt
          if (dmPeerPublicKey && identity?.secretKey && dmPeerPubkeyHex) {
            const { nonce, ciphertext } = encryptDM(msg, identity.secretKey, dmPeerPublicKey)
            swarmRef.current?.sendToAll({ type: 'DM', to: dmPeerPubkeyHex, nonce, ciphertext })
          }
        } else {
          // Channel message — in clear, includes channelName so peers can filter
          swarmRef.current?.sendToAll({ type: 'MSG', channelName: channelName ?? roomCode, message: msg })
        }
        onMessageSent?.()
      }
    },
    [
      identity?.username,
      identity?.secretKey,
      isDM,
      dmPeerPublicKey,
      dmPeerPubkeyHex,
      channelName,
      roomCode,
      onMessageSent,
      getStore,
    ]
  )

  const handleSendFile = useCallback(
    async (file) => {
      try {
        const msg = await sendImageFile(
          swarmRef.current,
          file,
          isDM ? null : (channelName ?? roomCode),
          identity,
          roomCode
        )
        // Add locally (sender doesn't receive own FILE_META/CHUNK)
        msgStoreRef.current?.receiveMessage(msg)
        onMessageSent?.()
      } catch (err) {
        console.error('[room] file send error', err)
        alert(err.message)
      }
    },
    [identity, isDM, channelName, roomCode, onMessageSent]
  )

  // Sends a signed operation (edit, delete, reaction): in a DM inside the encrypted DM payload, so nobody else
  // in the workspace sees it, otherwise to the whole channel.
  const sendOperation = useCallback(
    (type, op) => {
      if (isDM) {
        if (!dmPeerPublicKey || !identity?.secretKey || !dmPeerPubkeyHex) return
        const { nonce, ciphertext } = encryptDM({ ...op, op: type }, identity.secretKey, dmPeerPublicKey)
        swarmRef.current?.sendToAll({ type: 'DM', to: dmPeerPubkeyHex, nonce, ciphertext })
      } else {
        const wire = { edit: 'MSG_EDIT', delete: 'MSG_DELETE', reaction: 'REACTION' }[type]
        swarmRef.current?.sendToAll({ type: wire, ...op, channelName: channelName ?? roomCode })
      }
    },
    [isDM, dmPeerPublicKey, dmPeerPubkeyHex, identity?.secretKey, channelName, roomCode]
  )

  const handleEditMessage = useCallback(
    async (originalId, newContent) => {
      // Signed and applied locally right away; only the author's edit has effect, here and for the others
      const op = msgStoreRef.current?.createEdit(originalId, newContent)
      if (op) sendOperation('edit', op)
    },
    [sendOperation]
  )

  const handleDeleteMessage = useCallback(
    (originalId) => {
      const op = msgStoreRef.current?.createDelete(originalId)
      if (op) sendOperation('delete', op)
    },
    [sendOperation]
  )

  const handleReaction = useCallback(
    (messageId, emoji) => {
      const myPubkey = myPubkeyHexRef.current
      if (!myPubkey || !identity?.secretKey) return
      // Toggle: if already reacted, remove; otherwise add
      const removed = reactions.get(messageId)?.get(emoji)?.has(myPubkey) ?? false
      const previous = reactionStampsRef.current.get(`${messageId}|${emoji}|${myPubkey}`) ?? 0
      const op = signOp(
        'reaction',
        roomCode,
        { messageId, emoji, removed, at: Math.max(Date.now(), previous + 1) },
        identity
      )
      applyReaction(op) // optimistic local update
      sendOperation('reaction', op)
    },
    [reactions, identity, roomCode, applyReaction, sendOperation]
  )

  const handleTypingNotification = useCallback(() => {
    if (typingThrottleRef.current) return // already sent recently
    swarmRef.current?.sendToAll({
      type: 'TYPING',
      username: identity?.username ?? 'unknown',
      channelName: isDM ? null : (channelName ?? roomCode),
    })
    typingThrottleRef.current = setTimeout(() => {
      typingThrottleRef.current = null
    }, 2000)
  }, [identity?.username, isDM, channelName, roomCode])

  const handleSendThreadReply = useCallback(
    async (content) => {
      if (!activeThread) return
      const msg = await msgStoreRef.current?.addMessage(content, { parentId: activeThread.id })
      if (msg && !isDM) {
        swarmRef.current?.sendToAll({ type: 'MSG', channelName: channelName ?? roomCode, message: msg })
        onMessageSent?.()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeThread?.id, isDM, channelName, roomCode, onMessageSent]
  )

  async function handleStartCall() {
    try {
      const stream = await getLocalStream()
      setLocalStream(stream)
      // Without a camera or a microphone the call is joined all the same, with what there is
      const missing = getMissingDevices()
      setMissingDevices(missing)
      setCallNotice(missingDevicesNotice(missing))
      if (missing.camera) {
        videoMutedRef.current = true // the others are told our camera is off when connections are made below
        setVideoMutedState(true)
      }
      if (missing.microphone) setAudioMutedState(true)
      // Start from fresh TURN credentials (a tab can stay open for days)
      await swarmRef.current?.refreshIceConfig?.().catch(() => {})
      // Set the ref now: signalling that arrives before the next render must not be dropped
      callActiveRef.current = true
      setCallActive(true)
      setCallStartedAt(Date.now())

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
    clearAllReconnects()
    swarmRef.current?.sendToAll({ type: 'CALL_END' })
    Object.values(rtcPeersRef.current).forEach((p) => p.close())
    rtcPeersRef.current = {}
    remoteScreenIdsRef.current = {}
    setRemoteStreams({})
    setRemoteScreens({})
    setRemoteVideoOff({})
    stopLocalStream()
    setLocalStream(null)
    callActiveRef.current = false
    setCallActive(false)
    setCallStartedAt(null)
    setAudioMutedState(false)
    setVideoMutedState(false)
    videoMutedRef.current = false
    setMissingDevices(NO_MISSING_DEVICES)
    setCallNotice('')
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
    if (missingDevices.microphone) return
    const next = !audioMuted
    setAudioMuted(next)
    setAudioMutedState(next)
  }

  function handleToggleVideo() {
    if (missingDevices.camera) return
    const next = !videoMuted
    setVideoMuted(next)
    setVideoMutedState(next)
    videoMutedRef.current = next
    // A disabled camera track only sends black frames: tell the others, so they can show an avatar instead
    swarmRef.current?.sendToAll({ type: 'VIDEO_STATE', off: next })
  }

  async function handleSwitchCamera() {
    const result = await switchCamera()
    if (!result) return
    setVideoMuted(videoMuted) // the new camera starts enabled: keep it off if the user turned it off
    setLocalStream(result.stream)
    for (const rtcPeer of Object.values(rtcPeersRef.current)) {
      await rtcPeer.replaceVideoTrack(result.videoTrack)
    }
  }

  async function handleStopScreenShare() {
    stopScreenShare()
    setScreenSharing(false)
    swarmRef.current?.sendToAll({ type: 'SCREEN_SHARE_END' })
    for (const rtcPeer of Object.values(rtcPeersRef.current)) {
      await rtcPeer.removeScreenStream()
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

      setScreenSharing(true)
      // Announce the stream id first so peers can tell it apart from the camera
      swarmRef.current?.sendToAll({ type: 'SCREEN_SHARE_START', streamId: result.stream.id })

      // The camera keeps flowing; the screen is an additional video stream
      for (const rtcPeer of Object.values(rtcPeersRef.current)) {
        await rtcPeer.addScreenStream(result.stream)
      }

      // Handle user clicking "Stop sharing" in the browser's native bar
      result.screenTrack.addEventListener('ended', handleStopScreenShare, { once: true })
    } else {
      await handleStopScreenShare()
    }
  }

  function handleLeave() {
    if (callActive) handleEndCall()
    teardown()
    onLeave()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const callInProgress = callPeerIds.size > 0 && !callActive
  // People in the call we have no picture of yet: still connecting, or the connection is being recovered
  const pendingPeerIds = callActive
    ? [...callPeerIds].filter((id) => !remoteStreams[id] && id !== myPubkeyHexRef.current)
    : []

  return (
    <div className={`room-layout ${callActive ? 'room-layout--call' : ''}`}>
      {relayUnreachable && <div className="room-relay-banner">Cannot reach relay server — retrying…</div>}
      {callActive && callNotice && (
        <div className="room-call-notice" role="status">
          <span>{callNotice}</span>
          <button onClick={() => setCallNotice('')} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
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
                audioUnavailable={missingDevices.microphone}
                videoUnavailable={missingDevices.camera}
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

      {/* ── Center: video area (only during call) ── */}
      {callActive && (
        <main className="room-main">
          <VideoGrid
            localStream={localStream}
            remoteStreams={remoteStreams}
            remoteScreens={remoteScreens}
            peers={peers}
            localUsername={identity.username}
            localVideoMuted={videoMuted}
            remoteVideoOff={remoteVideoOff}
            peerStatus={peerStatus}
            pendingPeerIds={pendingPeerIds}
            callElapsed={embedded ? '' : callElapsed}
            showStats={showStats}
            peerStats={peerStats}
            layout={layout}
            spotlightPeerId={spotlightPeerId}
            onLayoutChange={setLayout}
            onSpotlightChange={setSpotlightPeerId}
            mirrorVideo={mirrorVideo}
          />
        </main>
      )}

      {/* ── Mobile call controls: the sidebar with the usual ones is hidden on a phone ── */}
      {callActive && mobileView && !embedded && (
        <div className="room-mobile-callbar">
          <button
            className={`btn-mobile-control${audioMuted ? ' btn-mobile-control--active' : ''}`}
            onClick={handleToggleAudio}
            disabled={missingDevices.microphone}
            aria-pressed={audioMuted}
            aria-label={
              missingDevices.microphone ? 'No microphone found' : audioMuted ? 'Unmute microphone' : 'Mute microphone'
            }
          >
            {audioMuted ? '🔇' : '🎙️'}
            <span>{audioMuted ? 'Unmute' : 'Mute'}</span>
          </button>
          <button
            className={`btn-mobile-control${videoMuted ? ' btn-mobile-control--active' : ''}`}
            onClick={handleToggleVideo}
            disabled={missingDevices.camera}
            aria-pressed={videoMuted}
            aria-label={missingDevices.camera ? 'No camera found' : videoMuted ? 'Turn on camera' : 'Turn off camera'}
          >
            {videoMuted ? '📵' : '📷'}
            <span>{videoMuted ? 'Cam on' : 'Cam off'}</span>
          </button>
        </div>
      )}

      {/* The call in the Document PiP window: same layout as above, with the window's own size and no sound */}
      {callActive &&
        pipHost &&
        createPortal(
          <VideoGrid
            pip
            localStream={localStream}
            remoteStreams={remoteStreams}
            remoteScreens={remoteScreens}
            peers={peers}
            localUsername={identity.username}
            localVideoMuted={videoMuted}
            remoteVideoOff={remoteVideoOff}
            peerStatus={peerStatus}
            pendingPeerIds={pendingPeerIds}
            showStats={false}
            peerStats={{}}
            layout={layout}
            spotlightPeerId={spotlightPeerId}
            onLayoutChange={setLayout}
            onSpotlightChange={setSpotlightPeerId}
            mirrorVideo={mirrorVideo}
          />,
          pipHost
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
            <ChatMessages
              messages={messages}
              identity={identity}
              typingUsers={typingUsers}
              peers={peers}
              reactions={reactions}
              onReact={handleReaction}
              onEdit={handleEditMessage}
              onDelete={handleDeleteMessage}
              onOpenThread={setActiveThread}
            />
            <ChatInput
              onSend={handleSendMessage}
              onTyping={handleTypingNotification}
              peers={peers}
              onSendFile={handleSendFile}
            />
          </>
        )}
      </section>

      {/* ── Thread panel (right of chat, when a thread is active) ── */}
      {activeThread && (
        <ThreadPanel
          parentMessage={activeThread}
          replies={threadReplies}
          identity={identity}
          peers={peers}
          onClose={() => setActiveThread(null)}
          onSendReply={handleSendThreadReply}
        />
      )}

      {/* ── Embedded call controls (workspace / channel mode) ─────────────────
           In embedded mode there is no sidebar, so call controls float at the
           bottom-left of the room layout.  The VideoGrid is already shown in
           <main> above; this bar provides mute / end / PiP etc.
      ── */}
      {embedded && callActive && (
        <div className="room-embedded-callbar">
          {callElapsed && (
            <span className="room-embedded-callbar__timer" aria-label="Call duration" aria-live="off">
              {callElapsed}
            </span>
          )}
          <VideoControls
            audioMuted={audioMuted}
            videoMuted={videoMuted}
            audioUnavailable={missingDevices.microphone}
            videoUnavailable={missingDevices.camera}
            screenSharing={screenSharing}
            pipActive={pipActive}
            onToggleAudio={handleToggleAudio}
            onToggleVideo={handleToggleVideo}
            onSwitchCamera={hasMultipleCameras ? handleSwitchCamera : undefined}
            onToggleScreenShare={navigator.mediaDevices?.getDisplayMedia ? handleToggleScreenShare : undefined}
            onTogglePiP={handleTogglePiP}
            onEndCall={handleEndCall}
          />
        </div>
      )}
    </div>
  )
}
