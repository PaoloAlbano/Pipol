import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles/global.css'

// Register service worker only in production — in dev the cache-first strategy
// would serve stale Vite bundles after every rebuild.
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => console.info('[sw] Registered:', reg.scope))
      .catch((err) => console.warn('[sw] Registration failed:', err))
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
