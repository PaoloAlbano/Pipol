/**
 * Room.calls.test.jsx
 * Room.jsx: WebRTC call signaling, screen share, remote streams, chat handlers
 * and visibility handling, using a fake WebRTCPeer and a fake MessageStore.
 */

import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Room from '../../src/components/Room.jsx'
import { createRoomSwarm } from '../../src/p2p/swarm.js'
import { WebRTCPeer } from '../../src/webrtc/peer.js'
import * as media from '../../src/webrtc/media.js'
import { sendImageFile } from '../../src/p2p/file-transfer.js'

// ── Module mocks ──────────────────────────────────────────────────────────────

let swarmListeners = {}
let swarmMock
let stores = []
let rtcPeers = []

vi.mock('../../src/p2p/swarm.js', () => ({ createRoomSwarm: vi.fn() }))

vi.mock('../../src/p2p/autobase.js', () => ({
  MessageStore: vi.fn().mockImplementation(function () {
    const listeners = {}
    const store = {
      init: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((evt, cb) => {
        listeners[evt] = cb
      }),
      emitMessages: (msgs) => listeners.messages?.(msgs),
      getHistory: vi.fn().mockResolvedValue([]),
      getLastTimestamp: vi.fn().mockResolvedValue(0),
      getLocalCoreKey: vi.fn().mockReturnValue('fake-key'),
      addMessage: vi.fn().mockResolvedValue({ id: 'm1', content: 'hi', timestamp: 1 }),
      receiveMessage: vi.fn(),
      receiveEdit: vi.fn(),
      receiveDelete: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }
    stores.push(store)
    return store
  }),
}))

vi.mock('../../src/p2p/file-transfer.js', () => ({
  sendImageFile: vi.fn(),
  FileReceiver: vi.fn().mockImplementation(function () {
    return {
      onMeta: vi.fn(),
      onChunk: vi.fn().mockReturnValue({ id: 'file-msg', content: 'img' }),
    }
  }),
}))

vi.mock('../../src/p2p/dm-crypto.js', () => ({
  encryptDM: vi.fn().mockReturnValue({ nonce: 'n', ciphertext: 'c' }),
  decryptDM: vi.fn().mockReturnValue({ id: 'dm1', content: 'secret' }),
}))

vi.mock('../../src/webrtc/peer.js', () => ({ WebRTCPeer: vi.fn() }))

const mockGetLocalStream = vi.fn()
vi.mock('../../src/webrtc/media.js', () => ({
  getLocalStream: (...args) => mockGetLocalStream(...args),
  stopLocalStream: vi.fn(),
  setAudioMuted: vi.fn(),
  setVideoMuted: vi.fn(),
  pauseVideoTracks: vi.fn(),
  resumeVideoTracks: vi.fn().mockReturnValue(true),
  switchCamera: vi.fn(),
  startScreenShare: vi.fn(),
  stopScreenShare: vi.fn(),
  getActiveScreenStream: vi.fn(() => null),
}))

// ── jsdom stubs ───────────────────────────────────────────────────────────────

