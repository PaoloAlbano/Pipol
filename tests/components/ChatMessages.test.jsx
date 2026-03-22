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

describe('ChatMessages — stato vuoto', () => {
  it('mostra un placeholder se non ci sono messaggi', () => {
    render(<ChatMessages messages={[]} identity={identity} />)
    expect(screen.getByText(/no messages/i)).toBeInTheDocument()
  })

  it('non mostra la lista messaggi quando è vuota', () => {
    const { container } = render(<ChatMessages messages={[]} identity={identity} />)
    expect(container.querySelector('.messages-list')).toBeNull()
  })
})

describe('ChatMessages — rendering messaggi', () => {
  it('mostra il contenuto del messaggio', () => {
    const msg = makeMsg({ content: 'Buongiorno a tutti' })
    render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(screen.getByText('Buongiorno a tutti')).toBeInTheDocument()
  })

  it('mostra tutti i messaggi', () => {
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

  it('mostra il nome del mittente per messaggi remoti', () => {
    const msg = makeMsg({ username: 'alice-bear', publicKey: '99887766' })
    render(<ChatMessages messages={[msg]} identity={identity} />)
    expect(screen.getByText('alice-bear')).toBeInTheDocument()
  })
})

describe('ChatMessages — distingue messaggi propri e altrui', () => {
  it('applica la classe --own ai propri messaggi', () => {
    const ownMsg = makeMsg({ publicKey: MY_KEY_HEX, username: 'swift-fox' })
    const { container } = render(<ChatMessages messages={[ownMsg]} identity={identity} />)
    const row = container.querySelector('.message-row--own')
    expect(row).toBeInTheDocument()
  })

  it('applica la classe --remote ai messaggi altrui', () => {
    const remoteMsg = makeMsg({ publicKey: '99887766', username: 'alice' })
    const { container } = render(<ChatMessages messages={[remoteMsg]} identity={identity} />)
    const row = container.querySelector('.message-row--remote')
    expect(row).toBeInTheDocument()
  })

  it('non mostra il nome del mittente per i propri messaggi', () => {
    const ownMsg = makeMsg({ publicKey: MY_KEY_HEX, username: 'swift-fox' })
    render(<ChatMessages messages={[ownMsg]} identity={identity} />)
    // .message-sender is rendered only for remote messages
    const { container } = render(<ChatMessages messages={[ownMsg]} identity={identity} />)
    expect(container.querySelector('.message-sender')).toBeNull()
  })

  it('gestisce mix di messaggi propri e altrui', () => {
    const msgs = [
      makeMsg({ id: '1', publicKey: MY_KEY_HEX, username: 'swift-fox' }),
      makeMsg({ id: '2', publicKey: '99887766', username: 'alice' }),
    ]
    const { container } = render(<ChatMessages messages={msgs} identity={identity} />)
    expect(container.querySelectorAll('.message-row--own')).toHaveLength(1)
    expect(container.querySelectorAll('.message-row--remote')).toHaveLength(1)
  })
})
