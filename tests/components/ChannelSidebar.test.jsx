/**
 * ChannelSidebar.test.jsx
 *
 * Tests for the unread dot indicator on channels and DM peers.
 * Covers the design decision: unread items show a white dot (.sidebar__item-dot)
 * and bold name (.sidebar__item--unread); no numbered red badge.
 */

import React from 'react'
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
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