Object.defineProperty(HTMLVideoElement.prototype, 'srcObject', {
  set() {},
  get() {
    return null
  },
  configurable: true,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const identity = { publicKey: Uint8Array.from([0xaa, 0xbb]), secretKey: 'ccdd', username: 'alice' }
const MY_HEX = 'aabb'

const baseProps = {
  roomCode: 'room-1',
  identity,
  showStats: false,
  onLeave: vi.fn(),
  onOpenSettings: vi.fn(),
}

function makeFakePeer(...args) {
  const peer = new EventTarget()
  peer.args = args
  peer.peerId = args[0]
  peer.isInitiator = args[1]
  peer.established = false
  peer.init = vi.fn().mockResolvedValue(undefined)
  peer.close = vi.fn(() => peer.dispatchEvent(new CustomEvent('closed')))
  peer.handleOffer = vi.fn().mockResolvedValue(undefined)
  peer.handleAnswer = vi.fn().mockResolvedValue(undefined)
  peer.handleIceCandidate = vi.fn().mockResolvedValue(undefined)
  peer.replaceVideoTrack = vi.fn().mockResolvedValue(undefined)
  peer.replaceAudioTrack = vi.fn().mockResolvedValue(undefined)
  peer.addScreenStream = vi.fn().mockResolvedValue(undefined)
  peer.removeScreenStream = vi.fn().mockResolvedValue(undefined)
  peer.getConnectionStats = vi.fn().mockResolvedValue(null)
  rtcPeers.push(peer)
  return peer
}

function resetMocks() {
  swarmListeners = {}
  stores = []
  rtcPeers = []
  swarmMock = {
    addEventListener: vi.fn((evt, cb) => {
      swarmListeners[evt] = cb
    }),
    removeEventListener: vi.fn(),
    sendToAll: vi.fn(),
    sendToPeer: vi.fn(),
    getPeers: vi.fn().mockReturnValue([]),
    leave: vi.fn().mockResolvedValue(undefined),
    peers: new Map(),
    _ws: { readyState: WebSocket.OPEN },
  }
  createRoomSwarm.mockResolvedValue(swarmMock)
  WebRTCPeer.mockImplementation(function (...args) {
    return makeFakePeer(...args)
  })
  mockGetLocalStream.mockResolvedValue(new MediaStream())
}

async function fire(name, detail = {}) {
  const handler = swarmListeners[name]
  if (!handler) throw new Error(`No swarm listener for '${name}'`)
  await act(async () => {
    await handler({ detail })
  })
}

async function setup(props = {}) {
  render(<Room {...baseProps} {...props} />)
  await waitFor(() => screen.getByText(/waiting for peers/i))
}

async function startCall(props = {}) {
  await setup(props)
  await userEvent.click(screen.getByText(/start video call/i))
  await waitFor(() => screen.getByTitle(/mute microphone/i))
}

function setPeers(...ids) {
  const list = ids.map((id) => ({ id, username: `user-${id}` }))
  swarmMock.getPeers.mockReturnValue(list)
  list.forEach((p) => swarmMock.peers.set(p.id, p))
}

beforeEach(() => {
  resetMocks()
  vi.clearAllMocks()
  resetMocks()
})

// ── Call signaling ────────────────────────────────────────────────────────────

describe('Room — call signaling', () => {
  it('opens an initiator connection to every current peer when starting a call', async () => {
    setPeers('peer-1', 'peer-2')
    await startCall()
    expect(rtcPeers.map((p) => [p.peerId, p.isInitiator])).toEqual([
      ['peer-1', true],
      ['peer-2', true],
    ])
    rtcPeers.forEach((p) => expect(p.init).toHaveBeenCalled())
  })

  it('relays offer, answer and ICE candidates through the swarm', async () => {
    setPeers('peer-1')
    await startCall()
    const [peer] = rtcPeers
    peer.dispatchEvent(new CustomEvent('offer', { detail: { sdp: 'o' } }))
    peer.dispatchEvent(new CustomEvent('answer', { detail: { sdp: 'a' } }))
    peer.dispatchEvent(new CustomEvent('ice-candidate', { detail: { candidate: 'c' } }))
    expect(swarmMock.sendToPeer).toHaveBeenCalledWith('peer-1', { type: 'VIDEO_OFFER', sdp: 'o' })
    expect(swarmMock.sendToPeer).toHaveBeenCalledWith('peer-1', { type: 'VIDEO_ANSWER', sdp: 'a' })
    expect(swarmMock.sendToPeer).toHaveBeenCalledWith('peer-1', { type: 'VIDEO_ICE', candidate: 'c' })
  })

  it('makes exactly one side of a pair polite', async () => {
    setPeers('zzzz', '0001')
    await startCall()
    const byId = Object.fromEntries(rtcPeers.map((p) => [p.peerId, p.args[4]]))
    expect(byId.zzzz).toBe(MY_HEX < 'zzzz')
    expect(byId['0001']).toBe(MY_HEX < '0001')
  })

  it('routes incoming offers to a responder peer when in a call', async () => {
    await startCall()
    await fire('video-offer', { peerId: 'peer-9', sdp: { type: 'offer' } })
    const peer = rtcPeers.find((p) => p.peerId === 'peer-9')
    expect(peer.isInitiator).toBe(false)
    expect(peer.handleOffer).toHaveBeenCalledWith({ type: 'offer' })
  })

  it('ignores offers, answers and ICE when not in a call', async () => {
    await setup()
    await fire('video-offer', { peerId: 'peer-9', sdp: {} })
    await fire('video-answer', { peerId: 'peer-9', sdp: {} })
    await fire('video-ice', { peerId: 'peer-9', candidate: {} })
    expect(rtcPeers).toHaveLength(0)
  })

  it('routes answers and ICE candidates to the matching peer', async () => {
    setPeers('peer-1')
    await startCall()
    await fire('video-answer', { peerId: 'peer-1', sdp: { type: 'answer' } })
    await fire('video-ice', { peerId: 'peer-1', candidate: { c: 1 } })
    expect(rtcPeers[0].handleAnswer).toHaveBeenCalledWith({ type: 'answer' })
    expect(rtcPeers[0].handleIceCandidate).toHaveBeenCalledWith({ c: 1 })
  })

  it('opens a responder connection when a peer starts a call we are already in', async () => {
    await startCall()
    await fire('call-init', { peerId: 'peer-5' })
    expect(rtcPeers.map((p) => [p.peerId, p.isInitiator])).toEqual([['peer-5', false]])
  })

  it('restarts a connection whose offer was sent before the other side joined (both see only themselves)', async () => {
    setPeers('peer-1')
    await startCall()
    const stale = rtcPeers[0]
    expect(stale.established).toBe(false)

    await fire('call-init', { peerId: 'peer-1' })

    expect(stale.close).toHaveBeenCalled()
    expect(rtcPeers).toHaveLength(2)
    expect(rtcPeers[1].peerId).toBe('peer-1')
    expect(rtcPeers[1].isInitiator).toBe(true)
    expect(rtcPeers[1].init).toHaveBeenCalled()
  })

  it('keeps an already established connection when the peer sends CALL_INIT again', async () => {
    setPeers('peer-1')
    await startCall()
    rtcPeers[0].established = true
    await fire('call-init', { peerId: 'peer-1' })
    expect(rtcPeers).toHaveLength(1)
    expect(rtcPeers[0].close).not.toHaveBeenCalled()
  })

  it('connects to a peer that joins the swarm during a call', async () => {
    await startCall()
    setPeers('late')
    await fire('peer-joined', { id: 'late' })
    expect(rtcPeers[0].peerId).toBe('late')
    expect(rtcPeers[0].isInitiator).toBe(true)
    expect(swarmMock.sendToPeer).toHaveBeenCalledWith('late', { type: 'CALL_INIT' })
    expect(swarmMock.sendToPeer).toHaveBeenCalledWith('late', expect.objectContaining({ type: 'HISTORY_REQ' }))
  })

  it('closes the connection when the peer leaves or ends the call', async () => {
    setPeers('peer-1', 'peer-2')
    await startCall()
    await fire('peer-left', { id: 'peer-1' })
    expect(rtcPeers[0].close).toHaveBeenCalled()
    await fire('call-end', { peerId: 'peer-2' })
    expect(rtcPeers[1].close).toHaveBeenCalled()
  })

  it('closes every connection when the local user ends the call', async () => {
    setPeers('peer-1')
    await startCall()
    await userEvent.click(screen.getByTitle(/leave video call/i))
    expect(rtcPeers[0].close).toHaveBeenCalled()
    expect(media.stopLocalStream).toHaveBeenCalled()
  })

  it('starts a call from the external trigger and reports activity', async () => {
    const onCallActiveChange = vi.fn()
    const { rerender } = render(<Room {...baseProps} startCallTrigger={0} onCallActiveChange={onCallActiveChange} />)
    await waitFor(() => screen.getByText(/waiting for peers/i))
    rerender(<Room {...baseProps} startCallTrigger={1} onCallActiveChange={onCallActiveChange} />)
    await waitFor(() => expect(onCallActiveChange).toHaveBeenCalledWith(true))
  })

  it('alerts when camera permission is denied', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    mockGetLocalStream.mockRejectedValueOnce(err)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await setup()
    await userEvent.click(screen.getByText(/start video call/i))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(expect.stringMatching(/permission denied/i)))
  })
})

