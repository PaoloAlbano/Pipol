// Service Worker — static asset caching only.
// Navigation requests (HTML pages) are intentionally not intercepted:
// Cloudflare Pages handles SPA routing via _redirects server-side.
const CACHE_NAME = 'p2p-chat-v2'

const STATIC_EXTENSIONS = ['.js', '.css', '.svg', '.png', '.woff2']

// Install: skip waiting immediately; no asset pre-caching to avoid
// blocking activation on potentially failing network requests.
self.addEventListener('install', () => {
  self.skipWaiting()
})

// Activate: remove caches from previous versions.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
  )
  self.clients.claim()
})

// Fetch: cache-first for static assets only; navigate requests pass through.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  if (event.request.mode === 'navigate') return // let Cloudflare _redirects handle routing

  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (!STATIC_EXTENSIONS.some((ext) => url.pathname.endsWith(ext))) return

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
    )
  )
})
