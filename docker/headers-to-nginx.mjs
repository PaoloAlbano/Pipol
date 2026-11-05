#!/usr/bin/env node
// Turns the `/*` block of public/_headers (the Cloudflare Pages format) into nginx `add_header` lines, so the
// image serves the same security headers (CSP included) as the hosted app, from a single source of truth.
//
//   node docker/headers-to-nginx.mjs public/_headers /etc/nginx/headers.conf

import { readFileSync, writeFileSync } from 'node:fs'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('Usage: node docker/headers-to-nginx.mjs <_headers file> <output file>')
  process.exit(1)
}

const lines = []
let inGlobalBlock = false

for (const raw of readFileSync(input, 'utf8').split('\n')) {
  const text = raw.trim()
  if (!text || text.startsWith('#')) continue
  if (!/^\s/.test(raw)) {
    inGlobalBlock = text === '/*'
    continue
  }
  if (!inGlobalBlock) continue

  const colon = text.indexOf(':')
  const name = text.slice(0, colon).trim()
  const value = text.slice(colon + 1).trim()
  // nginx would interpolate `$` and the quoting below would break on `"` or `\`
  if (colon < 1 || /[$"\\]/.test(value)) throw new Error(`Cannot convert the header line: ${text}`)
  lines.push(`add_header ${name} "${value}" always;`)
}

if (lines.length === 0) throw new Error(`No headers found for "/*" in ${input}`)
writeFileSync(output, `# Generated from public/_headers by docker/headers-to-nginx.mjs. Do not edit.\n${lines.join('\n')}\n`)
console.log(`${lines.length} headers written to ${output}`)
