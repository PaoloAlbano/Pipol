import React, { useEffect, useRef } from 'react'
import b4a from 'b4a'
import '../styles/chat.css'

/**
 * Renders the scrollable list of chat messages.
 * Auto-scrolls to the bottom when new messages arrive.
 *
 * @param {object[]} messages  Sorted array of message objects
 * @param {object}   identity  Local user identity (to distinguish own messages)
 */
export default function ChatMessages({ messages, identity }) {
  const bottomRef = useRef(null)

  // Scroll to bottom whenever messages update
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
              <span className="message-content">{msg.content}</span>
              <span className="message-time">{formatTime(msg.timestamp)}</span>
            </div>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
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
