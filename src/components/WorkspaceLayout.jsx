import React, { useState, useCallback } from 'react'
import '../styles/workspace.css'

/**
 * WorkspaceLayout — 4-zone shell.
 *
 * Zones:
 *   rail        — 48px leftmost strip (WorkspaceRail)
 *   sidebar     — 220px channel list (ChannelSidebar)
 *   children    — flex:1 main content area (Room / channel view)
 *   rightPanel  — 300px optional panel (Thread, Members, Info)
 *
 * Exposes via render props / context:
 *   - sidebarCollapsed  (tablet: sidebar collapses to icon-only)
 *   - mobileSidebarOpen (mobile: sidebar drawer)
 *   - rightPanelOpen
 *   - toggleRightPanel()
 *   - openMobileSidebar() / closeMobileSidebar()
 *
 * @param {ReactNode} rail
 * @param {ReactNode} sidebar
 * @param {ReactNode} rightPanel         — rendered only when rightPanelOpen
 * @param {ReactNode} mobileNav          — bottom nav for mobile
 * @param {ReactNode} children           — main content
 * @param {boolean}   [defaultRightPanel=false]
 */
export default function WorkspaceLayout({
  rail,
  sidebar,
  rightPanel,
  mobileNav,
  children,
  // Controlled right panel — if provided, overrides internal state
  rightPanelOpen: rightPanelOpenProp,
  onToggleRightPanel,
}) {
  const [rightPanelInternal, setRightPanelInternal] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // Use controlled state if prop provided, else internal
  const rightPanelOpen = rightPanelOpenProp !== undefined ? rightPanelOpenProp : rightPanelInternal
  const toggleRightPanel = useCallback(() => {
    if (onToggleRightPanel) onToggleRightPanel()
    else setRightPanelInternal((v) => !v)
  }, [onToggleRightPanel])
  const openMobileSidebar = useCallback(() => setMobileSidebarOpen(true), [])
  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), [])
  const toggleSidebarCollapsed = useCallback(() => setSidebarCollapsed((v) => !v), [])

  // Inject layout controls into rail, sidebar, children, rightPanel via cloneElement
  // so each child can call toggleRightPanel, openMobileSidebar, etc.
  const layoutControls = {
    rightPanelOpen,
    toggleRightPanel,
    mobileSidebarOpen,
    openMobileSidebar,
    closeMobileSidebar,
    sidebarCollapsed,
    toggleSidebarCollapsed,
  }

  return (
    <div className="workspace-layout">
      {/* Rail */}
      {rail && <div className="workspace-rail">{injectControls(rail, layoutControls)}</div>}

      {/* Sidebar */}
      <div
        className={[
          'workspace-sidebar',
          sidebarCollapsed ? 'workspace-sidebar--collapsed' : '',
          mobileSidebarOpen ? 'workspace-sidebar--open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {injectControls(sidebar, layoutControls)}
      </div>

      {/* Mobile backdrop — closes sidebar on tap outside */}
      {mobileSidebarOpen && (
        <div className="workspace-sidebar-backdrop" onClick={closeMobileSidebar} aria-hidden="true" />
      )}

      {/* Main content */}
      <main className="workspace-main">{injectControls(children, layoutControls)}</main>

      {/* Right panel */}
      {rightPanelOpen && rightPanel && (
        <div className="workspace-right-panel">{injectControls(rightPanel, layoutControls)}</div>
      )}

      {/* Mobile bottom nav */}
      {mobileNav && <nav className="workspace-mobile-nav">{injectControls(mobileNav, layoutControls)}</nav>}
    </div>
  )
}

/**
 * Passes layout control props into a single React element (if it is one).
 * Leaves arrays, strings, and null untouched.
 */
function injectControls(node, controls) {
  if (!React.isValidElement(node)) return node
  return React.cloneElement(node, controls)
}
