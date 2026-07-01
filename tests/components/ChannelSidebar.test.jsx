/**
 * ChannelSidebar.test.jsx
 *
 * Tests for the unread dot indicator on channels and DM peers.
 * Covers the design decision: unread items show a white dot (.sidebar__item-dot)
 * and bold name (.sidebar__item--unread); no numbered red badge.
 */

import React from 'react'
import { render, fireEvent, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import ChannelSidebar from '../../src/components/ChannelSidebar.jsx'

const identity = {
  username: 'alice',
  publicKey: new Uint8Array([0xaa, 0xbb, 0xcc]),
}

const workspace = { id: 'ws-1', name: 'Test Workspace', secret: 'secret' }

function makeChannel(overrides = {}) {
  return { name: 'generale', topic: '', unread: 0, ...overrides }
}

function makeDMPeer(overrides = {}) {
  return { pubkey: '112233', username: 'bob', online: true, unread: 0, ...overrides }
}

function renderSidebar(props = {}) {
  return render(
    <ChannelSidebar workspace={workspace} identity={identity} channels={[]} peers={[]} dmPeers={[]} {...props} />
  )
}

// ── Channel unread dot ─────────────────────────────────────────────────────────

describe('ChannelSidebar — channel unread indicator', () => {
  it('shows no dot when unread is 0', () => {
    const { container } = renderSidebar({ channels: [makeChannel({ unread: 0 })] })
    const items = container.querySelectorAll('.sidebar__item')
    expect(items.length).toBeGreaterThan(0)
    expect(container.querySelector('.sidebar__item-dot')).toBeNull()
  })

  it('shows the unread dot when unread > 0 and channel is not active', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', unread: 3 })],
      activeChannelName: 'random', // different channel is active
    })
    expect(container.querySelector('.sidebar__item-dot')).toBeInTheDocument()
  })

  it('applies .sidebar__item--unread (bold) when unread > 0 and not active', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', unread: 5 })],
      activeChannelName: 'random',
    })
    expect(container.querySelector('.sidebar__item--unread')).toBeInTheDocument()
  })

  it('does NOT show dot when the unread channel is the active one', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', unread: 5 })],
      activeChannelName: 'generale', // same channel is active → no dot
    })
    expect(container.querySelector('.sidebar__item-dot')).toBeNull()
    expect(container.querySelector('.sidebar__item--unread')).toBeNull()
  })

  it('does not show a numeric badge for channels', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', unread: 99 })],
      activeChannelName: 'other',
    })
    // Never shows the old numbered red badge
    expect(container.querySelector('.sidebar__item-badge')).toBeNull()
    // But does show the dot
    expect(container.querySelector('.sidebar__item-dot')).toBeInTheDocument()
  })

  it('shows dots for multiple channels with unread > 0', () => {
    const { container } = renderSidebar({
      channels: [
        makeChannel({ name: 'generale', unread: 1 }),
        makeChannel({ name: 'random', unread: 0 }),
        makeChannel({ name: 'dev', unread: 4 }),
      ],
      activeChannelName: 'other',
    })
    expect(container.querySelectorAll('.sidebar__item-dot').length).toBe(2)
  })
})

// ── DM peer unread dot ────────────────────────────────────────────────────────

describe('ChannelSidebar — DM peer unread indicator', () => {
  it('shows no dot when DM peer unread is 0', () => {
    const { container } = renderSidebar({ dmPeers: [makeDMPeer({ unread: 0 })] })
    expect(container.querySelector('.sidebar__item-dot')).toBeNull()
  })

  it('shows the unread dot when DM peer has unread > 0 and is not active', () => {
    const { container } = renderSidebar({
      dmPeers: [makeDMPeer({ pubkey: '112233', unread: 2 })],
      activeChannelName: 'generale', // not the DM
    })
    expect(container.querySelector('.sidebar__item-dot')).toBeInTheDocument()
  })

  it('applies .sidebar__item--unread (bold) on a DM peer with unread > 0', () => {
    const { container } = renderSidebar({
      dmPeers: [makeDMPeer({ pubkey: '112233', unread: 1 })],
      activeChannelName: 'generale',
    })
    expect(container.querySelector('.sidebar__item--unread')).toBeInTheDocument()
  })

  it('does NOT show dot when the unread DM peer is the active conversation', () => {
    const { container } = renderSidebar({
      dmPeers: [makeDMPeer({ pubkey: '112233', unread: 3 })],
      activeChannelName: 'dm:112233', // this DM is active
    })
    expect(container.querySelector('.sidebar__item-dot')).toBeNull()
  })

  it('does not show a numeric badge for DM peers', () => {
    const { container } = renderSidebar({
      dmPeers: [makeDMPeer({ pubkey: '112233', unread: 15 })],
      activeChannelName: 'generale',
    })
    expect(container.querySelector('.sidebar__item-badge')).toBeNull()
    expect(container.querySelector('.sidebar__item-dot')).toBeInTheDocument()
  })
})

