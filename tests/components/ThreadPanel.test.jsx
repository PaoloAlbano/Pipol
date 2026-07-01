/**
 * ThreadPanel.test.jsx
 * Tests for the ThreadPanel component:
 *   - rendering parent message
 *   - rendering replies
 *   - reply count display
 *   - close button
 *   - sending a reply
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ThreadPanel from '../../src/components/ThreadPanel.jsx'

// Mock ChatInput to avoid contenteditable complexity in unit tests
vi.mock('../../src/components/ChatInput.jsx', () => ({
  default: ({ onSend }) => (
    <input
      data-testid="thread-input"
      placeholder="Reply…"
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSend(e.target.value)
      }}
    />
  ),
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MY_KEY_HEX = 'aabbccdd'
const OTHER_KEY_HEX = '11223344'

const identity = {
  username: 'alice',
  publicKey: Uint8Array.from(MY_KEY_HEX.match(/.{2}/g).map((b) => parseInt(b, 16))),
}

function makeMsg(overrides = {}) {
  return {
    id: `msg-${Math.random()}`,
    content: 'Hello',
    username: 'bob',
    publicKey: OTHER_KEY_HEX,
    timestamp: Date.now(),
    type: 'text',
    ...overrides,
  }
}

const parentMsg = makeMsg({ id: 'parent-1', content: 'This is the parent message', username: 'bob' })

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('ThreadPanel — rendering', () => {
  it('renders the "Thread" header', () => {
    render(
      <ThreadPanel parentMessage={parentMsg} replies={[]} identity={identity} onClose={vi.fn()} onSendReply={vi.fn()} />
    )
    expect(screen.getByText('Thread')).toBeInTheDocument()
  })

  it('renders the parent message content', () => {
    render(
      <ThreadPanel parentMessage={parentMsg} replies={[]} identity={identity} onClose={vi.fn()} onSendReply={vi.fn()} />
    )
    expect(screen.getByText('This is the parent message')).toBeInTheDocument()
  })

  it('renders the parent message sender name (remote)', () => {
    render(
      <ThreadPanel parentMessage={parentMsg} replies={[]} identity={identity} onClose={vi.fn()} onSendReply={vi.fn()} />
    )
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  it('renders own username for parent messages sent by us', () => {
    const ownParent = makeMsg({ id: 'own-parent', publicKey: MY_KEY_HEX, username: 'alice' })
    render(
      <ThreadPanel parentMessage={ownParent} replies={[]} identity={identity} onClose={vi.fn()} onSendReply={vi.fn()} />
    )
    expect(screen.getAllByText('alice').length).toBeGreaterThan(0)
  })

  it('renders null when parentMessage is null', () => {
    const { container } = render(
      <ThreadPanel parentMessage={null} replies={[]} identity={identity} onClose={vi.fn()} onSendReply={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a close button', () => {
    render(
      <ThreadPanel parentMessage={parentMsg} replies={[]} identity={identity} onClose={vi.fn()} onSendReply={vi.fn()} />
    )
    expect(screen.getByLabelText(/close thread/i)).toBeInTheDocument()
  })
})

// ── Reply count ───────────────────────────────────────────────────────────────

describe('ThreadPanel — reply count', () => {
  it('does not show reply count when there are no replies', () => {
    render(
      <ThreadPanel parentMessage={parentMsg} replies={[]} identity={identity} onClose={vi.fn()} onSendReply={vi.fn()} />
    )
    expect(screen.queryByLabelText(/replies/i)).toBeNull()
  })

  it('shows "1 reply" for a single reply', () => {
    const reply = makeMsg({ id: 'r1', parentId: parentMsg.id })
    render(
      <ThreadPanel
        parentMessage={parentMsg}
        replies={[reply]}
        identity={identity}
        onClose={vi.fn()}
        onSendReply={vi.fn()}
      />
    )
    expect(screen.getByLabelText('1 reply')).toBeInTheDocument()
  })

  it('shows "N replies" for multiple replies', () => {
    const replies = [makeMsg({ id: 'r1' }), makeMsg({ id: 'r2' }), makeMsg({ id: 'r3' })]
    render(
      <ThreadPanel
        parentMessage={parentMsg}
        replies={replies}
        identity={identity}
        onClose={vi.fn()}
        onSendReply={vi.fn()}
      />
    )
    expect(screen.getByLabelText(/3 replies/i)).toBeInTheDocument()
  })
})

// ── Replies rendering ─────────────────────────────────────────────────────────

describe('ThreadPanel — replies', () => {
  it('renders all reply messages', () => {
    const replies = [makeMsg({ id: 'r1', content: 'First reply' }), makeMsg({ id: 'r2', content: 'Second reply' })]
    render(
      <ThreadPanel
        parentMessage={parentMsg}
        replies={replies}
        identity={identity}
        onClose={vi.fn()}
        onSendReply={vi.fn()}
      />
    )
    expect(screen.getByText('First reply')).toBeInTheDocument()
    expect(screen.getByText('Second reply')).toBeInTheDocument()
  })

  it('applies --own class for own replies', () => {
    const ownReply = makeMsg({ id: 'r-own', content: 'My reply', publicKey: MY_KEY_HEX })
    const { container } = render(
      <ThreadPanel
        parentMessage={parentMsg}
        replies={[ownReply]}
        identity={identity}
        onClose={vi.fn()}
        onSendReply={vi.fn()}
      />
    )
    expect(container.querySelector('.thread-reply--own')).toBeInTheDocument()
  })

  it('applies --remote class for replies from others', () => {
    const remoteReply = makeMsg({ id: 'r-remote', content: 'Their reply', publicKey: OTHER_KEY_HEX })
    const { container } = render(
      <ThreadPanel
        parentMessage={parentMsg}
        replies={[remoteReply]}
        identity={identity}
        onClose={vi.fn()}
        onSendReply={vi.fn()}
      />
    )
    expect(container.querySelector('.thread-reply--remote')).toBeInTheDocument()
  })
})

// ── Interactions ──────────────────────────────────────────────────────────────

describe('ThreadPanel — interactions', () => {
  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn()
    render(
      <ThreadPanel parentMessage={parentMsg} replies={[]} identity={identity} onClose={onClose} onSendReply={vi.fn()} />
    )
    await userEvent.click(screen.getByLabelText(/close thread/i))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onSendReply with content when Enter is pressed in the input', async () => {
    const onSendReply = vi.fn()
    render(
      <ThreadPanel
        parentMessage={parentMsg}
        replies={[]}
        identity={identity}
        onClose={vi.fn()}
        onSendReply={onSendReply}
      />
    )
    const input = screen.getByTestId('thread-input')
    await userEvent.type(input, 'my reply{Enter}')
    expect(onSendReply).toHaveBeenCalledWith('my reply')
  })
})
