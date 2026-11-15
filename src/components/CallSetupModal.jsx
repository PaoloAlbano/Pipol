import { useEffect, useRef, useState } from 'react'

/**
 * What to start the call with, asked before joining: the microphone and the camera, each on or off. What is left off
 * is not asked of the browser, and can be turned on during the call.
 *
 * @param {'start' | 'join'} mode
 * @param {string} [caller]  Who started the call (shown when joining)
 * @param {{ camera: boolean, microphone: boolean }} defaults
 * @param {(choice: { camera: boolean, microphone: boolean }) => void} onConfirm
 * @param {() => void} onCancel
 */
export default function CallSetupModal({ mode, caller, defaults, onConfirm, onCancel }) {
  const [microphone, setMicrophone] = useState(defaults.microphone)
  const [camera, setCamera] = useState(defaults.camera)
  const confirmRef = useRef(null)

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  const starting = mode === 'start'
  const title = starting ? 'Start a call' : caller ? `Join ${caller}'s call` : 'Join the call'

  return (
    <div
      className="call-modal-overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <div className="call-modal" role="dialog" aria-modal="true" aria-labelledby="call-setup-title">
        <div className="call-modal-icon">{camera ? '📹' : '🎧'}</div>
        <p className="call-modal-title" id="call-setup-title">
          {title}
        </p>

        <div className="call-setup-toggles">
          <Toggle label="Microphone" icon="🎙️" on={microphone} onChange={setMicrophone} />
          <Toggle label="Camera" icon="📷" on={camera} onChange={setCamera} />
        </div>

        <div className="call-modal-actions">
          <button ref={confirmRef} className="btn btn-primary" onClick={() => onConfirm({ camera, microphone })}>
            {starting ? 'Start call' : 'Join now'}
          </button>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function Toggle({ label, icon, on, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`call-setup-toggle${on ? ' call-setup-toggle--on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="call-setup-toggle__label">{label}</span>
      <span className="call-setup-toggle__state">{on ? 'On' : 'Off'}</span>
    </button>
  )
}
