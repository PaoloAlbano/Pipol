import React, { useRef, useEffect } from 'react'
import '../styles/video.css'

/**
 * Responsive video grid with two layout modes:
 *   'grid'      — symmetric grid, all peers equal size
 *   'spotlight' — one large tile in center, others in a sidebar column on the right
 */
export default function VideoGrid({
  localStream,
  remoteStreams,
  peers,
  localUsername,
  showStats,
  peerStats,
  layout,
  spotlightPeerId,
  onLayoutChange,
  onSpotlightChange,
}) {
  const peerById = Object.fromEntries(peers.map((p) => [p.id, p]))
  const remoteEntries = Object.entries(remoteStreams)
  const count = remoteEntries.length

  // Resolve which peer is in the spotlight
  const resolvedSpotlightId =
    spotlightPeerId && remoteStreams[spotlightPeerId]
      ? spotlightPeerId
      : (remoteEntries[0]?.[0] ?? null)

  const isSpotlight = layout === 'spotlight' && count > 0

  function getLabel(peerId) {
    return peerById[peerId]?.username ?? peerId.slice(0, 8)
  }

  function getStats(peerId) {
    return showStats ? (peerStats?.[peerId] ?? null) : null
  }

  // ── Layout toggle button ───────────────────────────────────────────────────
  const layoutToggle = count > 0 && (
    <button
      className="video-layout-toggle"
      onClick={() => onLayoutChange(isSpotlight ? 'grid' : 'spotlight')}
      title={isSpotlight ? 'Switch to grid layout' : 'Switch to spotlight layout'}
    >
      {isSpotlight ? '⊞' : '⊡'}
    </button>
  )

  // ── Spotlight layout ───────────────────────────────────────────────────────
  if (isSpotlight && resolvedSpotlightId) {
    const sidebarEntries = [
      ...remoteEntries.filter(([id]) => id !== resolvedSpotlightId),
      ['__local__', localStream],
    ]

    return (
      <div className="video-container video-container--spotlight">
        {layoutToggle}
        <div className="video-spotlight-main">
          <VideoTile
            stream={remoteStreams[resolvedSpotlightId]}
            label={getLabel(resolvedSpotlightId)}
            stats={getStats(resolvedSpotlightId)}
          />
        </div>
        <div className="video-spotlight-sidebar">
          {sidebarEntries.map(([id, stream]) => (
            <VideoTile
              key={id}
              stream={stream}
              label={id === '__local__' ? `${localUsername} (you)` : getLabel(id)}
              muted={id === '__local__'}
              stats={id === '__local__' ? null : getStats(id)}
              sidebar
              onClick={id !== '__local__' ? () => onSpotlightChange(id) : undefined}
            />
          ))}
        </div>
      </div>
    )
  }

  // ── Grid layout ────────────────────────────────────────────────────────────
  const { cols, rows } = getGridDimensions(count)

  return (
    <div className="video-container">
      {layoutToggle}
      <div className="video-grid" style={{ '--cols': cols, '--rows': rows }}>
        {count === 0 ? (
          <VideoTile stream={localStream} label={`${localUsername} (you)`} muted />
        ) : (
          remoteEntries.map(([peerId, stream]) => (
            <VideoTile
              key={peerId}
              stream={stream}
              label={getLabel(peerId)}
              stats={getStats(peerId)}
            />
          ))
        )}
      </div>

      {count > 0 && (
        <div className="video-self-preview">
          <VideoTile stream={localStream} label="You" muted small />
        </div>
      )}
    </div>
  )
}

/**
 * Compute optimal grid columns/rows for N remote participants.
 *
 *  1  → 1×1
 *  2  → 1×2  (stacked)
 *  3–4 → 2×2
 *  5–6 → 2×3
 *  7–9 → 3×3
 *  10+ → ceil(sqrt)×ceil(sqrt)
 */
function getGridDimensions(count) {
  if (count <= 1) return { cols: 1, rows: 1 }
  if (count <= 2) return { cols: 1, rows: 2 }
  if (count <= 4) return { cols: 2, rows: 2 }
  if (count <= 6) return { cols: 2, rows: 3 }
  if (count <= 9) return { cols: 3, rows: 3 }
  const cols = Math.ceil(Math.sqrt(count))
  return { cols, rows: Math.ceil(count / cols) }
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1048576).toFixed(1)}MB`
}

function VideoTile({
  stream,
  label,
  muted = false,
  small = false,
  sidebar = false,
  stats = null,
  onClick,
}) {
  const videoRef = useRef(null)

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
    }
  }, [stream])

  return (
    <div
      className={`video-tile ${small ? 'video-tile--small' : ''} ${sidebar ? 'video-tile--sidebar' : ''} ${onClick ? 'video-tile--clickable' : ''}`}
      onClick={onClick}
    >
      {stream ? (
        <video ref={videoRef} className="video-element" autoPlay playsInline muted={muted} />
      ) : (
        <div className="video-placeholder">👤</div>
      )}
      <span className="video-label">{label}</span>
      {stats && (
        <div className="video-stats-badge">
          <span className="video-stats-path">
            {stats.localType} ↔ {stats.remoteType}
          </span>
          {stats.rtt != null && <span className="video-stats-rtt">{stats.rtt}ms</span>}
          {(stats.bytesSentPerSec != null || stats.bytesReceivedPerSec != null) && (
            <span className="video-stats-bytes">
              ↑{formatBytes(stats.bytesSentPerSec)}/s ↓{formatBytes(stats.bytesReceivedPerSec)}/s
            </span>
          )}
        </div>
      )}
    </div>
  )
}
