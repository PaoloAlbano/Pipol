import { useState } from 'react'
import { CALL_REACTIONS } from '../webrtc/callReactions.js'
import { SHORTCUTS } from '../webrtc/useCallShortcuts.js'
import '../styles/video.css'

/**
 * In-call controls: mute mic, mute camera, end call.
 *
 * @param {boolean}  audioMuted
 * @param {boolean}  videoMuted
 * @param {function} onToggleAudio
 * @param {function} onToggleVideo
 * @param {boolean}  handRaised
 * @param {function} onToggleHand  raise or lower the hand (the button is not shown without it)
 * @param {function} onReact       called with the emoji chosen (the button is not shown without it)
 * @param {function} onEndCall
 */

const key = (name) => SHORTCUTS[name].toUpperCase()

/** A button that opens the row of reactions, and sends the one chosen. `mobile`: the style of the phone bar. */
export function ReactionPicker({ onReact, mobile = false }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`call-reactions${mobile ? ' call-reactions--mobile' : ''}`}>
      <button
        className={mobile ? 'btn-mobile-control' : 'control-btn'}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Send a reaction"
      >
        😀<span className={mobile ? undefined : 'control-label'}>React</span>
      </button>
      {open && (
        <div className="call-reactions__list" role="menu">
          {CALL_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              role="menuitem"
              className="call-reactions__emoji"
              aria-label={`React ${emoji}`}
              onClick={() => {
                onReact(emoji)
                setOpen(false)
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function VideoControls({
  audioMuted,
  videoMuted,
  handRaised = false,
  onToggleHand,
  onReact,
  screenSharing,
  pipActive,
  onToggleAudio,
  onToggleVideo,
  onSwitchCamera,
  onToggleScreenShare,
  onTogglePiP,
  onEndCall,
}) {
  return (
    <div className="video-controls">
      <button
        className={`control-btn ${audioMuted ? 'control-btn--active' : ''}`}
        onClick={onToggleAudio}
        aria-keyshortcuts={SHORTCUTS.audio}
        title={
          audioMuted
            ? `Unmute microphone (${key('audio')}, or hold Space to talk)`
            : `Mute microphone (${key('audio')})`
        }
      >
        {audioMuted ? '🔇' : '🎙️'}
        <span className="control-label">{audioMuted ? 'Unmute' : 'Mute'}</span>
      </button>

      <button
        className={`control-btn ${videoMuted ? 'control-btn--active' : ''}`}
        onClick={onToggleVideo}
        aria-keyshortcuts={SHORTCUTS.video}
        title={videoMuted ? `Turn on camera (${key('video')})` : `Turn off camera (${key('video')})`}
      >
        {videoMuted ? '📵' : '📷'}
        <span className="control-label">{videoMuted ? 'Cam on' : 'Cam off'}</span>
      </button>

      {onToggleHand && (
        <button
          className={`control-btn ${handRaised ? 'control-btn--active' : ''}`}
          onClick={onToggleHand}
          aria-pressed={handRaised}
          aria-keyshortcuts={SHORTCUTS.hand}
          title={handRaised ? `Lower hand (${key('hand')})` : `Raise hand (${key('hand')})`}
        >
          ✋<span className="control-label">{handRaised ? 'Lower' : 'Hand'}</span>
        </button>
      )}

      {onReact && <ReactionPicker onReact={onReact} />}

      {onSwitchCamera && (
        <button className="control-btn" onClick={onSwitchCamera} title="Switch camera">
          🔄
          <span className="control-label">Flip</span>
        </button>
      )}

      {onToggleScreenShare && (
        <button
          className={`control-btn ${screenSharing ? 'control-btn--active' : ''}`}
          onClick={onToggleScreenShare}
          title={screenSharing ? 'Stop screen share' : 'Share screen'}
        >
          🖥️
          <span className="control-label">{screenSharing ? 'Stop share' : 'Share'}</span>
        </button>
      )}

      {onTogglePiP && document.pictureInPictureEnabled && (
        <button
          className={`control-btn ${pipActive ? 'control-btn--active' : ''}`}
          onClick={onTogglePiP}
          title={pipActive ? 'Close picture-in-picture' : 'Open picture-in-picture'}
        >
          ⧉<span className="control-label">PiP</span>
        </button>
      )}

      <button className="control-btn control-btn--danger" onClick={onEndCall} title="Leave video call">
        📞
        <span className="control-label">End call</span>
      </button>
    </div>
  )
}
