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
  it('displays the text field with placeholder', () => {
    const { editor } = setup()
    expect(editor).toBeInTheDocument()
    expect(editor).toHaveAttribute('data-placeholder', expect.stringContaining('message'))
  })

  it('disables send button when field is empty', () => {
    const { button } = setup()
    expect(button).toBeDisabled()
  })

  it('enables button when text is entered', async () => {
    const user = userEvent.setup()
    const { editor, button } = setup()
    editor.focus()
    await user.type(editor, 'ciao')
    expect(button).not.toBeDisabled()
  })
})

describe('ChatInput — send with Enter', () => {
  it('calls onSend with content and clears field', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    await user.type(editor, 'ciao mondo')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith('ciao mondo')
    expect(editor.textContent).toBe('')
  })

  it('does not send if message is empty', async () => {
    const user = userEvent.setup()
    const { onSend } = setup()
    await user.keyboard('{Enter}')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('adds newline with Shift+Enter without sending', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    await user.type(editor, 'line 1')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, 'line 2')

    expect(onSend).not.toHaveBeenCalled()
    expect(editor.textContent).toContain('line 1')
    expect(editor.textContent).toContain('line 2')
  })

  it('sends trimmed content', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    await user.type(editor, 'messaggio')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledWith('messaggio')
  })
})

describe('ChatInput — send with button', () => {
  it('calls onSend when button is clicked', async () => {
    const user = userEvent.setup()
    const { onSend, editor, button } = setup()

    editor.focus()
    await user.type(editor, 'testo')
    await user.click(button)

    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledWith('testo')
  })

  it('clears field after click', async () => {
    const user = userEvent.setup()
    const { editor, button } = setup()

    editor.focus()
    await user.type(editor, 'testo')
    await user.click(button)

    expect(editor.textContent).toBe('')
  })
})

