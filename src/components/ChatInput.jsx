import React, { useState } from 'react'
import '../styles/chat.css'

/**
 * Message composition input at the bottom of the chat area.
 * Submits on Enter (Shift+Enter for newline).
 *
 * @param {function} onSend  Called with the trimmed message string
 */
export default function ChatInput({ onSend }) {
  const [text, setText] = useState('')

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

  return (
    <form className="chat-input-form" onSubmit={handleSubmit}>
      <textarea
        className="chat-input-field"
        placeholder="Type a message…  (Enter to send)"
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
    </form>
  )
}
