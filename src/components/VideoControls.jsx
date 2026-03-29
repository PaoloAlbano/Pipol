import '../styles/video.css'

/**
 * In-call controls: mute mic, mute camera, end call.
 *
 * @param {boolean}  audioMuted
 * @param {boolean}  videoMuted
 * @param {function} onToggleAudio
 * @param {function} onToggleVideo
 * @param {function} onEndCall
 */
export default function VideoControls({
  audioMuted,
  videoMuted,
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

      <button
        className="control-btn control-btn--danger"
        onClick={onEndCall}
        title="Leave video call"
      >
        📞
        <span className="control-label">End call</span>
      </button>
    </div>
  )
}
