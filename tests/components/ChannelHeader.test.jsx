/**
 * ChannelHeader.test.jsx
 * Tests for ChannelHeader: rendering, topic display, and topic editing.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChannelHeader from '../../src/components/ChannelHeader.jsx'

function setup(props = {}) {
  const defaults = {
    channelName: 'general',
  }
  render(<ChannelHeader {...defaults} {...props} />)
}

// ── Basic rendering ───────────────────────────────────────────────────────────

describe('ChannelHeader — rendering', () => {
  it('displays the channel name', () => {
    setup()
    expect(screen.getByText('general')).toBeInTheDocument()
  })

  it('shows › prefix for public channels', () => {
    setup()
    expect(screen.getByText('›')).toBeInTheDocument()
  })

  it('shows 🔒 prefix for private channels', () => {
    setup({ isPrivate: true })
    expect(screen.getByText('🔒')).toBeInTheDocument()
  })

  it('does not show topic if not provided', () => {
    setup()
    expect(screen.queryByText('test topic')).toBeNull()
  })

  it('displays topic when provided', () => {
    setup({ topic: 'Weekly standup channel' })
    expect(screen.getByText('Weekly standup channel')).toBeInTheDocument()
  })
})

// ── Edit button ───────────────────────────────────────────────────────────────

describe('ChannelHeader — edit button', () => {
  it('does not show edit button without onSetTopic', () => {
    setup()
    expect(screen.queryByLabelText(/add channel description|edit channel description/i)).toBeNull()
  })

  it('shows add description button when onSetTopic is provided and no topic', () => {
    setup({ onSetTopic: vi.fn() })
    expect(screen.getByLabelText(/add channel description/i)).toBeInTheDocument()
  })

  it('shows edit description button when onSetTopic is provided and topic exists', () => {
    setup({ topic: 'Existing topic', onSetTopic: vi.fn() })
    expect(screen.getByLabelText(/edit channel description/i)).toBeInTheDocument()
  })
})

// ── Inline editing ────────────────────────────────────────────────────────────

describe('ChannelHeader — inline topic editing', () => {
  it('shows input field after clicking the edit button', async () => {
    const user = userEvent.setup()
    setup({ onSetTopic: vi.fn() })
    await user.click(screen.getByLabelText(/add channel description/i))
    expect(screen.getByPlaceholderText(/add a description/i)).toBeInTheDocument()
  })

  it('pre-fills input with existing topic', async () => {
    const user = userEvent.setup()
    setup({ topic: 'Old topic', onSetTopic: vi.fn() })
    await user.click(screen.getByLabelText(/edit channel description/i))
    expect(screen.getByDisplayValue('Old topic')).toBeInTheDocument()
  })

  it('calls onSetTopic with new value on Enter', async () => {
    const user = userEvent.setup()
    const onSetTopic = vi.fn()
    setup({ onSetTopic })
    await user.click(screen.getByLabelText(/add channel description/i))
    const input = screen.getByPlaceholderText(/add a description/i)
    await user.clear(input)
    await user.type(input, 'New description{Enter}')
    expect(onSetTopic).toHaveBeenCalledWith('New description')
  })

  it('calls onSetTopic on blur', async () => {
    const user = userEvent.setup()
    const onSetTopic = vi.fn()
    setup({ onSetTopic })
    await user.click(screen.getByLabelText(/add channel description/i))
    const input = screen.getByPlaceholderText(/add a description/i)
    await user.type(input, 'Blur value')
    await user.tab()
    expect(onSetTopic).toHaveBeenCalledWith('Blur value')
  })

  it('cancels editing on Escape without calling onSetTopic', async () => {
    const user = userEvent.setup()
    const onSetTopic = vi.fn()
    setup({ topic: 'Keep this', onSetTopic })
    await user.click(screen.getByLabelText(/edit channel description/i))
    const input = screen.getByPlaceholderText(/add a description/i)
    await user.clear(input)
    await user.type(input, 'discarded{Escape}')
    expect(onSetTopic).not.toHaveBeenCalled()
    // Original topic still visible
    expect(screen.getByText('Keep this')).toBeInTheDocument()
  })
})
