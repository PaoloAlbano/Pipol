// @vitest-environment node
// The web image builds its security headers at start-up from public/_headers plus the addresses the app was given.
// A mistake here either breaks the app (the browser blocks its own relay) or opens the CSP wider than intended.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connectOrigins, convertHeaders } from '../../docker/headers-to-nginx.mjs'

const HEADERS = readFileSync('public/_headers', 'utf8')
const script = path.resolve('docker/headers-to-nginx.mjs')

const csp = (conf) => conf.split('\n').find((l) => l.includes('Content-Security-Policy'))
const connectSrc = (conf) =>
  csp(conf)
    .match(/connect-src ([^;]*);/)[1]
    .split(' ')

describe('connectOrigins', () => {
  it('lets the relay be opened as a WebSocket and called over HTTP (/ice)', () => {
    expect(connectOrigins('ws://localhost:8787')).toEqual(['ws://localhost:8787', 'http://localhost:8787'])
    expect(connectOrigins('wss://relay.example.com')).toEqual(['wss://relay.example.com', 'https://relay.example.com'])
  })

  it('allows only that scheme for an http(s) address, such as the auth server', () => {
    expect(connectOrigins('http://localhost:8081')).toEqual(['http://localhost:8081'])
    expect(connectOrigins('https://auth.example.com/some/path?x=1')).toEqual(['https://auth.example.com'])
  })

  it('allows nothing for an empty value', () => {
    expect(connectOrigins('')).toEqual([])
    expect(connectOrigins(undefined)).toEqual([])
    expect(connectOrigins('   ')).toEqual([])
  })

  it('refuses what is not a URL, or not a web scheme', () => {
    expect(() => connectOrigins('not a url')).toThrow(/valid URL/)
    expect(() => connectOrigins('ftp://example.com')).toThrow(/Unsupported scheme/)
    expect(() => connectOrigins('javascript:alert(1)')).toThrow(/Unsupported scheme/)
  })

  it('cannot be used to add a directive or a source to the policy', () => {
    // Not a URL at all: refused
    for (const hostile of [
      'http://a.com;script-src *',
      "http://a.com 'unsafe-inline'",
      'http://a.com; default-src *',
    ]) {
      expect(() => connectOrigins(hostile)).toThrow(/valid URL/)
    }
    // A URL with the attack in its path, query or credentials: only scheme, host and port are kept
    for (const hostile of [
      'http://a.com/;script-src *',
      'http://a.com/?x=\' "unsafe-inline"',
      'http://u:p;x@a.com:81/',
    ]) {
      const origins = connectOrigins(hostile)
      expect(origins).toHaveLength(1)
      expect(origins[0]).toMatch(/^http:\/\/a\.com(:81)?$/)
    }
  })
})

describe('convertHeaders', () => {
  it('turns the hosted headers into nginx directives, one per header', () => {
    const conf = convertHeaders(HEADERS)
    expect(conf).toMatch(/^add_header X-Frame-Options "DENY" always;$/m)
    expect(conf).toMatch(/^add_header Strict-Transport-Security "[^"]+" always;$/m)
    expect(conf.match(/^add_header /gm).length).toBeGreaterThanOrEqual(6)
  })

  it('leaves the policy as it is when there is nothing to add', () => {
    expect(convertHeaders(HEADERS, [])).toBe(convertHeaders(HEADERS, ['', '']))
  })

  it('adds the addresses of the relay and the auth server to connect-src, and only there', () => {
    const plain = convertHeaders(HEADERS)
    const conf = convertHeaders(HEADERS, ['ws://localhost:8787', 'http://localhost:8081'])

    expect(connectSrc(conf)).toEqual(
      expect.arrayContaining([
        "'self'",
        'https:',
        'wss:',
        'ws:',
        'ws://localhost:8787',
        'http://localhost:8787',
        'http://localhost:8081',
      ])
    )
    // The auth server is only fetched: no WebSocket address for it; and no blanket http:
    expect(connectSrc(conf)).not.toContain('ws://localhost:8081')
    expect(connectSrc(conf)).not.toContain('http:')
    // No other directive changed
    const without = (c) => csp(c).replace(/connect-src [^;]*;/, '')
    expect(without(conf)).toBe(without(plain))
  })

  it('does not repeat an address given twice', () => {
    const conf = convertHeaders(HEADERS, ['ws://relay.local:8787', 'http://relay.local:8787'])
    expect(connectSrc(conf).filter((s) => s === 'http://relay.local:8787')).toHaveLength(1)
  })

  it('refuses to guess when the policy has no connect-src', () => {
    const headers = "/*\n  Content-Security-Policy: default-src 'self'\n"
    expect(() => convertHeaders(headers, ['ws://localhost:8787'])).toThrow(/no connect-src/)
  })

  it('refuses header values nginx would misread', () => {
    expect(() => convertHeaders('/*\n  X-Test: has "quotes"\n')).toThrow(/Cannot convert/)
    expect(() => convertHeaders('/*\n  X-Test: costs $5\n')).toThrow(/Cannot convert/)
  })

  it('fails when the file has no headers for every path', () => {
    expect(() => convertHeaders('/other/*\n  X-Test: 1\n')).toThrow(/No headers/)
  })
})

describe('the command line', () => {
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  const outFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'hdr-')), 'headers.conf')

  it('writes the file and exits 0', () => {
    const out = outFile()
    const result = run('public/_headers', out, 'ws://localhost:8787', 'http://localhost:8081')
    expect(result.status).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('http://localhost:8081')
  })

  it('exits with an error, and writes nothing, when an address is invalid', () => {
    const out = outFile()
    const result = run('public/_headers', out, 'localhost:8787')
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/headers-to-nginx:/)
    expect(existsSync(out)).toBe(false)
  })

  it('prints the usage when it is called without arguments', () => {
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Usage/)
  })
})
