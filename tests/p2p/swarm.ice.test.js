/**
 * swarm.ice.test.js
 * RoomSwarm resolves its ICE configuration before joining and uses it for every connection.
 */

import { RoomSwarm } from '../../src/p2p/swarm.js'
import { resolveIceConfig, DEFAULT_ICE_SERVERS } from '../../src/webrtc/ice.js'

const mockSettings = vi.hoisted(() => ({ value: { mode: 'default', servers: [], forceRelay: false, chatTurn: false } }))

vi.mock('../../src/p2p/storage.js', () => ({
  getIceSettings: () => mockSettings.value,
  getIdentity: () => ({
    publicKey: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    secretKey: new Uint8Array(8),
    username: 'test-user',
  }),
  getRelayUrl: () => null,
}))

vi.mock('../../src/webrtc/ice.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveIceConfig: vi.fn(),
}))

const TURN_CONFIG = {
  iceServers: [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }],
  iceTransportPolicy: 'relay',
}

let sockets
let peerConnections

class FakeWebSocket extends EventTarget {
  constructor(url) {
    super()
    this.url = url
    this.sent = []
    this.readyState = 1
    sockets.push(this)
  }
  send(data) {
    this.sent.push(JSON.parse(data))
    if (JSON.parse(data).type === 'join') {
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'joined' }) }))
      )
    }
  }
  close() {}
  open() {
    this.dispatchEvent(new Event('open'))
  }
}
FakeWebSocket.OPEN = 1

class FakePC extends EventTarget {
  constructor(config) {
    super()
    this.config = config
    peerConnections.push(this)
  }
  createDataChannel() {
    return Object.assign(new EventTarget(), { readyState: 'connecting', send() {}, close() {} })
  }
  async createOffer() {
    return { type: 'offer', sdp: 'a=fingerprint:sha-256 AA:BB' }
  }
  async setLocalDescription() {}
  close() {}
}

beforeEach(() => {
  sockets = []
  peerConnections = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resolveIceConfig.mockReset()
  mockSettings.value = { mode: 'default', servers: [], forceRelay: false, chatTurn: false }
})

afterEach(() => vi.unstubAllGlobals())

describe('RoomSwarm — ICE configuration', () => {
  it('starts with public STUN until the configuration is resolved', () => {
    const swarm = new RoomSwarm('room')
    expect(swarm.rtcConfiguration.iceServers).toEqual(DEFAULT_ICE_SERVERS)
  })

  it('resolves ICE before sending the join message', async () => {
    let release
    resolveIceConfig.mockReturnValue(new Promise((resolve) => (release = () => resolve(TURN_CONFIG))))
    const swarm = new RoomSwarm('room', { relayUrl: 'wss://relay.example.com' })
    const joining = swarm.join()

    sockets[0].open()
    await Promise.resolve()
    expect(sockets[0].sent).toEqual([]) // still waiting for ICE

    release()
    await joining
    expect(sockets[0].sent[0]).toMatchObject({ type: 'join', room: 'room' })
    expect(swarm.rtcConfiguration).toBe(TURN_CONFIG)
  })

  it('asks for the relay /ice endpoint and passes the workspace ICE override', async () => {
    resolveIceConfig.mockResolvedValue(TURN_CONFIG)
    const workspaceIce = { url: 'https://ice.example.com/ice' }
    const swarm = new RoomSwarm('room', { relayUrl: 'wss://relay.example.com', ice: workspaceIce })
    const joining = swarm.join()
    sockets[0].open()
    await joining
    expect(resolveIceConfig).toHaveBeenCalledWith({ relayUrl: 'wss://relay.example.com', workspaceIce })
  })

  it('still joins with the default STUN when resolving fails', async () => {
    resolveIceConfig.mockRejectedValue(new Error('boom'))
    const swarm = new RoomSwarm('room')
    const joining = swarm.join()
    sockets[0].open()
    await joining
    expect(swarm.rtcConfiguration.iceServers).toEqual(DEFAULT_ICE_SERVERS)
  })

  it('keeps chat connections on public STUN while calls get TURN', async () => {
    resolveIceConfig.mockResolvedValue(TURN_CONFIG)
    const swarm = new RoomSwarm('room')
    const joining = swarm.join()
    sockets[0].open()
    await joining

    await swarm._initiateConnection('0a0b0c0d')
    expect(peerConnections[0].config.iceServers).toEqual(DEFAULT_ICE_SERVERS)
    expect(swarm.rtcConfiguration).toBe(TURN_CONFIG)
  })

  it('uses TURN for chat connections when the user opted in', async () => {
    mockSettings.value = { ...mockSettings.value, chatTurn: true }
    resolveIceConfig.mockResolvedValue(TURN_CONFIG)
    const swarm = new RoomSwarm('room')
    const joining = swarm.join()
    sockets[0].open()
    await joining

    await swarm._initiateConnection('0a0b0c0d')
    expect(peerConnections[0].config).toBe(TURN_CONFIG)
  })

  describe('refreshIceConfig', () => {
    async function joined() {
      resolveIceConfig.mockResolvedValue(TURN_CONFIG)
      const swarm = new RoomSwarm('room', { relayUrl: 'wss://relay.example.com' })
      const joining = swarm.join()
      sockets[0].open()
      await joining
      resolveIceConfig.mockClear()
      return swarm
    }

    it('replaces the credentials used for new connections', async () => {
      const swarm = await joined()
      const renewed = { ...TURN_CONFIG, iceServers: [{ ...TURN_CONFIG.iceServers[0], credential: 'new' }] }
      resolveIceConfig.mockResolvedValue(renewed)

      expect(await swarm.refreshIceConfig()).toBe(renewed)
      expect(swarm.rtcConfiguration).toBe(renewed)
      expect(resolveIceConfig).toHaveBeenCalledWith({ relayUrl: 'wss://relay.example.com', workspaceIce: null })
    })

    it('keeps the working credentials when the endpoint is unreachable, and suggests a retry', async () => {
      const swarm = await joined()
      resolveIceConfig.mockResolvedValue({ iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all', degraded: true })

      const result = await swarm.refreshIceConfig()
      expect(swarm.rtcConfiguration).toBe(TURN_CONFIG)
      expect(result.iceServers).toEqual(TURN_CONFIG.iceServers)
      expect(result.refreshInMs).toBe(30_000)
    })

    it('accepts a degraded answer when there was no TURN to lose', async () => {
      resolveIceConfig.mockResolvedValue({ iceServers: DEFAULT_ICE_SERVERS, iceTransportPolicy: 'all', degraded: true })
      const swarm = new RoomSwarm('room')
      const result = await swarm.refreshIceConfig()
      expect(result.degraded).toBe(true)
      expect(swarm.rtcConfiguration.iceServers).toEqual(DEFAULT_ICE_SERVERS)
    })
  })
})
