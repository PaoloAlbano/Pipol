/**
 * CreateWorkspaceModal.test.jsx
 * TURN / ICE configuration in the "Advanced configuration" step.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CreateWorkspaceModal from '../../src/components/CreateWorkspaceModal.jsx'

async function openAdvanced(user, props = {}) {
  const onCreated = vi.fn()
  render(
    <CreateWorkspaceModal workspace={null} createdWorkspace={null} onCreated={onCreated} onClose={vi.fn()} {...props} />
  )
  await user.type(screen.getByLabelText(/workspace name/i), 'Acme')
  await user.click(screen.getByRole('button', { name: /next/i }))
  await user.click(screen.getByRole('button', { name: /advanced configuration/i }))
  return onCreated
}

describe('CreateWorkspaceModal — TURN configuration', () => {
  it('creates a workspace without config when the advanced fields are empty', async () => {
    const user = userEvent.setup()
    const onCreated = await openAdvanced(user)
    await user.click(screen.getByRole('button', { name: /create workspace/i }))
    expect(onCreated).toHaveBeenCalledWith('Acme', ['general', 'random'], null)
  })

  it('embeds static TURN servers (e.g. coturn) in the workspace config', async () => {
    const user = userEvent.setup()
    const onCreated = await openAdvanced(user)
    await user.type(screen.getByLabelText(/turn server url/i), 'turn:turn.example.com:3478')
    await user.type(screen.getByLabelText(/turn username/i), 'alice')
    await user.type(screen.getByLabelText(/turn password/i), 'secret')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(onCreated).toHaveBeenCalledWith('Acme', ['general', 'random'], {
      relayUrl: undefined,
      authUrl: undefined,
      ice: { servers: [{ urls: ['turn:turn.example.com:3478'], username: 'alice', credential: 'secret' }] },
    })
  })

  it('embeds an ICE endpoint that issues short-lived credentials', async () => {
    const user = userEvent.setup()
    const onCreated = await openAdvanced(user)
    await user.type(screen.getByLabelText(/ice endpoint/i), 'https://relay.example.com/ice')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(onCreated.mock.calls[0][2].ice).toEqual({ url: 'https://relay.example.com/ice' })
  })

  it('keeps the relay URL next to the TURN settings', async () => {
    const user = userEvent.setup()
    const onCreated = await openAdvanced(user)
    await user.type(screen.getByLabelText(/custom relay url/i), 'wss://relay.example.com')
    await user.type(screen.getByLabelText(/ice endpoint/i), 'https://relay.example.com/ice')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(onCreated.mock.calls[0][2]).toMatchObject({
      relayUrl: 'wss://relay.example.com',
      ice: { url: 'https://relay.example.com/ice' },
    })
  })

  it('blocks creation and explains when TURN has no credentials', async () => {
    const user = userEvent.setup()
    const onCreated = await openAdvanced(user)
    await user.type(screen.getByLabelText(/turn server url/i), 'turn:turn.example.com:3478')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(screen.getByText(/check the turn settings/i)).toBeInTheDocument()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('blocks creation for a non-TURN URL scheme', async () => {
    const user = userEvent.setup()
    const onCreated = await openAdvanced(user)
    await user.type(screen.getByLabelText(/turn server url/i), 'http://evil.example.com')
    await user.type(screen.getByLabelText(/turn username/i), 'u')
    await user.type(screen.getByLabelText(/turn password/i), 'p')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))

    expect(onCreated).not.toHaveBeenCalled()
  })
})

describe('CreateWorkspaceModal — TURN disabled in this build', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('offers no TURN fields and embeds none in the workspace config', async () => {
    vi.stubEnv('VITE_TURN_DISABLED', 'true')
    const user = userEvent.setup()
    const onCreated = await openAdvanced(user)

    expect(screen.queryByLabelText(/turn server url/i)).toBeNull()
    expect(screen.queryByLabelText(/ice endpoint/i)).toBeNull()
    expect(screen.getByLabelText(/custom relay url/i)).toBeInTheDocument()

    await user.type(screen.getByLabelText(/custom relay url/i), 'wss://relay.example.com')
    await user.click(screen.getByRole('button', { name: /create workspace/i }))
    expect(onCreated.mock.calls[0][2]).toEqual({
      relayUrl: 'wss://relay.example.com',
      authUrl: undefined,
      ice: undefined,
    })
  })
})
