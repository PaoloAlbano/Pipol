import React, { useState, useRef, useEffect } from 'react'
import { getAvatarVisuals } from './Avatar.jsx'
import '../styles/sidebar.css'

/**
 * ChannelSidebar — 220px channel navigation panel.
 *
 * Sections:
 *   - Workspace header (name + online count)
 *   - Channels (append-only list, + button to create)
 *   - Direct Messages (peers seen in workspace swarm)
 *   - User card (bottom: avatar, username, mic/deaf toggles)
 *
 * @param {object}   workspace             Current workspace object
 * @param {object[]} channels              [{ name, topic, unread }]
 * @param {object[]} peers                 Online peers [{ id, username, status }]
 * @param {object[]} dmPeers              Known peers for DM [{ pubkey, username, online }]
 * @param {string}   activeChannelName
 * @param {object}   identity             { publicKey, username }
 * @param {boolean}  audioMuted
 * @param {function} onSelectChannel(name)
 * @param {function} onCreateChannel       Opens create-channel flow
 * @param {function} onSelectDM(pubkey)
 * @param {function} onToggleMute
 * @param {function} onOpenSettings
 * @param {function} onInvite               Opens share-invite modal (admin only)
 * @param {function} onWorkspaceHeaderClick  Opens workspace dropdown/settings
 */
