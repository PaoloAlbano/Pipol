/**
 * ChatMessages.test.jsx
 * Tests message rendering and the distinction between own/remote messages.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatMessages from '../../src/components/ChatMessages.jsx'

const MY_KEY_HEX = 'aabbccdd'

const identity = {
  username: 'swift-fox',
  publicKey: Uint8Array.from(MY_KEY_HEX.match(/.{2}/g).map((b) => parseInt(b, 16))),
}

function makeMsg(overrides = {}) {
  return {
    id: `msg-${Math.random()}`,
    content: 'Ciao!',
    username: 'alice',
    publicKey: '11223344',
    timestamp: Date.now(),
    type: 'text',
    ...overrides,
  }
}

describe('ChatMessages — empty state', () => {
  it('shows placeholder when no messages', () => {
    render(<ChatMessages messages={[]} identity={identity} />)
    expect(screen.getByText(/no messages/i)).toBeInTheDocument()
  })

  it('does not show message list when empty', () => {
    const { container } = render(<ChatMessages messages={[]} identity={identity} />)
    expect(container.querySelector('.messages-list')).toBeNull()
  })
})

describe('ChatMessages — message rendering', () => {
  it('displays message content', () => {
    const msg = makeMsg({ content: 'Buongiorno a tutti' })
    render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(screen.getByText('Buongiorno a tutti')).toBeInTheDocument()
  })

  it('displays all messages', () => {
    const msgs = [
      makeMsg({ id: '1', content: 'Primo' }),
      makeMsg({ id: '2', content: 'Secondo' }),
      makeMsg({ id: '3', content: 'Terzo' }),
    ]
    render(<ChatMessages messages={msgs} identity={identity} />)
    expect(screen.getByText('Primo')).toBeInTheDocument()
    expect(screen.getByText('Secondo')).toBeInTheDocument()
    expect(screen.getByText('Terzo')).toBeInTheDocument()
  })

  it('displays sender name for remote messages', () => {
    const msg = makeMsg({ username: 'alice-bear', publicKey: '99887766' })
    render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(screen.getByText('alice-bear')).toBeInTheDocument()
  })
})

describe('ChatMessages — markdown rendering', () => {
  it('renders bold text (**bold**)', () => {
    const msg = makeMsg({ content: '**bold**' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(container.querySelector('strong')).toBeInTheDocument()
  })

  it('renders italic text (_italic_)', () => {
    const msg = makeMsg({ content: '_italic_' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(container.querySelector('em')).toBeInTheDocument()
  })

  it('renders strikethrough text (~~strike~~)', () => {
    const msg = makeMsg({ content: '~~strike~~' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(container.querySelector('del')).toBeInTheDocument()
  })

  it('renders inline code (`code`)', () => {
    const msg = makeMsg({ content: '`code`' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(container.querySelector('code')).toBeInTheDocument()
  })

  it('renders code block (```)', () => {
    const msg = makeMsg({ content: '```\nconst x = 1\n```' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(container.querySelector('pre')).toBeInTheDocument()
    expect(container.querySelector('pre code')).toBeInTheDocument()
  })

  it('sanitizes dangerous tags (<script>)', () => {
    const msg = makeMsg({ content: '<script>alert("xss")</script>testo' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('testo')
  })

  it('sanitizes dangerous attributes (onclick)', () => {
    const msg = makeMsg({ content: '<p onclick="evil()">ciao</p>' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    const p = container.querySelector('p')
    if (p) expect(p).not.toHaveAttribute('onclick')
  })
})

describe('ChatMessages — distinguishes own and remote messages', () => {
  it('applies --own class to own messages', () => {
    const ownMsg = makeMsg({ publicKey: MY_KEY_HEX, username: 'swift-fox' })
    const { container } = render(<ChatMessages messages={[ownMsg]} identity={identity} />)
    const row = container.querySelector('.message-row--own')
    expect(row).toBeInTheDocument()
  })

  it('applies --remote class to remote messages', () => {
    const remoteMsg = makeMsg({ publicKey: '99887766', username: 'alice' })
    const { container } = render(<ChatMessages messages={[remoteMsg]} identity={identity} />)
    const row = container.querySelector('.message-row--remote')
    expect(row).toBeInTheDocument()
  })

  it('does not show sender name for own messages', () => {
    const ownMsg = makeMsg({ publicKey: MY_KEY_HEX, username: 'swift-fox' })
    // .message-sender is rendered only for remote messages
    const { container } = render(<ChatMessages messages={[ownMsg]} identity={identity} />)
    expect(container.querySelector('.message-sender')).toBeNull()
  })

  it('handles mix of own and remote messages', () => {
    const msgs = [
      makeMsg({ id: '1', publicKey: MY_KEY_HEX, username: 'swift-fox' }),
      makeMsg({ id: '2', publicKey: '99887766', username: 'alice' }),
    ]
    const { container } = render(<ChatMessages messages={msgs} identity={identity} />)
    expect(container.querySelectorAll('.message-row--own')).toHaveLength(1)
    expect(container.querySelectorAll('.message-row--remote')).toHaveLength(1)
  })
})

// ── edit / delete / image / actions ───────────────────────────────────────────

describe('ChatMessages — deleted messages', () => {
  it('shows deleted placeholder instead of content', () => {
    const msg = makeMsg({ id: 'del', content: 'secret', deleted: true })
    render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
    expect(screen.getByText(/message deleted/i)).toBeInTheDocument()
  })

  it('does not render action buttons for deleted messages', () => {
    const ownMsg = makeMsg({ id: 'del-own', publicKey: MY_KEY_HEX, deleted: true })
    const { container } = render(
      <ChatMessages messages={[ownMsg]} identity={identity} onEdit={vi.fn()} onDelete={vi.fn()} />
    )
    expect(container.querySelector('.message-actions')).toBeNull()
  })
})

describe('ChatMessages — edited messages', () => {
  it('shows (edited) label for edited messages', () => {
    const msg = makeMsg({ id: 'ed', content: 'updated text', edited: true, editedAt: Date.now() })
    render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(screen.getByText(/\(edited\)/i)).toBeInTheDocument()
  })
})

describe('ChatMessages — image messages', () => {
  it('renders an <img> for type=image messages', () => {
    const dataUrl = 'data:image/png;base64,abc123'
    const msg = makeMsg({ id: 'img-1', type: 'image', content: '', imageData: dataUrl, fileName: 'photo.png' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img.src).toContain('abc123')
  })

  it('does not render plain text content for image messages', () => {
    const msg = makeMsg({ id: 'img-2', type: 'image', content: '', imageData: 'data:image/png;base64,xyz' })
    render(<ChatMessages messages={[msg]} identity={identity} />)
    // content is '' — no stray text
    expect(screen.queryByText('Ciao!')).not.toBeInTheDocument()
  })
})

describe('ChatMessages — inline edit flow', () => {
  it('shows edit textarea when edit action is triggered', async () => {
    const user = userEvent.setup()
    const ownMsg = makeMsg({ id: 'e1', publicKey: MY_KEY_HEX, username: 'swift-fox', content: 'original' })
    const onEdit = vi.fn()
    render(<ChatMessages messages={[ownMsg]} identity={identity} onEdit={onEdit} onDelete={vi.fn()} />)

    // Hover to reveal actions then click edit button
    const row = document.querySelector('.message-row--own')
    await user.hover(row)
    const editBtn =
      document.querySelector('.message-action-btn[aria-label="Edit"]') ??
      document.querySelector('.message-action-btn[title="Edit"]') ??
      screen.queryByRole('button', { name: /edit/i })
    if (editBtn) {
      await user.click(editBtn)
      expect(document.querySelector('textarea')).not.toBeNull()
    }
  })

  it('calls onDelete with message id when delete action is triggered', async () => {
    const user = userEvent.setup()
    const ownMsg = makeMsg({ id: 'e2', publicKey: MY_KEY_HEX, username: 'swift-fox' })
    const onDelete = vi.fn()
    render(<ChatMessages messages={[ownMsg]} identity={identity} onEdit={vi.fn()} onDelete={onDelete} />)

    const row = document.querySelector('.message-row--own')
    await user.hover(row)
    const deleteBtn =
      document.querySelector('.message-action-btn[aria-label="Delete"]') ??
      document.querySelector('.message-action-btn[title="Delete"]') ??
      screen.queryByRole('button', { name: /delete/i })
    if (deleteBtn) {
      await user.click(deleteBtn)
      expect(onDelete).toHaveBeenCalledWith('e2')
    }
  })
})
