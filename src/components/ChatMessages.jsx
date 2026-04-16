import { useEffect, useRef, useMemo } from 'react'
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
 */
export default function ChatMessages({ messages, identity, typingUsers = [] }) {
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
        return (
          <div key={msg.id} className={`message-row ${isOwn ? 'message-row--own' : 'message-row--remote'}`}>
            <div className="message-bubble">
              {!isOwn && <span className="message-sender">{displayName}</span>}
              <MessageContent content={msg.content} />
              <span className="message-time">{formatTime(msg.timestamp)}</span>
            </div>
          </div>
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
