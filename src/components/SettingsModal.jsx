import React, { useState } from 'react'
import { getVideoQuality, setVideoQuality } from '../p2p/storage.js'
import { applyVideoQuality } from '../webrtc/media.js'
import '../styles/settings.css'

const QUALITIES = [
  { value: '480p', label: '480p', desc: 'Low bandwidth' },
  { value: '720p', label: '720p', desc: 'Balanced' },
  { value: '1080p', label: '1080p', desc: 'Best quality' },
]

export default function SettingsModal({
  identity,
  onUsernameChange,
  showStats,
  onShowStatsChange,
  onClose,
}) {
  const [name, setName] = useState(identity.username)
  const [nameError, setNameError] = useState('')
  const [quality, setQuality] = useState(getVideoQuality)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    const trimmed = name.trim()
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
    setVideoQuality(quality)
    applyVideoQuality(quality)

    setSaved(true)
    setTimeout(() => {
      setSaved(false)
      onClose()
    }, 800)
  }

  return (
    <div
      className="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-modal">
        <div className="settings-header">
          <h2 className="settings-title">Settings</h2>
          <button className="settings-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="settings-section">
          <label className="settings-label">Display name</label>
          <input
            className="settings-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setNameError('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            maxLength={32}
            placeholder="Your name"
            autoFocus
          />
          {nameError && <p className="settings-error">{nameError}</p>}
        </div>

        <div className="settings-section">
          <label className="settings-label">Video quality</label>
          <div className="settings-quality-group">
            {QUALITIES.map((q) => (
              <label
                key={q.value}
                className={`settings-quality-option ${quality === q.value ? 'settings-quality-option--active' : ''}`}
              >
                <input
                  type="radio"
                  name="quality"
                  value={q.value}
                  checked={quality === q.value}
                  onChange={() => setQuality(q.value)}
                />
                <span className="settings-quality-label">{q.label}</span>
                <span className="settings-quality-desc">{q.desc}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <label className="settings-label">Debug</label>
          <label className="settings-toggle-row">
            <span className="settings-toggle-label">Show network stats overlay</span>
            <span className="settings-toggle-desc">
              Shows connection type, RTT and bytes for each peer
            </span>
            <button
              className={`settings-toggle ${showStats ? 'settings-toggle--on' : ''}`}
              role="switch"
              aria-checked={showStats}
              onClick={() => onShowStatsChange(!showStats)}
            >
              <span className="settings-toggle-thumb" />
            </button>
          </label>
        </div>

        <div className="settings-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            {saved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
