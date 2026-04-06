import { useState, useEffect } from 'react'
import {
  getStoredIdentityMeta,
  deriveIdentityA,
  createGuestIdentity,
  setUsername,
  generateUsername,
} from '../p2p/storage.js'
import {
  hasBiometricUnlock,
  isBiometricUnlockAvailable,
  unlockWithBiometrics,
} from '../p2p/webauthn.js'
import { fetchProviders, startOIDCFlow } from '../p2p/oidc.js'
import EmojiPicker from './EmojiPicker.jsx'
import '../styles/login.css'

const AUTH_URL = import.meta.env.VITE_AUTH_URL || ''

const ALLOW_IDENTITY_RESET = __ALLOW_IDENTITY_RESET__

/** Builds the PBKDF2 password string from emoji sequence + optional PIN. */
function buildPassphrase(emojis, pin) {
  const emojiPart = emojis.map((e) => e.name).join(' ')
  return pin ? `${emojiPart}:${pin}` : emojiPart
}

export default function LoginScreen({ onLogin }) {
  const [storedMeta] = useState(() => getStoredIdentityMeta())

  // For existing accounts: method is fixed by what was used at creation
  // For new accounts: the user picks with the toggle below
  const [createMethod, setCreateMethod] = useState('passphrase')

  // The effective method for the current UI:
  // - unlock: always respect the stored method
  // - create: use createMethod toggle
  const isMethodA = storedMeta ? storedMeta.method === 'passphrase' : createMethod === 'passphrase'

  const hasBiometric = storedMeta && hasBiometricUnlock()
  const [mode, setMode] = useState(() => (hasBiometric ? 'biometric' : 'identity'))
  const [biometricAvailable, setBiometricAvailable] = useState(false)

  useEffect(() => {
    if (hasBiometric) isBiometricUnlockAvailable().then(setBiometricAvailable)
  }, [hasBiometric])

  // ── IDP providers ────────────────────────────────────────────────────────────
  const [idpProviders, setIdpProviders] = useState([])
  const [idpLoading, setIdpLoading] = useState(false)

  useEffect(() => {
    if (!AUTH_URL) return
    fetchProviders(AUTH_URL).then(setIdpProviders)
  }, [])

  async function handleIdpLogin(provider) {
    setIdpLoading(true)
    try {
      await startOIDCFlow(provider, AUTH_URL)
      // startOIDCFlow redirects — execution stops here
    } catch (err) {
      setError('Sign in failed: ' + err.message)
      setIdpLoading(false)
    }
  }

  // ── Shared fields ───────────────────────────────────────────────────────────
  const [handle, setHandle] = useState(storedMeta?.handle || '')
  const [displayName, setDisplayName] = useState(() => generateUsername())
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const normHandle = handle.toLowerCase().trim()
  const isUnlock = storedMeta && storedMeta.handle === normHandle
  const isCreate = !isUnlock

  // ── Method B state (emoji picker) ───────────────────────────────────────────
  const [selectedEmojis, setSelectedEmojis] = useState([])
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [showPin, setShowPin] = useState(false)

  // ── Method A state (legacy text passphrase) ─────────────────────────────────
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  // ── canSubmit ───────────────────────────────────────────────────────────────
  const canSubmit = (() => {
    if (!normHandle) return false
    if (isMethodA) {
      const s = passphraseStrength(passphrase)
      const mismatch = isCreate && confirm && passphrase !== confirm
      return (
        passphrase.length > 0 && !mismatch && (isUnlock || (s.score >= 3 && passphrase === confirm))
      )
    }
    // Method B
    if (selectedEmojis.length < 6) return false
    if (isCreate && pin && (pin.length < 4 || pin !== confirmPin)) return false
    if (isUnlock && storedMeta?.hasPIN && !pin) return false
    return true
  })()

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSubmit || loading) return
    setLoading(true)
    setError('')
    try {
      const pw = isMethodA ? passphrase : buildPassphrase(selectedEmojis, pin)
      const opts = isMethodA ? { method: 'passphrase' } : { method: 'emoji', hasPIN: !!pin }
      const { isNewAccount } = await deriveIdentityA(handle, pw, opts)
      if (isNewAccount) setUsername(displayName.trim() || generateUsername())
      onLogin()
    } catch (err) {
      const msg =
        err.message === 'wrong-passphrase'
          ? isMethodA
            ? 'Wrong passphrase.'
            : 'Wrong emoji sequence or PIN.'
          : 'Unexpected error.'
      setError(msg)
      console.error('[login]', err)
      setLoading(false)
    }
  }

  function handleGuestSubmit(e) {
    e.preventDefault()
    createGuestIdentity(displayName.trim() || generateUsername())
    onLogin()
  }

  async function handleBiometricUnlock() {
    setLoading(true)
    setError('')
    try {
      const { handle, passphrase } = await unlockWithBiometrics()
      await deriveIdentityA(handle, passphrase)
      onLogin()
    } catch (err) {
      if (err.message !== 'cancelled') {
        setError('Biometric unlock failed. Use your passphrase instead.')
      }
      setLoading(false)
    }
  }

  function handleReset() {
    localStorage.removeItem('p2p-chat:identity')
    localStorage.removeItem('p2p-chat:biometric')
    window.location.reload()
  }

  // ── Render: biometric mode ──────────────────────────────────────────────────
  if (mode === 'biometric') {
    return (
      <div className="login-screen">
        <div className="login-card">
          <img src="/icons/icon.svg" alt="Pipol" className="login-logo" />
          <h1 className="login-title">Pipol</h1>
          <p className="login-subtitle">Welcome back, {storedMeta.username}</p>

          {error && <p className="login-error">{error}</p>}

          <button
            className="login-biometric-btn"
            onClick={handleBiometricUnlock}
            disabled={loading || !biometricAvailable}
          >
            {loading ? (
              <>
                <span className="login-spinner" />
                Unlocking…
              </>
            ) : (
              <>
                <FingerprintIcon />
                Unlock with biometrics
              </>
            )}
          </button>

          <p className="login-note">
            <button className="login-link" onClick={() => setMode('identity')}>
              Use passphrase instead
            </button>
          </p>
        </div>
      </div>
    )
  }

  // ── Render: guest mode ──────────────────────────────────────────────────────
  if (mode === 'guest') {
    return (
      <div className="login-screen">
        <div className="login-card">
          <img src="/icons/icon.svg" alt="Pipol" className="login-logo" />
          <h1 className="login-title">Pipol</h1>
          <p className="login-subtitle">Choose a name and jump in</p>

          <form onSubmit={handleGuestSubmit} className="login-form" noValidate>
            <div className="login-field">
              <label htmlFor="guestName">Display name</label>
              <input
                id="guestName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How others will see you"
                autoComplete="nickname"
                maxLength={32}
                autoFocus
                spellCheck={false}
              />
            </div>
            <button type="submit" className="login-btn">
              Continue as guest
            </button>
          </form>

          <p className="login-note">
            Your identity exists only for this session.{' '}
            <button className="login-link" onClick={() => setMode('identity')}>
              Create a permanent identity instead
            </button>
          </p>
        </div>
      </div>
    )
  }

  // ── Render: identity mode ───────────────────────────────────────────────────
  return (
    <div className="login-screen login-screen--scroll">
      <div className="login-card login-card--wide">
        <img src="/icons/icon.svg" alt="Pipol" className="login-logo" />
        <h1 className="login-title">Pipol</h1>
        <p className="login-subtitle">
          {isUnlock ? `Welcome back, ${storedMeta.username}` : 'Create or restore your identity'}
        </p>

        <form onSubmit={handleSubmit} className="login-form" noValidate>
          {/* Handle */}
          <div className="login-field">
            <label htmlFor="handle">Handle</label>
            <input
              id="handle"
              type="text"
              value={handle}
              onChange={(e) => {
                setHandle(e.target.value)
                setError('')
                // Reset sequence when handle changes (different user = different identity)
                setSelectedEmojis([])
                setPin('')
                setConfirmPin('')
                setPassphrase('')
                setConfirm('')
              }}
              placeholder="email, username, or any stable ID"
              autoComplete="username"
              autoFocus={!storedMeta?.handle}
              disabled={loading}
              spellCheck={false}
            />
          </div>

          {/* ── Method selector (new accounts only) ── */}
          {isCreate && (
            <div className="login-method-selector">
              <button
                type="button"
                className={`login-method-btn${isMethodA ? ' login-method-btn--active' : ''}`}
                onClick={() => {
                  setCreateMethod('passphrase')
                  setSelectedEmojis([])
                  setPin('')
                  setConfirmPin('')
                  setError('')
                }}
              >
                Text passphrase
              </button>
              <button
                type="button"
                className={`login-method-btn${!isMethodA ? ' login-method-btn--active' : ''}`}
                onClick={() => {
                  setCreateMethod('emoji')
                  setPassphrase('')
                  setConfirm('')
                  setError('')
                }}
              >
                Emoji sequence
              </button>
            </div>
          )}

          {/* ── Method B: emoji picker ── */}
          {!isMethodA && (
            <>
              <div className="login-field">
                <label>{isUnlock ? 'Your emoji sequence' : 'Choose 6 emoji as your key'}</label>
                <EmojiPicker value={selectedEmojis} onChange={setSelectedEmojis} maxCount={6} />
              </div>

              <div className="login-field">
                <label htmlFor="pin">
                  PIN{' '}
                  <span className="field-hint">
                    {isUnlock
                      ? storedMeta?.hasPIN
                        ? '(required)'
                        : '(not set — leave empty)'
                      : '(optional, 4–8 digits)'}
                  </span>
                </label>
                <div className="input-wrap">
                  <input
                    id="pin"
                    type={showPin ? 'text' : 'password'}
                    inputMode="numeric"
                    value={pin}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 8)
                      setPin(v)
                      setError('')
                    }}
                    placeholder={isUnlock && storedMeta?.hasPIN ? '••••' : 'optional'}
                    autoComplete={isCreate ? 'new-password' : 'current-password'}
                    disabled={loading}
                    maxLength={8}
                  />
                  <button
                    type="button"
                    className="reveal-btn"
                    onClick={() => setShowPin((v) => !v)}
                    tabIndex={-1}
                    aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                  >
                    {showPin ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              {isCreate && pin.length > 0 && (
                <div className="login-field">
                  <label htmlFor="confirmPin">Confirm PIN</label>
                  <input
                    id="confirmPin"
                    type="password"
                    inputMode="numeric"
                    value={confirmPin}
                    onChange={(e) =>
                      setConfirmPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))
                    }
                    placeholder="••••"
                    autoComplete="new-password"
                    disabled={loading}
                    maxLength={8}
                  />
                  {confirmPin && pin !== confirmPin && (
                    <span className="field-hint field-hint--error">PINs do not match</span>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Method A: legacy text passphrase ── */}
          {isMethodA && (
            <>
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
                    autoFocus={!!storedMeta?.handle}
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
                {isCreate &&
                  passphrase &&
                  (() => {
                    const s = passphraseStrength(passphrase)
                    return (
                      <>
                        <div className="strength-bar" aria-label={`Strength: ${s.label}`}>
                          <div
                            className={`strength-fill strength-${s.key}`}
                            style={{ width: `${(s.score / 4) * 100}%` }}
                          />
                          <span className="strength-text">{s.label}</span>
                          {s.score < 3 && (
                            <span className="strength-count">{s.score} / 3 to unlock</span>
                          )}
                        </div>
                        {s.score < 3 && (
                          <ul className="strength-hints">
                            <li className="hints-header">Complete any 3 to continue:</li>
                            {s.criteria.map((c) => (
                              <li key={c.label} className={c.met ? 'hint-met' : 'hint-unmet'}>
                                {c.met ? '✓' : '○'} {c.label}
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )
                  })()}
              </div>

              {isCreate && (
                <div className="login-field">
                  <label htmlFor="confirmPassphrase">Confirm passphrase</label>
                  <div className="input-wrap">
                    <input
                      id="confirmPassphrase"
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
                  {confirm && passphrase !== confirm && (
                    <span className="field-hint field-hint--error">Passphrases do not match</span>
                  )}
                </div>
              )}
            </>
          )}

          {/* Display name (new accounts only) */}
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

        {isCreate && isMethodA && (
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

        {idpProviders.length > 0 && (
          <>
            <div className="login-divider">
              <span>or sign in with</span>
            </div>
            <div className="login-idp-list">
              {idpProviders.map((provider) => (
                <button
                  key={provider.id}
                  className="login-idp-btn"
                  onClick={() => handleIdpLogin(provider)}
                  disabled={idpLoading}
                >
                  {provider.icon && <img src={provider.icon} alt="" className="login-idp-icon" />}
                  {provider.name}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="login-divider">
          <span>or</span>
        </div>

        <button className="login-guest-btn" onClick={() => setMode('guest')}>
          Continue as guest
        </button>

        {ALLOW_IDENTITY_RESET && isUnlock && (
          <button className="login-reset-btn" onClick={handleReset}>
            Create new identity
          </button>
        )}
      </div>
    </div>
  )
}

// ── Passphrase strength (method A only) ──────────────────────────────────────

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

// ── Icons ────────────────────────────────────────────────────────────────────

function FingerprintIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 17c1 .5 2.5 1 4.5 1a7.98 7.98 0 0 0 5-1.76" />
      <path d="M2 12a10 10 0 0 0 3.33 7.41" />
      <path d="M20 12c0 3.17-.23 5.17-.5 6" />
      <path d="M7 16.46c.26.2.76.5 1.5.5 2 0 3.5-1.5 3.5-4" />
      <path d="M7 13a5 5 0 0 1 5-5" />
      <path d="M22 12c0 2-.5 4-1.5 5.5" />
    </svg>
  )
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
