import { useState, useRef, useEffect } from 'react'
import '../styles/chat.css'

// Maximum message length (prevents DoS and abuse)
const MAX_MESSAGE_LENGTH = 10000

// execCommand-based commands toggle a "pending format" mode — subsequent typing
// is wrapped automatically. For code/pre there is no native command, so we
// insert an empty element and place the cursor inside.
const TOOLBAR = [
  { label: 'B', title: 'Bold', className: 'toolbar-btn--bold', command: 'bold', tag: null },
  { label: 'I', title: 'Italic', className: 'toolbar-btn--italic', command: 'italic', tag: null },
  {
    label: 'S',
    title: 'Strikethrough',
    className: 'toolbar-btn--strike',
    command: 'strikeThrough',
    tag: null,
  },
  { label: '</>', title: 'Code block', className: 'toolbar-btn--mono', command: null, tag: 'pre' },
]

// Serialize the editor's DOM tree back to markdown for sending
function serializeNode(node) {
  // Strip zero-width spaces used as cursor anchors in empty code elements
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\u200B/g, '')
  const tag = node.tagName?.toLowerCase()
  const children = Array.from(node.childNodes).map(serializeNode).join('')
  switch (tag) {
    case 'strong':
    case 'b':
      return `**${children}**`
    case 'em':
    case 'i':
      return `_${children}_`
    case 'del':
    case 's':
    case 'strike':
      return `~~${children}~~`
    case 'code':
      if (node.parentNode?.tagName?.toLowerCase() === 'pre') return children
      return `\`${children}\``
    case 'pre':
      return `\`\`\`\n${children}\n\`\`\``
    case 'br':
      return '\n'
    case 'div':
      return '\n' + children
    default:
      return children
  }
}

function editorToMarkdown(el) {
  return Array.from(el.childNodes).map(serializeNode).join('').trim()
}

function findAncestor(node, tag, boundary) {
  let current = node
  while (current && current !== boundary) {
    if (current.tagName?.toLowerCase() === tag) return current
    current = current.parentNode
  }
  return null
}

function exitAfter(el, sel) {
  // Ensure there is a node after the element to land on (needed when el is the
  // last child — otherwise the cursor stays visually glued to the block end)
  if (!el.nextSibling) {
    el.parentNode.insertBefore(document.createElement('br'), null)
  }
  const range = document.createRange()
  range.setStartAfter(el)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * Message composition input.
 * - Enter sends, Shift+Enter inserts a newline.
 * - Formatting toolbar (visible on focus): bold, italic, strikethrough,
 *   inline code, code block.
 * - Toolbar buttons stay highlighted while the cursor is inside that format.
 */
/**
 * Returns the @word being typed immediately before the cursor, or null.
 */
function getMentionQuery(editor) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !editor.contains(sel.anchorNode)) return null
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return null
  const pre = range.cloneRange()
  pre.selectNodeContents(editor)
  pre.setEnd(range.endContainer, range.endOffset)
  const m = pre.toString().match(/\B@(\w*)$/)
  return m ? m[1] : null
}

