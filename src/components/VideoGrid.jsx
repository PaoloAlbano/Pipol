import React, { useRef, useEffect, useState } from 'react'
import { layoutGrid, spotlightGeometry, stripRects, cameraFit, initials, avatarHue } from './videoLayout.js'
import { useElementSize } from './useElementSize.js'
import { useSpeaking } from '../webrtc/useSpeaking.js'
import '../styles/video.css'

/**
 * The video area of a call, with two layouts:
 *   'grid'      — everybody (you included) in tiles of the same size, as big as the area allows
 *   'spotlight' — one big tile and a strip of thumbnails, at the side of a wide area and below a narrow one
 *
 * A peer sharing their screen has two tiles: their camera and their screen. In spotlight the screen takes the big
 * tile while the camera moves to the strip. Your own tile is always there, last, so nobody is covered by it.
 *
 * Tiles are placed with absolute positions computed from the real size of the area (see videoLayout.js).
 */

const PADDING = 6
const LOCAL_KEY = '__local__'
const MORE_KEY = '__more__'
// Thumbnails narrower than this are too small to carry the connection statistics
const STATS_MIN_WIDTH = 200

export default function VideoGrid({
  localStream,
  remoteStreams,
  remoteScreens = {},
  peers,
  localUsername,
  localVideoMuted = false,
  remoteVideoOff = {},
  callElapsed = '',
  showStats,
  peerStats,
  layout,
  spotlightPeerId,
  onLayoutChange,
  onSpotlightChange,
  mirrorVideo = true,
}) {
  const stageRef = useRef(null)
  const size = useElementSize(stageRef)
  const area = {
    width: Math.max(0, size.width - 2 * PADDING),
    height: Math.max(0, size.height - 2 * PADDING),
  }

  const peerById = Object.fromEntries(peers.map((p) => [p.id, p]))
  const remoteEntries = Object.entries(remoteStreams)
  const count = remoteEntries.length

  function nameOf(peerId) {
    return peerById[peerId]?.username ?? peerId.slice(0, 8)
  }

  // Camera tiles first, then one extra tile per active screen share, then yours
  const tiles = [
    ...remoteEntries.map(([peerId, stream]) => ({
      key: peerId,
      peerId,
      stream,
      screen: false,
      videoOff: Boolean(remoteVideoOff[peerId]),
      name: nameOf(peerId),
      label: nameOf(peerId),
    })),
    ...Object.entries(remoteScreens).map(([peerId, stream]) => ({
      key: `${peerId}:screen`,
      peerId,
      stream,
      screen: true,
      name: nameOf(peerId),
      label: `${nameOf(peerId)} (screen)`,
    })),
  ]
  const selfTile = {
    key: LOCAL_KEY,
    local: true,
    stream: localStream,
    name: localUsername,
    label: `${localUsername} (you)`,
  }

  // Resolve which peer is in the spotlight
  const resolvedSpotlightId =
    spotlightPeerId && remoteStreams[spotlightPeerId] ? spotlightPeerId : (remoteEntries[0]?.[0] ?? null)
  const isSpotlight = layout === 'spotlight' && count > 0 && resolvedSpotlightId !== null

  // ── Where everything goes ──────────────────────────────────────────────────
  /** @type {{ key: string, tile: object, rect: object, role: 'grid'|'main'|'strip'|'more', hidden?: number }[]} */
  const placed = []
  const place = (rect) => ({ ...rect, x: rect.x + PADDING, y: rect.y + PADDING })

  if (isSpotlight) {
    const mainTile =
      tiles.find((t) => t.peerId === resolvedSpotlightId && t.screen) ??
      tiles.find((t) => t.peerId === resolvedSpotlightId && !t.screen)
    const others = tiles.filter((t) => t !== mainTile)
    const geometry = spotlightGeometry(area.width, area.height)

    // More thumbnails than places: show what fits and a "+N" tile for the rest. You are always shown.
    let strip = [...others, selfTile]
    let hidden = 0
    if (strip.length > geometry.slots) {
      const keep = Math.max(0, geometry.slots - 2)
      hidden = others.length - keep
      strip = [...others.slice(0, keep), { key: MORE_KEY, more: true }, selfTile]
    }
    const rects = stripRects(geometry, strip.length, area.width, area.height)

    placed.push({ key: mainTile.key, tile: mainTile, rect: place(geometry.main), role: 'main' })
    strip.forEach((tile, i) => {
      placed.push({
        key: tile.key,
        tile,
        rect: place(rects[i]),
        role: tile.more ? 'more' : 'strip',
        hidden,
      })
    })
  } else {
    const all = count === 0 ? [selfTile] : [...tiles, selfTile]
    const grid = layoutGrid(all.length, area.width, area.height)
    all.forEach((tile, i) => placed.push({ key: tile.key, tile, rect: place(grid.rects[i]), role: 'grid' }))
  }

  function statsOf(tile, rect) {
    if (!showStats || tile.screen || tile.local || rect.width < STATS_MIN_WIDTH) return null
    return peerStats?.[tile.peerId] ?? null
  }

  // ── Layout toggle ──────────────────────────────────────────────────────────
  const layoutToggle = count > 0 && (
    <button
      className="video-layout-toggle"
      onClick={() => onLayoutChange(isSpotlight ? 'grid' : 'spotlight')}
      title={isSpotlight ? 'Switch to grid layout' : 'Switch to spotlight layout'}
    >
      {isSpotlight ? '⊞' : '⊡'}
    </button>
  )

  return (
    <div className={`video-container${isSpotlight ? ' video-container--spotlight' : ''}`}>
      {(callElapsed || layoutToggle) && (
        <div className="video-topbar">
          {callElapsed ? (
            <span className="video-call-timer" aria-label="Call duration" aria-live="off">
              {callElapsed}
            </span>
          ) : (
            <span />
          )}
          {layoutToggle}
        </div>
      )}

      <div className="video-stage" ref={stageRef}>
        {placed.map(({ key, tile, rect, role, hidden }) => {
          if (role === 'more') {
            return (
              <button
                key={key}
                type="button"
                className="video-tile video-tile--more"
                style={boxOf(rect)}
                title="Show everybody (grid layout)"
                onClick={() => onLayoutChange('grid')}
              >
                +{hidden}
              </button>
            )
          }
          const isMain = role === 'main'
          return (
            <VideoTile
              key={key}
              stream={tile.stream}
              label={tile.label}
              name={tile.name}
              rect={rect}
              role={role}
              muted={Boolean(tile.local)}
              mirror={Boolean(tile.local) && mirrorVideo}
              videoOff={tile.local ? localVideoMuted : Boolean(tile.videoOff)}
              fit={tile.screen ? 'contain' : isMain ? cameraFit(rect.width, rect.height) : 'cover'}
              stats={statsOf(tile, rect)}
              onClick={role === 'strip' && !tile.local ? () => onSpotlightChange(tile.peerId) : undefined}
            />
          )
        })}
      </div>
    </div>
  )
}

