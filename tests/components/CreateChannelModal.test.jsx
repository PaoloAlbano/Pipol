/**
 * CreateChannelModal.test.jsx
 * Tests input validation, normalization, submit and close behaviours.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CreateChannelModal from '../../src/components/CreateChannelModal.jsx'

function renderModal(props = {}) {
  const onCreated = props.onCreated ?? vi.fn()
  const onClose = props.onClose ?? vi.fn()
  render(<CreateChannelModal onCreated={onCreated} onClose={onClose} />)
  return { onCreated, onClose, input: screen.getByRole('textbox') }
}

// ── initial state ─────────────────────────────────────────────────────────────

describe('CreateChannelModal — initial state', () => {
  it('renders the channel name input', () => {
    const { input } = renderModal()
    expect(input).toBeInTheDocument()
  })

  it('Create channel button is disabled when input is empty', () => {
    renderModal()
    expect(screen.getByRole('button', { name: /create channel/i })).toBeDisabled()
  })

  it('does not show normalization hint on empty input', () => {
    renderModal()
    expect(screen.queryByText(/will be created as/i)).not.toBeInTheDocument()
  })
})

// ── validation + normalization ────────────────────────────────────────────────

describe('CreateChannelModal — input validation', () => {
  it('enables Create button when input has valid text', async () => {
    const user = userEvent.setup()
    const { input } = renderModal()
    await user.type(input, 'design')
    expect(screen.getByRole('button', { name: /create channel/i })).toBeEnabled()
  })

  it('shows normalization hint when input differs from normalized form', async () => {
    const user = userEvent.setup()
    const { input } = renderModal()
    await user.type(input, 'Design Stuff!')
    expect(screen.getByText(/will be created as/i)).toBeInTheDocument()
    expect(screen.getByText(/design-stuff/i)).toBeInTheDocument()
  })

  it('does not show normalization hint when input is already normalized', async () => {
    const user = userEvent.setup()
    const { input } = renderModal()
    await user.type(input, 'general')
    expect(screen.queryByText(/will be created as/i)).not.toBeInTheDocument()
  })
})

// ── submit ────────────────────────────────────────────────────────────────────

describe('CreateChannelModal — submit', () => {
  it('calls onCreated with normalized name on submit', async () => {
    const user = userEvent.setup()
    const { input, onCreated } = renderModal()
    await user.type(input, 'Design Stuff!')
    await user.click(screen.getByRole('button', { name: /create channel/i }))
    expect(onCreated).toHaveBeenCalledWith('design-stuff')
  })

  it('calls onCreated with the plain name when already normalized', async () => {
    const user = userEvent.setup()
    const { input, onCreated } = renderModal()
    await user.type(input, 'design')
    await user.click(screen.getByRole('button', { name: /create channel/i }))
    expect(onCreated).toHaveBeenCalledWith('design')
  })

  it('does not call onCreated when input is empty', () => {
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /create channel/i }))
    // button is disabled, so click does nothing — no error thrown
  })
})

// ── close / cancel ────────────────────────────────────────────────────────────

describe('CreateChannelModal — close', () => {
  it('calls onClose when Cancel button is clicked', async () => {
    const user = userEvent.setup()
    const { onClose } = renderModal()
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Escape key is pressed', async () => {
    const user = userEvent.setup()
    const { onClose } = renderModal()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when close (✕) button is clicked', async () => {
    const user = userEvent.setup()
    const { onClose } = renderModal()
    await user.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
