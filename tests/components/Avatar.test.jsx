/**
 * Avatar.test.jsx
 * Tests for the Avatar component: visuals, sizes, status dot, click handler.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Avatar, { getAvatarVisuals } from '../../src/components/Avatar.jsx'

// ── getAvatarVisuals ──────────────────────────────────────────────────────────

describe('getAvatarVisuals', () => {
  it('returns initials from username', () => {
    const { initials } = getAvatarVisuals(null, 'alice')
    expect(initials).toBe('A')
  })

  it('returns up to 2 initials for multi-word username', () => {
    const { initials } = getAvatarVisuals(null, 'swift fox')
    expect(initials).toBe('SF')
  })

  it('returns ? when username is missing', () => {
    const { initials } = getAvatarVisuals(null, '')
    expect(initials).toBe('?')
  })

  it('returns a color string', () => {
    const { color } = getAvatarVisuals('aabbcc', 'alice')
    expect(typeof color).toBe('string')
    expect(color.length).toBeGreaterThan(0)
  })

  it('derives color from Uint8Array pubkey', () => {
    const pk = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd])
    const { color } = getAvatarVisuals(pk, 'alice')
    expect(typeof color).toBe('string')
  })

  it('derives color from hex string pubkey', () => {
    const { color } = getAvatarVisuals('aabbccdd', 'alice')
    expect(typeof color).toBe('string')
  })

  it('returns same color for same pubkey', () => {
    const { color: c1 } = getAvatarVisuals('aabb', 'alice')
    const { color: c2 } = getAvatarVisuals('aabb', 'bob')
    expect(c1).toBe(c2)
  })
})

// ── Avatar rendering ──────────────────────────────────────────────────────────

describe('Avatar — rendering', () => {
  it('renders initials', () => {
    const { container } = render(<Avatar username="alice" />)
    expect(container.textContent).toContain('A')
  })

  it('renders aria-label with username', () => {
    render(<Avatar username="alice" />)
    expect(screen.getByLabelText('alice')).toBeInTheDocument()
  })

  it('renders status dot when status is provided', () => {
    render(<Avatar username="alice" status="online" />)
    expect(screen.getByLabelText('online')).toBeInTheDocument()
  })

  it('does not render status dot when status is null', () => {
    const { container } = render(<Avatar username="alice" />)
    expect(container.querySelector('span[aria-label]')).toBeNull()
  })

  it('applies custom className', () => {
    const { container } = render(<Avatar username="alice" className="my-class" />)
    expect(container.firstChild.className).toContain('my-class')
  })

  it('renders as button role when onClick is provided', () => {
    render(<Avatar username="alice" onClick={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'alice' })).toBeInTheDocument()
  })

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Avatar username="alice" onClick={onClick} />)
    await user.click(screen.getByRole('button', { name: 'alice' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not render as button when onClick is not provided', () => {
    render(<Avatar username="alice" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

// ── Avatar sizes ──────────────────────────────────────────────────────────────

describe('Avatar — sizes', () => {
  it('renders md size by default', () => {
    const { container } = render(<Avatar username="alice" />)
    const el = container.firstChild
    expect(el.style.width).toBeTruthy()
  })

  it('renders sm size', () => {
    const { container } = render(<Avatar username="alice" size="sm" />)
    const el = container.firstChild
    expect(el.style.width).toBeTruthy()
  })

  it('renders lg size', () => {
    const { container } = render(<Avatar username="alice" size="lg" />)
    const el = container.firstChild
    expect(el.style.width).toBeTruthy()
  })

  it('falls back to md for unknown size', () => {
    const { container } = render(<Avatar username="alice" size="xxl" />)
    const el = container.firstChild
    expect(el.style.width).toBeTruthy()
  })
})

// ── StatusDot colors ──────────────────────────────────────────────────────────

describe('Avatar — status dot variants', () => {
  for (const status of ['online', 'away', 'offline', 'dnd']) {
    it(`renders ${status} status dot`, () => {
      render(<Avatar username="alice" status={status} />)
      expect(screen.getByLabelText(status)).toBeInTheDocument()
    })
  }
})
