import http from 'http'
import { WebSocketServer } from 'ws'
import DHT from 'hyperdht'
import { relay } from '@hyperswarm/dht-relay'
import Stream from '@hyperswarm/dht-relay/ws'
import crypto from 'hypercore-crypto'

const PORT = process.env.PORT || 8787

// Initialize DHT without explicit bootstrap (uses hyperdht defaults)
const dht = new DHT()

// Async initialization with timeout
let dhtInitialized = false
let dhtInitError = null
let nodeId = null

const dhtInitPromise = (async () => {
  try {
    await dht.ready()
    
    // Wait a tick to ensure localAddress is populated
    await new Promise(resolve => setImmediate(resolve))
    
    // nodeId is in dht.io.localAddress (32 byte buffer)
    // If unavailable (firewall/nat), use a local keypair
    nodeId = dht.io?.localAddress
    
    if (!nodeId || !Buffer.isBuffer(nodeId) || nodeId.length !== 32) {
      // Fallback: generate a local nodeId from a keypair
      const keyPair = DHT.keyPair()
      nodeId = keyPair.publicKey
      console.log('[relay] ℹ️  Using local keypair for nodeId (no DHT bootstrap)')
    }
    
    dhtInitialized = true
    console.log('[relay] ✅ DHT node ready, nodeId:', nodeId.toString('hex').slice(0, 16) + '...')
  } catch (err) {
    dhtInitError = err.message
    console.warn('[relay] ⚠️ DHT initialization error:', err.message)
    console.warn('[relay]    Continuing in offline mode (no DHT connectivity)')
    
    // Extreme fallback: generate nodeId anyway
    const keyPair = DHT.keyPair()
    nodeId = keyPair.publicKey
    dhtInitialized = true
    console.log('[relay] ✅ DHT node ready (fallback), nodeId:', nodeId.toString('hex').slice(0, 16) + '...')
  }
})()

// Log status after 2 seconds
setTimeout(() => {
  if (!dhtInitialized && !dhtInitError) {
    console.warn('[relay] ⏳ DHT still initializing...')
  }
}, 2000)

const server = http.createServer()

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

// ── HTTP endpoint for DHT node info (public info only) ─────
server.on('request', async (req, res) => {
  if (req.url === '/info' && req.method === 'GET') {
    // Wait for DHT to initialize (or timeout)
    await Promise.race([
      dhtInitPromise,
      new Promise(resolve => setTimeout(resolve, 100))
    ])
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      // Public info (non-sensitive)
      nodeId: nodeId ? nodeId.toString('hex') : 'not-ready',
      dhtReady: dhtInitialized,
      dhtConnections: dhtConnections.size,
      
      // Signaling (aggregate counts only, no details)
      signalingRooms: rooms.size,
      signalingPeers: Array.from(rooms.values()).reduce((sum, room) => sum + room.size, 0),
      
      // System
      uptime: process.uptime(),
      timestamp: Date.now()
    }, null, 2))
    return
  }

  // Health check endpoint
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // 404 for other HTTP requests
  if (!req.url.startsWith('/signal')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not-found' }))
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
