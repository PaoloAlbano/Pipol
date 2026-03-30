import { useEffect, useRef, useMemo } from 'react'
import b4a from 'b4a'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import '../styles/chat.css'

// Configure marked once: GFM (~~strike~~, `code`) + single newline → <br>
marked.use({ breaks: true, gfm: true })

// Only allow safe inline/block elements — no iframes, scripts, or styles
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
  ],
  ALLOWED_ATTR: [],
}

function renderMarkdown(content) {
  const raw = marked.parse(content)
  return DOMPurify.sanitize(raw, PURIFY_CONFIG)
}

/**
 * Renders the scrollable list of chat messages.
 * Message content is parsed as Markdown (GFM subset, sanitized).
 * Auto-scrolls to the bottom when new messages arrive.
 */
export default function ChatMessages({ messages, identity }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
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
          <div
            key={msg.id}
            className={`message-row ${isOwn ? 'message-row--own' : 'message-row--remote'}`}
          >
            <div className="message-bubble">
              {!isOwn && <span className="message-sender">{displayName}</span>}
              <MessageContent content={msg.content} />
              <span className="message-time">{formatTime(msg.timestamp)}</span>
            </div>
          </div>
        )
      })}
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
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

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
