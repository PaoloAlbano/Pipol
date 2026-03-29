/**
 * PiPOverlay — rendered inside a Document Picture-in-Picture window.
 *
 * Styles are copied from the main document when the PiP window is opened,
 * so CSS classes (control-btn, etc.) work here just like in the main app.
 */
import { useEffect, useRef } from 'react'

function PiPVideo({ stream, label, muted = false }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null
  }, [stream])

  return (
    <div
      style={{
        position: 'relative',
        flex: '1 1 0',
        minWidth: 0,
        background: '#1a1a1a',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {stream ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={muted}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
          }}
        >
          👤
        </div>
      )}
      <span
        style={{
          position: 'absolute',
          bottom: 4,
          left: 6,
          fontSize: 10,
          color: '#fff',
          background: 'rgba(0,0,0,0.6)',
          padding: '1px 5px',
          borderRadius: 3,
          maxWidth: '80%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </div>
  )
}

export default function PiPOverlay({
  localStream,
  remoteStreams,
  peers,
  audioMuted,
  videoMuted,
  onToggleAudio,
  onToggleVideo,
}) {
  const peerById = Object.fromEntries(peers.map((p) => [p.id, p]))
  const remoteEntries = Object.entries(remoteStreams)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 8,
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', gap: 6, flex: 1, minHeight: 0 }}>
        {remoteEntries.length === 0 ? (
          <PiPVideo stream={localStream} label="You" muted />
        ) : (
          remoteEntries.map(([id, stream]) => (
            <PiPVideo key={id} stream={stream} label={peerById[id]?.username ?? id.slice(0, 8)} />
          ))
        )}
      </div>

      <div className="video-controls" style={{ padding: 0, flexDirection: 'row' }}>
        <button
          className={`control-btn ${audioMuted ? 'control-btn--active' : ''}`}
          onClick={onToggleAudio}
          title={audioMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {audioMuted ? '🔇' : '🎙️'}
          <span className="control-label">{audioMuted ? 'Unmute' : 'Mute'}</span>
        </button>
        <button
          className={`control-btn ${videoMuted ? 'control-btn--active' : ''}`}
          onClick={onToggleVideo}
          title={videoMuted ? 'Turn on camera' : 'Turn off camera'}
        >
          {videoMuted ? '📵' : '📷'}
          <span className="control-label">{videoMuted ? 'Cam on' : 'Cam off'}</span>
        </button>
      </div>
    </div>
  )
}