export default function ChatInput({ onSend, onTyping, peers = [] }) {
  const [hasContent, setHasContent] = useState(false)
  const [activeFormats, setActiveFormats] = useState(new Set())
  const [mentionQuery, setMentionQuery] = useState(null) // string | null
  const [mentionIdx, setMentionIdx] = useState(0)
  const editorRef = useRef(null)
  const dropdownRef = useRef(null)

  const mentionMatches =
    mentionQuery !== null ? peers.filter((p) => p.username?.toLowerCase().startsWith(mentionQuery.toLowerCase())) : []

  // Clear dropdown on outside click
  useEffect(() => {
    if (mentionQuery === null) return
    function onPointerDown(e) {
      if (!dropdownRef.current?.contains(e.target) && !editorRef.current?.contains(e.target)) {
        setMentionQuery(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [mentionQuery])

  // On touch-only devices there is no physical keyboard, so the Shift+Enter
  // hint is irrelevant. matchMedia with 'pointer: fine' is the most reliable
  // cross-browser signal for "this device has a mouse/trackpad" (i.e. desktop).
  const hasFinePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: fine)').matches
  const placeholder = hasFinePointer ? 'Type a message…  (Enter to send, Shift+Enter for new line)' : 'Type a message…'

  function updateActiveFormats() {
    const editor = editorRef.current
    if (!editor) return
    const next = new Set()
    try {
      if (document.queryCommandState('bold')) next.add('bold')
      if (document.queryCommandState('italic')) next.add('italic')
      if (document.queryCommandState('strikeThrough')) next.add('strikeThrough')
    } catch {
      /* not supported */
    }
    // Walk DOM to detect cursor inside code / pre
    const sel = window.getSelection()
    if (sel?.anchorNode) {
      let node = sel.anchorNode
      while (node && node !== editor) {
        const t = node.tagName?.toLowerCase()
        if (t === 'code' && node.parentNode?.tagName?.toLowerCase() !== 'pre') next.add('code')
        if (t === 'pre') next.add('pre')
        node = node.parentNode
      }
    }
    setActiveFormats(next)
  }

  function handleInput() {
    const el = editorRef.current
    setHasContent(!!el && el.textContent.trim() !== '')
    updateActiveFormats()
    onTyping?.()
    const query = getMentionQuery(el)
    setMentionQuery(query)
    setMentionIdx(0)
  }

  function insertMention(username) {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const textNode = range.endContainer
    if (textNode.nodeType !== Node.TEXT_NODE) return
    const text = textNode.textContent
    const atPos = text.lastIndexOf('@', range.endOffset - 1)
    if (atPos === -1) return
    const newRange = document.createRange()
    newRange.setStart(textNode, atPos)
    newRange.setEnd(textNode, range.endOffset)
    sel.removeAllRanges()
    sel.addRange(newRange)
    document.execCommand('insertText', false, `@${username} `)
    setMentionQuery(null)
    setMentionIdx(0)
  }

  function handleKeyDown(e) {
    if (mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIdx((i) => (i + 1) % mentionMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(mentionMatches[mentionIdx].username)
        return
      }
      if (e.key === 'Escape') {
        setMentionQuery(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  function doSend() {
    const el = editorRef.current
    if (!el) return
    const content = editorToMarkdown(el)
    if (!content.trim()) return
    if (content.length > MAX_MESSAGE_LENGTH) {
      alert(`Message too long (${content.length}/${MAX_MESSAGE_LENGTH} characters). Please shorten it.`)
      return
    }
    onSend(content)
    el.innerHTML = ''
    setHasContent(false)
    setActiveFormats(new Set())
  }

  function handleToolbarClick(e, btn) {
    e.preventDefault()
    const editor = editorRef.current
    if (!editor) return
    editor.focus()

    if (btn.command) {
      // execCommand toggles format mode; browser handles wrapping typed text
      document.execCommand(btn.command)
    } else {
      // code / pre — insert empty element and place cursor inside
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)

      // Toggle off: if already inside a <pre>, move cursor after it
      const existingPre = findAncestor(sel.anchorNode, 'pre', editor)
      if (existingPre) {
        exitAfter(existingPre, sel)
      } else {
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        if (range.collapsed) {
          code.textContent = '\u200B'
        } else {
          code.textContent = range.toString()
          range.deleteContents()
        }
        pre.appendChild(code)
        range.insertNode(pre)
        const newRange = document.createRange()
        newRange.setStart(code.firstChild, code.firstChild.length)
        newRange.collapse(true)
        sel.removeAllRanges()
        sel.addRange(newRange)
      }
    }

    updateActiveFormats()
    setHasContent((editorRef.current?.textContent ?? '').trim() !== '')
  }

  return (
    <form
      className="chat-input-form"
      onSubmit={(e) => {
        e.preventDefault()
        doSend()
      }}
    >
      {/* @mention autocomplete dropdown */}
      {mentionMatches.length > 0 && (
        <ul className="mention-dropdown" ref={dropdownRef} role="listbox" aria-label="Mention suggestions">
          {mentionMatches.map((peer, i) => (
            <li
              key={peer.username}
              className={`mention-dropdown-item${i === mentionIdx ? ' mention-dropdown-item--active' : ''}`}
              role="option"
              aria-selected={i === mentionIdx}
              onPointerDown={(e) => {
                e.preventDefault()
                insertMention(peer.username)
              }}
            >
              @{peer.username}
            </li>
          ))}
        </ul>
      )}

      <div className="chat-input-wrapper">
        <div className="chat-input-toolbar" role="toolbar" aria-label="Formatting">
          {TOOLBAR.map((btn) => {
            const active = activeFormats.has(btn.command ?? btn.tag)
            return (
              <button
                key={btn.label}
                type="button"
                className={`toolbar-btn ${btn.className}${active ? ' toolbar-btn--active' : ''}`}
                title={btn.title}
                data-tooltip={btn.title}
                aria-pressed={active}
                onMouseDown={(e) => handleToolbarClick(e, btn)}
              >
                {btn.label}
              </button>
            )
          })}
        </div>

        <div className="chat-input-row">
          <div
            ref={editorRef}
            className={`chat-input-field${hasContent ? '' : ' chat-input-field--empty'}`}
            contentEditable
            role="textbox"
            aria-multiline="true"
            aria-label="Message input"
            data-placeholder={placeholder}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onKeyUp={updateActiveFormats}
            onClick={updateActiveFormats}
            suppressContentEditableWarning
          />
          <button className="chat-send-btn" type="submit" disabled={!hasContent} title="Send message" aria-label="Send">
            ↑
          </button>
        </div>
      </div>
    </form>
  )
}
