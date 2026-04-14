import React from 'react'
import '../styles/channel-header.css'

/**
 * ChannelHeader — 48px top bar for the active channel.
 *
 * Shows: channel prefix + name | action buttons.
 *
 * @param {string}   channelName
 * @param {boolean}  [isPrivate=false]     Shows lock icon instead of #
 * @param {boolean}  [callActive=false]    Video call in progress
 * @param {function} [onStartCall]
 * @param {function} [onSearch]
 */
export default function ChannelHeader({ channelName, isPrivate = false, callActive = false, onStartCall, onSearch }) {
  return (
    <div className="channel-header">
      {/* Prefix */}
      <span className="channel-header__prefix" aria-hidden="true">
        {isPrivate ? '🔒' : '›'}
      </span>

      {/* Channel name */}
      <span className="channel-header__name">{channelName}</span>

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
