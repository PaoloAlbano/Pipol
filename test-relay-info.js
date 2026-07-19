// Test dell'endpoint /info del relay server
console.log('🔍 Richiesta informazioni dal relay server...\n')

// Usa localhost se disponibile, altrimenti il relay su Render
const RELAY_URL = process.env.REMOTE ? 'https://pipol-vyl9.onrender.com' : 'http://localhost:8787'
console.log(`   URL: ${RELAY_URL}\n`)

async function testInfoEndpoint() {
  try {
    const response = await fetch(`${RELAY_URL}/info`)
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const info = await response.json()
    
    console.log('✅ Relay server informazioni:\n')
    console.log(`📍 Node ID:        ${info.nodeId.slice(0, 16)}...${info.nodeId.slice(-16)}`)
    console.log(`📊 DHT Ready:      ${info.dhtReady ? '✅ Sì' : '❌ No'}`)
    console.log(`🔗 DHT Connections: ${info.dhtConnections} client(s) WebSocket`)
    console.log(`📡 Signaling Rooms: ${info.signalingRooms} room(s) attive`)
    console.log(`👥 Signaling Peers: ${info.totalSignalingPeers} peer total`)
    console.log(`⏱️  Uptime:         ${Math.round(info.uptime)}s (${Math.round(info.uptime / 60)}min)`)
    console.log(`🕐 Timestamp:      ${new Date(info.timestamp).toISOString()}`)
    console.log('')
    
    // Calcola l'età del relay
    const age = Date.now() - info.timestamp
    console.log(`📈 Server attivo da: ~${Math.round(age / 1000)}s dall'ultimo avvio`)
    
  } catch (err) {
    console.error('❌ Errore:', err.message)
    console.log('')
    console.log('Possibili cause:')
    console.log('  - Il relay server non è stato ancora deployato con le modifiche')
    console.log('  - Il server è temporaneamente down')
    console.log('  - Problemi di rete')
    process.exit(1)
  }
}

testInfoEndpoint()