// ── Remote streams and screen share ───────────────────────────────────────────

describe('Room — remote streams', () => {
  const camStream = { id: 'cam-1' }
  const screenStream = { id: 'screen-1' }

  it('renders a tile when a remote stream arrives and removes it when the peer closes', async () => {
    setPeers('peer-1')
    await startCall()
    await act(async () => {
      rtcPeers[0].dispatchEvent(new CustomEvent('remote-stream', { detail: { stream: camStream } }))
    })
    expect(screen.getByText('peer-1')).toBeInTheDocument()
    await act(async () => {
      rtcPeers[0].dispatchEvent(new CustomEvent('closed'))
    })
    expect(screen.queryByText('peer-1')).toBeNull()
  })

  it('shows an announced screen stream as a separate tile and removes it when sharing ends', async () => {
    setPeers('peer-1')
    await startCall()
    await act(async () => {
      rtcPeers[0].dispatchEvent(new CustomEvent('remote-stream', { detail: { stream: camStream } }))
    })
    await fire('screen-share-start', { peerId: 'peer-1', streamId: 'screen-1' })
    await act(async () => {
      rtcPeers[0].dispatchEvent(new CustomEvent('remote-stream', { detail: { stream: screenStream } }))
    })
    expect(screen.getByText('peer-1 (screen)')).toBeInTheDocument()
    expect(screen.getByText('peer-1')).toBeInTheDocument()

    await fire('screen-share-end', { peerId: 'peer-1' })
    expect(screen.queryByText('peer-1 (screen)')).toBeNull()
    expect(screen.getByText('peer-1')).toBeInTheDocument()
  })

  it('removes remote streams when the peer leaves', async () => {
    setPeers('peer-1')
    await startCall()
    await act(async () => {
      rtcPeers[0].dispatchEvent(new CustomEvent('remote-stream', { detail: { stream: camStream } }))
    })
    await fire('peer-left', { id: 'peer-1' })
    expect(screen.queryByText('peer-1')).toBeNull()
  })

  it('announces an active screen share to a peer that connects later', async () => {
    media.getActiveScreenStream.mockReturnValue({ id: 'my-screen' })
    await startCall()
    await fire('call-init', { peerId: 'peer-7' })
    expect(swarmMock.sendToPeer).toHaveBeenCalledWith('peer-7', { type: 'SCREEN_SHARE_START', streamId: 'my-screen' })
    expect(rtcPeers[0].args[3]).toEqual({ id: 'my-screen' })
  })
})

