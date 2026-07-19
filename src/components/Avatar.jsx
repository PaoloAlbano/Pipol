import React from 'react'

/**
 * Avatar — identicon circle derived from a user's public key.
 *
 * Color: hue from first 4 hex chars of pubkey → HSL
 * Initials: first letter of each word in username (max 2)
 *
 * @param {Uint8Array|string} pubkey    Raw bytes or hex string
 * @param {string}            username
 * @param {'sm'|'md'|'lg'|'xl'} [size='md']
 * @param {'online'|'away'|'offline'|null} [status]
 * @param {string}            [className]
 * @param {function}          [onClick]
 */
export default function Avatar({ pubkey, username = '?', size = 'md', status = null, className = '', onClick }) {
  const { color, initials } = getAvatarVisuals(pubkey, username)
  const { px, fontSize, dotSize } = SIZE_MAP[size] ?? SIZE_MAP.md

  const style = {
    width: px,
    height: px,
    minWidth: px,
    borderRadius: '50%',
    background: color,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize,
    fontWeight: 700,
    color: '#fff',
    fontFamily: 'var(--font-sans)',
    position: 'relative',
    flexShrink: 0,
    cursor: onClick ? 'pointer' : 'default',
    userSelect: 'none',
  }

  return (
    <div
      style={style}
      className={className}
      onClick={onClick}
      aria-label={username}
      role={onClick ? 'button' : undefined}
    >
      {initials}
      {status && <StatusDot status={status} size={dotSize} />}
    </div>
  )
}

// ── StatusDot ─────────────────────────────────────────────────────────────────

function StatusDot({ status, size }) {
  const COLOR = {
    online: 'var(--success)',
    away: 'var(--warning)',
    offline: 'var(--text-faint)',
    dnd: 'var(--danger)',
  }

  const style = {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: size,
    height: size,
    borderRadius: '50%',
    background: COLOR[status] ?? COLOR.offline,
    border: '2px solid var(--surface)',
  }

  return <span style={style} aria-label={status} />
}

// ── Size map ──────────────────────────────────────────────────────────────────

const SIZE_MAP = {
  sm: { px: 20, fontSize: '9px', dotSize: 7 },
  md: { px: 28, fontSize: '11px', dotSize: 8 },
  lg: { px: 32, fontSize: '13px', dotSize: 9 },
  xl: { px: 40, fontSize: '16px', dotSize: 11 },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derives a consistent color and initials from pubkey + username.
 * Exported so other components (ChannelSidebar, UserCard, etc.) can reuse it
 * without importing the full Avatar component.
 *
 * @param {Uint8Array|string|null} pubkey
 * @param {string} username
 * @returns {{ color: string, initials: string }}
 */
export function getAvatarVisuals(pubkey, username = '?') {
  let hex = '0000'
  if (pubkey) {
    if (typeof pubkey === 'string') {
      hex = pubkey
    } else if (pubkey instanceof Uint8Array || ArrayBuffer.isView(pubkey)) {
      hex = Array.from(pubkey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
  }

  const hue = parseInt(hex.slice(0, 4), 16) % 360
  const color = `hsl(${hue}, 50%, 42%)`

  const words = (username || '?').split(/[-_ ]+/)
  const initials = words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  return { color, initials }
}
