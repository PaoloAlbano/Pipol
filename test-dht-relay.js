// Test del DHT relay via WebSocket
// Hyperswarm su Node.js di default usa UDP, ma su Render dobbiamo usare WSS

import WebSocket from 'ws'
import { createWebSocketStream } from 'ws'
import DHT from 'hyperdht'
import crypto from 'hypercore-crypto'
import Hyperswarm from 'hyperswarm'
import dhtRelay from '@hyperswarm/dht-relay'
const createClient = dhtRelay.createClient

async function testDHTRelay() {
  console.log('🔍 Testing DHT relay su wss://pipol-vyl9.onrender.com')
  
  // Step 1: Crea connessione WebSocket al relay
  const ws = new WebSocket('wss://pipol-vyl9.onrender.com')
  
  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('✅ WebSocket connesso')
      resolve()
    })
    ws.on('error', (err) => {
      console.error('❌ WebSocket error:', err.message)
      reject(err)
    })
    setTimeout(() => reject(new Error('Timeout connecting to WebSocket')), 5000)
  })
  
  // Step 2: Crea un client DHT che usa il WebSocket come trasporto
  // Questo è il trucco: invece di UDP, usiamo il WebSocket relay
  const relayClient = createClient({
    connect: () => createWebSocketStream(ws)
  })
  
  // Step 3: Crea un nodo DHT che usa il relay client come bootstrap
  const dht = new DHT({
    bootstrap: [relayClient]
  })
  
  await dht.ready()
  console.log('✅ DHT ready, nodeId:', dht.nodeId.toString('hex').slice(0, 16) + '...')
  
  // Step 4: Usa Hyperswarm con il DHT configurato per usare il relay
  const topic = crypto.hash(Buffer.from('test-dht-' + Date.now()))
  console.log('📡 Joining topic:', topic.toString('hex').slice(0, 16) + '...')
  
  const swarm = new Hyperswarm({ dht })
  swarm.join(topic, { server: true, client: true })
  
  swarm.on('connection', (peer, info) => {
    console.log('✅ Peer trovato!', info.publicKey.toString('hex').slice(0, 16) + '...')
    peer.close()
    swarm.destroy()
    dht.destroy()
    ws.close()
    process.exit(0)
  })
  
  // Timeout: se nessun peer dopo 10s
  setTimeout(() => {
    console.log('⚠️ Nessun peer trovato dopo 10s')
    console.log('   (Il relay funziona, ma non ci sono altri peer nel topic)')
    swarm.destroy()
    dht.destroy()
    ws.close()
    process.exit(0)
  }, 10000)
}

testDHTRelay().catch((err) => {
  console.error('❌ Test fallito:', err.message)
  process.exit(1)
})
