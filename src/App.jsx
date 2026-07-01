import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import Home from './components/Home.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import LoginScreen from './components/LoginScreen.jsx'
import OIDCCallback from './components/OIDCCallback.jsx'
import WorkspaceLayout from './components/WorkspaceLayout.jsx'
import ChannelSidebar from './components/ChannelSidebar.jsx'
import ChannelHeader from './components/ChannelHeader.jsx'
import CreateWorkspaceModal from './components/CreateWorkspaceModal.jsx'
import CreateChannelModal from './components/CreateChannelModal.jsx'
import MobileNav from './components/MobileNav.jsx'

const Room = lazy(() => import('./components/Room.jsx'))

import {
  getIdentity,
  setUsername,
  getShowStats,
  setShowStats,
  getMirrorVideo,
  setMirrorVideo,
  getMasterSeed,
  lockSession,
} from './p2p/storage.js'
import { initEncryption } from './p2p/db.js'
import {
  getWorkspaces,
  saveWorkspace,
  removeWorkspace,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  deriveChannelRoomCode,
  deriveDMRoomCode,
  addChannel,
  setChannelTopic,
  parseInviteUrl,
  createWorkspace,
  getInviteParamFromUrl,
} from './p2p/workspace.js'
import { useWorkspaceSync } from './p2p/useWorkspaceSync.js'
import { showNotification, updateAppBadge } from './p2p/notifications.js'

// ── Unread count helpers (localStorage) ──────────────────────────────────────

function getUnreadCounts(workspaceId) {
  try {
    return JSON.parse(localStorage.getItem(`p2p-chat:unread:${workspaceId}`) || '{}')
  } catch {
    return {}
  }
}

function clearUnread(workspaceId, channelName) {
  const counts = getUnreadCounts(workspaceId)
  delete counts[channelName]
  localStorage.setItem(`p2p-chat:unread:${workspaceId}`, JSON.stringify(counts))
}

function incrementUnread(workspaceId, channelName) {
  const counts = getUnreadCounts(workspaceId)
  counts[channelName] = (counts[channelName] || 0) + 1
  localStorage.setItem(`p2p-chat:unread:${workspaceId}`, JSON.stringify(counts))
}

// ── Mention count helpers (localStorage) ─────────────────────────────────────

function getMentionCounts(workspaceId) {
  try {
    return JSON.parse(localStorage.getItem(`p2p-chat:mentions:${workspaceId}`) || '{}')
  } catch {
    return {}
  }
}

function clearMentions(workspaceId, channelName) {
  const counts = getMentionCounts(workspaceId)
  delete counts[channelName]
  localStorage.setItem(`p2p-chat:mentions:${workspaceId}`, JSON.stringify(counts))
}

function incrementMention(workspaceId, channelName) {
  const counts = getMentionCounts(workspaceId)
  counts[channelName] = (counts[channelName] || 0) + 1
  localStorage.setItem(`p2p-chat:mentions:${workspaceId}`, JSON.stringify(counts))
}

// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [identity, setIdentity] = useState(() => getIdentity())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showStats, setShowStatsState] = useState(getShowStats)
  const [mirrorVideo, setMirrorVideoState] = useState(getMirrorVideo)

  // Workspace state
  const [workspaces, setWorkspaces] = useState(() => getWorkspaces())
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState(
    () => getActiveWorkspaceId() || getWorkspaces()[0]?.id || null
  )
  const [activeChannelName, setActiveChannelName] = useState(null)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)

  // Call state reflected from the embedded Room (used to show correct icon in ChannelHeader)
  const [roomCallActive, setRoomCallActive] = useState(false)
  const [startCallTrigger, setStartCallTrigger] = useState(0)

  // Active workspace (derived — kept in sync for hooks that run before early returns)
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0] || null

  // Trigger re-render when unread counts change (localStorage isn't reactive)
  const [unreadVersion, bumpUnread] = useState(0) // Ref for stable access inside workspace sync callback without stale closures
  const activeChannelNameRef = useRef(activeChannelName)
  const activeWorkspaceIdRef = useRef(activeWorkspaceId)
  useEffect(() => {
    activeChannelNameRef.current = activeChannelName
  }, [activeChannelName])
  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  const onChannelNotify = useCallback((channelName) => {
    const wsId = activeWorkspaceIdRef.current
    const active = activeChannelNameRef.current
    if (!wsId || channelName === active) return
    incrementUnread(wsId, channelName)
    bumpUnread((v) => v + 1)
    showNotification(`#${channelName}`, 'New message')
    // Badge = sum of all unread counts for this workspace
    const counts = getUnreadCounts(wsId)
    updateAppBadge(Object.values(counts).reduce((s, n) => s + n, 0))
  }, [])

  const onMentionNotify = useCallback((channelName) => {
    const wsId = activeWorkspaceIdRef.current
    const active = activeChannelNameRef.current
    if (!wsId || channelName === active) return
    incrementMention(wsId, channelName)
    bumpUnread((v) => v + 1)
  }, [])

  // When a DM arrives for us, increment unread indicator (do NOT auto-switch)
  const onDMOpen = useCallback((fromPubkey) => {
    const wsId = activeWorkspaceIdRef.current
    if (!wsId) return
    // Already open in this DM — no badge needed
    if (activeChannelNameRef.current === `dm:${fromPubkey}`) return
    incrementUnread(wsId, `dm:${fromPubkey}`)
    bumpUnread((v) => v + 1)
    showNotification('New direct message', 'You have a new DM')
    const counts = getUnreadCounts(wsId)
    updateAppBadge(Object.values(counts).reduce((s, n) => s + n, 0))
  }, [])

  // Workspace channel + presence sync (P2P)
  const {
    swarm: metaSwarm,
    broadcastChannels,
    members,
    notifyChannel,
  } = useWorkspaceSync(
    activeWorkspace,
    identity,
    useCallback(() => setWorkspaces(getWorkspaces()), []),
    onChannelNotify,
    onDMOpen,
    onMentionNotify
  )

  // Pending invite (from ?invite= URL param)
  const [pendingInvite, setPendingInvite] = useState(null)

  // CreateWorkspaceModal: null = closed, 'new' = create mode, workspace object = share mode
  const [workspaceModal, setWorkspaceModal] = useState(null)
  // Ref to the modal's setCreatedWorkspace setter — set after workspace is created
  const [modalCreatedWorkspace, setModalCreatedWorkspace] = useState(null)

  // CreateChannelModal
  const [channelModalWorkspaceId, setChannelModalWorkspaceId] = useState(null)

  // Direct room join (no workspace)
  const [directRoomCode, setDirectRoomCode] = useState(null)

  // View: 'home' | 'workspace' | 'room'
  const [view, setView] = useState(() => {
    if (window.location.pathname === '/callback') return 'callback'
    return null // determined after identity check
  })

  // ── Splash ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const splash = document.getElementById('splash')
    if (splash) {
      splash.classList.add('hidden')
      splash.addEventListener('transitionend', () => splash.remove(), { once: true })
    }
  }, [])

  // ── Encryption init ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!identity) return
    initEncryption(getMasterSeed()).catch((err) => console.warn('[db] encryption init failed', err))
  }, [identity])

  // ── Determine view after identity is available ────────────────────────────

  useEffect(() => {
    if (!identity) return
    if (view === 'callback') return

    // Parse ?invite= from URL (do this once after login)
    const inviteParam = getInviteParamFromUrl()
    if (inviteParam) {
      try {
        const { workspace } = parseInviteUrl(inviteParam)
        // Remove ?invite= from URL immediately so it doesn't persist
        window.history.replaceState({}, '', '/')
        setPendingInvite(workspace) // eslint-disable-line react-hooks/set-state-in-effect
      } catch {
        window.history.replaceState({}, '', '/')
      }
    }

    // Deep-link ?room= — enter quick room directly, even if workspaces exist
    const params = new URLSearchParams(window.location.search)
    const roomParam = params.get('room')
    if (roomParam) {
      const code = roomParam.trim().toLowerCase()
      setDirectRoomCode(code)
      setView('room')
      return
    }

    // Restore deep-link ?ws + ?ch — only apply if the workspace actually exists
    const wsId = params.get('ws')
    const chName = params.get('ch')
    const ws = getWorkspaces()
    setWorkspaces(ws)
    if (wsId && ws.find((w) => w.id === wsId)) {
      setActiveWorkspaceIdState(wsId)
      setActiveWorkspaceId(wsId)
      if (chName) setActiveChannelName(chName)
    } else if (wsId) {
      // Unknown workspace in URL — clear the stale param and use the last known one
      window.history.replaceState({}, '', '/')
    }

    if (ws.length > 0) {
      setView('workspace')
      if (!activeWorkspaceId && ws[0]) {
        setActiveWorkspaceIdState(ws[0].id)
        setActiveWorkspaceId(ws[0].id)
      }
    } else {
      setView('home')
    }
  }, [identity]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── URL sync ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (view !== 'workspace' || !activeWorkspace) return
    const params = new URLSearchParams()
    params.set('ws', activeWorkspace.id)
    if (activeChannelName) params.set('ch', activeChannelName)
    window.history.replaceState({}, '', `?${params}`)
  }, [view, activeWorkspace, activeChannelName])

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleLogin() {
    const params = new URLSearchParams(window.location.search)
    const room = params.get('room') // legacy / direct room link
    setIdentity(getIdentity())
    if (room) {
      const code = room.trim().toLowerCase()
      window.history.replaceState({}, '', `?room=${encodeURIComponent(code)}`)
      setDirectRoomCode(code)
      setView('room')
    } else {
      // Reset view so the identity useEffect can determine the correct view.
      // Without this, view stays 'callback' after OIDC redirect and the app shows a blank screen.
      setView(null)
    }
  }

  function handleJoinDirectRoom(code) {
    const normalised = code.trim().toLowerCase()
    setDirectRoomCode(normalised)
    setView('room')
    window.history.pushState({}, '', `?room=${encodeURIComponent(normalised)}`)
  }

  function handleLeaveDirectRoom() {
    setDirectRoomCode(null)
    setView(workspaces.length > 0 ? 'workspace' : 'home')
    window.history.pushState({}, '', '/')
  }

  function handleLock() {
    lockSession()
    setIdentity(null)
    setView(null)
    setSettingsOpen(false)
  }

  function handleUsernameChange(name) {
    setUsername(name)
    setIdentity((prev) => ({ ...prev, username: name }))
  }

  function handleSelectWorkspace(id) {
    setActiveWorkspaceIdState(id)
    setActiveWorkspaceId(id)
    setActiveChannelName(null)
  }

  function handleSelectChannel(channelName) {
    clearUnread(activeWorkspaceId, channelName)
    clearMentions(activeWorkspaceId, channelName)
    bumpUnread((v) => v + 1)
    setActiveChannelName(channelName)
    setRoomCallActive(false)
    setStartCallTrigger(0)
    // Recalculate badge after clearing
    const counts = getUnreadCounts(activeWorkspaceId)
    updateAppBadge(Object.values(counts).reduce((s, n) => s + n, 0))
  }

  function handleSelectDM(pubkey) {
    clearUnread(activeWorkspaceId, `dm:${pubkey}`)
    bumpUnread((v) => v + 1)
    setActiveChannelName(`dm:${pubkey}`)
    setRoomCallActive(false)
    setStartCallTrigger(0)
    const counts = getUnreadCounts(activeWorkspaceId)
    updateAppBadge(Object.values(counts).reduce((s, n) => s + n, 0))
    // The DM room will be opened; no DM_INVITE needed — the first DM message
    // triggers onDMOpen on the recipient's side automatically.
  }

  function handleLeaveChannel() {
    setActiveChannelName(null)
  }

  function handleCreateChannel(workspaceId) {
    setChannelModalWorkspaceId(workspaceId)
  }

  function handleSetChannelTopic(topic) {
    if (!activeWorkspaceId || !activeChannelName || isDM) return
    const updated = setChannelTopic(activeWorkspaceId, activeChannelName, topic)
    if (!updated) return
    const fresh = getWorkspaces()
    setWorkspaces(fresh)
    const ws = fresh.find((w) => w.id === activeWorkspaceId)
    if (ws) broadcastChannels(ws.channels)
  }

  function handleChannelModalCreate(name) {
    const updated = addChannel(
      channelModalWorkspaceId,
      name,
      identity?.publicKey
        ? Array.from(identity.publicKey)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        : null
    )
    setChannelModalWorkspaceId(null)
    if (updated) {
      const fresh = getWorkspaces()
      setWorkspaces(fresh)
      const ws = fresh.find((w) => w.id === channelModalWorkspaceId)
      if (ws) broadcastChannels(ws.channels)
    }
  }

  // ── Create workspace ──────────────────────────────────────────────────────

  function handleCreateWorkspace() {
    setWorkspaceModal('new')
  }

  // Called by CreateWorkspaceModal when user confirms name + channels
  function handleModalCreate(name, channels, config) {
    const pubkeyHex = identity?.publicKey
      ? Array.from(identity.publicKey)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      : null
    const { workspace } = createWorkspace(name, channels, config, pubkeyHex)
    saveWorkspace(workspace)
    const ws = getWorkspaces()
    setWorkspaces(ws)
    setActiveWorkspaceIdState(workspace.id)
    setActiveWorkspaceId(workspace.id)
    setActiveChannelName(null)
    setView('workspace')
    // Pass created workspace back to modal so it can show invite URL on step 3
    setModalCreatedWorkspace(workspace)
  }

  function handleModalClose() {
    setWorkspaceModal(null)
    setModalCreatedWorkspace(null)
  }

  // ── Share invite URL (opens modal in share mode) ──────────────────────────

  function handleShareInvite() {
    if (!activeWorkspace) return
    setWorkspaceModal(activeWorkspace)
  }
  // ── Leave workspace ─────────────────────────────────────────────────

  function handleLeaveWorkspace() {
    if (!activeWorkspaceId) return
    removeWorkspace(activeWorkspaceId)
    const remaining = getWorkspaces()
    const next = remaining[0] ?? null
    setWorkspaces(remaining)
    setActiveChannelName(null)
    if (next) {
      setActiveWorkspaceIdState(next.id)
      setActiveWorkspaceId(next.id)
      setView('workspace')
    } else {
      setActiveWorkspaceIdState(null)
      setActiveWorkspaceId(null)
      setView('home')
    }
  }
  // ── Invite join ───────────────────────────────────────────────────────────

  function handleJoinInvite(workspace) {
    // Check if we already have this workspace (same secret)
    const existing = getWorkspaces().find((w) => w.secret === workspace.secret)
    if (existing) {
      setActiveWorkspaceIdState(existing.id)
      setActiveWorkspaceId(existing.id)
    } else {
      saveWorkspace(workspace)
      setActiveWorkspaceIdState(workspace.id)
      setActiveWorkspaceId(workspace.id)
    }
    setWorkspaces(getWorkspaces())
    setActiveChannelName(null)
    setPendingInvite(null)
    setView('workspace')
  }

  // ── OIDC callback ─────────────────────────────────────────────────────────

  if (window.location.pathname === '/callback') {
    return <OIDCCallback onLogin={handleLogin} />
  }

  if (!identity) return <LoginScreen onLogin={handleLogin} />

  // Build channel list with unread counts.
  // unreadVersion changing forces a re-render so getUnreadCounts re-reads localStorage.
  const unreadCounts = activeWorkspace && unreadVersion >= 0 ? getUnreadCounts(activeWorkspace.id) : {}
  const mentionCounts = activeWorkspace && unreadVersion >= 0 ? getMentionCounts(activeWorkspace.id) : {}
  const channels = (activeWorkspace?.channels ?? []).map((ch) => ({
    ...ch,
    unread: unreadCounts[ch.name] || 0,
    mentioned: mentionCounts[ch.name] || 0,
  }))

  // Current user pubkey hex (needed for DM derivation and admin check)
  const myPubkeyHex = identity?.publicKey
    ? Array.from(identity.publicKey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    : null

  // Derive room code for active channel or DM (used as MessageStore key)
  const isDM = activeChannelName?.startsWith('dm:')
  const dmPeerPubkey = isDM ? activeChannelName.slice(3) : null
  const activeRoomCode = isDM
    ? myPubkeyHex && dmPeerPubkey && activeWorkspace?.secret
      ? deriveDMRoomCode(activeWorkspace.secret, myPubkeyHex, dmPeerPubkey)
      : null
    : activeWorkspace && activeChannelName
      ? deriveChannelRoomCode(activeWorkspace.secret, activeChannelName)
      : null

  // Convert DM peer pubkey hex → Uint8Array for NaCl box encryption
  const dmPeerPublicKey = dmPeerPubkey
    ? Uint8Array.from({ length: 32 }, (_, i) => parseInt(dmPeerPubkey.slice(i * 2, i * 2 + 2), 16))
    : null

  // Display name for the active view (channel name or DM peer username)
  const activeDisplayName = isDM
    ? (members.get(dmPeerPubkey)?.username ?? dmPeerPubkey?.slice(0, 8) ?? 'DM')
    : activeChannelName

  // Topic of the active channel (null for DMs or when none set)
  const activeChannelTopic = isDM
    ? null
    : activeWorkspace?.channels?.find((c) => c.name === activeChannelName)?.topic || null

  // Effective relay URL for active workspace (null = use global/env default)

  const isWorkspaceAdmin = activeWorkspace?.createdBy && myPubkeyHex ? activeWorkspace.createdBy === myPubkeyHex : false

  // Convert members Map → arrays for sidebar (exclude self)
  const workspacePeers = Array.from(members.values()).filter((m) => m.pubkey !== myPubkeyHex)
  const dmPeers = workspacePeers.map((m) => ({
    pubkey: m.pubkey,
    username: m.username,
    online: m.status === 'online',
    unread: unreadCounts[`dm:${m.pubkey}`] || 0,
  }))

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Create / share workspace modal ── */}
      {workspaceModal && (
        <CreateWorkspaceModal
          workspace={workspaceModal === 'new' ? null : workspaceModal}
          createdWorkspace={modalCreatedWorkspace}
          onCreated={handleModalCreate}
          onClose={handleModalClose}
        />
      )}

      {/* ── Invite confirmation modal ── */}
      {pendingInvite && (
        <InviteConfirmModal
          workspace={pendingInvite}
          onConfirm={() => handleJoinInvite(pendingInvite)}
          onDismiss={() => setPendingInvite(null)}
        />
      )}

      {/* ── Create channel modal ── */}
      {channelModalWorkspaceId && (
        <CreateChannelModal onCreated={handleChannelModalCreate} onClose={() => setChannelModalWorkspaceId(null)} />
      )}

      {/* ── Onboarding ── */}
      {view === 'home' && (
        <Home
          identity={identity}
          onCreateWorkspace={handleCreateWorkspace}
          onJoinInvite={handleJoinInvite}
          onJoinDirectRoom={handleJoinDirectRoom}
          onUsernameChange={handleUsernameChange}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {/* ── Direct room (no workspace) ── */}
      {view === 'room' && directRoomCode && (
        <Suspense fallback={null}>
          <Room
            key={directRoomCode}
            roomCode={directRoomCode}
            identity={identity}
            showStats={showStats}
            mirrorVideo={mirrorVideo}
            onLeave={handleLeaveDirectRoom}
            onOpenSettings={() => setSettingsOpen(true)}
            onMessageSent={() => {
              showNotification('Quick room', 'New message')
              updateAppBadge(1)
            }}
            onPeerMessage={(msg) => {
              showNotification(msg.username ?? 'Someone', msg.content || '📎 Image')
              updateAppBadge(1)
            }}
          />
        </Suspense>
      )}

      {/* ── Workspace ── */}
      {view === 'workspace' && (
        <WorkspaceLayout
          rightPanelOpen={rightPanelOpen}
          onToggleRightPanel={() => setRightPanelOpen((v) => !v)}
          mobileNav={<MobileNav activeChannelName={activeChannelName} onOpenSettings={() => setSettingsOpen(true)} />}
          sidebar={
            <ChannelSidebar
              workspace={activeWorkspace}
              channels={channels}
              peers={workspacePeers}
              dmPeers={dmPeers}
              activeChannelName={activeChannelName}
              identity={identity}
              isAdmin={isWorkspaceAdmin}
              onSelectChannel={handleSelectChannel}
              onCreateChannel={() => handleCreateChannel(activeWorkspace?.id)}
              onInvite={handleShareInvite}
              onSelectDM={handleSelectDM}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          }
        >
          {/* Render Room only when meta swarm is connected (or it's a direct room without swarm) */}
          {activeRoomCode && metaSwarm ? (
            <>
              <ChannelHeader
                channelName={activeDisplayName}
                isPrivate={isDM}
                topic={activeChannelTopic}
                onSetTopic={!isDM ? handleSetChannelTopic : undefined}
                callActive={roomCallActive}
                onStartCall={() => setStartCallTrigger((n) => n + 1)}
              />
              <Suspense fallback={null}>
                <Room
                  key={activeRoomCode}
                  roomCode={activeRoomCode}
                  channelName={isDM ? null : activeChannelName}
                  isDM={isDM}
                  dmPeerPublicKey={dmPeerPublicKey}
                  dmPeerPubkeyHex={dmPeerPubkey}
                  swarm={metaSwarm}
                  identity={identity}
                  showStats={showStats}
                  mirrorVideo={mirrorVideo}
                  onLeave={handleLeaveChannel}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onMessageSent={() => notifyChannel(activeChannelName)}
                  embedded
                  startCallTrigger={startCallTrigger}
                  onCallActiveChange={setRoomCallActive}
                />
              </Suspense>
            </>
          ) : activeRoomCode ? (
            // Swarm not yet connected — show brief connecting state
            <>
              <ChannelHeader channelName={activeDisplayName} isPrivate={isDM} topic={activeChannelTopic} />
              <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Connecting…</div>
            </>
          ) : (
            <ChannelWelcome
              workspaceName={activeWorkspace?.name}
              onCreateChannel={() => handleCreateChannel(activeWorkspace?.id)}
            />
          )}
        </WorkspaceLayout>
      )}

      {/* ── Settings modal ── */}
      {settingsOpen && (
        <SettingsModal
          identity={identity}
          onUsernameChange={handleUsernameChange}
          showStats={showStats}
          onShowStatsChange={(v) => {
            setShowStats(v)
            setShowStatsState(v)
          }}
          mirrorVideo={mirrorVideo}
          onMirrorVideoChange={(v) => {
            setMirrorVideo(v)
            setMirrorVideoState(v)
          }}
          onClose={() => setSettingsOpen(false)}
          onLock={handleLock}
          activeWorkspace={view === 'workspace' ? activeWorkspace : null}
          onLeaveWorkspace={view === 'workspace' ? handleLeaveWorkspace : null}
          workspaces={view === 'workspace' ? workspaces : []}
          onSelectWorkspace={
            view === 'workspace'
              ? (id) => {
                  handleSelectWorkspace(id)
                  setSettingsOpen(false)
                }
              : null
          }
        />
      )}
    </>
  )
}

