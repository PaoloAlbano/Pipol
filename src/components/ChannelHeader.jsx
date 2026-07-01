import React, { useState } from 'react'
import '../styles/channel-header.css'

/**
 * ChannelHeader — 48px top bar for the active channel.
 *
 * Shows: channel prefix + name | optional topic | action buttons.
 *
 * @param {string}   channelName
 * @param {boolean}  [isPrivate=false]     Shows lock icon instead of #
 * @param {boolean}  [callActive=false]    Video call in progress
 * @param {string}   [topic]              Optional channel description
 * @param {function} [onSetTopic]         If provided, shows edit button for topic
 * @param {function} [onStartCall]
 * @param {function} [onSearch]
 */
export default function ChannelHeader({
  channelName,
  isPrivate = false,
  callActive = false,
  topic,
  onSetTopic,
  onStartCall,
  onSearch,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function startEdit() {
    setDraft(topic ?? '')
    setEditing(true)
  }

  function commitEdit() {
    onSetTopic?.(draft.trim())
    setEditing(false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') commitEdit()
    if (e.key === 'Escape') setEditing(false)
  }

  return (
    <div className="channel-header">
      {/* Prefix */}
      <span className="channel-header__prefix" aria-hidden="true">
        {isPrivate ? '🔒' : '›'}
      </span>

      {/* Channel name + topic */}
      <div className="channel-header__title">
        <span className="channel-header__name">{channelName}</span>
        {editing ? (
          <input
            className="channel-header__topic-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={handleKeyDown}
            placeholder="Add a description…"
            maxLength={120}
            autoFocus
          />
        ) : (
          topic && <span className="channel-header__topic">{topic}</span>
        )}
      </div>

      {/* Action buttons */}
      <div className="channel-header__actions" role="toolbar" aria-label="Azioni canale">
        {onSetTopic && !editing && (
          <button
            className="channel-header__btn"
            onClick={startEdit}
            title={topic ? 'Edit description' : 'Add description'}
            aria-label={topic ? 'Edit channel description' : 'Add channel description'}
          >
            ✏️
          </button>
        )}

        {onSearch && (
          <button className="channel-header__btn" onClick={onSearch} title="Search in channel" aria-label="Search">
            🔍
          </button>
        )}

        {onStartCall && (
          <button
            className={['channel-header__btn', callActive ? 'channel-header__btn--call-active' : ''].join(' ')}
            onClick={onStartCall}
            title={callActive ? 'Video call in progress' : 'Start video call'}
            aria-label={callActive ? 'Video call in progress' : 'Start video call'}
            aria-pressed={callActive}
          >
            📹
          </button>
        )}
      </div>
    </div>
  )
}
