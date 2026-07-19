/**
 * test-relay.js
 *
 * Minimal in-process WebSocket signaling + data-relay server for integration
 * tests.  Mirrors the logic in relay/server.js (signaling + relay-data paths)
 * without the DHT dependency.
 *
 * Usage:
 *   const relay = await createTestRelay()
 *   // relay.port  → listen port
 *   // relay.url   → 'ws://127.0.0.1:<port>'  (pass as relayUrl to RoomSwarm)
 *   await relay.close()
 */

import http from 'http'
import { WebSocketServer } from 'ws'

export async function createTestRelay() {
  const rooms = new Map() // roomCode → Map<peerId, ws>

  const server = http.createServer()
  // One WSS listening on all paths; routes via req.url (mirrors relay/server.js)
  const wssSignal = new WebSocketServer({ noServer: true })

  wssSignal.on('connection', (ws) => {
    let peerId = null
    let roomCode = null

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }

      // ── Join room ──────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        peerId = msg.peerId
        roomCode = msg.room
        if (!rooms.has(roomCode)) rooms.set(roomCode, new Map())
        const room = rooms.get(roomCode)

        // Notify existing peers + ourselves
        for (const [existingId, existingWs] of room) {
          if (existingWs.readyState === 1 /* OPEN */) {
            existingWs.send(JSON.stringify({ type: 'peer-joined', peerId }))
            ws.send(JSON.stringify({ type: 'peer-joined', peerId: existingId }))
          }
        }

        room.set(peerId, ws)
        ws.send(JSON.stringify({ type: 'joined', peerId }))
        return
      }

      // ── Forward WebRTC signal (SDP offer/answer/ICE) ──────────────────────
      if (msg.type === 'signal' && msg.to && roomCode) {
        const target = rooms.get(roomCode)?.get(msg.to)
        if (target?.readyState === 1) {
          target.send(JSON.stringify({ ...msg, from: peerId }))
        }
        return
      }

      // ── Broadcast data relay (fallback when DataChannel unavailable) ───────
      if (msg.type === 'relay-data' && roomCode) {
        const room = rooms.get(roomCode)
        if (!room) return
        const payload = JSON.stringify({ type: 'relay-data', from: peerId, data: msg.data })
        for (const [id, peerWs] of room) {
          if (id !== peerId && peerWs.readyState === 1) peerWs.send(payload)
        }
        return
      }

      // ── Unicast data relay (peer-to-peer fallback) ────────────────────────
      if (msg.type === 'relay-data-to' && msg.to && roomCode) {
        const target = rooms.get(roomCode)?.get(msg.to)
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
        if (peerWs.readyState === 1) peerWs.send(JSON.stringify({ type: 'peer-left', peerId }))
      }
    })
  })

  // Route HTTP upgrades to the signal server (matches /signal path like production)
  server.on('upgrade', (req, socket, head) => {
    wssSignal.handleUpgrade(req, socket, head, (ws) => wssSignal.emit('connection', ws, req))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}