// ── InviteConfirmModal ────────────────────────────────────────────────────────

function InviteConfirmModal({ workspace, onConfirm, onDismiss }) {
  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <h2 style={{ marginBottom: 8, fontSize: 18 }}>Join workspace</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 4, fontSize: 14 }}>You have been invited to:</p>
        <p style={{ fontWeight: 700, fontSize: 20, marginBottom: 8 }}>{workspace.name}</p>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
          {workspace.channels.length} channels · P2P E2E encrypted connection
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onDismiss}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            Join
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 200,
}

const modalStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-lg)',
  padding: '28px 32px',
  maxWidth: 400,
  width: '90%',
  boxShadow: 'var(--shadow-lg)',
}

// ── ChannelWelcome ────────────────────────────────────────────────────────────

function ChannelWelcome({ workspaceName, onCreateChannel }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        color: 'var(--text-muted)',
        padding: 32,
      }}
    >
      <div style={{ fontSize: 48 }}>👋</div>
      <h2 style={{ color: 'var(--text)', fontSize: 20, fontWeight: 700 }}>Welcome to {workspaceName}</h2>
      <p style={{ fontSize: 14, textAlign: 'center', maxWidth: 360 }}>
        Select a channel from the sidebar to start chatting, or create a new one.
      </p>
      <button className="btn btn-primary" onClick={onCreateChannel}>
        + Create channel
      </button>
    </div>
  )
}