// ── Channel @mention badge ────────────────────────────────────────────────────

describe('ChannelSidebar — @mention badge', () => {
  it('shows no mention badge when mentioned is 0', () => {
    const { container } = renderSidebar({ channels: [makeChannel({ mentioned: 0 })] })
    expect(container.querySelector('.sidebar__item-mention')).toBeNull()
  })

  it('shows @ badge when mentioned > 0 and channel is not active', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', mentioned: 2 })],
      activeChannelName: 'other',
    })
    const badge = container.querySelector('.sidebar__item-mention')
    expect(badge).toBeInTheDocument()
    expect(badge.textContent).toBe('@')
  })

  it('hides the @ badge when the mentioned channel is active', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', mentioned: 3 })],
      activeChannelName: 'generale',
    })
    expect(container.querySelector('.sidebar__item-mention')).toBeNull()
  })

  it('shows @ badge instead of the plain dot when both unread and mentioned > 0', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', unread: 5, mentioned: 1 })],
      activeChannelName: 'other',
    })
    expect(container.querySelector('.sidebar__item-mention')).toBeInTheDocument()
    expect(container.querySelector('.sidebar__item-dot')).toBeNull()
  })

  it('shows plain dot but no @ badge when unread > 0 but mentioned is 0', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', unread: 3, mentioned: 0 })],
      activeChannelName: 'other',
    })
    expect(container.querySelector('.sidebar__item-dot')).toBeInTheDocument()
    expect(container.querySelector('.sidebar__item-mention')).toBeNull()
  })

  it('@ badge has an accessible aria-label with the mention count', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', mentioned: 1 })],
      activeChannelName: 'other',
    })
    const badge = container.querySelector('.sidebar__item-mention')
    expect(badge).toHaveAttribute('aria-label', '1 mention')
  })

  it('aria-label uses plural "mentions" when count > 1', () => {
    const { container } = renderSidebar({
      channels: [makeChannel({ name: 'generale', mentioned: 3 })],
      activeChannelName: 'other',
    })
    const badge = container.querySelector('.sidebar__item-mention')
    expect(badge).toHaveAttribute('aria-label', '3 mentions')
  })
})

// ── UserCard ──────────────────────────────────────────────────────────────────

