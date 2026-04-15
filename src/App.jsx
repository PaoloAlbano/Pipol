import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import Home from './components/Home.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import LoginScreen from './components/LoginScreen.jsx'
import OIDCCallback from './components/OIDCCallback.jsx'
import WorkspaceLayout from './components/WorkspaceLayout.jsx'
import ChannelSidebar from './components/ChannelSidebar.jsx'
import ChannelHeader from './components/ChannelHeader.jsx'
import CreateWorkspaceModal from './components/CreateWorkspaceModal.jsx'

const Room = lazy(() => import('./components/Room.jsx'))

import { getIdentity, setUsername, getShowStats, setShowStats, getMasterSeed, lockSession } from './p2p/storage.js'
import { initEncryption } from './p2p/db.js'
import {
  getWorkspaces,
  saveWorkspace,
  removeWorkspace,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  getActiveWorkspace,
  deriveChannelRoomCode,
  deriveDMRoomCode,
  addChannel,
  parseInviteUrl,
  createWorkspace,
  getInviteParamFromUrl,
  getEffectiveConfig,
} from './p2p/workspace.js'
import { useWorkspaceSync } from './p2p/useWorkspaceSync.js'

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

// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [identity, setIdentity] = useState(() => getIdentity())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showStats, setShowStatsState] = useState(getShowStats)

  // Workspace state
  const [workspaces, setWorkspaces] = useState(() => getWorkspaces())
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState(
    () => getActiveWorkspaceId() || getWorkspaces()[0]?.id || null
  )
  const [activeChannelName, setActiveChannelName] = useState(null)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)

  // Active workspace (derived — kept in sync for hooks that run before early returns)
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0] || null

  // Trigger re-render when unread counts change (localStorage isn't reactive)
  const [unreadVersion, bumpUnread] = useState(0)

  // Ref for stable access inside workspace sync callback without stale closures
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
  }, [])

  // When a peer sends us a DM_INVITE, auto-open the DM with them
  const onDMInvite = useCallback((fromPubkey) => {
    // Don't interrupt if already in that DM
    if (activeChannelNameRef.current === `dm:${fromPubkey}`) return
    setActiveChannelName(`dm:${fromPubkey}`)
  }, [])

  // Workspace channel + presence sync (P2P)
  const { broadcastChannels, members, notifyChannel, sendDMInvite } = useWorkspaceSync(
    activeWorkspace,
    identity,
    useCallback(() => setWorkspaces(getWorkspaces()), []),
    onChannelNotify,
    onDMInvite
  )

  // Pending invite (from ?invite= URL param)
  const [pendingInvite, setPendingInvite] = useState(null)

  // CreateWorkspaceModal: null = closed, 'new' = create mode, workspace object = share mode
  const [workspaceModal, setWorkspaceModal] = useState(null)
  // Ref to the modal's setCreatedWorkspace setter — set after workspace is created
  const [modalCreatedWorkspace, setModalCreatedWorkspace] = useState(null)

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

    // Restore deep-link ?ws + ?ch
    const params = new URLSearchParams(window.location.search)
    const wsId = params.get('ws')
    const chName = params.get('ch')
    if (wsId) {
      setActiveWorkspaceIdState(wsId)
      setActiveWorkspaceId(wsId)
      if (chName) setActiveChannelName(chName)
    }

    const ws = getWorkspaces()
    setWorkspaces(ws)

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
    if (view !== 'workspace' || !activeWorkspaceId) return
    const params = new URLSearchParams()
    params.set('ws', activeWorkspaceId)
    if (activeChannelName) params.set('ch', activeChannelName)
    window.history.replaceState({}, '', `?${params}`)
  }, [view, activeWorkspaceId, activeChannelName])

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
    setActiveChannelName(channelName)
  }

  function handleSelectDM(pubkey) {
    setActiveChannelName(`dm:${pubkey}`)
    // Notify the other peer so they join the DM swarm automatically
    sendDMInvite(pubkey)
  }

  function handleLeaveChannel() {
    setActiveChannelName(null)
  }

  function handleCreateChannel(workspaceId) {
    const name = window.prompt('Channel name (letters, numbers, hyphens only):')
    if (!name) return
    const clean = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]/g, '-')
    if (!clean) return
    const updated = addChannel(
      workspaceId,
      clean,
      identity?.publicKey
        ? Array.from(identity.publicKey)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        : null
    )
    if (updated) {
      const fresh = getWorkspaces()
      setWorkspaces(fresh)
      // Push new channel list to connected peers immediately
      const ws = fresh.find((w) => w.id === workspaceId)
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
  const channels = (activeWorkspace?.channels ?? []).map((ch) => ({
    ...ch,
    unread: unreadCounts[ch.name] || 0,
  }))

  // Current user pubkey hex (needed for DM derivation and admin check)
  const myPubkeyHex = identity?.publicKey
    ? Array.from(identity.publicKey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    : null

  // Derive room code for active channel or DM
  const isDM = activeChannelName?.startsWith('dm:')
  const dmPeerPubkey = isDM ? activeChannelName.slice(3) : null
  const activeRoomCode = isDM
    ? myPubkeyHex && dmPeerPubkey && activeWorkspace?.secret
      ? deriveDMRoomCode(activeWorkspace.secret, myPubkeyHex, dmPeerPubkey)
      : null
    : activeWorkspace && activeChannelName
      ? deriveChannelRoomCode(activeWorkspace.secret, activeChannelName)
      : null

  // Display name for the active view (channel name or DM peer username)
  const activeDisplayName = isDM
    ? (members.get(dmPeerPubkey)?.username ?? dmPeerPubkey?.slice(0, 8) ?? 'DM')
    : activeChannelName

  // Effective relay URL for active workspace (null = use global/env default)
  const { relayUrl: activeRelayUrl } = getEffectiveConfig(activeWorkspace?.config ?? null)

  const isWorkspaceAdmin = activeWorkspace?.createdBy && myPubkeyHex ? activeWorkspace.createdBy === myPubkeyHex : false

  // Convert members Map → arrays for sidebar (exclude self)
  const workspacePeers = Array.from(members.values()).filter((m) => m.pubkey !== myPubkeyHex)
  const dmPeers = workspacePeers.map((m) => ({
    pubkey: m.pubkey,
    username: m.username,
    online: m.status === 'online',
    unread: 0,
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
            onLeave={handleLeaveDirectRoom}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </Suspense>
      )}

      {/* ── Workspace ── */}
      {view === 'workspace' && (
        <WorkspaceLayout
          rightPanelOpen={rightPanelOpen}
          onToggleRightPanel={() => setRightPanelOpen((v) => !v)}
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
          {activeRoomCode ? (
            <>
              <ChannelHeader channelName={activeDisplayName} isPrivate={isDM} />
              <Suspense fallback={null}>
                <Room
                  key={activeRoomCode}
                  roomCode={activeRoomCode}
                  identity={identity}
                  showStats={showStats}
                  onLeave={handleLeaveChannel}
                  onOpenSettings={() => setSettingsOpen(true)}
                  relayUrl={activeRelayUrl || null}
                  onMessageSent={() => notifyChannel(activeChannelName)}
                  embedded
                />
              </Suspense>
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
          onClose={() => setSettingsOpen(false)}
          onLock={handleLock}
          activeWorkspace={view === 'workspace' ? activeWorkspace : null}
          onLeaveWorkspace={view === 'workspace' ? handleLeaveWorkspace : null}
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
