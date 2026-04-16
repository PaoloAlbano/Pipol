/**
 * MobileNav — bottom navigation bar for mobile (< 768px).
 *
 * Injected props (via WorkspaceLayout.injectControls):
 *   openMobileSidebar()
 *   mobileSidebarOpen
 *
 * Own props (passed from App):
 *   activeChannelName   — shown as current "location"
 *   onOpenSettings
 */
export default function MobileNav({
  // injected by WorkspaceLayout
  openMobileSidebar,
  mobileSidebarOpen,
  // from App
  activeChannelName,
  onOpenSettings,
}) {
  const channelLabel = activeChannelName
    ? activeChannelName.startsWith('dm:')
      ? '@ DM'
      : `# ${activeChannelName}`
    : 'Channels'

  return (
    <>
      <button
        className={`workspace-mobile-nav__btn ${mobileSidebarOpen ? 'workspace-mobile-nav__btn--active' : ''}`}
        onClick={openMobileSidebar}
        aria-label="Open channel list"
      >
        <span>☰</span>
        <span className="workspace-mobile-nav__label">{channelLabel}</span>
      </button>

      <button className="workspace-mobile-nav__btn" onClick={onOpenSettings} aria-label="Settings">
        <span>⚙</span>
        <span className="workspace-mobile-nav__label">Settings</span>
      </button>
    </>
  )
}
