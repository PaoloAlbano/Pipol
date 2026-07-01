import React, { useRef, useEffect } from 'react'
import b4a from 'b4a'
import ChatInput from './ChatInput.jsx'
import '../styles/thread.css'

/**
 * ThreadPanel — right-side panel showing replies to a parent message.
 *
 * @param {object}   parentMessage   The message that was replied to
 * @param {object[]} replies         Messages with parentId === parentMessage.id
 * @param {object}   identity        { publicKey, username }
 * @param {object[]} peers           Online peers (passed to ChatInput for @mention)
 * @param {function} onClose
 * @param {function} onSendReply(content)
 */
export default function ThreadPanel({ parentMessage, replies = [], identity, peers = [], onClose, onSendReply }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [replies])

  if (!parentMessage) return null

  const myPubkey = b4a.toString(identity.publicKey, 'hex')

  return (
    <aside className="thread-panel" aria-label="Thread">
      <div className="thread-panel__header">
        <span className="thread-panel__title">Thread</span>
        <button className="thread-panel__close" onClick={onClose} aria-label="Close thread">
          ✕
        </button>
      </div>

      <div className="thread-panel__body">
        {/* Parent message */}
        <div className="thread-panel__parent">
          <span className="thread-panel__parent-sender">
            {parentMessage.publicKey === myPubkey ? identity.username : parentMessage.username}
          </span>
          <span className="thread-panel__parent-content">{parentMessage.content}</span>
          <span className="thread-panel__parent-time">{formatTime(parentMessage.timestamp)}</span>
        </div>

        {/* Reply count separator */}
        {replies.length > 0 && (
          <div
            className="thread-panel__reply-count"
            aria-label={`${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
          >
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </div>
        )}

        {/* Replies */}
        <div className="thread-panel__replies">
          {replies.map((msg) => {
            const isOwn = msg.publicKey === myPubkey
            return (
              <div key={msg.id} className={`thread-reply ${isOwn ? 'thread-reply--own' : 'thread-reply--remote'}`}>
                <span className="thread-reply__sender">{isOwn ? identity.username : msg.username}</span>
                <span className="thread-reply__content">{msg.content}</span>
                <span className="thread-reply__time">{formatTime(msg.timestamp)}</span>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="thread-panel__input">
        <ChatInput onSend={onSendReply} peers={peers} />
      </div>
    </aside>
  )
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
