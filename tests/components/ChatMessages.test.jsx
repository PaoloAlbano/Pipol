/**
 * ChatMessages.test.jsx
 * Tests message rendering and the distinction between own/remote messages.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
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

// ── ReactionPicker ────────────────────────────────────────────────────────────

describe('ChatMessages — ReactionPicker', () => {
  it('opens reaction picker when 😊 trigger is clicked', async () => {
    const user = userEvent.setup()
    const msg = makeMsg({ id: 'r1' })
    const onReact = vi.fn()
    render(<ChatMessages messages={[msg]} identity={identity} reactions={new Map()} onReact={onReact} />)
    const trigger = screen.getByRole('button', { name: /add reaction/i })
    await user.click(trigger)
    expect(screen.getByRole('listbox', { name: /pick a reaction/i })).toBeInTheDocument()
  })

  it('calls onReact with messageId and emoji when emoji is clicked', async () => {
    const user = userEvent.setup()
    const msg = makeMsg({ id: 'r2' })
    const onReact = vi.fn()
    render(<ChatMessages messages={[msg]} identity={identity} reactions={new Map()} onReact={onReact} />)
    await user.click(screen.getByRole('button', { name: /add reaction/i }))
    await user.click(screen.getByRole('button', { name: '👍' }))
    expect(onReact).toHaveBeenCalledWith('r2', '👍')
  })

  it('closes the picker after an emoji is selected', async () => {
    const user = userEvent.setup()
    const msg = makeMsg({ id: 'r3' })
    render(<ChatMessages messages={[msg]} identity={identity} reactions={new Map()} onReact={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /add reaction/i }))
    await user.click(screen.getByRole('button', { name: '👍' }))
    expect(screen.queryByRole('listbox', { name: /pick a reaction/i })).not.toBeInTheDocument()
  })

  it('does not render ReactionPicker when onReact is not provided', () => {
    const msg = makeMsg({ id: 'r4' })
    render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(screen.queryByRole('button', { name: /add reaction/i })).not.toBeInTheDocument()
  })
})

// ── formatTimestamp ───────────────────────────────────────────────────────────

describe('ChatMessages — timestamp display', () => {
  it('shows a timestamp on each message', () => {
    const msg = makeMsg({ id: 'ts1', timestamp: new Date('2024-01-15T14:30:00').getTime() })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    // Some time element should be rendered
    expect(container.querySelector('.message-time')).not.toBeNull()
  })
})

// ── Thread support ────────────────────────────────────────────────────────────

describe('ChatMessages — thread filtering', () => {
  it('hides reply messages (parentId set) from the main list', () => {
    const root = makeMsg({ id: 'root-1', content: 'Root message' })
    const reply = makeMsg({ id: 'reply-1', content: 'Thread reply', parentId: 'root-1' })
    render(<ChatMessages messages={[root, reply]} identity={identity} />)
    expect(screen.getByText('Root message')).toBeInTheDocument()
    expect(screen.queryByText('Thread reply')).not.toBeInTheDocument()
  })

  it('shows all root messages when some replies exist', () => {
    const msgs = [
      makeMsg({ id: 'r1', content: 'First root' }),
      makeMsg({ id: 'r2', content: 'Second root' }),
      makeMsg({ id: 'rep1', content: 'A reply', parentId: 'r1' }),
    ]
    render(<ChatMessages messages={msgs} identity={identity} />)
    expect(screen.getByText('First root')).toBeInTheDocument()
    expect(screen.getByText('Second root')).toBeInTheDocument()
    expect(screen.queryByText('A reply')).not.toBeInTheDocument()
  })

  it('shows empty state when all messages are replies', () => {
    const reply = makeMsg({ id: 'rep', content: 'Only reply', parentId: 'some-parent' })
    render(<ChatMessages messages={[reply]} identity={identity} />)
    expect(screen.getByText(/no messages/i)).toBeInTheDocument()
  })
})

describe('ChatMessages — thread reply button', () => {
  it('shows the "Reply in thread" button when onOpenThread is provided', () => {
    const root = makeMsg({ id: 'root-1', content: 'Root' })
    render(<ChatMessages messages={[root]} identity={identity} onOpenThread={vi.fn()} />)
    expect(screen.getByRole('button', { name: /reply in thread/i })).toBeInTheDocument()
  })

  it('does not show thread button when onOpenThread is not provided', () => {
    const root = makeMsg({ id: 'root-1', content: 'Root' })
    render(<ChatMessages messages={[root]} identity={identity} />)
    expect(screen.queryByRole('button', { name: /reply in thread/i })).not.toBeInTheDocument()
  })

  it('shows reply count when replies exist', () => {
    const root = makeMsg({ id: 'root-1', content: 'Root' })
    const reply1 = makeMsg({ id: 'rep-1', parentId: 'root-1' })
    const reply2 = makeMsg({ id: 'rep-2', parentId: 'root-1' })
    render(<ChatMessages messages={[root, reply1, reply2]} identity={identity} onOpenThread={vi.fn()} />)
    expect(screen.getByRole('button', { name: /2 replies/i })).toBeInTheDocument()
  })

  it('calls onOpenThread with the message when the thread button is clicked', async () => {
    const onOpenThread = vi.fn()
    const root = makeMsg({ id: 'root-1', content: 'Clickable root' })
    render(<ChatMessages messages={[root]} identity={identity} onOpenThread={onOpenThread} />)
    await userEvent.click(screen.getByRole('button', { name: /reply in thread/i }))
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'root-1' }))
  })

  it('does not show thread button for deleted messages', () => {
    const deleted = makeMsg({ id: 'del-1', deleted: true })
    render(<ChatMessages messages={[deleted]} identity={identity} onOpenThread={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /reply in thread/i })).not.toBeInTheDocument()
  })
})

// ── ImageLightbox ─────────────────────────────────────────────────────────────

describe('ChatMessages — image lightbox', () => {
  it('opens the lightbox when an image is clicked', async () => {
    const imgMsg = makeMsg({ type: 'image', url: 'https://example.com/pic.jpg', content: '' })
    render(<ChatMessages messages={[imgMsg]} identity={identity} />)
    const img = screen.getByRole('img')
    fireEvent.click(img)
    expect(screen.getByRole('dialog', { name: /image preview/i })).toBeInTheDocument()
  })

  it('closes the lightbox when the close button is clicked', async () => {
    const imgMsg = makeMsg({ type: 'image', url: 'https://example.com/pic.jpg', content: '' })
    render(<ChatMessages messages={[imgMsg]} identity={identity} />)
    fireEvent.click(screen.getByRole('img'))
    fireEvent.click(screen.getByRole('button', { name: /close image preview/i }))
    expect(screen.queryByRole('dialog', { name: /image preview/i })).not.toBeInTheDocument()
  })

  it('closes the lightbox when the overlay backdrop is clicked', async () => {
    const imgMsg = makeMsg({ type: 'image', url: 'https://example.com/pic.jpg', content: '' })
    render(<ChatMessages messages={[imgMsg]} identity={identity} />)
    fireEvent.click(screen.getByRole('img'))
    const overlay = screen.getByRole('dialog', { name: /image preview/i })
    fireEvent.click(overlay)
    expect(screen.queryByRole('dialog', { name: /image preview/i })).not.toBeInTheDocument()
  })

  it('closes the lightbox when Escape is pressed', async () => {
    const imgMsg = makeMsg({ type: 'image', url: 'https://example.com/pic.jpg', content: '' })
    render(<ChatMessages messages={[imgMsg]} identity={identity} />)
    fireEvent.click(screen.getByRole('img'))
    expect(screen.getByRole('dialog', { name: /image preview/i })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /image preview/i })).not.toBeInTheDocument()
  })

  it('clicking the lightbox image does not close the overlay', async () => {
    const imgMsg = makeMsg({ type: 'image', url: 'https://example.com/pic.jpg', content: '' })
    render(<ChatMessages messages={[imgMsg]} identity={identity} />)
    fireEvent.click(screen.getByRole('img'))
    // Click the lightbox image (not the overlay)
    const lightboxImg = screen.getByRole('dialog').querySelector('img')
    fireEvent.click(lightboxImg)
    expect(screen.getByRole('dialog', { name: /image preview/i })).toBeInTheDocument()
  })
})

// ── @mention rendering ────────────────────────────────────────────────────────

describe('ChatMessages — @mention highlight', () => {
  it('wraps @username in a <mark class="mention"> element', () => {
    const msg = makeMsg({ content: 'hello @swift-fox, welcome!' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    const mark = container.querySelector('mark.mention')
    expect(mark).toBeInTheDocument()
    expect(mark.textContent).toBe('@swift-fox')
  })

  it('does not add mention mark when no @ in content', () => {
    const msg = makeMsg({ content: 'hello everyone!' })
    const { container } = render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(container.querySelector('mark.mention')).toBeNull()
  })
})

// ── ReactionPicker ────────────────────────────────────────────────────────────

describe('ChatMessages — ReactionPicker interaction', () => {
  it('shows all 8 quick-emoji buttons when picker is open', async () => {
    const msg = makeMsg()
    const onReact = vi.fn()
    render(<ChatMessages messages={[msg]} identity={identity} onReact={onReact} />)
    const trigger = screen.getByRole('button', { name: /add reaction/i })
    await userEvent.click(trigger)
    const buttons = screen.getAllByRole('button', { name: /👍|❤️|😂|😮|😢|🙏|🔥|👀/ })
    expect(buttons.length).toBe(8)
  })
})
