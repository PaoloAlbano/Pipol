import React, { useState } from 'react'
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
      </div>
    </div>
  )
}
