/**
 * CallSetupModal.test.jsx
 * The choice of what to start a call with: the microphone and the camera, each on or off.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CallSetupModal from '../../src/components/CallSetupModal.jsx'

function setup(props = {}) {
  const handlers = { onConfirm: vi.fn(), onCancel: vi.fn() }
  const view = render(
    <CallSetupModal mode="start" defaults={{ camera: true, microphone: true }} {...handlers} {...props} />
  )
  return { ...handlers, ...view }
}

describe('CallSetupModal', () => {
  it('names what it is for: a new call, or a call of somebody', () => {
    const { unmount } = setup()
    expect(screen.getByRole('dialog', { name: 'Start a call' })).toBeInTheDocument()
    unmount()

    const second = setup({ mode: 'join', caller: 'alice' })
    expect(screen.getByRole('dialog', { name: "Join alice's call" })).toBeInTheDocument()
    second.unmount()

    setup({ mode: 'join' })
    expect(screen.getByRole('dialog', { name: 'Join the call' })).toBeInTheDocument()
  })

  it('labels the confirm button by what is being done', () => {
    const { unmount } = setup()
    expect(screen.getByRole('button', { name: 'Start call' })).toBeInTheDocument()
    unmount()
    setup({ mode: 'join' })
    expect(screen.getByRole('button', { name: 'Join now' })).toBeInTheDocument()
  })

  it('starts with the choices it was given', () => {
    setup({ defaults: { camera: false, microphone: true } })
    expect(screen.getByRole('switch', { name: 'Microphone' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: 'Camera' })).toHaveAttribute('aria-checked', 'false')
  })

  it('confirms with what is on, after the switches are changed', async () => {
    const user = userEvent.setup()
    const { onConfirm } = setup()
    await user.click(screen.getByRole('switch', { name: 'Camera' }))
    await user.click(screen.getByRole('button', { name: 'Start call' }))
    expect(onConfirm).toHaveBeenCalledWith({ camera: false, microphone: true })
  })

  it('turns a switch back on', async () => {
    const user = userEvent.setup()
    const { onConfirm } = setup({ defaults: { camera: false, microphone: false } })
    await user.click(screen.getByRole('switch', { name: 'Microphone' }))
    await user.click(screen.getByRole('switch', { name: 'Camera' }))
    await user.click(screen.getByRole('button', { name: 'Start call' }))
    expect(onConfirm).toHaveBeenCalledWith({ camera: true, microphone: true })
  })

  it('can be left with both off, to watch and listen', async () => {
    const user = userEvent.setup()
    const { onConfirm } = setup({ defaults: { camera: false, microphone: false } })
    await user.click(screen.getByRole('button', { name: 'Start call' }))
    expect(onConfirm).toHaveBeenCalledWith({ camera: false, microphone: false })
  })

  it('shows a camera icon with the camera on, and headphones without it', async () => {
    const user = userEvent.setup()
    const { container } = setup()
    expect(container.querySelector('.call-modal-icon').textContent).toBe('📹')
    await user.click(screen.getByRole('switch', { name: 'Camera' }))
    expect(container.querySelector('.call-modal-icon').textContent).toBe('🎧')
  })

  it('has the focus on the confirm button, so Enter starts the call', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Start call' })).toHaveFocus()
  })

  it('is cancelled with the button or with Escape, and nothing else cancels it', async () => {
    const user = userEvent.setup()
    const { onCancel } = setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()

    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(2)

    await user.keyboard('a')
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
