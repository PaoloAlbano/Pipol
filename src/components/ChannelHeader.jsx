import React, { useState, useRef, useEffect } from 'react'
import '../styles/channel-header.css'

/**
 * ChannelHeader — 48px top bar for the active channel.
 *
 * Shows: channel prefix + name | topic (inline editable) | action buttons.
 *
 * @param {string}   channelName
 * @param {string}   [topic]
 * @param {boolean}  [isPrivate=false]     Shows lock icon instead of #
 * @param {boolean}  [callActive=false]    Video call in progress
 * @param {boolean}  [rightPanelOpen]      Injected by WorkspaceLayout
 * @param {function} [toggleRightPanel]    Injected by WorkspaceLayout
 * @param {function} [onTopicChange(topic)]
 * @param {function} [onStartCall]
 * @param {function} [onSearch]
 */
export default function ChannelHeader({
  channelName,
  topic = '',
  isPrivate = false,
  callActive = false,
  onTopicChange,
  onStartCall,
  onSearch,
}) {
  const [editingTopic, setEditingTopic] = useState(false)
  const [topicDraft, setTopicDraft] = useState(topic)
  const inputRef = useRef(null)

  // Focus input when entering edit mode
  useEffect(() => {
    if (editingTopic) inputRef.current?.select()
  }, [editingTopic])

  function startEditing() {
    setTopicDraft(topic) // init draft from current prop
    setEditingTopic(true)
  }

  function commitTopic() {
    setEditingTopic(false)
    const trimmed = topicDraft.trim()
    if (trimmed !== topic) onTopicChange?.(trimmed)
  }

  function handleTopicKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitTopic()
    }
    if (e.key === 'Escape') {
      setEditingTopic(false)
      setTopicDraft(topic)
    }
  }

  return (
    <div className="channel-header">
      {/* Prefix */}
      <span className="channel-header__prefix" aria-hidden="true">
        {isPrivate ? '🔒' : '›'}
      </span>

      {/* Channel name */}
      <span className="channel-header__name">{channelName}</span>

      {/* Divider — only shown when there is a topic or edit is available */}
      <span className="channel-header__divider" aria-hidden="true" />

      {/* Topic */}
      {editingTopic ? (
        <input
          ref={inputRef}
          className="channel-header__topic-input"
          value={topicDraft}
          onChange={(e) => setTopicDraft(e.target.value)}
          onBlur={commitTopic}
          onKeyDown={handleTopicKeyDown}
          placeholder="Add a description…"
          maxLength={250}
          aria-label="Edit channel topic"
        />
      ) : (
        <span
          className={['channel-header__topic', !topic ? 'channel-header__topic--placeholder' : ''].join(' ')}
          onClick={() => startEditing()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && startEditing()}
          title={topic || 'Click to add a topic'}
          aria-label={topic ? `Topic: ${topic}` : 'Add topic'}
        >
          {topic || 'Add a topic…'}
        </span>
      )}

      {/* Action buttons */}
      <div className="channel-header__actions" role="toolbar" aria-label="Azioni canale">
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
