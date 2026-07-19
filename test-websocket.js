// Test semplice del DHT relay
import WebSocket from 'ws'

console.log('🔍 Test WebSocket DHT Relay')
console.log('   URL: wss://pipol-vyl9.onrender.com/')
console.log('')

const ws = new WebSocket('wss://pipol-vyl9.onrender.com/')

ws.on('open', () => {
  console.log('✅ WebSocket APERTO!')
  console.log('   Il DHT relay è raggiungibile su Render')
  console.log('')
  console.log('Questo significa che:')
  console.log('   1. Il server su Render è online')
  console.log('   2. Il path "/" accetta WebSocket')
  console.log('   3. I browser possono connettersi al DHT relay')
  console.log('')
  ws.close()
  setTimeout(() => process.exit(0), 500)
})

ws.on('error', (err) => {
  console.error('❌ WebSocket FALLITO:')
  console.error('   ' + err.message)
  console.log('')
  console.log('Possibili cause:')
  console.log('   - Il server su Render è down')
  console.log('   - Il path "/" non è configurato correttamente')
  console.log('   - Problemi di rete/firewall')
  process.exit(1)
})

ws.on('close', (code) => {
  console.log('👋 WebSocket chiuso (code: ' + code + ')')
})

setTimeout(() => {
  console.error('⚠️ Timeout (5s) - nessun response dal server')
  process.exit(1)
}, 5000)