describe('Room — local screen share and camera', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([]) },
      configurable: true,
    })
  })
  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })

  function fakeScreen() {
    const track = Object.assign(new EventTarget(), { kind: 'video' })
    const stream = { id: 'my-screen' }
    media.startScreenShare.mockResolvedValue({ stream, screenTrack: track })
    return { track, stream }
  }

  it('adds the screen to every peer connection and removes it on stop', async () => {
    setPeers('peer-1')
    const { stream } = fakeScreen()
    await startCall()
    await userEvent.click(screen.getByTitle(/share screen/i))
    await waitFor(() => expect(rtcPeers[0].addScreenStream).toHaveBeenCalledWith(stream))

    await userEvent.click(screen.getByTitle(/stop screen share/i))
    expect(media.stopScreenShare).toHaveBeenCalled()
    expect(rtcPeers[0].removeScreenStream).toHaveBeenCalled()
    expect(swarmMock.sendToAll).toHaveBeenCalledWith({ type: 'SCREEN_SHARE_END' })
  })

  it('stops sharing when the browser "Stop sharing" bar ends the track', async () => {
    setPeers('peer-1')
    const { track } = fakeScreen()
    await startCall()
    await userEvent.click(screen.getByTitle(/share screen/i))
    await waitFor(() => screen.getByTitle(/stop screen share/i))
    await act(async () => {
      track.dispatchEvent(new Event('ended'))
    })
    expect(media.stopScreenShare).toHaveBeenCalled()
    expect(screen.getByTitle(/share screen/i)).toBeInTheDocument()
    expect(media.startScreenShare).toHaveBeenCalledTimes(1)
  })

  it('does not share when the picker is cancelled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    media.startScreenShare.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await startCall()
    await userEvent.click(screen.getByTitle(/share screen/i))
    expect(screen.getByTitle(/share screen/i)).toBeInTheDocument()
    media.startScreenShare.mockRejectedValue(new Error('boom'))
    await userEvent.click(screen.getByTitle(/share screen/i))
    expect(screen.getByTitle(/share screen/i)).toBeInTheDocument()
  })

  it('toggles the camera without touching screen share', async () => {
    await startCall()
    await userEvent.click(screen.getByTitle(/turn off camera/i))
    expect(media.setVideoMuted).toHaveBeenCalledWith(true)
    expect(screen.getByTitle(/turn on camera/i)).toBeInTheDocument()
  })

  it('replaces the camera track on every peer after switching camera', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }, { kind: 'videoinput' }]) },
      configurable: true,
    })
    setPeers('peer-1')
    const videoTrack = { kind: 'video' }
    media.switchCamera.mockResolvedValue({ stream: new MediaStream(), videoTrack })
    await startCall()
    await waitFor(() => screen.getByTitle(/switch camera/i))
    await userEvent.click(screen.getByTitle(/switch camera/i))
    await waitFor(() => expect(rtcPeers[0].replaceVideoTrack).toHaveBeenCalledWith(videoTrack))
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
  })
})

