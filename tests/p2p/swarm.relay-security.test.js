/**
 * Behaviour of RoomSwarm towards a relay that is not trusted: it sends and accepts only sealed payloads.
 */

import { describe, it, expect, vi } from 'vitest'
import { RoomSwarm } from '../../src/p2p/swarm.js'
import { RelayCipher } from '../../src/p2p/relay-crypto.js'

vi.mock('../../src/p2p/storage.js', () => ({
  getIdentity: () => ({ publicKey: new Uint8Array([1, 2, 3, 4]), secretKey: new Uint8Array(8), username: 'me' }),
  getRelayUrl: () => null,
  getIceSettings: () => ({ mode: 'default', servers: [], forceRelay: false, chatTurn: false }),
}))

const KEY = new Uint8Array(32).fill(5)
const ROOM = 'workspace-topic'
const ME = '1'.repeat(64)
const ALICE = 'a'.repeat(64)
const MALLORY = 'd'.repeat(64)

function makeSwarm() {
  const swarm = new RoomSwarm(ROOM, { relayKey: KEY })
  swarm._localPeerId = ME
  swarm._ws = { readyState: 1, send: vi.fn() }
  const sent = () => swarm._ws.send.mock.calls.map(([raw]) => JSON.parse(raw))
  return { swarm, sent, alice: new RelayCipher(KEY, ROOM) }
}

describe('RoomSwarm — sealed relay traffic', () => {
  it('seals signaling (SDP, ICE) before it reaches the relay', () => {
    const { swarm, sent } = makeSwarm()
    swarm._sendSignal(ALICE, { type: 'offer', sdp: { sdp: 'v=0 a=fingerprint:sha-256 AA' }, fingerprint: 'aa' })

    const [frame] = sent()
    expect(frame).toMatchObject({ type: 'signal', to: ALICE, signal: { v: 1 } })
    expect(JSON.stringify(frame)).not.toContain('fingerprint')
    const opened = new RelayCipher(KEY, ROOM).open(frame.signal, ME, ALICE)
    expect(opened.type).toBe('offer')
  })

  it('seals the relay HELLO', () => {
    const { swarm, sent } = makeSwarm()
    swarm._sendRelayHello(ALICE)

    const [frame] = sent()
    expect(frame).toMatchObject({ type: 'relay-data-to', to: ALICE })
    expect(JSON.stringify(frame)).not.toContain('HELLO')
  })

  it('delivers a sealed relay-data and ignores one that is not sealed', () => {
    const { swarm, alice } = makeSwarm()
    const chat = []
    swarm.addEventListener('chat-message', (e) => chat.push(e.detail))

    swarm._handleSignal({ type: 'relay-data', from: ALICE, data: { type: 'MSG', message: { content: 'clear' } } })
    expect(chat).toHaveLength(0)
    expect(swarm.peers.has(ALICE)).toBe(false)

    swarm._handleSignal({
      type: 'relay-data',
      from: ALICE,
      data: alice.seal({ type: 'MSG', message: { content: 'sealed' } }, ALICE),
    })
    expect(chat.map((c) => c.message.content)).toEqual(['sealed'])
  })

  it('ignores a sender forged by the relay', () => {
    const { swarm, alice } = makeSwarm()
    const chat = []
    swarm.addEventListener('chat-message', (e) => chat.push(e.detail))

    swarm._handleSignal({
      type: 'relay-data',
      from: MALLORY,
      data: alice.seal({ type: 'MSG', message: { content: 'x' } }, ALICE),
    })

    expect(chat).toHaveLength(0)
    expect(swarm.peers.has(MALLORY)).toBe(false)
  })

  it('ignores a unicast message that was meant for somebody else', () => {
    const { swarm, alice } = makeSwarm()
    const chat = []
    swarm.addEventListener('chat-message', (e) => chat.push(e.detail))

    swarm._handleSignal({
      type: 'relay-data',
      from: ALICE,
      data: alice.seal({ type: 'MSG', message: { content: 'x' } }, ALICE, MALLORY),
    })

    expect(chat).toHaveLength(0)
  })

  it('does not process an unsealed or forged WebRTC signal', async () => {
    const { swarm, alice } = makeSwarm()
    const handle = vi.spyOn(swarm, '_handleRTCSignal').mockResolvedValue()

    swarm._handleSignal({ type: 'signal', from: ALICE, signal: { type: 'offer', sdp: { sdp: 'evil' } } })
    swarm._handleSignal({ type: 'signal', from: MALLORY, signal: alice.seal({ type: 'offer' }, ALICE, ME) })
    expect(handle).not.toHaveBeenCalled()

    swarm._handleSignal({ type: 'signal', from: ALICE, signal: alice.seal({ type: 'offer' }, ALICE, ME) })
    expect(handle).toHaveBeenCalledWith(ALICE, { type: 'offer' })
  })

  it('drops a replayed relay-data', () => {
    const { swarm, alice } = makeSwarm()
    const chat = []
    swarm.addEventListener('chat-message', (e) => chat.push(e.detail))
    const frame = { type: 'relay-data', from: ALICE, data: alice.seal({ type: 'MSG', message: { id: '1' } }, ALICE) }

    swarm._handleSignal(frame)
    swarm._handleSignal(frame)

    expect(chat).toHaveLength(1)
  })

  it('does not accept relay traffic before it has a key', () => {
    const swarm = new RoomSwarm(ROOM) // quick room that has not derived its key yet
    const handle = vi.spyOn(swarm, '_handleRTCSignal')
    swarm._handleSignal({ type: 'signal', from: ALICE, signal: { type: 'offer' } })
    swarm._handleSignal({ type: 'relay-data', from: ALICE, data: { type: 'MSG' } })
    expect(handle).not.toHaveBeenCalled()
    expect(swarm.peers.size).toBe(0)
  })
})

describe('RoomSwarm.join — quick rooms', () => {
  it('fails clearly, without sending anything, when the key cannot be derived', async () => {
    const sockets = []
    vi.stubGlobal(
      'WebSocket',
      class {
        static OPEN = 1
        constructor() {
          this.readyState = 1
          this.sent = []
          this.handlers = {}
          sockets.push(this)
        }
        addEventListener(type, fn) {
          this.handlers[type] = fn
        }
        send(data) {
          this.sent.push(data)
        }
        close() {}
      }
    )
    vi.stubGlobal('crypto', { ...globalThis.crypto, subtle: undefined })

    const swarm = new RoomSwarm('some-code', { relayUrl: 'wss://relay.example.com' })
    const joining = swarm.join()
    joining.catch(() => {})
    await sockets[0].handlers.open()

    await expect(joining).rejects.toThrow('Cannot derive the relay encryption key')
    expect(sockets[0].sent).toEqual([])
    vi.unstubAllGlobals()
  })
})
