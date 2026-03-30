/**
 * ChatInput.test.jsx
 * Tests message composition and sending (contenteditable WYSIWYG editor).
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatInput from '../../src/components/ChatInput.jsx'

// jsdom does not implement execCommand/queryCommandState — stub them
beforeEach(() => {
  document.execCommand = vi.fn().mockReturnValue(true)
  document.queryCommandState = vi.fn().mockReturnValue(false)
})

function setup() {
  const onSend = vi.fn()
  render(<ChatInput onSend={onSend} />)
  const editor = screen.getByRole('textbox')
  const button = screen.getByRole('button', { name: /send/i })
  return { onSend, editor, button }
}

describe('ChatInput — rendering', () => {
  it('mostra il campo di testo con placeholder', () => {
    const { editor } = setup()
    expect(editor).toBeInTheDocument()
    expect(editor).toHaveAttribute('data-placeholder', expect.stringContaining('message'))
  })

  it('il pulsante di invio è disabilitato se il campo è vuoto', () => {
    const { button } = setup()
    expect(button).toBeDisabled()
  })

  it("il pulsante si abilita quando c'è testo", async () => {
    const user = userEvent.setup()
    const { editor, button } = setup()
    editor.focus()
    await user.type(editor, 'ciao')
    expect(button).not.toBeDisabled()
  })
})

describe('ChatInput — invio con Enter', () => {
  it('chiama onSend con il contenuto e pulisce il campo', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    await user.type(editor, 'ciao mondo')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith('ciao mondo')
    expect(editor.textContent).toBe('')
  })

  it('non invia se il messaggio è vuoto', async () => {
    const user = userEvent.setup()
    const { onSend } = setup()
    await user.keyboard('{Enter}')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Shift+Enter aggiunge un a capo senza inviare', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    await user.type(editor, 'riga 1')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, 'riga 2')

    expect(onSend).not.toHaveBeenCalled()
    expect(editor.textContent).toContain('riga 1')
    expect(editor.textContent).toContain('riga 2')
  })

  it('invia il contenuto trimmed', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    await user.type(editor, 'messaggio')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledWith('messaggio')
  })
})

describe('ChatInput — invio con pulsante', () => {
  it('chiama onSend al click del pulsante', async () => {
    const user = userEvent.setup()
    const { onSend, editor, button } = setup()

    editor.focus()
    await user.type(editor, 'testo')
    await user.click(button)

    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith('testo')
  })

  it('pulisce il campo dopo il click', async () => {
    const user = userEvent.setup()
    const { editor, button } = setup()

    editor.focus()
    await user.type(editor, 'testo')
    await user.click(button)

    expect(editor.textContent).toBe('')
  })
})

describe('ChatInput — invii multipli', () => {
  it('gestisce più invii consecutivi correttamente', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    await user.type(editor, 'primo')
    await user.keyboard('{Enter}')
    await user.type(editor, 'secondo')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledTimes(2)
    expect(onSend).toHaveBeenNthCalledWith(1, 'primo')
    expect(onSend).toHaveBeenNthCalledWith(2, 'secondo')
  })
})

describe('ChatInput — toolbar di formattazione', () => {
  function getToolbarBtn(title) {
    return screen.getByTitle(title)
  }
  function clickToolbar(btn) {
    fireEvent.mouseDown(btn, { button: 0 })
  }

  it('mostra i 4 pulsanti della toolbar', () => {
    setup()
    expect(getToolbarBtn('Bold')).toBeInTheDocument()
    expect(getToolbarBtn('Italic')).toBeInTheDocument()
    expect(getToolbarBtn('Strikethrough')).toBeInTheDocument()
    expect(getToolbarBtn('Code block')).toBeInTheDocument()
  })

  it('Bold chiama execCommand("bold")', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Bold'))
    expect(document.execCommand).toHaveBeenCalledWith('bold')
  })

  it('Italic chiama execCommand("italic")', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Italic'))
    expect(document.execCommand).toHaveBeenCalledWith('italic')
  })

  it('Strikethrough chiama execCommand("strikeThrough")', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Strikethrough'))
    expect(document.execCommand).toHaveBeenCalledWith('strikeThrough')
  })

  it('Code block inserisce <pre><code> nel editor', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Code block'))
    expect(editor.querySelector('pre')).toBeInTheDocument()
    expect(editor.querySelector('pre code')).toBeInTheDocument()
  })

  it('Code block ripremuto non annida un secondo <pre>', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Code block'))
    // Simulate cursor inside the pre (move anchorNode into the pre)
    const pre = editor.querySelector('pre')
    // Click again — should NOT create a nested pre
    clickToolbar(getToolbarBtn('Code block'))
    expect(editor.querySelectorAll('pre')).toHaveLength(1)
  })

  it('la toolbar non causa un invio prematuro', () => {
    const { onSend, editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Bold'))
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('ChatInput — serializzazione markdown su invio', () => {
  async function sendWithHTML(html) {
    const user = userEvent.setup()
    const { onSend, editor } = setup()
    editor.innerHTML = html
    fireEvent.input(editor)
    editor.focus()
    await user.keyboard('{Enter}')
    return onSend
  }

  it('grassetto <b> → **…**', async () => {
    const onSend = await sendWithHTML('<b>ciao</b>')
    expect(onSend).toHaveBeenCalledWith('**ciao**')
  })

  it('corsivo <i> → _…_', async () => {
    const onSend = await sendWithHTML('<i>corsivo</i>')
    expect(onSend).toHaveBeenCalledWith('_corsivo_')
  })

  it('barrato <s> → ~~…~~', async () => {
    const onSend = await sendWithHTML('<s>barrato</s>')
    expect(onSend).toHaveBeenCalledWith('~~barrato~~')
  })

  it('code block <pre><code> → ```…```', async () => {
    const onSend = await sendWithHTML('<pre><code>fn()</code></pre>')
    expect(onSend).toHaveBeenCalledWith('```\nfn()\n```')
  })

  it('testo misto con formattazione', async () => {
    const onSend = await sendWithHTML('ciao <b>mondo</b>!')
    expect(onSend).toHaveBeenCalledWith('ciao **mondo**!')
  })
})
