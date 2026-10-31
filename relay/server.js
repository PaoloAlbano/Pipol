import http from 'http'
import { WebSocketServer } from 'ws'
import DHT from 'hyperdht'
import { relay } from '@hyperswarm/dht-relay'
import Stream from '@hyperswarm/dht-relay/ws'
import { createIceProvider, isIceDisabled } from './ice.js'
import { createIceGuard } from './ice-guard.js'
import { createTurnstile } from './turnstile.js'
import { createUsageGuard } from './usage-guard.js'

const PORT = process.env.PORT || 8787

const dht = new DHT()
await dht.ready()
console.log('[relay] DHT node ready')

const iceDisabled = isIceDisabled()
if (iceDisabled) console.log('[relay] /ice endpoint: DISABLED (ICE_DISABLED=true), it answers 404')

const iceProvider = createIceProvider()
if (iceProvider.name) console.log(`[relay] TURN credentials: provider "${iceProvider.name}"`)
else if (iceProvider.error) console.warn(`[relay] TURN disabled: ${iceProvider.error}`)
else console.log('[relay] TURN credentials: not configured (clients use public STUN)')

const iceGuard = createIceGuard()
const guardSummary = iceGuard.describe()
console.log(`[relay] /ice access: ${guardSummary.text}`)
if (guardSummary.invalid.length > 0) {
  console.warn(`[relay] ICE_ALLOWED_ORIGINS: ignored invalid entries: ${guardSummary.invalid.join(', ')}`)
}

const turnstile = createTurnstile()
console.log(`[relay] /ice human check (Turnstile): ${turnstile.enabled ? 'required' : 'off (set TURNSTILE_SECRET to require it)'}`)

const usageGuard = createUsageGuard()
if (iceProvider.name === 'cloudflare' && !iceDisabled) {
  console.log(`[relay] TURN usage guard: ${usageGuard.describe()}`)
  usageGuard.start()
}

const rateLimitLogged = new Set()

const server = http.createServer(async (req, res) => {
  if (req.headers.upgrade) return

  // TURN credentials for browsers (any origin: the app and the relay are usually on different hosts)
  if (req.url?.split('?')[0] === '/ice') {
    if (iceDisabled) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not-found' }))
      return
    }
    const verdict = iceGuard.check(req, { rateLimit: req.method !== 'OPTIONS' })
    if (!verdict.ok) {
      // Log each blocked client once so the proxy setting (TRUST_PROXY_HOPS) can be checked against a known IP
      if (verdict.status === 429 && !rateLimitLogged.has(verdict.ip)) {
        rateLimitLogged.add(verdict.ip)
        // The whole proxy chain is logged so TRUST_PROXY_HOPS can be set from what the proxies really send
        const chain = req.headers['x-forwarded-for'] ?? 'none'
        console.warn(
          `[relay] /ice rate limit hit for ${verdict.ip} (TRUST_PROXY_HOPS=${iceGuard.hops}, X-Forwarded-For: ${chain}, socket: ${req.socket.remoteAddress})`
        )
      }
      res.writeHead(verdict.status, { ...verdict.headers, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: verdict.error }))
      return
    }
    const cors = verdict.headers
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    if (turnstile.enabled) {
      const human = await turnstile.verify(req.headers['x-turnstile-token'], iceGuard.clientIp(req))
      if (!human.ok) {
        if (human.codes?.length) console.warn(`[relay] /ice Turnstile refused: ${human.codes.join(', ')}`)
        res.writeHead(human.status, { ...cors, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: human.error }))
        return
      }
    }
    try {
      // Monthly budget used up: issue nothing, clients fall back to public STUN
      if (usageGuard.exhausted) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ iceServers: [], ttl: 0 }))
        return
      }
      const { iceServers, ttl } = await iceProvider.get()
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ iceServers, ttl }))
    } catch (err) {
      console.warn('[relay] /ice failed:', err.message)
      res.writeHead(502, { ...cors, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'ice-unavailable' }))
    }
    return
  }

  // Health check for tests / load balancers
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('OK')
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