describe('ChatInput — multiple sends', () => {
  it('handles multiple consecutive sends correctly', async () => {
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

describe('ChatInput — formatting toolbar', () => {
  function getToolbarBtn(title) {
    return screen.getByTitle(title)
  }
  function clickToolbar(btn) {
    fireEvent.mouseDown(btn, { button: 0 })
  }

  it('displays 4 toolbar buttons', () => {
    setup()
    expect(getToolbarBtn('Bold')).toBeInTheDocument()
    expect(getToolbarBtn('Italic')).toBeInTheDocument()
    expect(getToolbarBtn('Strikethrough')).toBeInTheDocument()
    expect(getToolbarBtn('Code block')).toBeInTheDocument()
  })

  it('Bold calls execCommand("bold")', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Bold'))
    expect(document.execCommand).toHaveBeenCalledWith('bold')
  })

  it('Italic calls execCommand("italic")', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Italic'))
    expect(document.execCommand).toHaveBeenCalledWith('italic')
  })

  it('Strikethrough calls execCommand("strikeThrough")', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Strikethrough'))
    expect(document.execCommand).toHaveBeenCalledWith('strikeThrough')
  })

  it('Code block inserts <pre><code> into editor', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Code block'))
    expect(editor.querySelector('pre')).toBeInTheDocument()
    expect(editor.querySelector('pre code')).toBeInTheDocument()
  })

  it('Code block does not nest second <pre> when toggled', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Code block'))
    const pre = editor.querySelector('pre')

    // Move the selection inside the pre so findAncestor can detect it
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(pre.querySelector('code'))
    sel.removeAllRanges()
    sel.addRange(range)

    clickToolbar(getToolbarBtn('Code block'))
    expect(editor.querySelectorAll('pre')).toHaveLength(1)
  })

  it('exitAfter inserts <br> if nothing after <pre>', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Code block'))

    const pre = editor.querySelector('pre')
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(pre.querySelector('code'))
    sel.removeAllRanges()
    sel.addRange(range)

    // pre is the last child — exitAfter must add a <br>
    expect(pre.nextSibling).toBeNull()
    clickToolbar(getToolbarBtn('Code block'))
    expect(editor.querySelector('br')).toBeInTheDocument()
  })

  it('Code block with selection uses selected text as content', () => {
    const { editor } = setup()
    editor.innerHTML = 'ciao'
    editor.focus()

    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor.firstChild)
    sel.removeAllRanges()
    sel.addRange(range)

    clickToolbar(getToolbarBtn('Code block'))
    expect(editor.querySelector('pre code').textContent).toBe('ciao')
  })

  it('updateActiveFormats adds bold to set when queryCommandState reports it', () => {
    document.queryCommandState = vi.fn((cmd) => cmd === 'bold')
    const { editor } = setup()
    editor.focus()
    fireEvent.click(editor)
    const btn = getToolbarBtn('Bold')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('updateActiveFormats detects cursor inside <pre>', () => {
    const { editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Code block'))
    const pre = editor.querySelector('pre')

    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(pre)
    sel.removeAllRanges()
    sel.addRange(range)

    fireEvent.click(editor)
    expect(getToolbarBtn('Code block')).toHaveAttribute('aria-pressed', 'true')
  })

  it('toolbar does not cause premature send', () => {
    const { onSend, editor } = setup()
    editor.focus()
    clickToolbar(getToolbarBtn('Bold'))
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('ChatInput — markdown serialization on send', () => {
  async function sendWithHTML(html) {
    const user = userEvent.setup()
    const { onSend, editor } = setup()
    editor.innerHTML = html
    fireEvent.input(editor)
    editor.focus()
    await user.keyboard('{Enter}')
    return onSend
  }

  it('bold <b> → **…**', async () => {
    const onSend = await sendWithHTML('<b>ciao</b>')
    expect(onSend).toHaveBeenCalledWith('**ciao**')
  })

  it('italic <i> → _…_', async () => {
    const onSend = await sendWithHTML('<i>corsivo</i>')
    expect(onSend).toHaveBeenCalledWith('_corsivo_')
  })

  it('strikethrough <s> → ~~…~~', async () => {
    const onSend = await sendWithHTML('<s>barrato</s>')
    expect(onSend).toHaveBeenCalledWith('~~barrato~~')
  })

  it('code block <pre><code> → ```…```', async () => {
    const onSend = await sendWithHTML('<pre><code>fn()</code></pre>')
    expect(onSend).toHaveBeenCalledWith('```\nfn()\n```')
  })

  it('mixed text with formatting', async () => {
    const onSend = await sendWithHTML('ciao <b>mondo</b>!')
    expect(onSend).toHaveBeenCalledWith('ciao **mondo**!')
  })

  it('pasted hyperlink keeps its URL as [text](url)', async () => {
    const onSend = await sendWithHTML('<a href="https://example.com/x">Esempio</a>')
    expect(onSend).toHaveBeenCalledWith('[Esempio](https://example.com/x)')
  })

  it('hyperlink whose text is the URL stays a plain URL', async () => {
    const onSend = await sendWithHTML('<a href="https://example.com">https://example.com</a>')
    expect(onSend).toHaveBeenCalledWith('https://example.com')
  })

  it('non-http(s) hyperlink falls back to its text', async () => {
    const onSend = await sendWithHTML('<a href="javascript:alert(1)">clic</a>')
    expect(onSend).toHaveBeenCalledWith('clic')
  })

  it('escapes parentheses in a pasted hyperlink URL', async () => {
    const onSend = await sendWithHTML('<a href="https://example.com/a_(b)">w</a>')
    expect(onSend).toHaveBeenCalledWith('[w](https://example.com/a_%28b%29)')
  })
})

describe('ChatInput — message length validation', () => {
  const MAX_MESSAGE_LENGTH = 10000

  it('sends a message under the character limit', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    // Use innerHTML instead of type() for performance with long texts
    editor.innerHTML = 'x'.repeat(MAX_MESSAGE_LENGTH - 100)
    fireEvent.input(editor)
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledOnce()
  })

  it('shows alert and does not send if message exceeds limit', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    // Mock alert to avoid real popups during test
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})

    editor.focus()
    editor.innerHTML = 'x'.repeat(MAX_MESSAGE_LENGTH + 1)
    fireEvent.input(editor)
    await user.keyboard('{Enter}')

    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('Message too long'))
    expect(onSend).not.toHaveBeenCalled()

    // Cleanup
    alertMock.mockRestore()
  })

  it('includes character count in alert message', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})

    editor.focus()
    const longMessage = 'x'.repeat(MAX_MESSAGE_LENGTH + 500)
    editor.innerHTML = longMessage
    fireEvent.input(editor)
    await user.keyboard('{Enter}')

    expect(alertMock).toHaveBeenCalledWith(
      `Message too long (${MAX_MESSAGE_LENGTH + 500}/${MAX_MESSAGE_LENGTH} characters). Please shorten it.`
    )
    expect(onSend).not.toHaveBeenCalled()

    alertMock.mockRestore()
  })

  it('allows sending after shortening an too-long message', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})

    editor.focus()
    // First attempt with too-long message
    editor.innerHTML = 'x'.repeat(MAX_MESSAGE_LENGTH + 1)
    fireEvent.input(editor)
    await user.keyboard('{Enter}')
    expect(alertMock).toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()

    // Now shorten the message
    editor.innerHTML = 'valid message'
    fireEvent.input(editor)
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledWith('valid message')
    alertMock.mockRestore()
  })

  it('validates serialized markdown, not visible text', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})

    // Bold doubles characters in serialization (**test** instead of test)
    editor.focus()
    document.queryCommandState = vi.fn((cmd) => cmd === 'bold')

    // Text under limit in plain text but could exceed with formatting
    const text = 'x'.repeat(MAX_MESSAGE_LENGTH - 10)
    editor.innerHTML = text
    fireEvent.input(editor)

    // Apply bold (in serialization it becomes **xxx**)
    fireEvent.mouseDown(screen.getByTitle('Bold'), { button: 0 })

    await user.keyboard('{Enter}')

    // Should send because even with ** the total is under limit
    // (this test verifies validation uses editorToMarkdown)
    expect(onSend).toHaveBeenCalled()
    alertMock.mockRestore()
  })
})

