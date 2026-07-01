import http from 'http'
import { WebSocketServer } from 'ws'
import DHT from 'hyperdht'
import { relay } from '@hyperswarm/dht-relay'
import Stream from '@hyperswarm/dht-relay/ws'

const PORT = process.env.PORT || 8787

const dht = new DHT()
await dht.ready()
console.log('[relay] DHT node ready')

const server = http.createServer((req, res) => {
  // Health check for tests / load balancers
  if (!req.headers.upgrade) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK')
  }
})

// ── DHT relay WebSocket server (path: /) ──────────────────────────────────────
const wssDHT = new WebSocketServer({ noServer: true })
const dhtConnections = new Set()

wssDHT.on('connection', (socket, req) => {
  const ip = req.socket.remoteAddress + ':' + req.socket.remotePort
  dhtConnections.add(socket)
  console.log(`[relay] DHT + connected: ${ip}  (total: ${dhtConnections.size})`)
  socket.on('close', () => {
    dhtConnections.delete(socket)
    console.log(`[relay] DHT - disconnected: ${ip}  (total: ${dhtConnections.size})`)
  })
  relay(dht, new Stream(false, socket))
})

// ── Signaling WebSocket server (path: /signal) ───────────────────────────────
// Simple room-based WebSocket signaling for browser-to-browser WebRTC.
// Only SDP offers/answers and ICE candidates pass through — no message content.
const wssSignal = new WebSocketServer({ noServer: true })
const rooms = new Map() // roomCode → Map<peerId, ws>

wssSignal.on('connection', (ws) => {
  let peerId = null
  let roomCode = null

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'join') {
      peerId = msg.peerId
      roomCode = msg.room
      if (!rooms.has(roomCode)) rooms.set(roomCode, new Map())
      const room = rooms.get(roomCode)

      // Notify new peer about all existing peers, and existing peers about newcomer
      for (const [existingId, existingWs] of room) {
        if (existingWs.readyState === 1) {
          existingWs.send(JSON.stringify({ type: 'peer-joined', peerId }))
          ws.send(JSON.stringify({ type: 'peer-joined', peerId: existingId }))
        }
      }

      room.set(peerId, ws)
      ws.send(JSON.stringify({ type: 'joined', peerId }))
      console.log(`[signal] ${peerId.slice(0, 8)}… joined room "${roomCode}"  (room size: ${room.size})`)
      return
    }

    // Forward signaling messages (offer/answer/ice) to the target peer
    if (msg.type === 'signal' && msg.to && roomCode) {
      const room = rooms.get(roomCode)
      const target = room?.get(msg.to)
      if (target?.readyState === 1) {
        target.send(JSON.stringify({ ...msg, from: peerId }))
      }
      return
    }

    // ── WebSocket data relay fallback ──────────────────────────────────────
    // Broadcast to all other peers in the room (used when WebRTC DataChannel
    // is not available, e.g. behind symmetric NAT on mobile).
    if (msg.type === 'relay-data' && roomCode) {
      const room = rooms.get(roomCode)
      if (!room) return
      const payload = JSON.stringify({ type: 'relay-data', from: peerId, data: msg.data })
      for (const [id, peerWs] of room) {
        if (id !== peerId && peerWs.readyState === 1) peerWs.send(payload)
      }
      return
    }

    // Unicast relay to a specific peer (used for HISTORY_REQ/RES etc.)
    if (msg.type === 'relay-data-to' && msg.to && roomCode) {
      const room = rooms.get(roomCode)
      const target = room?.get(msg.to)
      if (target?.readyState === 1) {
        target.send(JSON.stringify({ type: 'relay-data', from: peerId, data: msg.data }))
      }
    }
  })

  ws.on('close', () => {
    if (!peerId || !roomCode) return
    const room = rooms.get(roomCode)
    if (!room) return
    room.delete(peerId)
    if (room.size === 0) rooms.delete(roomCode)
    for (const [, peerWs] of room) {
      if (peerWs.readyState === 1) {
        peerWs.send(JSON.stringify({ type: 'peer-left', peerId }))
      }
    }
    console.log(`[signal] ${peerId.slice(0, 8)}… left room "${roomCode}"  (room size: ${room.size})`)
  })
})

// ── Route HTTP upgrades by path ───────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/signal') {
    wssSignal.handleUpgrade(req, socket, head, (ws) => wssSignal.emit('connection', ws, req))
  } else {
    wssDHT.handleUpgrade(req, socket, head, (ws) => wssDHT.emit('connection', ws, req))
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] Listening on port ${PORT}`)
  console.log(`[relay]   DHT relay:  /`)
  console.log(`[relay]   Signaling:  /signal`)
})

process.on('SIGINT', async () => {
  console.log('\n[relay] Shutting down…')
  await dht.destroy()
  process.exit(0)
})

process.on('uncaughtException', (err) => {
  console.warn('[relay] uncaught error (ignored):', err.message)
})
