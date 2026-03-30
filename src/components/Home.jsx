import React, { useState, useEffect } from 'react'
import { generateRoomCode } from '../p2p/storage.js'
import '../styles/home.css'

/**
 * Home / Lobby screen.
 * Users can enter an existing room code or generate a fresh one.
 */
export default function Home({ identity, onJoin, onUsernameChange, onOpenSettings }) {
  const [inputCode, setInputCode] = useState('')
  const [error, setError] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(identity.username)
  const [nameError, setNameError] = useState('')
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

  function handleNameSave() {
    const trimmed = nameInput.trim()
    if (!trimmed) {
      setNameError('Name cannot be empty.')
      return
    }
    if (trimmed.length > 32) {
      setNameError('Max 32 characters.')
      return
    }
    if (!/^[a-zA-Z0-9 _-]+$/.test(trimmed)) {
      setNameError('Only letters, numbers, spaces, - and _.')
      return
    }
    onUsernameChange(trimmed)
    setEditingName(false)
    setNameError('')
  }

  function handleNameKeyDown(e) {
    if (e.key === 'Enter') handleNameSave()
    if (e.key === 'Escape') {
      setEditingName(false)
      setNameInput(identity.username)
      setNameError('')
    }
  }

  function handleCreate() {
    const code = generateRoomCode()
    onJoin(code)
  }

  function handleJoin(e) {
    e.preventDefault()
    const code = inputCode.trim().toLowerCase()
    if (!code) {
      setError('Please enter a room code.')
      return
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(code)) {
      setError('Room code can only contain letters, numbers, and hyphens.')
      return
    }
    setError('')
    onJoin(code)
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
        <p className="home-subtitle">
          Serverless group chat &amp; video calls — no accounts, no servers.
        </p>

        {/* Settings button */}
        <button className="home-settings-btn" onClick={onOpenSettings} title="Settings">
          ⚙️ Settings
        </button>

        {/* Identity badge */}
        {editingName ? (
          <div className="home-identity-edit">
            <input
              className="home-input home-name-input"
              value={nameInput}
              onChange={(e) => {
                setNameInput(e.target.value)
                setNameError('')
              }}
              onKeyDown={handleNameKeyDown}
              maxLength={32}
              autoFocus
              placeholder="Your name"
            />
            {nameError && <p className="home-error">{nameError}</p>}
            <div className="home-name-actions">
              <button className="btn btn-primary" onClick={handleNameSave}>
                Save
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setEditingName(false)
                  setNameInput(identity.username)
                  setNameError('')
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="home-identity">
            <span className="home-identity-dot" />
            You are <strong>{identity.username}</strong>
            <button
              className="home-edit-name-btn"
              onClick={() => {
                setEditingName(true)
                setNameInput(identity.username)
              }}
              title="Change name"
            >
              ✏️
            </button>
          </div>
        )}

        {/* Join form */}
        <form className="home-form" onSubmit={handleJoin}>
          <input
            className="home-input"
            type="text"
            placeholder="Enter room code  (e.g. cloud-river-stone)"
            value={inputCode}
            onChange={(e) => {
              setInputCode(e.target.value)
              setError('')
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {error && <p className="home-error">{error}</p>}

          <div className="home-actions">
            <button className="btn btn-secondary" type="button" onClick={handleCreate}>
              <span className="btn-icon">✦</span>
              Create Room
            </button>
            <button className="btn btn-primary" type="submit">
              <span className="btn-icon">→</span>
              Join Room
            </button>
          </div>
        </form>

        <p className="home-footer">
          All data stays on your device. Connections are end-to-end encrypted.
        </p>

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
            View on GitHub
          </a>
        </div>
      </div>
    </div>
  )
}
