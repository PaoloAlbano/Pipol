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
 * @param {object[]} messages
 * @param {object}   identity
 * @param {string[]} [typingUsers]   Usernames of peers currently typing
 * @param {object[]} [peers]         Peer list (unused currently, reserved for future)
 * @param {Map}      [reactions]     messageId → Map<emoji, Set<userPubkeyHex>>
 * @param {function} [onReact]       (messageId, emoji) => void
 * @param {function} [onEdit]        (messageId, newContent) => void
 * @param {function} [onDelete]      (messageId) => void
 */
export default function ChatMessages({ messages, identity, typingUsers = [], reactions = new Map(), onReact, onEdit, onDelete }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, typingUsers])

  if (messages.length === 0 && typingUsers.length === 0) {
    return (
      <div className="messages-empty">
        <p>No messages yet. Say hello! 👋</p>
      </div>
    )
  }

  return (
    <div className="messages-list">
      {messages.map((msg) => {
        const isOwn = msg.publicKey === b4a.toString(identity.publicKey, 'hex')
        const displayName = isOwn ? identity.username : msg.username
        const msgReactions = reactions.get(msg.id)
        const myPubkey = b4a.toString(identity.publicKey, 'hex')
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

function MessageRow({ msg, isOwn, displayName, msgReactions, myPubkey, onReact, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
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
              <span className="message-edit-hint">Esc to <button className="message-edit-link" onClick={cancelEdit}>cancel</button> · Enter to save</span>
              <button className="message-edit-save" onClick={confirmEdit}>Save</button>
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
              />
              <span className="message-image-name">{msg.fileName}</span>
            </div>
            {onReact && <ReactionPicker messageId={msg.id} onReact={onReact} myPubkey={myPubkey} />}
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

        {/* Hover actions — only for own non-deleted messages, hidden while editing */}
        {isOwn && !editing && (onEdit || onDelete) && (
          <div className="message-actions" aria-label="Message actions">
            {onEdit && (
              <button
                className="message-action-btn"
                onClick={startEdit}
                title="Edit message"
                aria-label="Edit message"
              >
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
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onOutside(e) {
      if (!ref.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  return (
    <div className="reaction-picker-wrap" ref={ref}>
      <button
        className="reaction-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add reaction"
        title="Add reaction"
      >
        😊
      </button>
      {open && (
        <div className="reaction-picker" role="listbox" aria-label="Pick a reaction">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              className="reaction-picker__emoji"
              onClick={() => { onReact(messageId, emoji); setOpen(false) }}
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