describe('ChannelSidebar — UserCard', () => {
  it('renders the username', () => {
    renderSidebar()
    expect(screen.getByText('alice')).toBeInTheDocument()
  })

  it('shows "Online" status when not muted', () => {
    renderSidebar({ audioMuted: false })
    expect(screen.getByText('Online')).toBeInTheDocument()
  })

  it('shows "Microphone muted" status when muted', () => {
    renderSidebar({ audioMuted: true })
    expect(screen.getByText('Microphone muted')).toBeInTheDocument()
  })

  it('calls onOpenSettings when the avatar is clicked', () => {
    const onOpenSettings = vi.fn()
    renderSidebar({ onOpenSettings })
    fireEvent.click(screen.getByRole('button', { name: /open profile settings/i }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('calls onToggleMute when the mute button is clicked', () => {
    const onToggleMute = vi.fn()
    renderSidebar({ onToggleMute })
    fireEvent.click(screen.getByRole('button', { name: /mute microphone/i }))
    expect(onToggleMute).toHaveBeenCalledTimes(1)
  })

  it('mute button label changes when audioMuted is true', () => {
    renderSidebar({ audioMuted: true, onToggleMute: vi.fn() })
    expect(screen.getByRole('button', { name: /unmute microphone/i })).toBeInTheDocument()
  })

  it('calls onOpenSettings from the settings button', () => {
    const onOpenSettings = vi.fn()
    renderSidebar({ onOpenSettings })
    fireEvent.click(screen.getByRole('button', { name: /open settings/i }))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it('does not render the user card when identity is null', () => {
    const { container } = render(
      <ChannelSidebar workspace={workspace} identity={null} channels={[]} peers={[]} dmPeers={[]} />
    )
    expect(container.querySelector('.sidebar__user-card')).toBeNull()
  })
})

// ── Workspace header ──────────────────────────────────────────────────────────

describe('ChannelSidebar — workspace header', () => {
  it('renders the workspace name', () => {
    renderSidebar()
    expect(screen.getByText('Test Workspace')).toBeInTheDocument()
  })

  it('shows online count when online peers are present', () => {
    renderSidebar({ peers: [{ id: '1', username: 'bob', status: 'online' }] })
    expect(screen.getByText('1 online')).toBeInTheDocument()
  })

  it('does not show online count when no online peers', () => {
    renderSidebar({ peers: [] })
    expect(screen.queryByText(/online/)).toBeNull()
  })

  it('offline peers are excluded from online count', () => {
    renderSidebar({ peers: [{ id: '1', username: 'bob', status: 'offline' }] })
    expect(screen.queryByText(/online/)).toBeNull()
  })

  it('does not show admin chevron when isAdmin is false', () => {
    const { container } = renderSidebar({ isAdmin: false })
    expect(container.querySelector('.sidebar__workspace-chevron')).toBeNull()
  })

  it('shows admin chevron when isAdmin is true', () => {
    const { container } = renderSidebar({ isAdmin: true })
    expect(container.querySelector('.sidebar__workspace-chevron')).toBeInTheDocument()
  })

  it('admin can open the workspace dropdown menu by clicking header', () => {
    const { container } = renderSidebar({ isAdmin: true, onInvite: vi.fn() })
    const header = container.querySelector('.sidebar__workspace-header')
    fireEvent.click(header)
    expect(container.querySelector('.sidebar__ws-menu')).toBeInTheDocument()
  })

  it('workspace menu shows invite button when onInvite is provided', () => {
    const { container } = renderSidebar({ isAdmin: true, onInvite: vi.fn() })
    fireEvent.click(container.querySelector('.sidebar__workspace-header'))
    expect(screen.getByRole('menuitem', { name: /copy invite link/i })).toBeInTheDocument()
  })

  it('clicking invite button calls onInvite and closes menu', () => {
    const onInvite = vi.fn()
    const { container } = renderSidebar({ isAdmin: true, onInvite })
    fireEvent.click(container.querySelector('.sidebar__workspace-header'))
    fireEvent.click(screen.getByRole('menuitem', { name: /copy invite link/i }))
    expect(onInvite).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.sidebar__ws-menu')).toBeNull()
  })
})

// ── Channel search ────────────────────────────────────────────────────────────

describe('ChannelSidebar — channel search', () => {
  const channels = [
    { name: 'general', topic: '', unread: 0 },
    { name: 'random', topic: '', unread: 0 },
    { name: 'announcements', topic: '', unread: 0 },
  ]

  it('shows all channels when search is empty', () => {
    renderSidebar({ channels })
    expect(screen.getByText('general')).toBeInTheDocument()
    expect(screen.getByText('random')).toBeInTheDocument()
    expect(screen.getByText('announcements')).toBeInTheDocument()
  })

  it('filters channels by search term', () => {
    renderSidebar({ channels })
    fireEvent.change(screen.getByRole('textbox', { name: /search channels/i }), {
      target: { value: 'gen' },
    })
    expect(screen.getByText('general')).toBeInTheDocument()
    expect(screen.queryByText('random')).toBeNull()
    expect(screen.queryByText('announcements')).toBeNull()
  })

  it('clear button appears when search has text', () => {
    renderSidebar({ channels })
    const input = screen.getByRole('textbox', { name: /search channels/i })
    fireEvent.change(input, { target: { value: 'gen' } })
    expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument()
  })

  it('clear button clears the search and shows all channels', () => {
    renderSidebar({ channels })
    const input = screen.getByRole('textbox', { name: /search channels/i })
    fireEvent.change(input, { target: { value: 'gen' } })
    fireEvent.click(screen.getByRole('button', { name: /clear search/i }))
    expect(screen.getByText('random')).toBeInTheDocument()
    expect(screen.getByText('announcements')).toBeInTheDocument()
  })

  it('shows no channels when search matches nothing', () => {
    renderSidebar({ channels })
    fireEvent.change(screen.getByRole('textbox', { name: /search channels/i }), {
      target: { value: 'zzz' },
    })
    expect(screen.queryByText('general')).toBeNull()
  })
})

// ── Sections collapse ─────────────────────────────────────────────────────────

describe('ChannelSidebar — collapsible sections', () => {
  it('channels section is visible by default', () => {
    renderSidebar({ channels: [{ name: 'general', topic: '', unread: 0 }] })
    expect(screen.getByText('general')).toBeInTheDocument()
  })

  it('clicking the Channels section header collapses it', () => {
    renderSidebar({ channels: [{ name: 'general', topic: '', unread: 0 }] })
    const sectionHeader = screen.getByText('Channels').closest('[role="button"]')
    fireEvent.click(sectionHeader)
    expect(screen.queryByText('general')).toBeNull()
  })

  it('clicking the + button calls onCreateChannel', () => {
    const onCreateChannel = vi.fn()
    renderSidebar({ channels: [{ name: 'general', topic: '', unread: 0 }], onCreateChannel })
    fireEvent.click(screen.getByRole('button', { name: /create channel/i }))
    expect(onCreateChannel).toHaveBeenCalledTimes(1)
  })

  it('DM section collapses when its header is clicked', () => {
    const peers = [{ pubkey: 'abc', username: 'bob', online: true, unread: 0 }]
    renderSidebar({ dmPeers: peers })
    const dmHeader = screen.getByText('Direct Messages').closest('[role="button"]')
    fireEvent.click(dmHeader)
    expect(screen.queryByText('bob')).toBeNull()
  })
})

// ── onSelectChannel / onSelectDM callbacks ────────────────────────────────────

describe('ChannelSidebar — selection callbacks', () => {
  it('calls onSelectChannel when a channel item is clicked', () => {
    const onSelectChannel = vi.fn()
    renderSidebar({
      channels: [{ name: 'general', topic: '', unread: 0 }],
      onSelectChannel,
    })
    fireEvent.click(screen.getByText('general'))
    expect(onSelectChannel).toHaveBeenCalledWith('general')
  })

  it('calls onSelectDM when a DM item is clicked', () => {
    const onSelectDM = vi.fn()
    renderSidebar({
      dmPeers: [{ pubkey: 'aabbcc', username: 'bob', online: true, unread: 0 }],
      onSelectDM,
    })
    fireEvent.click(screen.getByText('bob'))
    expect(onSelectDM).toHaveBeenCalledWith('aabbcc')
  })

  it('calls closeMobileSidebar when a channel is selected', () => {
    const onSelectChannel = vi.fn()
    const closeMobileSidebar = vi.fn()
    renderSidebar({
      channels: [{ name: 'general', topic: '', unread: 0 }],
      onSelectChannel,
      closeMobileSidebar,
    })
    fireEvent.click(screen.getByText('general'))
    expect(closeMobileSidebar).toHaveBeenCalledTimes(1)
  })

  it('renders close button when closeMobileSidebar is provided', () => {
    renderSidebar({ closeMobileSidebar: vi.fn() })
    expect(screen.getByRole('button', { name: /close sidebar/i })).toBeInTheDocument()
  })

  it('calls closeMobileSidebar when the close button is clicked', () => {
    const closeMobileSidebar = vi.fn()
    renderSidebar({ closeMobileSidebar })
    fireEvent.click(screen.getByRole('button', { name: /close sidebar/i }))
    expect(closeMobileSidebar).toHaveBeenCalledTimes(1)
  })
})