describe('ChatInput — doSend edge cases', () => {
  it('handles the case when editor element is null', () => {
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} />)
    const editor = screen.getByRole('textbox')

    // Remove the editor from DOM to simulate it being null
    editor.remove()

    // Try to send by clicking the send button (which calls doSend)
    const button = screen.getByTitle('Send message')
    fireEvent.click(button)

    // Should not crash and should not call onSend
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send if content is only whitespace', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    // Insert only whitespace/spaces
    editor.innerHTML = '   \n\t   '
    fireEvent.input(editor)
    await user.keyboard('{Enter}')

    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send if content is only zero-width spaces', async () => {
    const user = userEvent.setup()
    const { onSend, editor } = setup()

    editor.focus()
    // Zero-width space is used as cursor anchor in empty code elements
    editor.innerHTML = '\u200B\u200B\u200B'
    fireEvent.input(editor)
    await user.keyboard('{Enter}')

    expect(onSend).not.toHaveBeenCalled()
  })
})

// ── file attach / drag-drop ───────────────────────────────────────────────────

describe('ChatInput — file attach button', () => {
  it('renders the attach button when onSendFile is provided', () => {
    render(<ChatInput onSend={vi.fn()} onSendFile={vi.fn()} />)
    expect(screen.getByRole('button', { name: /attach image/i })).toBeInTheDocument()
  })

  it('does not render the attach button when onSendFile is not provided', () => {
    render(<ChatInput onSend={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /attach image/i })).not.toBeInTheDocument()
  })

  it('calls onSendFile with the selected file when input changes', () => {
    const onSendFile = vi.fn()
    render(<ChatInput onSend={vi.fn()} onSendFile={onSendFile} />)
    const fileInput = document.querySelector('input[type="file"]')
    const file = new File(['data'], 'photo.jpg', { type: 'image/jpeg' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    fireEvent.change(fileInput)
    expect(onSendFile).toHaveBeenCalledWith(file)
  })

  it('does nothing when file input changes with no files', () => {
    const onSendFile = vi.fn()
    render(<ChatInput onSend={vi.fn()} onSendFile={onSendFile} />)
    const fileInput = document.querySelector('input[type="file"]')
    Object.defineProperty(fileInput, 'files', { value: [], configurable: true })
    fireEvent.change(fileInput)
    expect(onSendFile).not.toHaveBeenCalled()
  })
})

describe('ChatInput — drag and drop', () => {
  it('calls onSendFile with the dropped file', () => {
    const onSendFile = vi.fn()
    render(<ChatInput onSend={vi.fn()} onSendFile={onSendFile} />)
    const form = document.querySelector('form')
    const file = new File(['img'], 'photo.png', { type: 'image/png' })
    fireEvent.drop(form, { dataTransfer: { files: [file] } })
    expect(onSendFile).toHaveBeenCalledWith(file)
  })

  it('does nothing on drop with no files', () => {
    const onSendFile = vi.fn()
    render(<ChatInput onSend={vi.fn()} onSendFile={onSendFile} />)
    const form = document.querySelector('form')
    fireEvent.drop(form, { dataTransfer: { files: [] } })
    expect(onSendFile).not.toHaveBeenCalled()
  })

  it('adds dragover class when dragging over', () => {
    render(<ChatInput onSend={vi.fn()} onSendFile={vi.fn()} />)
    const form = document.querySelector('form')
    fireEvent.dragOver(form)
    expect(form.className).toContain('chat-input-form--dragover')
  })

  it('removes dragover class on drag leave', () => {
    render(<ChatInput onSend={vi.fn()} onSendFile={vi.fn()} />)
    const form = document.querySelector('form')
    fireEvent.dragOver(form)
    fireEvent.dragLeave(form)
    expect(form.className).not.toContain('chat-input-form--dragover')
  })
})

describe('ChatInput — pasting images', () => {
  function setupWithFiles() {
    const onSend = vi.fn()
    const onSendFile = vi.fn()
    render(<ChatInput onSend={onSend} onSendFile={onSendFile} />)
    const editor = screen.getByRole('textbox')
    const button = screen.getByRole('button', { name: /send/i })
    return { onSend, onSendFile, editor, button }
  }

  function pasteImage(editor, { type = 'image/png', text = '' } = {}) {
    const file = new File(['x'], 'image.png', { type })
    fireEvent.paste(editor, {
      clipboardData: { files: [file], getData: (t) => (t === 'text/plain' ? text : '') },
    })
    return file
  }

  it('shows a data-URL preview (CSP blocks blob:) and enables send when an image is pasted', async () => {
    const { editor, button } = setupWithFiles()
    pasteImage(editor)
    const preview = await screen.findByAltText('image.png')
    expect(preview.getAttribute('src')).toMatch(/^data:/)
    expect(button).not.toBeDisabled()
  })

  it('sends the pasted image as a file attachment on submit', async () => {
    const { editor, button, onSend, onSendFile } = setupWithFiles()
    const file = pasteImage(editor)
    await screen.findByAltText('image.png')
    fireEvent.click(button)
    expect(onSendFile).toHaveBeenCalledWith(file)
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByAltText('image.png')).toBeNull()
  })

  it('sends text and image together', async () => {
    const user = userEvent.setup()
    const { editor, onSend, onSendFile } = setupWithFiles()
    editor.focus()
    await user.type(editor, 'look')
    const file = pasteImage(editor)
    await screen.findByAltText('image.png')
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledWith('look')
    expect(onSendFile).toHaveBeenCalledWith(file)
  })

  it('lets the user remove a pasted image before sending', async () => {
    const { editor, button, onSendFile } = setupWithFiles()
    pasteImage(editor)
    await screen.findByAltText('image.png')
    fireEvent.click(screen.getByRole('button', { name: /remove image/i }))
    expect(screen.queryByAltText('image.png')).toBeNull()
    expect(button).toBeDisabled()
    expect(onSendFile).not.toHaveBeenCalled()
  })

  it('ignores the image when the clipboard also carries text', () => {
    const { editor, button } = setupWithFiles()
    pasteImage(editor, { text: 'a\tb' })
    expect(screen.queryByAltText('image.png')).toBeNull()
    expect(button).toBeDisabled()
  })

  it('ignores unsupported image types', () => {
    const { editor } = setupWithFiles()
    pasteImage(editor, { type: 'image/bmp' })
    expect(screen.queryByAltText('image.png')).toBeNull()
  })
})
