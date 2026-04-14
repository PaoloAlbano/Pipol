import React, { useState } from 'react'
import '../styles/workspace-rail.css'

/**
 * WorkspaceRail — 48px leftmost strip.
 *
 * Shows one avatar per workspace. The active one has a pill indicator on the
 * left (Discord-style). A "+" button at the bottom opens the create/join flow.
 * Settings icon at the very bottom.
 *
 * @param {object[]} workspaces        — full workspace list
 * @param {string}   activeWorkspaceId
 * @param {function} onSelectWorkspace(id)
 * @param {function} onCreateWorkspace — opens CreateWorkspaceModal
 * @param {function} onOpenSettings
 */
export default function WorkspaceRail({
  workspaces = [],
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  onOpenSettings,
}) {
  const [tooltip, setTooltip] = useState(null) // workspace id currently hovered

  return (
    <>
      {workspaces.map((ws) => (
        <WorkspaceAvatar
          key={ws.id}
          workspace={ws}
          active={ws.id === activeWorkspaceId}
          showTooltip={tooltip === ws.id}
          onMouseEnter={() => setTooltip(ws.id)}
          onMouseLeave={() => setTooltip(null)}
          onClick={() => onSelectWorkspace?.(ws.id)}
        />
      ))}

      <div className="workspace-rail__divider" />

      <button
        className="workspace-rail__icon-btn"
        title="Create or join a workspace"
        aria-label="Create or join a workspace"
        onClick={onCreateWorkspace}
      >
        <span className="workspace-rail__plus">+</span>
      </button>

      {/* Push settings to the bottom */}
      <div className="workspace-rail__spacer" />

      <button className="workspace-rail__icon-btn" title="Settings" aria-label="Open settings" onClick={onOpenSettings}>
        ⚙
      </button>
    </>
  )
}

// ── WorkspaceAvatar ───────────────────────────────────────────────────────────

function WorkspaceAvatar({ workspace, active, showTooltip, onMouseEnter, onMouseLeave, onClick }) {
  const { initials, color } = getWorkspaceVisuals(workspace)

  return (
    <div className="workspace-avatar-wrap">
      {/* Active pill indicator */}
      <span className={['workspace-avatar__pill', active ? 'workspace-avatar__pill--active' : ''].join(' ')} />

      <button
        className={['workspace-avatar', active ? 'workspace-avatar--active' : ''].join(' ')}
        style={{ background: color }}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        aria-label={workspace.name}
        aria-pressed={active}
      >
        {initials}
      </button>

      {/* Tooltip — appears to the right of the rail */}
      {showTooltip && (
        <div className="workspace-avatar__tooltip" role="tooltip">
          {workspace.name}
        </div>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Derives display initials and a consistent HSL color from the workspace id.
 */
function getWorkspaceVisuals(workspace) {
  // Color: hue from first 4 chars of id
  const hue = parseInt((workspace.id || '0000').replace(/-/g, '').slice(0, 4), 16) % 360
  const color = `hsl(${hue}, 50%, 40%)`

  // Initials: up to 2 words from name
  const words = workspace.name.trim().split(/\s+/)
  const initials = words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  return { initials, color }
}
