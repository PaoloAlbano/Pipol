import { useState, useEffect, useRef } from 'react'
import '../styles/create-channel-modal.css'

/**
 * Modal for creating a new channel.
 * @param {function} onCreated  Called with the validated channel name string
 * @param {function} onClose    Called when the modal is dismissed without creating
 */
export default function CreateChannelModal({ onCreated, onClose }) {
  const [name, setName] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const normalized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  const isValid = normalized.length >= 1 && normalized.length <= 80

  function handleSubmit(e) {
    e.preventDefault()
    if (!isValid) return
    onCreated(normalized)
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Create channel">
      <div className="ccm" onClick={(e) => e.stopPropagation()}>
        <header className="ccm__header">
          <h2 className="ccm__title">Create a channel</h2>
          <button className="ccm__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <p className="ccm__hint">Channels are where conversations happen. Use a name that&apos;s easy to find.</p>

        <form onSubmit={handleSubmit} className="ccm__form">
          <label className="ccm__label" htmlFor="ch-name-input">
            Channel name
          </label>
          <div className="ccm__input-wrap">
            <span className="ccm__hash">#</span>
            <input
              id="ch-name-input"
              ref={inputRef}
              className="ccm__input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. design"
              maxLength={80}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {normalized && name !== normalized && (
            <p className="ccm__normalized">
              Will be created as: <strong>#{normalized}</strong>
            </p>
          )}

          <div className="ccm__actions">
            <button type="button" className="ccm__btn ccm__btn--cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="ccm__btn ccm__btn--create" disabled={!isValid}>
              Create channel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
