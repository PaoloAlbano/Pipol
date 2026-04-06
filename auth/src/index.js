/**
 * index.js — Cloudflare Worker entry point
 *
 * Thin adapter: handles HTTP/CORS plumbing and delegates to derive.js.
 * Deploy with: wrangler deploy
 */

import { derive, DeriveError } from './derive.js'

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? ''
    const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const originAllowed = allowedOrigins.includes(origin)

    if (request.method === 'OPTIONS') {
      if (!originAllowed) return new Response(null, { status: 403 })
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    if (!originAllowed) return jsonResponse({ error: 'origin-not-allowed' }, 403)

    const url = new URL(request.url)

    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ ok: true }, 200, origin)
    }

    if (url.pathname === '/derive' && request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse({ error: 'invalid-json' }, 400, origin)
      }

      try {
        const result = await derive(body, env)
        return jsonResponse(result, 200, origin)
      } catch (err) {
        if (err instanceof DeriveError) return jsonResponse({ error: err.code }, err.status, origin)
        console.error('[worker] unhandled error:', err)
        return jsonResponse({ error: 'internal-error' }, 500, origin)
      }
    }

    return jsonResponse({ error: 'not-found' }, 404, origin)
  },
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? corsHeaders(origin) : {}),
    },
  })
}