// ── Visibility ────────────────────────────────────────────────────────────────

describe('Room — visibility changes', () => {
  function setVisibility(state) {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  afterEach(() => setVisibility('visible'))

  it('pauses video when hidden outside a call, and resumes when visible again', async () => {
    await setup()
    await act(async () => setVisibility('hidden'))
    expect(media.pauseVideoTracks).toHaveBeenCalled()
    await act(async () => setVisibility('visible'))
    expect(media.resumeVideoTracks).toHaveBeenCalled()
  })

  it('keeps video running when hidden during a call (PiP)', async () => {
    await startCall()
    media.pauseVideoTracks.mockClear()
    await act(async () => setVisibility('hidden'))
    expect(media.pauseVideoTracks).not.toHaveBeenCalled()
  })

  it('re-acquires the stream and swaps camera/mic tracks if the OS killed them', async () => {
    setPeers('peer-1')
    await startCall()
    const video = { kind: 'video' }
    const audio = { kind: 'audio' }
    media.resumeVideoTracks.mockReturnValueOnce(false)
    mockGetLocalStream.mockResolvedValueOnce({
      getVideoTracks: () => [video],
      getAudioTracks: () => [audio],
    })
    await act(async () => setVisibility('visible'))
    await waitFor(() => expect(rtcPeers[0].replaceVideoTrack).toHaveBeenCalledWith(video))
    expect(rtcPeers[0].replaceAudioTrack).toHaveBeenCalledWith(audio)
  })

  it('reconnects the swarm when the websocket closed while hidden', async () => {
    await setup()
    swarmMock._ws.readyState = WebSocket.CLOSED
    createRoomSwarm.mockClear()
    await act(async () => setVisibility('visible'))
    await waitFor(() => expect(createRoomSwarm).toHaveBeenCalled())
    expect(swarmMock.leave).toHaveBeenCalled()
  })

  it('shows an error status when reconnecting fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await setup()
    swarmMock._ws.readyState = WebSocket.CLOSED
    createRoomSwarm.mockRejectedValueOnce(new Error('nope'))
    await act(async () => setVisibility('visible'))
    await waitFor(() => screen.getByText(/reconnect failed: nope/i))
  })
})

