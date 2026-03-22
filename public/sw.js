// Service Worker — offline app shell caching
const CACHE_NAME = 'p2p-chat-v1'

// Files to cache for offline use (app shell)
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
]

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  )
  self.skipWaiting()
})

// Activate: remove old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  )
  self.clients.claim()
})

// Fetch: serve from cache first, fall back to network
self.addEventListener('fetch', (event) => {
  // Only handle GET requests for same-origin or app shell assets
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)

  // For navigation requests serve index.html (SPA routing)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then((cached) => cached || fetch(event.request))
    )
    return
  }

  // For static assets: cache-first strategy
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) => cached || fetch(event.request).then((response) => {
          // Cache newly fetched static assets
          if (response.ok && (
            event.request.url.endsWith('.js') ||
            event.request.url.endsWith('.css') ||
            event.request.url.endsWith('.svg') ||
            event.request.url.endsWith('.png')
          )) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
      )
    )
  }
})
