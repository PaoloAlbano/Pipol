import { useEffect, useRef, useMemo, useState } from 'react'
import b4a from 'b4a'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import '../styles/chat.css'

// Configure marked once: GFM (~~strike~~, `code`) + single newline → <br>
marked.use({ breaks: true, gfm: true })

// Allow mark tag for @mention highlighting
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'del',
    's',
    'code',
    'pre',
    'ul',
    'ol',
    'li',
    'blockquote',
    'mark',
  ],
  ALLOWED_ATTR: ['class'],
}

function renderMarkdown(content) {
  const raw = marked.parse(content)
  const sanitized = DOMPurify.sanitize(raw, PURIFY_CONFIG)
  // Highlight @mentions — safe to do after DOMPurify since < in text is already &lt;
  return sanitized.replace(/>([^<]+)</g, (match, text) => {
    const highlighted = text.replace(/\B@([\w-]+)/g, '<mark class="mention">@$1</mark>')
    return `>${highlighted}<`
  })
}

/**
 * Renders the scrollable list of chat messages.
 * Message content is parsed as Markdown (GFM subset, sanitized).
 * Auto-scrolls to the bottom when new messages arrive.
 *
 * @param {object[]} messages        All messages (root + replies). Root-only messages are shown in the list.
 * @param {object}   identity
 * @param {string[]} [typingUsers]   Usernames of peers currently typing
 * @param {object[]} [peers]         Peer list (unused currently, reserved for future)
 * @param {Map}      [reactions]     messageId → Map<emoji, Set<userPubkeyHex>>
 * @param {function} [onReact]       (messageId, emoji) => void
 * @param {function} [onEdit]        (messageId, newContent) => void
 * @param {function} [onDelete]      (messageId) => void
 * @param {function} [onOpenThread]  (message) => void — open thread panel for a message
 */
