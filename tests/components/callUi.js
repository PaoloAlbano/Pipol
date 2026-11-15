import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** The window that asks what to start the call with, with the switches set as asked, then its confirm button. */
async function confirmCallSetup(user, { camera = true, microphone = true, confirm }) {
  const dialog = within(await screen.findByRole('dialog'))
  for (const [name, wanted] of [
    ['Microphone', microphone],
    ['Camera', camera],
  ]) {
    const toggle = dialog.getByRole('switch', { name })
    if ((toggle.getAttribute('aria-checked') === 'true') !== wanted) await user.click(toggle)
  }
  await user.click(dialog.getByRole('button', { name: confirm }))
}

/** "Start call" on the page, then in the window that asks what to start with. */
export async function clickStartCall(user = userEvent, options = {}) {
  await user.click(screen.getByRole('button', { name: /start call/i }))
  await confirmCallSetup(user, { ...options, confirm: 'Start call' })
}

/** "Join" (in the window of the incoming call, or the button of the call in progress), then "Join now". */
export async function clickJoinCall(user = userEvent, options = {}) {
  await user.click(screen.getAllByRole('button', { name: /^join$/i })[0])
  await confirmCallSetup(user, { ...options, confirm: 'Join now' })
}
