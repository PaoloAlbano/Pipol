/**
 * OIDCCallback.jsx
 * Rendered at /callback after the IDP redirects back.
 * Exchanges the authorization code for a serverSecret and derives the identity.
 */

import { useEffect, useState } from 'react'
import { handleOIDCCallback } from '../p2p/oidc.js'
import { deriveIdentityOIDC } from '../p2p/storage.js'

const ERROR_MESSAGES = {
  'missing-code': 'Invalid callback — no authorization code received.',
  'no-pending-session': 'Session expired. Please try signing in again.',
  'state-mismatch': 'Security check failed. Please try signing in again.',
  'token-exchange-failed': 'Could not complete sign-in with the identity provider.',
  'missing-id-token': 'Identity provider did not return a valid token.',
  'derive-failed': 'Auth server error. Please try again.',
  'key-version-retired': 'Your session key has been rotated. Please sign in again.',
  'key-version-changed': 'Account key changed. Please contact support.',
}

export default function OIDCCallback({ onLogin }) {
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function run() {
      try {
        const { serverSecret, keyVersion, provider } = await handleOIDCCallback()
        await deriveIdentityOIDC(serverSecret, keyVersion, provider.id)
        if (cancelled) return
        // Navigate to root before calling onLogin so App re-renders on '/'
        window.history.replaceState({}, '', '/')
        onLogin()
      } catch (err) {
        if (cancelled) return
        console.warn('[oidc] callback failed:', err.message)
        setError(err.message)
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [onLogin])

  if (error) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h2 className="login-title">Sign in failed</h2>
          <p className="login-error">
            {ERROR_MESSAGES[error] ?? 'An unexpected error occurred. Please try again.'}
          </p>
          <button
            className="login-btn"
            onClick={() => window.history.replaceState({}, '', '/') || window.location.reload()}
          >
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <p className="login-subtitle">Completing sign in…</p>
      </div>
    </div>
  )
}