// ── Chat handlers ─────────────────────────────────────────────────────────────

describe('Room — chat messages', () => {
  const msg = (over = {}) => ({
    id: 'x1',
    content: 'hello there',
    username: 'bob',
    publicKey: 'ffff',
    timestamp: 10,
    ...over,
  })

  it('stores and broadcasts a typed message', async () => {
    const onMessageSent = vi.fn()
    await setup({ onMessageSent })
    const editor = screen.getByRole('textbox')
    editor.focus()
    await userEvent.type(editor, 'hi{Enter}')
    await waitFor(() => expect(swarmMock.sendToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'MSG' })))
    expect(stores[0].addMessage).toHaveBeenCalledWith('hi')
    expect(onMessageSent).toHaveBeenCalled()
  })

  it('broadcasts typing notifications, throttled', async () => {
    await setup()
    const editor = screen.getByRole('textbox')
    editor.focus()
    await userEvent.type(editor, 'abc')
    const typing = swarmMock.sendToAll.mock.calls.filter(([m]) => m.type === 'TYPING' && !m.stopped)
    expect(typing).toHaveLength(1)
  })

  it('displays history and live messages from the store', async () => {
    await setup()
    await act(async () => stores[0].emitMessages([msg()]))
    expect(screen.getByText('hello there')).toBeInTheDocument()
  })

  it('stores incoming channel messages and flags mentions', async () => {
    const onPeerMessage = vi.fn()
    await setup({ onPeerMessage })
    await fire('chat-message', { channelName: null, message: msg({ content: 'hey @alice' }) })
    expect(stores[0].receiveMessage).toHaveBeenCalled()
    expect(onPeerMessage).toHaveBeenCalledWith(expect.objectContaining({ mentioned: true }))
  })

  it('ignores channel messages addressed to another channel', async () => {
    await setup({ channelName: 'general' })
    await fire('chat-message', { channelName: 'random', message: msg() })
    expect(stores[0].receiveMessage).not.toHaveBeenCalled()
  })

  it('answers history requests with newer messages only', async () => {
    await setup()
    stores[0].getHistory.mockResolvedValue([msg({ timestamp: 5 }), msg({ id: 'x2', timestamp: 20 })])
    await fire('history-req', { peerId: 'p', since: 10, channelName: 'room-1' })
    expect(swarmMock.sendToPeer).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({
        type: 'HISTORY_RES',
        messages: [expect.objectContaining({ id: 'x2' })],
      })
    )
  })

  it('does not answer history requests for another channel or with nothing new', async () => {
    await setup()
    await fire('history-req', { peerId: 'p', since: 0, channelName: 'other' })
    await fire('history-req', { peerId: 'p', since: 99, channelName: 'room-1' })
    expect(swarmMock.sendToPeer).not.toHaveBeenCalledWith('p', expect.objectContaining({ type: 'HISTORY_RES' }))
  })

  it('applies remote edits and deletes', async () => {
    await setup()
    await fire('msg-edit', { originalId: 'a', newContent: 'new', editedAt: 5, channelName: null })
    await fire('msg-delete', { originalId: 'a', channelName: null })
    expect(stores[0].receiveEdit).toHaveBeenCalledWith('a', 'new', 5)
    expect(stores[0].receiveDelete).toHaveBeenCalledWith('a')
  })

  it('shows and clears typing indicators', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await setup()
      await act(async () => stores[0].emitMessages([msg()]))
      await fire('typing', { peerId: 'p1', username: 'bob', channelName: null })
      expect(screen.getByText(/bob/i, { selector: '.typing-indicator, .typing-indicator *' })).toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(3500)
      })
      expect(screen.queryByText(/bob is typing/i)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('adds a reaction from a peer and removes it again', async () => {
    await setup()
    await act(async () => stores[0].emitMessages([msg()]))
    await fire('reaction', { messageId: 'x1', emoji: '👍', userPubkey: 'ffff', channelName: null })
    expect(screen.getByText(/👍/)).toBeInTheDocument()
    await fire('reaction', { messageId: 'x1', emoji: '👍', userPubkey: 'ffff', channelName: null, removed: true })
    expect(screen.queryByText(/👍/)).toBeNull()
  })

  it('receives chunked files through the file receiver', async () => {
    await setup()
    await fire('file-meta', { fileId: 'f', channelName: null })
    await fire('file-chunk', { fileId: 'f' })
    expect(stores[0].receiveMessage).toHaveBeenCalledWith({ id: 'file-msg', content: 'img' })
  })

  it('shows signaling errors as reconnecting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await setup()
    await fire('error', new Error('ws closed'))
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
  })

  it('sends a pasted image file and adds it locally', async () => {
    sendImageFile.mockResolvedValue({ id: 'img1', content: 'img' })
    await setup()
    const input = document.querySelector('input[type="file"]')
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(stores[0].receiveMessage).toHaveBeenCalledWith({ id: 'img1', content: 'img' }))
  })

  it('alerts when sending an image fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    sendImageFile.mockRejectedValue(new Error('too big'))
    await setup()
    const input = document.querySelector('input[type="file"]')
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    })
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('too big'))
  })
})

