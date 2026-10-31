/**
 * workspace.ice.test.js
 * The `ice` block of an invite is validated strictly when parsed.
 */

import { createWorkspace, parseInviteUrl } from '../../src/p2p/workspace.js'

const TURN = { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }

function inviteWith(config) {
  const { inviteUrl } = createWorkspace('Acme', ['general'], config)
  return inviteUrl
}

describe('invite URL — TURN configuration', () => {
  it('round-trips static TURN servers and an ICE endpoint', () => {
    const url = inviteWith({ ice: { servers: [TURN], url: 'https://relay.example.com/ice' } })
    const { workspace } = parseInviteUrl(url)
    expect(workspace.config.ice.servers).toEqual([TURN])
    expect(workspace.config.ice.url).toBe('https://relay.example.com/ice')
  })

  it('keeps other config values next to ice', () => {
    const { workspace } = parseInviteUrl(inviteWith({ relayUrl: 'wss://relay.example.com', ice: { servers: [TURN] } }))
    expect(workspace.config.relayUrl).toBe('wss://relay.example.com')
  })

  it('accepts invites without any ice config', () => {
    expect(parseInviteUrl(inviteWith({ relayUrl: 'wss://relay.example.com' })).workspace.config.ice).toBeUndefined()
    expect(parseInviteUrl(inviteWith(null)).workspace.config).toBeNull()
  })

  it.each([
    ['a non-TURN scheme', { servers: [{ urls: 'http://evil.example.com' }] }],
    ['TURN without credentials', { servers: [{ urls: 'turn:turn.example.com:3478' }] }],
    ['a javascript: endpoint', { url: 'javascript:alert(1)' }],
  ])('rejects an invite with %s', (_name, ice) => {
    expect(() => parseInviteUrl(inviteWith({ ice }))).toThrow('invalid-invite')
  })
})