export default function ChannelSidebar({
  workspace,
  channels = [],
  peers = [],
  dmPeers = [],
  activeChannelName,
  identity,
  audioMuted = false,
  isAdmin = false,
  onSelectChannel,
  onCreateChannel,
  onInvite,
  onSelectDM,
  onToggleMute,
  onOpenSettings,
  // injected by WorkspaceLayout on mobile
  closeMobileSidebar,
}) {
  const [channelsCollapsed, setChannelsCollapsed] = useState(false)
  const [dmsCollapsed, setDmsCollapsed] = useState(false)
  const [channelSearch, setChannelSearch] = useState('')
  const [wsMenuOpen, setWsMenuOpen] = useState(false)
  const wsMenuRef = useRef(null)

  // Close workspace dropdown on outside click
  useEffect(() => {
    if (!wsMenuOpen) return
    function onOutsideClick(e) {
      if (!wsMenuRef.current?.contains(e.target)) setWsMenuOpen(false)
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
  }, [wsMenuOpen])

  const onlineCount = peers.filter((p) => p.status !== 'offline').length

  const filteredChannels = channelSearch.trim()
    ? channels.filter((ch) => ch.name.includes(channelSearch.trim().toLowerCase()))
    : channels

  return (
    <div className="sidebar">
      {/* Mobile-only close button */}
      {closeMobileSidebar && (
        <button className="sidebar__mobile-close" onClick={closeMobileSidebar} aria-label="Close sidebar">
          ✕
        </button>
      )}
      {/* Workspace header */}
      <div className="sidebar__workspace-header-wrap" ref={wsMenuRef}>
        <div
          className={['sidebar__workspace-header', isAdmin ? 'sidebar__workspace-header--clickable' : '']
            .filter(Boolean)
            .join(' ')}
          onClick={isAdmin ? () => setWsMenuOpen((v) => !v) : undefined}
          role={isAdmin ? 'button' : undefined}
          tabIndex={isAdmin ? 0 : undefined}
          onKeyDown={isAdmin ? (e) => e.key === 'Enter' && setWsMenuOpen((v) => !v) : undefined}
          aria-label={`Workspace: ${workspace?.name}`}
          aria-haspopup={isAdmin ? 'menu' : undefined}
          aria-expanded={isAdmin ? wsMenuOpen : undefined}
        >
          <span className="sidebar__workspace-name">{workspace?.name ?? 'Workspace'}</span>
          {onlineCount > 0 && <span className="sidebar__online-count">{onlineCount} online</span>}
          {isAdmin && (
            <span
              className={['sidebar__workspace-chevron', wsMenuOpen ? 'sidebar__workspace-chevron--open' : ''].join(' ')}
            >
              ▾
            </span>
          )}
        </div>

        {/* Workspace dropdown — invite link (admin only) */}
        {isAdmin && wsMenuOpen && (
          <div className="sidebar__ws-menu" role="menu">
            {onInvite && (
              <button
                className="sidebar__ws-menu-item"
                role="menuitem"
                onClick={() => {
                  setWsMenuOpen(false)
                  onInvite()
                }}
              >
                <span className="sidebar__ws-menu-icon">🔗</span>
                Copy invite link
              </button>
            )}
          </div>
        )}
      </div>

      {/* Channel search */}
      <div className="sidebar__search">
        <input
          className="sidebar__search-input"
          type="text"
          placeholder="Search channels…"
          value={channelSearch}
          onChange={(e) => setChannelSearch(e.target.value)}
          aria-label="Search channels"
        />
        {channelSearch && (
          <button className="sidebar__search-clear" onClick={() => setChannelSearch('')} aria-label="Clear search">
            ✕
          </button>
        )}
      </div>

      {/* Scrollable section list */}
      <div className="sidebar__scroll">
        {/* ── Channels ── */}
        <div className="sidebar__section">
          <div
            className="sidebar__section-header"
            onClick={() => setChannelsCollapsed((v) => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setChannelsCollapsed((v) => !v)}
            aria-expanded={!channelsCollapsed}
          >
            <span
              className={[
                'sidebar__section-chevron',
                channelsCollapsed ? 'sidebar__section-chevron--collapsed' : '',
              ].join(' ')}
            >
              ▾
            </span>
            <span className="sidebar__section-title">Channels</span>
            <button
              className="sidebar__section-add"
              onClick={(e) => {
                e.stopPropagation()
                onCreateChannel?.()
              }}
              title="Create channel"
              aria-label="Create channel"
            >
              +
            </button>
          </div>

          {!channelsCollapsed &&
            filteredChannels.map((ch) => (
              <ChannelItem
                key={ch.name}
                channel={ch}
                active={ch.name === activeChannelName}
                onSelect={() => {
                  onSelectChannel?.(ch.name)
                  closeMobileSidebar?.()
                }}
              />
            ))}
        </div>

        {/* ── Direct Messages ── */}
        {dmPeers.length > 0 && (
          <div className="sidebar__section">
            <div
              className="sidebar__section-header"
              onClick={() => setDmsCollapsed((v) => !v)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setDmsCollapsed((v) => !v)}
              aria-expanded={!dmsCollapsed}
            >
              <span
                className={['sidebar__section-chevron', dmsCollapsed ? 'sidebar__section-chevron--collapsed' : ''].join(
                  ' '
                )}
              >
                ▾
              </span>
              <span className="sidebar__section-title">Direct Messages</span>
            </div>

            {!dmsCollapsed &&
              dmPeers.map((peer) => (
                <DMItem
                  key={peer.pubkey}
                  peer={peer}
                  active={activeChannelName === `dm:${peer.pubkey}`}
                  onSelect={() => {
                    onSelectDM?.(peer.pubkey)
                    closeMobileSidebar?.()
                  }}
                />
              ))}
          </div>
        )}
      </div>

      {/* User card */}
      <UserCard
        identity={identity}
        audioMuted={audioMuted}
        onToggleMute={onToggleMute}
        onOpenSettings={onOpenSettings}
      />
    </div>
  )
}

// ── ChannelItem ───────────────────────────────────────────────────────────────

function ChannelItem({ channel, active, onSelect }) {
  const { name, unread = 0 } = channel

  return (
    <div
      className={[
        'sidebar__item',
        active ? 'sidebar__item--active' : '',
        unread > 0 && !active ? 'sidebar__item--unread' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      aria-current={active ? 'page' : undefined}
      aria-label={`Canale ${name}${unread > 0 ? `, ${unread} non letti` : ''}`}
    >
      <span className="sidebar__item-prefix">›</span>
      <span className="sidebar__item-name">{name}</span>
      {unread > 0 &&
        !active &&
        (unread > 9 ? (
          <span className="sidebar__item-badge">9+</span>
        ) : (
          <span className="sidebar__item-dot" aria-hidden="true" />
        ))}
    </div>
  )
}

// ── DMItem ────────────────────────────────────────────────────────────────────

function DMItem({ peer, active, onSelect }) {
  const status = peer.online ? 'online' : 'offline'

  return (
    <div
      className={[
        'sidebar__item',
        active ? 'sidebar__item--active' : '',
        peer.unread > 0 && !active ? 'sidebar__item--unread' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      aria-current={active ? 'page' : undefined}
      aria-label={`Direct message with ${peer.username}`}
    >
      <span className={`sidebar__presence sidebar__presence--${status}`} aria-label={status} />
      <span className="sidebar__item-name">{peer.username}</span>
      {peer.unread > 0 && !active && (
        <span className="sidebar__item-badge">{peer.unread > 9 ? '9+' : peer.unread}</span>
      )}
    </div>
  )
}

// ── UserCard ──────────────────────────────────────────────────────────────────

function UserCard({ identity, audioMuted, onToggleMute, onOpenSettings }) {
  if (!identity) return null

  const { color, initials } = getAvatarVisuals(identity.publicKey, identity.username)

  return (
    <div className="sidebar__user-card">
      <div
        className="sidebar__user-card-avatar"
        style={{ background: color }}
        onClick={onOpenSettings}
        title="Open profile"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onOpenSettings?.()}
        aria-label="Open profile settings"
      >
        {initials}
      </div>

      <div className="sidebar__user-card-info">
        <div className="sidebar__user-card-name">{identity.username}</div>
        <div className="sidebar__user-card-status">{audioMuted ? 'Microphone muted' : 'Online'}</div>
      </div>

      <div className="sidebar__user-card-actions">
        {onToggleMute && (
          <button
            className={['sidebar__user-card-btn', audioMuted ? 'sidebar__user-card-btn--muted' : ''].join(' ')}
            onClick={onToggleMute}
            title={audioMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-label={audioMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={audioMuted}
          >
            {audioMuted ? '🔇' : '🎙️'}
          </button>
        )}

        <button className="sidebar__user-card-btn" onClick={onOpenSettings} title="Settings" aria-label="Open settings">
          ⚙
        </button>
      </div>
    </div>
  )
}