// ── Direct messages ───────────────────────────────────────────────────────────

describe('Room — direct messages', () => {
  const dmProps = { isDM: true, dmPeerPublicKey: Uint8Array.from([1, 2]), dmPeerPubkeyHex: '0102' }

  it('encrypts outgoing DMs for the recipient only', async () => {
    await setup(dmProps)
    const editor = screen.getByRole('textbox')
    editor.focus()
    await userEvent.type(editor, 'psst{Enter}')
    await waitFor(() =>
      expect(swarmMock.sendToAll).toHaveBeenCalledWith({ type: 'DM', to: '0102', nonce: 'n', ciphertext: 'c' })
    )
    expect(swarmMock.sendToAll).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'MSG' }))
  })

  it('decrypts DMs addressed to us from the expected peer', async () => {
    await setup(dmProps)
    await fire('dm-message', { from: '0102', to: MY_HEX, nonce: 'n', ciphertext: 'c' })
    expect(stores[0].receiveMessage).toHaveBeenCalledWith({ id: 'dm1', content: 'secret' })
  })

  it('ignores DMs from other senders or addressed to someone else', async () => {
    await setup(dmProps)
    await fire('dm-message', { from: '9999', to: MY_HEX, nonce: 'n', ciphertext: 'c' })
    await fire('dm-message', { from: '0102', to: 'ffff', nonce: 'n', ciphertext: 'c' })
    expect(stores[0].receiveMessage).not.toHaveBeenCalled()
  })

  it('ignores channel messages in a DM room', async () => {
    await setup(dmProps)
    await fire('chat-message', { channelName: null, message: { id: 'z', content: 'x', timestamp: 1 } })
    expect(stores[0].receiveMessage).not.toHaveBeenCalled()
  })
})

// ── Peers and incoming calls ──────────────────────────────────────────────────

describe('Room — peers', () => {
  it('updates the status as peers join and leave', async () => {
    await setup()
    setPeers('p1')
    await fire('peer-joined', { id: 'p1' })
    expect(screen.getByText(/1 peer\(s\) connected/i)).toBeInTheDocument()
    swarmMock.getPeers.mockReturnValue([])
    await fire('peer-left', { id: 'p1' })
    expect(screen.getByText(/waiting for peers/i)).toBeInTheDocument()
  })

  it('dismisses the incoming call banner when the caller leaves', async () => {
    setPeers('p1')
    await setup()
    await fire('call-init', { peerId: 'p1' })
    expect(screen.getByText(/has started a video call/i)).toBeInTheDocument()
    await fire('peer-left', { id: 'p1' })
    expect(screen.queryByText(/has started a video call/i)).toBeNull()
  })

  it('removes the swarm listeners on unmount', async () => {
    const { unmount } = render(<Room {...baseProps} />)
    await waitFor(() => screen.getByText(/waiting for peers/i))
    unmount()
    expect(swarmMock.removeEventListener).toHaveBeenCalledWith('call-init', expect.any(Function))
  })

  it('shows a retry banner when the relay is unreachable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    createRoomSwarm.mockRejectedValueOnce(new Error('down'))
    render(<Room {...baseProps} />)
    await waitFor(() => screen.getByText(/relay unreachable/i))
  })

  it('reports unsupported browsers', async () => {
    createRoomSwarm.mockRejectedValueOnce(Object.assign(new Error('no webrtc'), { code: 'BROWSER_UNSUPPORTED' }))
    render(<Room {...baseProps} />)
    await waitFor(() => screen.getByText(/no webrtc/i))
  })
})

