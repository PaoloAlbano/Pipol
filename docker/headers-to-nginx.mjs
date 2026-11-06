#!/usr/bin/env node
// Turns the `/*` block of public/_headers (the Cloudflare Pages format) into nginx `add_header` lines, so the
// image serves the same security headers (CSP included) as the hosted app, from a single source of truth.
//
// The Content-Security-Policy of that file allows https:, wss: and ws: for connections, but not plain http:.
// A relay or auth server on http (for instance http://localhost:8787) would be blocked by the browser, so the
// addresses the app was built with are added to `connect-src`, and only those, never a blanket `http:`.
//
//   node docker/headers-to-nginx.mjs public/_headers /tmp/headers.conf ws://localhost:8787 http://localhost:8081

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// A ws:/wss: address is the relay: the app opens its WebSocket (/signal) and also calls /ice over HTTP on the same
// host. An http:/https: address (the auth server, a custom ICE endpoint) is only ever fetched, so only that.
const COMPANION = {
  'http:': ['http:'],
  'https:': ['https:'],
  'ws:': ['ws:', 'http:'],
  'wss:': ['wss:', 'https:'],
}

/**
 * Origins to allow in connect-src for one of the URLs the app talks to.
 * @param {string} value  A URL, or an empty string (nothing to allow)
 * @returns {string[]}
 */
export function connectOrigins(value) {
  const text = String(value ?? '').trim()
  if (!text) return []
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`Not a valid URL: "${text}"`)
  }
  if (!COMPANION[url.protocol]) throw new Error(`Unsupported scheme in "${text}": use http, https, ws or wss`)
  // Built from the parts: it can only contain a scheme, a host and a port, never anything that could add a directive
  return COMPANION[url.protocol].map((scheme) => `${scheme}//${url.host}`)
}

/**
 * @param {string} text   Contents of a Cloudflare Pages _headers file
 * @param {string[]} [extraConnect]  URLs of the services the app talks to
 * @returns {string}  nginx configuration
 */
export function convertHeaders(text, extraConnect = []) {
  const extra = [...new Set(extraConnect.flatMap(connectOrigins))]
  const lines = []
  let inGlobalBlock = false

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      inGlobalBlock = line === '/*'
      continue
    }
    if (!inGlobalBlock) continue

    const colon = line.indexOf(':')
    const name = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()

    if (name.toLowerCase() === 'content-security-policy' && extra.length > 0) {
      if (!/\bconnect-src\b/.test(value)) throw new Error('The Content-Security-Policy has no connect-src to extend')
      value = value.replace(
        /\bconnect-src\b([^;]*)/,
        (_m, sources) => `connect-src${sources.trimEnd()} ${extra.join(' ')}`
      )
    }
    // nginx would interpolate `$` and the quoting below would break on `"` or `\`
    if (colon < 1 || /[$"\\]/.test(value)) throw new Error(`Cannot convert the header line: ${line}`)
    lines.push(`add_header ${name} "${value}" always;`)
  }

  if (lines.length === 0) throw new Error('No headers found for "/*"')
  return `# Generated from public/_headers by docker/headers-to-nginx.mjs. Do not edit.\n${lines.join('\n')}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, ...urls] = process.argv.slice(2)
  if (!input || !output) {
    console.error('Usage: node docker/headers-to-nginx.mjs <_headers file> <output file> [url ...]')
    process.exit(1)
  }
  try {
    writeFileSync(output, convertHeaders(readFileSync(input, 'utf8'), urls))
  } catch (err) {
    console.error(`headers-to-nginx: ${err.message}`)
    process.exit(1)
  }
  console.log(`Security headers written to ${output}`)
}
