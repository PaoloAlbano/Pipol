import React, { useState, useEffect } from 'react'
import { parseInviteUrl } from '../p2p/workspace.js'
import { generateRoomCode } from '../p2p/storage.js'
import '../styles/home.css'

/**
 * Home — onboarding screen.
 *
 * Three paths:
 *   1. Create a new workspace
 *   2. Join via invite URL
 *   3. Quick room join (no workspace)
 */
export default function Home({
  identity,
  onCreateWorkspace,
  onJoinInvite,
  onJoinDirectRoom,
  onUsernameChange: _onUsernameChange,
  onOpenSettings,
}) {
  const [tab, setTab] = useState('create') // 'create' | 'join' | 'quick'

  // Join flow
  const [inviteInput, setInviteInput] = useState('')
  const [inviteError, setInviteError] = useState('')
  const [invitePreview, setInvitePreview] = useState(null)

  // Quick room flow
  const [roomInput, setRoomInput] = useState('')
  const [roomError, setRoomError] = useState('')

  // Install prompt
  const [installPrompt, setInstallPrompt] = useState(null)

  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches) return
    function onBeforeInstallPrompt(e) {
      e.preventDefault()
      setInstallPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  }, [])

  async function handleInstall() {
    if (!installPrompt) return
    installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') setInstallPrompt(null)
  }

  // ── Create ──────────────────────────────────────────────────────────────

  function handleCreate(e) {
    e.preventDefault()
    onCreateWorkspace() // opens CreateWorkspaceModal in App.jsx
  }

  // ── Quick room ──────────────────────────────────────────────────────────

  function handleQuickJoin(e) {
    e.preventDefault()
    const code = roomInput.trim().toLowerCase()
    if (!code) {
      setRoomError('Please enter a room code.')
      return
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(code)) {
      setRoomError('Only letters, numbers and hyphens.')
      return
    }
    onJoinDirectRoom(code)
  }

  // ── Join ────────────────────────────────────────────────────────────────

  function handleInviteChange(value) {
    setInviteInput(value)
    setInviteError('')
    setInvitePreview(null)
    if (!value.trim()) return
    try {
      const { workspace } = parseInviteUrl(value.trim())
      setInvitePreview(workspace)
    } catch {
      // Don't show error while typing — only on submit
    }
  }

  function handleJoin(e) {
    e.preventDefault()
    const value = inviteInput.trim()
    if (!value) {
      setInviteError('Please paste an invite link.')
      return
    }
    try {
      const { workspace } = parseInviteUrl(value)
      setInviteError('')
      onJoinInvite(workspace)
    } catch (err) {
      if (err.message === 'unsupported-version') {
        setInviteError('Invite link was created with a newer version of the app.')
      } else {
        setInviteError('Invalid invite link. Please check and try again.')
      }
    }
  }

  return (
    <div className="home-bg">
      <div className="home-card">
        {/* Logo */}
        <div className="home-logo">
          <img src="/icons/icon.svg" alt="Pipol.dev" width={56} height={56} />
        </div>

        <h1 className="home-title">
          Pipol.dev
          <span className="home-beta-badge">beta</span>
        </h1>
        <p className="home-subtitle">P2P chat and video calls — no server, E2E encrypted.</p>

        {/* Identity + settings */}
        <div className="home-identity-row">
          <div className="home-identity">
            <span className="home-identity-dot" />
            Connected as <strong>{identity.username}</strong>
          </div>
          <button className="home-settings-btn" onClick={onOpenSettings} title="Settings" aria-label="Open settings">
            ⚙
          </button>
        </div>

        {/* Tab switcher */}
        <div className="home-tabs">
          <button className={`home-tab ${tab === 'create' ? 'home-tab--active' : ''}`} onClick={() => setTab('create')}>
            Create workspace
          </button>
          <button className={`home-tab ${tab === 'join' ? 'home-tab--active' : ''}`} onClick={() => setTab('join')}>
            Join
          </button>
          <button className={`home-tab ${tab === 'quick' ? 'home-tab--active' : ''}`} onClick={() => setTab('quick')}>
            Quick room
          </button>
        </div>

        {/* Create workspace */}
        {tab === 'create' && (
          <form className="home-form" onSubmit={handleCreate}>
            <p className="home-hint">
              Set up a private workspace with channels. You&apos;ll get an invite link to share with your team.
            </p>
            <button className="btn btn-primary" type="submit" style={{ width: '100%' }} autoFocus>
              Create workspace →
            </button>
          </form>
        )}

        {/* Join workspace */}
        {tab === 'join' && (
          <form className="home-form" onSubmit={handleJoin}>
            <label className="home-label">Invite link</label>
            <input
              className="home-input"
              type="text"
              placeholder="Paste the invite link…"
              value={inviteInput}
              onChange={(e) => handleInviteChange(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            {inviteError && <p className="home-error">{inviteError}</p>}

            {/* Preview card */}
            {invitePreview && !inviteError && (
              <div className="home-invite-preview">
                <strong>{invitePreview.name}</strong>
                <span className="home-invite-channels">
                  {invitePreview.channels.map((c) => `#${c.name}`).join('  ')}
                </span>
              </div>
            )}

            <button className="btn btn-primary" type="submit" style={{ width: '100%' }}>
              Join workspace
            </button>
          </form>
        )}

        {/* Quick room */}
        {tab === 'quick' && (
          <form className="home-form" onSubmit={handleQuickJoin}>
            <label className="home-label">Room code</label>
            <input
              className="home-input"
              type="text"
              placeholder="e.g. cloud-river-stone"
              value={roomInput}
              onChange={(e) => {
                setRoomInput(e.target.value)
                setRoomError('')
              }}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            {roomError && <p className="home-error">{roomError}</p>}
            <p className="home-hint">
              Join a room directly without creating a workspace. Anyone with the same code joins the same room.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary"
                type="button"
                style={{ flex: 1 }}
                onClick={() => setRoomInput(generateRoomCode())}
              >
                Generate code
              </button>
              <button className="btn btn-primary" type="submit" style={{ flex: 1 }}>
                Join
              </button>
            </div>
          </form>
        )}

        <p className="home-footer">All data stays on your devices. E2E encrypted connections.</p>

        {installPrompt && (
          <button className="home-install-btn" onClick={handleInstall}>
            ⬇ Install app
          </button>
        )}

        <div className="home-github">
          <a
            href="https://github.com/PaoloAlbano/Pipol"
            target="_blank"
            rel="noopener noreferrer"
            className="home-github-link"
          >
            <svg className="home-github-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.741 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
            </svg>
            GitHub
          </a>
        </div>
      </div>
    </div>
  )
}
