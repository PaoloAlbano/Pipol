/**
 * server.js — Node.js HTTP entry point (Docker / self-hosted)
 *
 * Thin adapter: handles HTTP plumbing and delegates to src/derive.js.
 * Reads configuration from process.env instead of the CF Worker env object.
 * Requires Node.js 18+.
 */

import http from 'http'
import { derive, DeriveError, getPublicProviders } from './src/derive.js'
import { html } from './src/landing.js'

const PORT = process.env.PORT ?? 8080

// ALLOWED_ORIGINS is optional — if not set, origin check is skipped.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function sendJson(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json' }
  if (origin) Object.assign(headers, corsHeaders(origin))
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

async function handleRequest(req, res) {
  const origin = req.headers['origin'] ?? ''
  const originAllowed = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)

  if (req.method === 'OPTIONS') {
    if (!originAllowed) {
      res.writeHead(403)
      res.end()
      return
    }
    res.writeHead(204, corsHeaders(origin))
    res.end()
    return
  }

  if (!originAllowed) {
    sendJson(res, 403, { error: 'origin-not-allowed' })
    return
  }

  const url = new URL(req.url, `http://${req.headers.host}`)

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }

  if (url.pathname === '/healthcheck' && req.method === 'GET') {
    sendJson(res, 200, { ok: true }, origin)
    return
  }

  if (url.pathname === '/providers' && req.method === 'GET') {
    sendJson(res, 200, getPublicProviders(process.env), origin)
    return
  }

  if (url.pathname === '/derive' && req.method === 'POST') {
    let body
    try {
      body = await readBody(req)
    } catch {
      sendJson(res, 400, { error: 'invalid-json' }, origin)
      return
    }

    try {
      const result = await derive(body, process.env)
      sendJson(res, 200, result, origin)
    } catch (err) {
      if (err instanceof DeriveError) {
        sendJson(res, err.status, { error: err.code }, origin)
        return
      }
      console.error('[server] unhandled error:', err)
      sendJson(res, 500, { error: 'internal-error' }, origin)
    }
    return
  }

  sendJson(res, 404, { error: 'not-found' }, origin)
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[server] unhandled error:', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal-error' }))
    }
  })
})

server.listen(PORT, () => {
  console.log(`[pipol-auth] listening on port ${PORT}`)
})
