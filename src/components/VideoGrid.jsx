import React, { useRef, useEffect } from 'react'
import '../styles/video.css'

/**
 * Responsive video grid with two layout modes:
 *   'grid'      — symmetric grid, all peers equal size
 *   'spotlight' — one large tile in center, others in a sidebar column on the right
 *
 * A peer sharing their screen has two tiles: their camera and their screen.
 * In spotlight the screen takes the main slot while the camera moves to the sidebar.
 */
export default function VideoGrid({
  localStream,
  remoteStreams,
  remoteScreens = {},
  peers,
  localUsername,
  showStats,
  peerStats,
  layout,
  spotlightPeerId,
  onLayoutChange,
  onSpotlightChange,
  mirrorVideo = true,
}) {
  const peerById = Object.fromEntries(peers.map((p) => [p.id, p]))
  const remoteEntries = Object.entries(remoteStreams)
  const count = remoteEntries.length

  // Camera tiles first, then one extra tile per active screen share
  const tiles = [
    ...remoteEntries.map(([peerId, stream]) => ({ key: peerId, peerId, stream, screen: false })),
    ...Object.entries(remoteScreens).map(([peerId, stream]) => ({
      key: `${peerId}:screen`,
      peerId,
      stream,
      screen: true,
    })),
  ]

  // Resolve which peer is in the spotlight
  const resolvedSpotlightId =
    spotlightPeerId && remoteStreams[spotlightPeerId] ? spotlightPeerId : (remoteEntries[0]?.[0] ?? null)

  const isSpotlight = layout === 'spotlight' && count > 0

  function getLabel(peerId, screen = false) {
    const name = peerById[peerId]?.username ?? peerId.slice(0, 8)
    return screen ? `${name} (screen)` : name
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
    const mainTile =
      tiles.find((t) => t.peerId === resolvedSpotlightId && t.screen) ??
      tiles.find((t) => t.peerId === resolvedSpotlightId && !t.screen)
    const sidebarTiles = tiles.filter((t) => t !== mainTile)

    return (
      <div className="video-container video-container--spotlight">
        {layoutToggle}
        <div className="video-spotlight-main">
          <VideoTile
            stream={mainTile.stream}
            label={getLabel(mainTile.peerId, mainTile.screen)}
            stats={mainTile.screen ? null : getStats(mainTile.peerId)}
            contain={mainTile.screen}
          />
        </div>
        <div className="video-spotlight-sidebar">
          {sidebarTiles.map((t) => (
            <VideoTile
              key={t.key}
              stream={t.stream}
              label={getLabel(t.peerId, t.screen)}
              stats={t.screen ? null : getStats(t.peerId)}
              contain={t.screen}
              sidebar
              onClick={() => onSpotlightChange(t.peerId)}
            />
          ))}
          <VideoTile
            key="__local__"
            stream={localStream}
            label={`${localUsername} (you)`}
            muted
            mirror={mirrorVideo}
            sidebar
          />
        </div>
      </div>
    )
  }

  // ── Grid layout ────────────────────────────────────────────────────────────
  const { cols, rows } = getGridDimensions(tiles.length)

  return (
    <div className="video-container">
      {layoutToggle}
      <div className="video-grid" style={{ '--cols': cols, '--rows': rows }}>
        {count === 0 ? (
          <VideoTile stream={localStream} label={`${localUsername} (you)`} muted mirror={mirrorVideo} />
        ) : (
          tiles.map((t) => (
            <VideoTile
              key={t.key}
              stream={t.stream}
              label={getLabel(t.peerId, t.screen)}
              stats={t.screen ? null : getStats(t.peerId)}
              contain={t.screen}
            />
          ))
        )}
      </div>

      {count > 0 && (
        <div className="video-self-preview">
          <VideoTile stream={localStream} label="You" muted small mirror={mirrorVideo} />
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
  mirror = false,
  contain = false,
}) {
  const videoRef = useRef(null)

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
      // Set via DOM API — React filters this attribute in JSX
      if (!muted) {
        videoRef.current.setAttribute('autopictureinpicture', '')
      } else {
        videoRef.current.removeAttribute('autopictureinpicture')
      }
    }
  }, [stream, muted])

  return (
    <div
      className={`video-tile ${small ? 'video-tile--small' : ''} ${sidebar ? 'video-tile--sidebar' : ''} ${onClick ? 'video-tile--clickable' : ''}`}
      onClick={onClick}
    >
      {stream ? (
        <video
          ref={videoRef}
          className={`video-element${mirror ? ' video-element--mirror' : ''}${contain ? ' video-element--contain' : ''}`}
          autoPlay
          playsInline
          muted={muted}
        />
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