export default function ChatMessages({
  messages,
  identity,
  typingUsers = [],
  reactions = new Map(),
  onReact,
  onEdit,
  onDelete,
  onOpenThread,
}) {
  const bottomRef = useRef(null)

  // Only root messages (no parentId) appear in the main list.
  // Reply counts are derived from messages that have a parentId.
  const rootMessages = messages.filter((m) => !m.parentId)
  const replyCounts = useMemo(() => {
    const counts = new Map()
    for (const m of messages) {
      if (m.parentId) counts.set(m.parentId, (counts.get(m.parentId) || 0) + 1)
    }
    return counts
  }, [messages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typingUsers])

  if (rootMessages.length === 0 && typingUsers.length === 0) {
    return (
      <div className="messages-empty">
        <p>No messages yet. Say hello! 👋</p>
      </div>
    )
  }

  return (
    <div className="messages-list">
      {rootMessages.map((msg) => {
        const isOwn = msg.publicKey === b4a.toString(identity.publicKey, 'hex')
        const displayName = isOwn ? identity.username : msg.username
        const msgReactions = reactions.get(msg.id)
        const myPubkey = b4a.toString(identity.publicKey, 'hex')
        const replyCount = replyCounts.get(msg.id) || 0
        return (
          <MessageRow
            key={msg.id}
            msg={msg}
            isOwn={isOwn}
            displayName={displayName}
            msgReactions={msgReactions}
            myPubkey={myPubkey}
            onReact={onReact}
            onEdit={onEdit}
            onDelete={onDelete}
            replyCount={replyCount}
            onOpenThread={onOpenThread}
          />
        )
      })}

      {/* Typing indicator */}
      {typingUsers.length > 0 && (
        <div className="typing-indicator" aria-live="polite" aria-label={`${typingUsers.join(', ')} is typing`}>
          <span className="typing-indicator__dots">
            <span />
            <span />
            <span />
          </span>
          <span className="typing-indicator__text">
            {typingUsers.length === 1
              ? `${typingUsers[0]} is typing…`
              : typingUsers.length === 2
                ? `${typingUsers[0]} and ${typingUsers[1]} are typing…`
                : 'Several people are typing…'}
          </span>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}

function MessageContent({ content }) {
  const html = useMemo(() => renderMarkdown(content), [content])
  return <span className="message-content" dangerouslySetInnerHTML={{ __html: html }} />
}

// ── MessageRow ────────────────────────────────────────────────────────────────

function MessageRow({
  msg,
  isOwn,
  displayName,
  msgReactions,
  myPubkey,
  onReact,
  onEdit,
  onDelete,
  replyCount = 0,
  onOpenThread,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [lightbox, setLightbox] = useState(false)
  const textareaRef = useRef(null)

  // Focus textarea when edit mode opens
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
    }
  }, [editing])

  function startEdit() {
    setDraft(msg.content)
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setDraft(msg.content)
  }

  function confirmEdit() {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === msg.content) {
      cancelEdit()
      return
    }
    onEdit?.(msg.id, trimmed)
    setEditing(false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      confirmEdit()
    } else if (e.key === 'Escape') {
      cancelEdit()
    }
  }

  if (msg.deleted) {
    return (
      <div className={`message-row ${isOwn ? 'message-row--own' : 'message-row--remote'}`}>
        <div className="message-bubble message-bubble--deleted">
          <span className="message-deleted-label">Message deleted</span>
          <span className="message-time">{formatTime(msg.timestamp)}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`message-row ${isOwn ? 'message-row--own' : 'message-row--remote'}`}>
      <div className="message-bubble">
        {!isOwn && <span className="message-sender">{displayName}</span>}

        {editing ? (
          <div className="message-edit-wrap">
            <textarea
              ref={textareaRef}
              className="message-edit-textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={Math.min(6, draft.split('\n').length + 1)}
            />
            <div className="message-edit-actions">
              <span className="message-edit-hint">
                Esc to{' '}
                <button className="message-edit-link" onClick={cancelEdit}>
                  cancel
                </button>{' '}
                · Enter to save
              </span>
              <button className="message-edit-save" onClick={confirmEdit}>
                Save
              </button>
            </div>
          </div>
        ) : msg.type === 'image' ? (
          <div className="message-bubble__body">
            <div className="message-image-wrap">
              <img
                src={msg.imageData}
                alt={msg.fileName ?? 'image'}
                className="message-image"
                loading="lazy"
                onClick={() => setLightbox(true)}
              />
              <span className="message-image-name">{msg.fileName}</span>
            </div>
            {onReact && <ReactionPicker messageId={msg.id} onReact={onReact} myPubkey={myPubkey} />}
            {lightbox && (
              <ImageLightbox src={msg.imageData} alt={msg.fileName ?? 'image'} onClose={() => setLightbox(false)} />
            )}
          </div>
        ) : (
          <div className="message-bubble__body">
            <MessageContent content={msg.content} />
            {onReact && <ReactionPicker messageId={msg.id} onReact={onReact} myPubkey={myPubkey} />}
          </div>
        )}

        <div className="message-meta">
          <span className="message-time">{formatTime(msg.timestamp)}</span>
          {msg.edited && <span className="message-edited-label">(edited)</span>}
        </div>

        {msgReactions && msgReactions.size > 0 && (
          <div className="message-reactions">
            {Array.from(msgReactions.entries()).map(([emoji, users]) => (
              <button
                key={emoji}
                className={`reaction-pill${users.has(myPubkey) ? ' reaction-pill--own' : ''}`}
                onClick={() => onReact?.(msg.id, emoji)}
                aria-label={`${emoji} ${users.size}`}
                title={`${users.size} reaction${users.size !== 1 ? 's' : ''}`}
              >
                {emoji} <span className="reaction-pill__count">{users.size}</span>
              </button>
            ))}
          </div>
        )}

        {/* Thread reply button — available on any non-deleted message */}
        {onOpenThread && !msg.deleted && (
          <button
            className={`message-thread-btn${replyCount > 0 ? ' message-thread-btn--has-replies' : ''}`}
            onClick={() => onOpenThread(msg)}
            aria-label={
              replyCount > 0
                ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}, open thread`
                : 'Reply in thread'
            }
          >
            💬 {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread'}
          </button>
        )}

        {/* Hover actions — only for own non-deleted messages, hidden while editing */}
        {isOwn && !editing && (onEdit || onDelete) && (
          <div className="message-actions" aria-label="Message actions">
            {onEdit && (
              <button className="message-action-btn" onClick={startEdit} title="Edit message" aria-label="Edit message">
                ✏️
              </button>
            )}
            {onDelete && (
              <button
                className="message-action-btn message-action-btn--danger"
                onClick={() => onDelete(msg.id)}
                title="Delete message"
                aria-label="Delete message"
              >
                🗑
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👀']

function ReactionPicker({ messageId, onReact }) {
  const [open, setOpen] = useState(false)
  const [pickerStyle, setPickerStyle] = useState({})
  const triggerRef = useRef(null)
  const pickerRef = useRef(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function onOutside(e) {
      if (!triggerRef.current?.contains(e.target) && !pickerRef.current?.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  // Reposition picker so it never overflows the viewport
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const PICKER_WIDTH = 280 // approximate max width of 8 emoji buttons
    const PICKER_HEIGHT = 44
    const GAP = 6
    const rect = triggerRef.current.getBoundingClientRect()
    const vw = window.innerWidth

    // Vertical: try above the trigger, fall back to below
    let top = rect.top - PICKER_HEIGHT - GAP
    if (top < 4) top = rect.bottom + GAP

    // Horizontal: centre on trigger, clamp to viewport edges with 8px margin
    let left = rect.left + rect.width / 2 - PICKER_WIDTH / 2
    if (left < 8) left = 8
    if (left + PICKER_WIDTH > vw - 8) left = vw - PICKER_WIDTH - 8

    setPickerStyle({ top: Math.round(top), left: Math.round(left) })
  }, [open])

  return (
    <div className="reaction-picker-wrap">
      <button
        ref={triggerRef}
        className="reaction-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add reaction"
        title="Add reaction"
      >
        😊
      </button>
      {open && (
        <div
          ref={pickerRef}
          className="reaction-picker reaction-picker--fixed"
          role="listbox"
          aria-label="Pick a reaction"
          style={pickerStyle}
        >
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              className="reaction-picker__emoji"
              onClick={() => {
                onReact(messageId, emoji)
                setOpen(false)
              }}
              aria-label={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function formatTime(ts) {
  const date = new Date(ts)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  const timePart = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })

  if (isToday) return timePart

  const datePart = date.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })

  return `${datePart} ${timePart}`
}

// ── ImageLightbox ─────────────────────────────────────────────────────────────

function ImageLightbox({ src, alt, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="lightbox-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Image preview">
      <img src={src} alt={alt} className="lightbox-img" onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-close" onClick={onClose} aria-label="Close image preview">
        ✕
      </button>
    </div>
  )
}
