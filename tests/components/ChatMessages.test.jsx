/**
 * ChatMessages.test.jsx
 * Tests message rendering and the distinction between own/remote messages.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
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
