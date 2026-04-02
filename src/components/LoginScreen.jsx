import { useState } from 'react'
import {
  getStoredIdentityMeta,
  deriveIdentityA,
  setUsername,
  generateUsername,
} from '../p2p/storage.js'
import '../styles/login.css'

export default function LoginScreen({ onLogin }) {
  const [storedMeta] = useState(() => getStoredIdentityMeta())
  const initialHandle = storedMeta?.handle || ''

  const [handle, setHandle] = useState(initialHandle)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [displayName, setDisplayName] = useState(() => generateUsername())
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const normHandle = handle.toLowerCase().trim()
  const isUnlock = storedMeta && storedMeta.handle === normHandle
  const isCreate = !isUnlock

  const strength = passphraseStrength(passphrase)
  const confirmMismatch = isCreate && confirm && passphrase !== confirm
  const canSubmit =
    normHandle.length > 0 &&
    passphrase.length > 0 &&
    !confirmMismatch &&
    (isUnlock || (strength.score >= 3 && passphrase === confirm))

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSubmit || loading) return
    setLoading(true)
    setError('')
    try {
      const { isNewAccount } = await deriveIdentityA(handle, passphrase)
      if (isNewAccount) setUsername(displayName.trim() || generateUsername())
      onLogin()
    } catch (err) {
      setError(err.message === 'wrong-passphrase' ? 'Wrong passphrase.' : 'Unexpected error.')
      console.error('[login]', err)
      setLoading(false)
    }
  }

  function handleReset() {
    localStorage.removeItem('p2p-chat:identity')
    window.location.reload()
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="/icons/icon.svg" alt="Pipol" className="login-logo" />
        <h1 className="login-title">Pipol</h1>
        <p className="login-subtitle">
          {isUnlock ? `Welcome back, ${storedMeta.username}` : 'Create or restore your identity'}
        </p>

        <form onSubmit={handleSubmit} className="login-form" noValidate>
          <div className="login-field">
            <label htmlFor="handle">Handle</label>
            <input
              id="handle"
              type="text"
              value={handle}
              onChange={(e) => {
                setHandle(e.target.value)
                setError('')
              }}
              placeholder="email, username, or any stable ID"
              autoComplete="username"
              autoFocus={!initialHandle}
              disabled={loading}
              spellCheck={false}
            />
          </div>

          <div className="login-field">
            <label htmlFor="passphrase">Passphrase</label>
            <div className="input-wrap">
              <input
                id="passphrase"
                type={showPassphrase ? 'text' : 'password'}
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value)
                  setError('')
                }}
                placeholder="••••••••••••••••"
                autoComplete={isCreate ? 'new-password' : 'current-password'}
                autoFocus={!!initialHandle}
                disabled={loading}
              />
              <button
                type="button"
                className="reveal-btn"
                onClick={() => setShowPassphrase((v) => !v)}
                tabIndex={-1}
                aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
              >
                {showPassphrase ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            {isCreate && passphrase && (
              <>
                <div className="strength-bar" aria-label={`Strength: ${strength.label}`}>
                  <div
                    className={`strength-fill strength-${strength.key}`}
                    style={{ width: `${(strength.score / 4) * 100}%` }}
                  />
                  <span className="strength-text">{strength.label}</span>
                  {strength.score < 3 && (
                    <span className="strength-count">{strength.score} / 3 to unlock</span>
                  )}
                </div>
                {strength.score < 3 && (
                  <ul className="strength-hints">
                    <li className="hints-header">Complete any 3 to continue:</li>
                    {strength.criteria.map((c) => (
                      <li key={c.label} className={c.met ? 'hint-met' : 'hint-unmet'}>
                        {c.met ? '✓' : '○'} {c.label}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {isCreate && (
            <div className="login-field">
              <label htmlFor="confirm">Confirm passphrase</label>
              <div className="input-wrap">
                <input
                  id="confirm"
                  type={showConfirm ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••••••••••••"
                  autoComplete="new-password"
                  disabled={loading}
                />
                <button
                  type="button"
                  className="reveal-btn"
                  onClick={() => setShowConfirm((v) => !v)}
                  tabIndex={-1}
                  aria-label={showConfirm ? 'Hide passphrase' : 'Show passphrase'}
                >
                  {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              {confirmMismatch && (
                <span className="field-hint field-hint--error">Passphrases do not match</span>
              )}
            </div>
          )}

          {isCreate && (
            <div className="login-field">
              <label htmlFor="displayName">
                Display name <span className="field-hint">(optional)</span>
              </label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How others will see you"
                autoComplete="nickname"
                maxLength={32}
                disabled={loading}
                spellCheck={false}
              />
            </div>
          )}

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-btn" disabled={!canSubmit || loading}>
            {loading ? (
              <>
                <span className="login-spinner" />
                Deriving key…
              </>
            ) : isUnlock ? (
              'Unlock'
            ) : (
              'Create / restore identity'
            )}
          </button>
        </form>

        {isCreate && (
          <p className="login-note">
            Your passphrase cannot be recovered. Choose a strong one and keep it safe.
          </p>
        )}

        {storedMeta && isCreate && (
          <p className="login-note">
            Different handle — a new identity will be created.{' '}
            <button className="login-link" onClick={handleReset}>
              Go back
            </button>
          </p>
        )}
      </div>
    </div>
  )
}

function passphraseStrength(passphrase) {
  if (!passphrase) return { score: 0, label: '', key: 'empty', criteria: [] }

  const criteria = [
    { label: 'At least 12 characters', met: passphrase.length >= 12 },
    { label: '20+ characters for extra strength', met: passphrase.length >= 20 },
    {
      label: 'Uppercase and lowercase letters',
      met: /[A-Z]/.test(passphrase) && /[a-z]/.test(passphrase),
    },
    { label: 'At least one number', met: /[0-9]/.test(passphrase) },
    { label: 'At least one symbol (!@#…)', met: /[^A-Za-z0-9]/.test(passphrase) },
  ]

  const score = Math.min(criteria.filter((c) => c.met).length, 4)

  const map = [
    { label: 'Very weak', key: 'very-weak' },
    { label: 'Weak', key: 'weak' },
    { label: 'Fair', key: 'fair' },
    { label: 'Strong', key: 'strong' },
    { label: 'Very strong', key: 'strong' },
  ]
  return { score, ...map[score], criteria }
}

function EyeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}
