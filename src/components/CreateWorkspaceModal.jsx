import React, { useState, useRef, useEffect } from 'react'
import { buildInviteUrl } from '../p2p/workspace.js'
import { buildWorkspaceIce, isTurnDisabled } from '../webrtc/ice.js'
import '../styles/create-workspace-modal.css'

/**
 * CreateWorkspaceModal — two modes:
 *
 *   create mode  (workspace === null)
 *     Step 1 → workspace name
 *     Step 2 → seed channels + optional advanced config
 *     Step 3 → invite URL display with copy button
 *
 *   share mode   (workspace !== null)
 *     Shows invite URL for an existing workspace directly.
 *
 * @param {object|null} workspace   null = create new, object = share existing
 * @param {function}    onCreated   called with (workspace) after creation
 * @param {function}    onClose
 */
export default function CreateWorkspaceModal({ workspace: existingWorkspace, createdWorkspace, onCreated, onClose }) {
  const isShareMode = existingWorkspace !== null && existingWorkspace !== undefined
  const turnDisabled = isTurnDisabled() // build-level kill switch: no TURN settings to offer

  // ── Create flow state ──────────────────────────────────────────────────────
  const [step, setStep] = useState(1) // 1 | 2 | 3
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const [channels, setChannels] = useState(['general', 'random'])
  const [newChannel, setNewChannel] = useState('')
  const [channelError, setChannelError] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [relayUrl, setRelayUrl] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const [turnUrls, setTurnUrls] = useState('')
  const [turnUsername, setTurnUsername] = useState('')
  const [turnCredential, setTurnCredential] = useState('')
  const [iceEndpoint, setIceEndpoint] = useState('')
  const [iceError, setIceError] = useState('')

  const [copied, setCopied] = useState(false)

  const nameInputRef = useRef(null)

  useEffect(() => {
    if (!isShareMode && step === 1) nameInputRef.current?.focus()
  }, [isShareMode, step])

  // ── Helpers ────────────────────────────────────────────────────────────────

  const activeWorkspaceForUrl = isShareMode ? existingWorkspace : createdWorkspace
  const inviteUrl = activeWorkspaceForUrl ? buildInviteUrl(activeWorkspaceForUrl) : null

  function copyToClipboard() {
    if (!inviteUrl) return
    navigator.clipboard
      .writeText(inviteUrl)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => {
        window.prompt('Copy the invite link:', inviteUrl)
      })
  }

  // ── Step 1 ─────────────────────────────────────────────────────────────────

  function handleStep1(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('Please enter a workspace name.')
      return
    }
    if (trimmed.length > 48) {
      setNameError('Maximum 48 characters.')
      return
    }
    setNameError('')
    setStep(2)
  }

  // ── Step 2 ─────────────────────────────────────────────────────────────────

  function addChannel() {
    const clean = newChannel
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
    if (!clean) {
      setChannelError('Enter a channel name.')
      return
    }
    if (channels.includes(clean)) {
      setChannelError('Channel already exists.')
      return
    }
    setChannels((prev) => [...prev, clean])
    setNewChannel('')
    setChannelError('')
  }

  function removeChannel(ch) {
    if (channels.length <= 1) return // keep at least one
    setChannels((prev) => prev.filter((c) => c !== ch))
  }

  function handleStep2(e) {
    e.preventDefault()
    if (channels.length === 0) {
      setChannelError('Add at least one channel.')
      return
    }

    let ice = null
    try {
      if (!turnDisabled) {
        ice = buildWorkspaceIce({
          urls: turnUrls,
          username: turnUsername,
          credential: turnCredential,
          endpoint: iceEndpoint,
        })
      }
    } catch {
      setIceError('Check the TURN settings: use turn:/turns:/stun: URLs, with username and password for TURN.')
      setAdvancedOpen(true)
      return
    }
    setIceError('')

    const config =
      relayUrl.trim() || authUrl.trim() || ice
        ? {
            relayUrl: relayUrl.trim() || undefined,
            authUrl: authUrl.trim() || undefined,
            ice: ice ?? undefined,
          }
        : null

    onCreated(name.trim(), channels, config)
    // App.jsx creates the workspace and passes it back via the createdWorkspace prop,
    // which triggers the step 3 result screen.
    setStep(3)
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  function handleKeyDown(e) {
    if (e.key === 'Escape') onClose()
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const totalSteps = 3

  return (
    <div className="cwm-overlay" onKeyDown={handleKeyDown} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="cwm"
        role="dialog"
        aria-modal="true"
        aria-label={isShareMode ? 'Share workspace' : 'Create workspace'}
      >
        {/* Header */}
        <div className="cwm__header">
          <span className="cwm__title">
            {isShareMode ? 'Invite people' : step === 3 ? 'Workspace ready!' : 'Create workspace'}
          </span>
          <button className="cwm__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Step dots — only in create mode, steps 1 and 2 */}
        {!isShareMode && step < 3 && (
          <div className="cwm__steps" aria-label={`Step ${step} of ${totalSteps - 1}`}>
            {[1, 2].map((s) => (
              <span
                key={s}
                className={[
                  'cwm__step-dot',
                  step === s ? 'cwm__step-dot--active' : '',
                  step > s ? 'cwm__step-dot--done' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            ))}
          </div>
        )}

        {/* ── Share mode ── */}
        {isShareMode && (
          <ShareContent
            workspace={existingWorkspace}
            inviteUrl={inviteUrl}
            copied={copied}
            onCopy={copyToClipboard}
            onClose={onClose}
          />
        )}

        {/* ── Create mode: step 1 — name ── */}
        {!isShareMode && step === 1 && (
          <form onSubmit={handleStep1} style={{ display: 'contents' }}>
            <div>
              <label className="cwm__label" htmlFor="cwm-name">
                Workspace name
              </label>
              <input
                id="cwm-name"
                ref={nameInputRef}
                className="cwm__input"
                type="text"
                placeholder="e.g. Acme Corp, Team Design…"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameError('')
                }}
                maxLength={48}
                autoComplete="off"
              />
              {nameError && <p className="cwm__error">{nameError}</p>}
              <p className="cwm__hint">Give your workspace a short, recognisable name.</p>
            </div>
            <div className="cwm__footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Next →
              </button>
            </div>
          </form>
        )}

        {/* ── Create mode: step 2 — channels + config ── */}
        {!isShareMode && step === 2 && (
          <form onSubmit={handleStep2} style={{ display: 'contents' }}>
            <div>
              <label className="cwm__label">Seed channels</label>
              <div className="cwm__channels">
                {channels.map((ch) => (
                  <div key={ch} className="cwm__channel-row">
                    <span className="cwm__channel-prefix">›</span>
                    <input className="cwm__channel-input" value={ch} readOnly aria-label={`Channel ${ch}`} />
                    <button
                      type="button"
                      className="cwm__channel-remove"
                      onClick={() => removeChannel(ch)}
                      aria-label={`Remove ${ch}`}
                      disabled={channels.length <= 1}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="cwm__channel-row">
                  <span className="cwm__channel-prefix">›</span>
                  <input
                    className="cwm__channel-input"
                    placeholder="new-channel"
                    value={newChannel}
                    onChange={(e) => {
                      setNewChannel(e.target.value)
                      setChannelError('')
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChannel())}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="New channel name"
                  />
                  <button
                    type="button"
                    className="cwm__channel-remove"
                    onClick={addChannel}
                    aria-label="Add channel"
                    style={{ color: 'var(--primary)', fontSize: 18 }}
                  >
                    +
                  </button>
                </div>
              </div>
              {channelError && <p className="cwm__error">{channelError}</p>}
            </div>

            {/* Advanced config */}
            <div>
              <button
                type="button"
                className="cwm__advanced-toggle"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
              >
                <span
                  className={['cwm__advanced-chevron', advancedOpen ? 'cwm__advanced-chevron--open' : ''].join(' ')}
                >
                  ▶
                </span>
                Advanced configuration
              </button>
              {advancedOpen && (
                <div className="cwm__advanced-fields">
                  <div>
                    <label className="cwm__label" htmlFor="cwm-relay">
                      Custom relay URL
                    </label>
                    <input
                      id="cwm-relay"
                      className="cwm__input"
                      type="url"
                      placeholder="wss://relay.example.com"
                      value={relayUrl}
                      onChange={(e) => setRelayUrl(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="cwm__label" htmlFor="cwm-auth">
                      Custom auth URL
                    </label>
                    <input
                      id="cwm-auth"
                      className="cwm__input"
                      type="url"
                      placeholder="https://auth.example.com"
                      value={authUrl}
                      onChange={(e) => setAuthUrl(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  {!turnDisabled && (
                    <>
                      <div>
                        <label className="cwm__label" htmlFor="cwm-turn-urls">
                          TURN server URL(s)
                        </label>
                        <input
                          id="cwm-turn-urls"
                          className="cwm__input"
                          placeholder="turn:turn.example.com:3478, turns:turn.example.com:5349"
                          value={turnUrls}
                          onChange={(e) => setTurnUrls(e.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </div>
                      <div>
                        <label className="cwm__label" htmlFor="cwm-turn-user">
                          TURN username
                        </label>
                        <input
                          id="cwm-turn-user"
                          className="cwm__input"
                          value={turnUsername}
                          onChange={(e) => setTurnUsername(e.target.value)}
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="cwm__label" htmlFor="cwm-turn-pass">
                          TURN password
                        </label>
                        <input
                          id="cwm-turn-pass"
                          className="cwm__input"
                          value={turnCredential}
                          onChange={(e) => setTurnCredential(e.target.value)}
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="cwm__label" htmlFor="cwm-ice-endpoint">
                          Or ICE endpoint URL
                        </label>
                        <input
                          id="cwm-ice-endpoint"
                          className="cwm__input"
                          type="url"
                          placeholder="https://relay.example.com/ice"
                          value={iceEndpoint}
                          onChange={(e) => setIceEndpoint(e.target.value)}
                          autoComplete="off"
                        />
                      </div>
                      {iceError && <p className="cwm__error">{iceError}</p>}
                    </>
                  )}
                  <p className="cwm__hint">
                    Leave empty to use the app defaults. These settings are embedded in the invite link so joiners pick
                    them up automatically.
                    {!turnDisabled &&
                      ' A TURN username and password in the link are visible to everyone who has it: prefer an ICE endpoint that issues short-lived credentials. Each member can still override or disable TURN in their own Settings.'}
                  </p>
                </div>
              )}
            </div>

            <div className="cwm__footer">
              <button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>
                ← Back
              </button>
              <button type="submit" className="btn btn-primary">
                Create workspace
              </button>
            </div>
          </form>
        )}

        {/* ── Create mode: step 3 — result ── */}
        {!isShareMode && step === 3 && createdWorkspace && (
          <ShareContent
            workspace={createdWorkspace}
            inviteUrl={inviteUrl}
            copied={copied}
            onCopy={copyToClipboard}
            onClose={onClose}
            isNewWorkspace
          />
        )}

        {/* Waiting for createdWorkspace to be set */}
        {!isShareMode && step === 3 && !createdWorkspace && (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Creating workspace…</p>
        )}
      </div>
    </div>
  )
}

// ── ShareContent ──────────────────────────────────────────────────────────────

function ShareContent({ workspace, inviteUrl, copied, onCopy, onClose, isNewWorkspace = false }) {
  return (
    <>
      <div style={{ textAlign: 'center' }}>
        <div className="cwm__success-icon">{isNewWorkspace ? '🎉' : '🔗'}</div>
        <p className="cwm__workspace-name-preview" style={{ marginTop: 8 }}>
          {workspace.name}
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          {workspace.channels?.length ?? 0} channels · P2P E2E encrypted
        </p>
      </div>

      <div>
        <label className="cwm__label">Invite link</label>
        <div className="cwm__invite-box">{inviteUrl}</div>
        <p className="cwm__hint">
          Anyone with this link can join the workspace. Keep it safe — it contains the workspace secret.
        </p>
      </div>

      <div className="cwm__invite-actions">
        <button
          className={['btn btn-primary cwm__copy-btn', copied ? 'cwm__copy-btn--copied' : ''].join(' ')}
          onClick={onCopy}
        >
          {copied ? '✓ Copied!' : '📋 Copy link'}
        </button>
        <button className="btn btn-secondary" onClick={() => window.open(inviteUrl, '_blank', 'noopener')}>
          Open in new tab
        </button>
      </div>

      <div className="cwm__footer">
        <button className="btn btn-primary" onClick={onClose}>
          {isNewWorkspace ? 'Go to workspace' : 'Done'}
        </button>
      </div>
    </>
  )
}
