import { useState, useRef, useEffect } from 'react'
import '../styles/chat.css'

// Static toolbar config — no closures over component state/refs
const TOOLBAR = [
  {
    label: 'B',
    title: 'Bold',
    className: 'toolbar-btn--bold',
    before: '**',
    after: '**',
    placeholder: 'text',
  },
  {
    label: 'I',
    title: 'Italic',
    className: 'toolbar-btn--italic',
    before: '_',
    after: '_',
    placeholder: 'text',
  },
  {
    label: 'S',
    title: 'Strikethrough',
    className: 'toolbar-btn--strike',
    before: '~~',
    after: '~~',
    placeholder: 'text',
  },
  { label: '`', title: 'Inline code', className: '', before: '`', after: '`', placeholder: 'code' },
  {
    label: '```',
    title: 'Code block',
    className: 'toolbar-btn--mono',
    before: null,
    after: null,
    placeholder: null,
  },
]

/**
 * Message composition input.
 * - Enter sends, Shift+Enter inserts a newline.
 * - Formatting toolbar (visible on focus): bold, italic, strikethrough,
 *   inline code, code block.
 */
export default function ChatInput({ onSend }) {
  const [text, setText] = useState('')
  const textareaRef = useRef(null)

  // Auto-resize: grow with content, show scrollbar only once max-height is hit
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.overflowY = 'hidden'
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    const maxH = parseInt(getComputedStyle(el).maxHeight, 10)
    el.style.overflowY = el.scrollHeight >= maxH ? 'auto' : 'hidden'
  }, [text])

  function handleSubmit(e) {
    e.preventDefault()
    const content = text.trim()
    if (!content) return
    onSend(content)
    setText('')
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      handleSubmit(e)
    }
  }

  function handleToolbarClick(e, btn) {
    // Prevent textarea from losing focus before we read the selection
    e.preventDefault()
    const el = textareaRef.current
    if (!el) return

    const start = el.selectionStart
    const end = el.selectionEnd

    let newText, selStart, selEnd

    if (btn.before === null) {
      // Code block
      const selected = text.slice(start, end) || 'code'
      const block = `\`\`\`\n${selected}\n\`\`\``
      newText = text.slice(0, start) + block + text.slice(end)
      selStart = start + 4
      selEnd = selStart + selected.length
    } else {
      const selected = text.slice(start, end) || btn.placeholder
      newText = text.slice(0, start) + btn.before + selected + btn.after + text.slice(end)
      selStart = start + btn.before.length
      selEnd = selStart + selected.length
    }

    setText(newText)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(selStart, selEnd)
    })
  }

  return (
    <form className="chat-input-form" onSubmit={handleSubmit}>
      <div className="chat-input-wrapper">
        <div className="chat-input-toolbar" role="toolbar" aria-label="Formatting">
          {TOOLBAR.map((btn) => (
            <button
              key={btn.label}
              type="button"
              className={`toolbar-btn ${btn.className}`}
              title={btn.title}
              data-tooltip={btn.title}
              onMouseDown={(e) => handleToolbarClick(e, btn)}
            >
              {btn.label}
            </button>
          ))}
        </div>

        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            className="chat-input-field"
            placeholder="Type a message…  (Enter to send, Shift+Enter for new line)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            className="chat-send-btn"
            type="submit"
            disabled={!text.trim()}
            title="Send message"
            aria-label="Send"
          >
            ↑
          </button>
        </div>
      </div>
    </form>
  )
}
