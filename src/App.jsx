import React, { useState, useEffect, lazy, Suspense } from 'react'
import Home from './components/Home.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import LoginScreen from './components/LoginScreen.jsx'
import OIDCCallback from './components/OIDCCallback.jsx'

// Lazy-load Room and the entire P2P stack — only downloaded when the user enters a room
const Room = lazy(() => import('./components/Room.jsx'))
import {
  getIdentity,
  setUsername,
  getShowStats,
  setShowStats,
  getMasterSeed,
  lockSession,
} from './p2p/storage.js'
import { initEncryption } from './p2p/db.js'

/**
 * App root.
 * Manages the top-level view: "home" (lobby) or "room" (active chat).
 */
export default function App() {
  const [identity, setIdentity] = useState(() => getIdentity()) // null until login
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showStats, setShowStatsState] = useState(getShowStats)
  const [roomCode, setRoomCode] = useState(() => {
    const { pathname, search } = window.location
    // Leave /callback alone — OIDCCallback handles it and will replaceState itself
    if (pathname !== '/' && pathname !== '/callback') {
      window.history.replaceState({}, '', '/')
      return ''
    }
    const params = new URLSearchParams(search)
    return params.get('room') || ''
  })
  const [view, setView] = useState(() => {
    const { pathname, search } = window.location
    if (pathname !== '/') return 'home'
    const params = new URLSearchParams(search)
    return params.get('room') ? 'room' : 'home'
  })

  // Hide the static HTML splash as soon as React mounts
  useEffect(() => {
    const splash = document.getElementById('splash')
    if (splash) {
      splash.classList.add('hidden')
      splash.addEventListener('transitionend', () => splash.remove(), { once: true })
    }
  }, [])

  // Init IndexedDB encryption once identity is available
  useEffect(() => {
    if (!identity) return
    initEncryption(getMasterSeed()).catch((err) => console.warn('[db] encryption init failed', err))
  }, [identity])

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

  function handleLogin() {
    // Re-read room from URL — OIDC callback may have restored a ?room= param
    const params = new URLSearchParams(window.location.search)
    const room = params.get('room')
    if (room) {
      const normalised = room.trim().toLowerCase()
      setRoomCode(normalised)
      setView('room')
    }
    setIdentity(getIdentity())
  }

  function handleLock() {
    lockSession()
    setIdentity(null)
    setSettingsOpen(false)
  }

  function handleUsernameChange(name) {
    setUsername(name)
    setIdentity((prev) => ({ ...prev, username: name }))
  }

  if (window.location.pathname === '/callback') {
    return <OIDCCallback onLogin={handleLogin} />
  }

  if (!identity) return <LoginScreen onLogin={handleLogin} />

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
        <Suspense fallback={null}>
          <Room
            key={roomCode}
            roomCode={roomCode}
            identity={identity}
            showStats={showStats}
            onLeave={handleLeaveRoom}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </Suspense>
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
          onClose={() => setSettingsOpen(false)}
          onLock={handleLock}
        />
      )}
    </>
  )
}
