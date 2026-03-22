/**
 * ChatInput.test.jsx
 * Tests message composition and sending.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatInput from '../../src/components/ChatInput.jsx'

function setup() {
  const onSend = vi.fn()
  render(<ChatInput onSend={onSend} />)
  const textarea = screen.getByRole('textbox')
  const button = screen.getByRole('button', { name: /send/i })
  return { onSend, textarea, button }
}

describe('ChatInput — rendering', () => {
  it('mostra la textarea con placeholder', () => {
    const { textarea } = setup()
    expect(textarea).toBeInTheDocument()
    expect(textarea).toHaveAttribute('placeholder', expect.stringContaining('message'))
  })

  it('il pulsante di invio è disabilitato se il campo è vuoto', () => {
    const { button } = setup()
    expect(button).toBeDisabled()
  })

  it("il pulsante si abilita quando c'è testo", async () => {
    const user = userEvent.setup()
    const { textarea, button } = setup()
    await user.type(textarea, 'ciao')
    expect(button).not.toBeDisabled()
  })
})

describe('ChatInput — invio con Enter', () => {
  it('chiama onSend con il contenuto e pulisce il campo', async () => {
    const user = userEvent.setup()
    const { onSend, textarea } = setup()

    await user.type(textarea, 'ciao mondo')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith('ciao mondo')
    expect(textarea).toHaveValue('')
  })

  it('non invia se il messaggio è vuoto', async () => {
    const user = userEvent.setup()
    const { onSend, textarea } = setup()

    await user.keyboard('{Enter}')
    expect(onSend).not.toHaveBeenCalled()
    // Type only spaces
    await user.type(textarea, '   ')
    await user.keyboard('{Enter}')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Shift+Enter aggiunge un a capo senza inviare', async () => {
    const user = userEvent.setup()
    const { onSend, textarea } = setup()

    await user.type(textarea, 'riga 1')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(textarea, 'riga 2')

    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toContain('riga 1')
    expect(textarea.value).toContain('riga 2')
  })

  it('invia il contenuto trimmed (spazi iniziali/finali rimossi)', async () => {
    const user = userEvent.setup()
    const { onSend, textarea } = setup()

    await user.type(textarea, '  messaggio  ')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledWith('messaggio')
  })
})

describe('ChatInput — invio con pulsante', () => {
  it('chiama onSend al click del pulsante', async () => {
    const user = userEvent.setup()
    const { onSend, textarea, button } = setup()

    await user.type(textarea, 'testo')
    await user.click(button)

    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith('testo')
  })

  it('pulisce il campo dopo il click', async () => {
    const user = userEvent.setup()
    const { textarea, button } = setup()

    await user.type(textarea, 'testo')
    await user.click(button)

    expect(textarea).toHaveValue('')
  })
})

describe('ChatInput — invii multipli', () => {
  it('gestisce più invii consecutivi correttamente', async () => {
    const user = userEvent.setup()
    const { onSend, textarea } = setup()

    await user.type(textarea, 'primo')
    await user.keyboard('{Enter}')
    await user.type(textarea, 'secondo')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledTimes(2)
    expect(onSend).toHaveBeenNthCalledWith(1, 'primo')
    expect(onSend).toHaveBeenNthCalledWith(2, 'secondo')
  })
})
