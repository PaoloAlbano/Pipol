import React, { useState, useEffect } from 'react'
import {
  getVideoQuality,
  setVideoQuality,
  getRelayUrl,
  setRelayUrl,
  getMasterSeed,
  getStoredIdentityMeta,
} from '../p2p/storage.js'
import { applyVideoQuality } from '../webrtc/media.js'
import {
  isBiometricUnlockAvailable,
  hasBiometricUnlock,
  setupBiometricUnlock,
  removeBiometricUnlock,
} from '../p2p/webauthn.js'
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
  onLock,
}) {
  const [name, setName] = useState(identity.username)
  const [nameError, setNameError] = useState('')
  const [quality, setQuality] = useState(getVideoQuality)
  const [relayUrl, setRelayUrlState] = useState(getRelayUrl)
  const [relayError, setRelayError] = useState('')
  const [saved, setSaved] = useState(false)
  const [biometricAvailable, setBiometricAvailable] = useState(false)
  const [biometricEnabled, setBiometricEnabled] = useState(hasBiometricUnlock)
  const [biometricError, setBiometricError] = useState('')
  const [biometricLoading, setBiometricLoading] = useState(false)

  useEffect(() => {
    if (identity.isGuest) return
    isBiometricUnlockAvailable().then(setBiometricAvailable)
  }, [identity.isGuest])

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

    const trimmedRelay = relayUrl.trim()
    if (trimmedRelay && !/^wss?:\/\/.+/.test(trimmedRelay)) {
      setRelayError('Must be a valid ws:// or wss:// URL.')
      return
    }

    onUsernameChange(trimmed)
    setVideoQuality(quality)
    applyVideoQuality(quality)
    setRelayUrl(trimmedRelay)

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

        <div className="settings-body">
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
            <label className="settings-label">Relay server</label>
            <input
              className="settings-input"
              value={relayUrl}
              onChange={(e) => {
                setRelayUrlState(e.target.value)
                setRelayError('')
              }}
              placeholder="wss://relay.example.com  (leave empty for default)"
              spellCheck={false}
            />
            {relayError && <p className="settings-error">{relayError}</p>}
            <p className="settings-hint">
              Custom signaling relay. Changes take effect on the next room join.
            </p>
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

          {biometricAvailable && !identity.isGuest && (
            <div className="settings-section">
              <label className="settings-label">Biometric unlock</label>
              {biometricEnabled ? (
                <>
                  <p className="settings-hint">
                    Biometric unlock is active on this device. You can sign in with Touch ID / Face
                    ID without typing your passphrase.
                  </p>
                  <button
                    className="btn btn-lock"
                    onClick={() => {
                      removeBiometricUnlock()
                      setBiometricEnabled(false)
                    }}
                  >
                    Disable
                  </button>
                </>
              ) : (
                <>
                  <p className="settings-hint">
                    Use Touch ID, Face ID or Windows Hello to unlock without your passphrase.
                  </p>
                  <button
                    className="btn btn-secondary"
                    disabled={biometricLoading}
                    onClick={async () => {
                      setBiometricLoading(true)
                      setBiometricError('')
                      try {
                        const meta = getStoredIdentityMeta()
                        await setupBiometricUnlock(getMasterSeed(), meta)
                        setBiometricEnabled(true)
                      } catch (err) {
                        if (err.message !== 'cancelled') {
                          setBiometricError(
                            err.message === 'authenticator-no-prf-no-largeblob'
                              ? 'Your authenticator supports neither PRF nor largeBlob. Try a FIDO2 security key (e.g. YubiKey 5) or use your passphrase to unlock.'
                              : 'Setup failed. Try again.'
                          )
                        }
                      } finally {
                        setBiometricLoading(false)
                      }
                    }}
                  >
                    {biometricLoading ? 'Setting up…' : 'Enable biometric unlock'}
                  </button>
                  {biometricError && <p className="settings-error">{biometricError}</p>}
                </>
              )}
            </div>
          )}

          <div className="settings-section">
            <label className="settings-label">Session</label>
            <button className="btn btn-lock" onClick={onLock}>
              Lock session
            </button>
            <p className="settings-hint">
              Removes the decryption key from memory. You&apos;ll need your passphrase to unlock
              again.
            </p>
          </div>
        </div>
        {/* settings-body */}

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