// ── Own message actions ───────────────────────────────────────────────────────

describe('Room — own message actions', () => {
  const own = { id: 'own1', content: 'my text', username: 'alice', publicKey: MY_HEX, timestamp: 10 }

  async function setupWithOwnMessage() {
    await setup()
    await act(async () => stores[0].emitMessages([own]))
    await userEvent.click(screen.getByRole('button', { name: /message actions/i }))
  }

  it('toggles a reaction optimistically and broadcasts it', async () => {
    await setupWithOwnMessage()
    await userEvent.click(screen.getByRole('menuitem', { name: '👍' }))
    expect(swarmMock.sendToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'REACTION', messageId: 'own1', emoji: '👍', removed: false })
    )
    expect(screen.getByLabelText(/👍 1/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /message actions/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: '👍' }))
    expect(swarmMock.sendToAll).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'REACTION', removed: true }))
    expect(screen.queryByLabelText(/👍 1/)).toBeNull()
  })

  it('deletes optimistically and broadcasts MSG_DELETE', async () => {
    await setupWithOwnMessage()
    await userEvent.click(screen.getByRole('menuitem', { name: /delete/i }))
    expect(stores[0].receiveDelete).toHaveBeenCalledWith('own1')
    expect(swarmMock.sendToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MSG_DELETE', originalId: 'own1' })
    )
  })

  it('edits optimistically and broadcasts MSG_EDIT', async () => {
    await setupWithOwnMessage()
    await userEvent.click(screen.getByRole('menuitem', { name: /edit/i }))
    const box = document.querySelector('.message-edit-textarea')
    await userEvent.clear(box)
    await userEvent.type(box, 'changed{Enter}')
    expect(stores[0].receiveEdit).toHaveBeenCalledWith('own1', 'changed', expect.any(Number))
    expect(swarmMock.sendToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MSG_EDIT', originalId: 'own1', newContent: 'changed' })
    )
  })

  it('sends a thread reply with the parent id', async () => {
    await setupWithOwnMessage()
    await userEvent.click(screen.getByRole('menuitem', { name: /reply in thread/i }))
    const boxes = screen.getAllByRole('textbox')
    const threadBox = boxes[boxes.length - 1]
    threadBox.focus()
    await userEvent.type(threadBox, 'reply{Enter}')
    await waitFor(() => expect(stores[0].addMessage).toHaveBeenCalledWith('reply', { parentId: 'own1' }))
    expect(swarmMock.sendToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'MSG' }))
  })
})

// ── Connection stats ──────────────────────────────────────────────────────────

describe('Room — connection stats', () => {
  it('polls peer stats and shows the path and bandwidth badge', async () => {
    setPeers('peer-1')
    await setup({ showStats: true })
    await userEvent.click(screen.getByText(/start video call/i))
    await waitFor(() => screen.getByTitle(/mute microphone/i))
    rtcPeers[0].getConnectionStats.mockResolvedValue({
      localType: 'host',
      remoteType: 'srflx',
      rtt: 12,
      bytesSent: 1000,
      bytesReceived: 2000,
    })
    await act(async () => {
      rtcPeers[0].dispatchEvent(new CustomEvent('remote-stream', { detail: { stream: { id: 's' } } }))
    })
    await waitFor(() => expect(screen.getByText(/host ↔ srflx/)).toBeInTheDocument(), { timeout: 4000 })
  })
})
