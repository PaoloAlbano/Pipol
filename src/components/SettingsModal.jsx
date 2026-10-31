import React, { useState, useEffect } from 'react'
import {
  getVideoQuality,
  setVideoQuality,
  getRelayUrl,
  setRelayUrl,
  setMirrorVideo,
  getIceSettings,
  setIceSettings,
  getPassphrase,
  clearPassphrase,
  getStoredIdentityMeta,
} from '../p2p/storage.js'
import { applyVideoQuality } from '../webrtc/media.js'
import {
  parseIceUrls,
  validateIceServers,
  resolveIceConfig,
  testIceServers,
  hasTurnServer,
  isTurnDisabled,
} from '../webrtc/ice.js'
import { getEffectiveConfig } from '../p2p/workspace.js'
import {
  isBiometricUnlockAvailable,
  hasBiometricUnlock,
  setupBiometricUnlock,
  removeBiometricUnlock,
} from '../p2p/webauthn.js'
import { getNotificationPermission, requestNotificationPermission } from '../p2p/notifications.js'
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
  mirrorVideo,
  onMirrorVideoChange,
  onClose,
  onLock,
  activeWorkspace,
  onLeaveWorkspace,
  workspaces = [],
  onSelectWorkspace,
  getDebugInfo,
}) {
  const [name, setName] = useState(identity.username)
  const [nameError, setNameError] = useState('')
  const [quality, setQuality] = useState(getVideoQuality)
  const [relayUrl, setRelayUrlState] = useState(getRelayUrl)
  const [relayError, setRelayError] = useState('')
  const [iceMode, setIceMode] = useState(() => getIceSettings().mode)
  const [iceUrls, setIceUrls] = useState(() =>
    parseIceUrls((getIceSettings().servers[0]?.urls ?? []).join(' ')).join('\n')
  )
  const [iceUsername, setIceUsername] = useState(() => getIceSettings().servers[0]?.username ?? '')
  const [iceCredential, setIceCredential] = useState(() => getIceSettings().servers[0]?.credential ?? '')
  const [forceRelay, setForceRelay] = useState(() => getIceSettings().forceRelay)
  const [chatTurn, setChatTurn] = useState(() => getIceSettings().chatTurn)
  const [iceError, setIceError] = useState('')
  const [iceTest, setIceTest] = useState(null) // null | 'running' | { ok: boolean, message: string }
  const [saved, setSaved] = useState(false)
  const [biometricAvailable, setBiometricAvailable] = useState(false)
  const [biometricEnabled, setBiometricEnabled] = useState(hasBiometricUnlock)
  const [biometricError, setBiometricError] = useState('')
  const [debugText, setDebugText] = useState(null)
  const [debugCopied, setDebugCopied] = useState(false)
  const [biometricLoading, setBiometricLoading] = useState(false)
  const [biometricDisableConfirm, setBiometricDisableConfirm] = useState(false)
  const [leaveConfirm, setLeaveConfirm] = useState(false)
  const [notifPerm, setNotifPerm] = useState(getNotificationPermission)

  useEffect(() => {
    if (identity.isGuest) return
    isBiometricUnlockAvailable().then(setBiometricAvailable)
  }, [identity.isGuest])

  /** Builds the ICE settings object from the form; throws 'invalid-ice-servers' for bad custom input. */
  function readIceSettings() {
    const settings = { mode: iceMode, servers: [], forceRelay, chatTurn }
    if (iceMode === 'custom') {
      settings.servers = validateIceServers([
        { urls: parseIceUrls(iceUrls), username: iceUsername.trim(), credential: iceCredential },
      ])
    }
    return settings
  }

  async function handleTestIce() {
    let settings
    try {
      settings = readIceSettings()
    } catch {
      setIceError('Use turn:, turns: or stun: URLs. TURN also needs a username and password.')
      return
    }
    setIceError('')
    setIceTest('running')
    try {
      const relay = relayUrl.trim() || getEffectiveConfig(activeWorkspace?.config).relayUrl
      const config = await resolveIceConfig({ relayUrl: relay, workspaceIce: activeWorkspace?.config?.ice, settings })
      if (!hasTurnServer(config.iceServers)) {
        setIceTest({ ok: false, message: 'No TURN server in use: only direct and STUN connections are possible.' })
        return
      }
      const found = await testIceServers(config)
      setIceTest(
        found.relay
          ? { ok: true, message: 'TURN works: a relayed address was allocated.' }
          : { ok: false, message: 'No relayed address: check the server address, port and credentials.' }
      )
    } catch (err) {
      setIceTest({ ok: false, message: `Test failed: ${err.message}` })
    }
  }

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

    let iceSettings
    try {
      iceSettings = readIceSettings()
    } catch {
      setIceError('Use turn:, turns: or stun: URLs. TURN also needs a username and password.')
      return
    }

    onUsernameChange(trimmed)
    setIceSettings(iceSettings)
    setVideoQuality(quality)
    applyVideoQuality(quality)
    setRelayUrl(trimmedRelay)
    setMirrorVideo(mirrorVideo)

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
            <label className="settings-label">Video</label>
            <label className="settings-toggle-row">
              <span className="settings-toggle-label">Mirror local camera</span>
              <span className="settings-toggle-desc">Flip your own video preview horizontally</span>
              <button
                className={`settings-toggle ${mirrorVideo ? 'settings-toggle--on' : ''}`}
                role="switch"
                aria-checked={mirrorVideo}
                onClick={() => onMirrorVideoChange?.(!mirrorVideo)}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </label>
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
            <p className="settings-hint">Custom signaling relay. Changes take effect on the next room join.</p>
          </div>

          <div className="settings-section">
            <label className="settings-label">Connection (TURN)</label>
            {isTurnDisabled() && (
              <p className="settings-hint settings-hint--warn">
                TURN is disabled in this version of the app: &quot;Default&quot; uses public STUN only. Choose
                &quot;Custom&quot; to use a TURN server of your own.
              </p>
            )}
            <div className="settings-quality-group" role="radiogroup" aria-label="TURN mode">
              {[
                { value: 'default', label: 'Default', desc: 'Workspace or app TURN' },
                { value: 'custom', label: 'Custom', desc: 'Your own TURN (e.g. coturn)' },
                { value: 'off', label: 'Off', desc: 'Public STUN only' },
              ].map((m) => (
                <label
                  key={m.value}
                  className={`settings-quality-option ${iceMode === m.value ? 'settings-quality-option--active' : ''}`}
                >
                  <input
                    type="radio"
                    name="ice-mode"
                    value={m.value}
                    checked={iceMode === m.value}
                    onChange={() => {
                      setIceMode(m.value)
                      setIceError('')
                      setIceTest(null)
                    }}
                  />
                  <span className="settings-quality-label">{m.label}</span>
                  <span className="settings-quality-desc">{m.desc}</span>
                </label>
              ))}
            </div>
            {iceMode === 'custom' && (
              <>
                <textarea
                  className="settings-input"
                  rows={2}
                  aria-label="TURN server URLs"
                  value={iceUrls}
                  onChange={(e) => setIceUrls(e.target.value)}
                  placeholder={'turn:turn.example.com:3478\nturns:turn.example.com:5349'}
                  spellCheck={false}
                />
                <input
                  className="settings-input"
                  aria-label="TURN username"
                  value={iceUsername}
                  onChange={(e) => setIceUsername(e.target.value)}
                  placeholder="Username"
                  autoComplete="off"
                />
                <input
                  className="settings-input"
                  aria-label="TURN password"
                  type="password"
                  value={iceCredential}
                  onChange={(e) => setIceCredential(e.target.value)}
                  placeholder="Password"
                  autoComplete="off"
                />
              </>
            )}
            {iceMode !== 'off' && (
              <label className="settings-toggle-row">
                <span className="settings-toggle-label">Also use TURN for chat</span>
                <span className="settings-toggle-desc">
                  Off by default: TURN is used for video calls only, chat connects directly or falls back to the relay.
                </span>
                <input
                  type="checkbox"
                  checked={chatTurn || forceRelay}
                  disabled={forceRelay}
                  onChange={(e) => setChatTurn(e.target.checked)}
                />
              </label>
            )}
            {iceMode !== 'off' && (
              <label className="settings-toggle-row">
                <span className="settings-toggle-label">Always relay (hide my IP)</span>
                <span className="settings-toggle-desc">
                  Other participants will not see your IP address, in calls and chat. Needs a TURN server and adds
                  latency.
                </span>
                <input type="checkbox" checked={forceRelay} onChange={(e) => setForceRelay(e.target.checked)} />
              </label>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestIce}
              disabled={iceTest === 'running'}
            >
              {iceTest === 'running' ? 'Testing…' : 'Test connection'}
            </button>
            {iceError && <p className="settings-error">{iceError}</p>}
            {iceTest && iceTest !== 'running' && (
              <p className={iceTest.ok ? 'settings-hint' : 'settings-hint settings-hint--warn'} role="status">
                {iceTest.message}
              </p>
            )}
            <p className="settings-hint">
              TURN relays traffic when a direct connection is not possible. It only sees encrypted packets, but it does
              see IP addresses. Changes apply to the next call.
            </p>
          </div>

          <div className="settings-section">
            <label className="settings-label">Notifications</label>
            {notifPerm === 'unsupported' ? (
              <p className="settings-hint">Desktop notifications are unavailable in this browser.</p>
            ) : notifPerm === 'granted' ? (
              <p className="settings-hint">
                Notifications are enabled. You&apos;ll be notified of new messages in channels you&apos;re not currently
                viewing.
              </p>
            ) : notifPerm === 'denied' ? (
              <p className="settings-hint settings-hint--warn">
                Notifications are blocked. Allow them in your browser settings to receive alerts.
              </p>
            ) : (
              <>
                <p className="settings-hint">
                  Get desktop notifications for new messages in channels you’re not currently viewing.
                </p>
                <button
                  className="btn btn-secondary"
                  onClick={async () => {
                    const result = await requestNotificationPermission()
                    setNotifPerm(result)
                  }}
                >
                  Enable notifications
                </button>
              </>
            )}
          </div>

          <div className="settings-section">
            <label className="settings-label">Debug</label>
            <label className="settings-toggle-row">
              <span className="settings-toggle-label">Show network stats overlay</span>
              <span className="settings-toggle-desc">Shows connection type, RTT and bytes for each peer</span>
              <button
                className={`settings-toggle ${showStats ? 'settings-toggle--on' : ''}`}
                role="switch"
                aria-checked={showStats}
                onClick={() => onShowStatsChange(!showStats)}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </label>
            {getDebugInfo && (
              <div className="settings-debug-diag">
                <button
                  className="btn btn-secondary settings-debug-btn"
                  onClick={() => {
                    setDebugText(JSON.stringify(getDebugInfo(), null, 2))
                    setDebugCopied(false)
                  }}
                >
                  Show diagnostics
                </button>
                {debugText && (
                  <>
                    <textarea
                      className="settings-debug-text"
                      readOnly
                      value={debugText}
                      rows={14}
                      aria-label="Diagnostic info"
                    />
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        navigator.clipboard?.writeText(debugText).then(() => {
                          setDebugCopied(true)
                          setTimeout(() => setDebugCopied(false), 2000)
                        })
                      }}
                    >
                      {debugCopied ? '✓ Copied!' : 'Copy to clipboard'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {biometricAvailable && !identity.isGuest && (
            <div className="settings-section">
              <label className="settings-label">Biometric unlock</label>
              {biometricEnabled ? (
                <>
                  <p className="settings-hint">
                    Biometric unlock is active on this device. You can sign in with Touch ID / Face ID without typing
                    your passphrase.
                  </p>
                  {biometricDisableConfirm ? (
                    <>
                      <p className="settings-hint settings-hint--warn">
                        To re-enable biometric unlock you will need to log out and log back in. Continue?
                      </p>
                      <div className="settings-row">
                        <button
                          className="btn btn-lock"
                          onClick={() => {
                            removeBiometricUnlock()
                            setBiometricEnabled(false)
                            setBiometricDisableConfirm(false)
                          }}
                        >
                          Yes, disable
                        </button>
                        <button className="btn btn-secondary" onClick={() => setBiometricDisableConfirm(false)}>
                          Keep enabled
                        </button>
                      </div>
                    </>
                  ) : (
                    <button className="btn btn-lock" onClick={() => setBiometricDisableConfirm(true)}>
                      Disable
                    </button>
                  )}
                </>
              ) : getPassphrase() === null ? (
                <p className="settings-hint">
                  Biometric unlock is not available in this session. Log out and log back in to enable it.
                </p>
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
                        await setupBiometricUnlock(getPassphrase(), meta)
                        clearPassphrase()
                        setBiometricEnabled(true)
                      } catch (err) {
                        console.warn('[biometric setup]', err?.message)
                        const msg =
                          err.message === 'not-supported'
                            ? 'Your device or browser does not support biometric unlock. Make sure you have a PIN or biometric set up.'
                            : err.message === 'create-failed'
                              ? 'Passkey creation failed. Your device or browser may not fully support this feature.'
                              : err.message === 'cancelled'
                                ? null // real user cancel — no message
                                : 'Setup failed. Try again.'
                        if (msg) setBiometricError(msg)
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
              Removes the decryption key from memory. You&apos;ll need your passphrase to unlock again.
            </p>
          </div>

          {workspaces.length > 0 && (
            <div className="settings-section">
              <label className="settings-label">Workspaces</label>
              <ul className="settings-workspace-list">
                {workspaces.map((ws) => {
                  const isActive = ws.id === activeWorkspace?.id
                  return (
                    <li
                      key={ws.id}
                      className={`settings-workspace-item ${isActive ? 'settings-workspace-item--active' : ''}`}
                    >
                      <button
                        className="settings-workspace-name"
                        onClick={() => !isActive && onSelectWorkspace?.(ws.id)}
                        disabled={isActive}
                      >
                        {ws.name}
                        {isActive && <span className="settings-workspace-badge">current</span>}
                      </button>
                      {isActive &&
                        onLeaveWorkspace &&
                        (leaveConfirm ? (
                          <span className="settings-workspace-confirm">
                            <span className="settings-hint--warn">Sure?</span>
                            <button
                              className="btn btn-lock btn-xs"
                              onClick={() => {
                                onClose()
                                onLeaveWorkspace()
                              }}
                            >
                              Leave
                            </button>
                            <button className="btn btn-secondary btn-xs" onClick={() => setLeaveConfirm(false)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button className="btn btn-lock btn-xs" onClick={() => setLeaveConfirm(true)}>
                            Leave
                          </button>
                        ))}
                    </li>
                  )
                })}
              </ul>
              <p className="settings-hint">
                Click a workspace to switch. Leaving removes it from this device — you&apos;ll need an invite link to
                rejoin.
              </p>
            </div>
          )}
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