function boxOf(rect) {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n}B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1048576).toFixed(1)}MB`
}

function Avatar({ name, size }) {
  const diameter = Math.round(Math.min(120, Math.max(36, size * 0.4)))
  return (
    <div
      className="video-avatar"
      aria-hidden="true"
      style={{
        width: diameter,
        height: diameter,
        fontSize: Math.round(diameter * 0.4),
        background: `hsl(${avatarHue(name)} 45% 36%)`,
      }}
    >
      {initials(name)}
    </div>
  )
}

function VideoTile({
  stream,
  label,
  name,
  rect,
  role,
  muted = false,
  mirror = false,
  videoOff = false,
  fit = 'cover',
  stats = null,
  onClick,
}) {
  const videoRef = useRef(null)
  // Listening to the sound of a remote stream before its video has started playing can keep the video from ever
  // starting in Chrome: the level is only read once the stream is really playing.
  const [playingStream, setPlayingStream] = useState(null)
  const speaking = useSpeaking(playingStream === stream ? stream : null)

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

  const showVideo = Boolean(stream) && !videoOff
  const classes = [
    'video-tile',
    `video-tile--${role}`,
    onClick ? 'video-tile--clickable' : '',
    speaking ? 'video-tile--speaking' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} style={boxOf(rect)} onClick={onClick}>
      {stream && (
        // Kept mounted while the camera is off, so it resumes without reconnecting
        <video
          ref={videoRef}
          className={`video-element${mirror ? ' video-element--mirror' : ''}${fit === 'contain' ? ' video-element--contain' : ''}${showVideo ? '' : ' video-element--hidden'}`}
          autoPlay
          playsInline
          muted={muted}
          onPlaying={() => setPlayingStream(stream)}
        />
      )}
      {!showVideo && <Avatar name={name} size={Math.min(rect.width, rect.height)} />}
      <span className="video-label">{label}</span>
      {stats && (
        <div className="video-stats-badge">
          <span className={`video-stats-route${stats.relayed ? ' video-stats-route--relay' : ''}`}>
            {stats.relayed ? `via TURN${stats.relayProtocol ? ` (${stats.relayProtocol})` : ''}` : 'direct'}
          </span>
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
