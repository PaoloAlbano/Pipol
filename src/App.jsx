import React, { useState, useEffect } from 'react'
import Home from './components/Home.jsx'
import Room from './components/Room.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import {
  getIdentity,
  setUsername,
  getShowStats,
  setShowStats,
  isFirstVisit,
  markOnboarded,
} from './p2p/storage.js'
import { initEncryption } from './p2p/db.js'

/**
 * App root.
 * Manages the top-level view: "home" (lobby) or "room" (active chat).
 */
export default function App() {
  const [identity, setIdentity] = useState(() => getIdentity())
  const [settingsOpen, setSettingsOpen] = useState(isFirstVisit)
  const [showStats, setShowStatsState] = useState(getShowStats)
  const [roomCode, setRoomCode] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('room') || ''
  })
  const [view, setView] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('room') ? 'room' : 'home'
  })

  useEffect(() => {
    initEncryption(identity.secretKey).catch((err) =>
      console.warn('[db] encryption init failed', err)
    )

    // Hide the static HTML splash once React has mounted
    const splash = document.getElementById('splash')
    if (splash) {
      splash.classList.add('hidden')
      splash.addEventListener('transitionend', () => splash.remove(), { once: true })
    }
  }, [identity.secretKey])

  function handleJoinRoom(code) {
    const normalised = code.trim().toLowerCase()
    setRoomCode(normalised)
    setView('room')
    // Reflect room in URL so it can be bookmarked / shared
    window.history.pushState({}, '', `?room=${encodeURIComponent(normalised)}`)
  }

  function handleLeaveRoom() {
    setView('home')
    setRoomCode('')
    window.history.pushState({}, '', '/')
  }

  function handleUsernameChange(name) {
    setUsername(name)
    setIdentity((prev) => ({ ...prev, username: name }))
  }

  if (!identity)
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: '#0f0f0f',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
        }}
      >
        <img
          src="/icons/icon.svg"
          alt="Pipol.dev"
          style={{ width: 72, height: 72, borderRadius: 18 }}
        />
        <div
          style={{
            width: 32,
            height: 32,
            border: '3px solid #333',
            borderTopColor: '#7c6bf0',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <span style={{ fontFamily: 'system-ui', fontSize: 13, color: '#888' }}>Loading…</span>
      </div>
    )

  return (
    <>
      {view === 'home' && (
        <Home
          identity={identity}
          onJoin={handleJoinRoom}
          onUsernameChange={handleUsernameChange}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {view === 'room' && (
        <Room
          key={roomCode}
          roomCode={roomCode}
          identity={identity}
          showStats={showStats}
          onLeave={handleLeaveRoom}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          identity={identity}
          onUsernameChange={handleUsernameChange}
          showStats={showStats}
          onShowStatsChange={(v) => {
            setShowStats(v)
            setShowStatsState(v)
          }}
          onClose={() => {
            markOnboarded()
            setSettingsOpen(false)
          }}
        />
      )}
    </>
  )
}
