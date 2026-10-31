// Guard against forgetting LOG_HIDE_SENSITIVE: every log call in the relay's source that mentions something
// identifying (an IP or address, a room name, a peer id, a credential id) must sit behind the switch.
//
// If you add a log line and this test fails, either wrap it in `if (!hideSensitive)` (see server.js) or, if it
// really is not sensitive, rename the variable it prints.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Names of variables that carry identifying data in the relay's code
const SENSITIVE = /\b(ip|peerId|roomCode|remoteAddress|remotePort|chain|username)\b/
const LOG_CALL = /\b(?:console\.(?:log|info|warn|error)|log\.(?:info|warn|error))\(/g
const GUARD = /\bhideSensitive\b/

// ── A small scanner: strings and template literals (with nested ${ }) must not confuse the paren matching ──

function skipString(src, i) {
  const quote = src[i]
  i++
  while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1
  return i + 1
}

function skipTemplate(src, i) {
  i++
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') i += 2
    else if (src[i] === '$' && src[i + 1] === '{') i = skipBraces(src, i + 2)
    else i++
  }
  return i + 1
}

function skipBraces(src, i) {
  let depth = 1
  while (i < src.length && depth > 0) {
    const c = src[i]
    if (c === "'" || c === '"') i = skipString(src, i)
    else if (c === '`') i = skipTemplate(src, i)
    else {
      if (c === '{') depth++
      if (c === '}') depth--
      i++
    }
  }
  return i
}

/** Index of the ")" that closes the "(" at `open`. */
function matchParen(src, open) {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"') i = skipString(src, i)
    else if (c === '`') i = skipTemplate(src, i)
    else {
      if (c === '(') depth++
      if (c === ')' && --depth === 0) return i
      i++
    }
  }
  return -1
}

/**
 * Log calls that print something sensitive without being behind the hideSensitive switch.
 * A call is guarded if the switch appears in the call itself (e.g. a ternary) or in the header of any block
 * that encloses it (`if (!hideSensitive) { … }`).
 */
export function findUnguardedSensitiveLogs(source) {
  const lines = source.split('\n')
  const lineStarts = []
  let offset = 0
  for (const line of lines) {
    lineStarts.push(offset)
    offset += line.length + 1
  }
  const lineOf = (index) => lineStarts.findLastIndex((start) => start <= index)

  const problems = []
  for (const match of source.matchAll(LOG_CALL)) {
    const open = match.index + match[0].length - 1
    const close = matchParen(source, open)
    const call = source.slice(match.index, close + 1)
    if (!SENSITIVE.test(call)) continue

    const startLine = lineOf(match.index)
    const headers = [lines[startLine].slice(0, lines[startLine].indexOf(match[0]))]
    let indent = lines[startLine].search(/\S/)
    for (let i = startLine - 1; i >= 0 && indent > 0; i--) {
      const lineIndent = lines[i].search(/\S/)
      if (lineIndent !== -1 && lineIndent < indent) {
        headers.push(lines[i])
        indent = lineIndent
      }
    }
    if (GUARD.test(call) || headers.some((h) => GUARD.test(h))) continue

    problems.push({ line: startLine + 1, call: call.replace(/\s+/g, ' ').slice(0, 100) })
  }
  return problems
}

function sourceFiles() {
  return readdirSync(relayDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, source: readFileSync(path.join(relayDir, name), 'utf8') }))
}

// ── The check on the real code ──

test('every log line that prints an IP, room name, peer id or credential id is behind LOG_HIDE_SENSITIVE', () => {
  const problems = sourceFiles().flatMap(({ name, source }) =>
    findUnguardedSensitiveLogs(source).map((p) => `${name}:${p.line}  ${p.call}`)
  )
  assert.deepEqual(problems, [], `unguarded sensitive log lines:\n${problems.join('\n')}`)
})

test('the check really sees the sensitive log lines (it would fail silently if the scanner found none)', () => {
  const server = readFileSync(path.join(relayDir, 'server.js'), 'utf8')
  const usageGuard = readFileSync(path.join(relayDir, 'usage-guard.js'), 'utf8')
  const guarded = (source) =>
    [...source.matchAll(LOG_CALL)].filter((m) => SENSITIVE.test(source.slice(m.index, matchParen(source, m.index + m[0].length - 1) + 1)))

  // server.js: DHT connected + disconnected, joined + left room, rate limit hit
  assert.ok(guarded(server).length >= 5, `found ${guarded(server).length} sensitive log calls in server.js`)
  // usage-guard.js: credential revoked + could not be revoked
  assert.ok(guarded(usageGuard).length >= 2, `found ${guarded(usageGuard).length} sensitive log calls in usage-guard.js`)
})

// ── The checker itself ──

test('flags a sensitive log line that is not guarded', () => {
  const source = `
function onConnect(req) {
  const ip = req.socket.remoteAddress
  console.log(\`[relay] connected: \${ip}\`)
}`
  const problems = findUnguardedSensitiveLogs(source)
  assert.equal(problems.length, 1)
  assert.match(problems[0].call, /connected/)
})

test('flags room names, peer ids, credential ids and proxy chains too', () => {
  for (const expression of ['roomCode', 'peerId.slice(0, 8)', 'username', 'chain', 'req.socket.remoteAddress']) {
    const source = `function f() {\n  console.warn(\`x \${${expression}}\`)\n}`
    assert.equal(findUnguardedSensitiveLogs(source).length, 1, expression)
  }
})

test('flags calls through the injected logger and multi-line calls', () => {
  const source = `
function f(log, username) {
  log.warn(
    \`credential \${username.slice(0, 8)}… revoked\`
  )
}`
  assert.equal(findUnguardedSensitiveLogs(source).length, 1)
})

test('accepts a call inside an if (!hideSensitive) block, on the same line or further up', () => {
  const sameLine = `function f(ip) {\n  if (!hideSensitive) console.log(\`from \${ip}\`)\n}`
  const block = `function f(ip, port) {
  if (port) {
    if (!hideSensitive) {
      console.log(\`from \${ip}\`)
    }
  }
}`
  assert.equal(findUnguardedSensitiveLogs(sameLine).length, 0)
  assert.equal(findUnguardedSensitiveLogs(block).length, 0)
})

test('accepts a call that keeps the identifier out through a ternary on the switch', () => {
  const source = 'function f(username) {\n  log.warn(`credential ${hideSensitive ? "" : username} revoked`)\n}'
  assert.equal(findUnguardedSensitiveLogs(source).length, 0)
})

test('a guard in an unrelated, earlier block does not protect a later call', () => {
  const source = `
function f(ip) {
  if (!hideSensitive) {
    console.log('quiet')
  }
  console.log(\`from \${ip}\`)
}`
  assert.equal(findUnguardedSensitiveLogs(source).length, 1)
})

test('ignores log lines without sensitive data, including words in the message text', () => {
  const source = `
console.log('[relay] log: client IPs, room names and peer ids are not logged')
console.warn('[relay] /ice failed:', err.message)
console.log(\`[relay] Listening on port \${PORT}\`)`
  assert.deepEqual(findUnguardedSensitiveLogs(source), [])
})

test('is not fooled by parentheses or braces inside strings and nested templates', () => {
  const source = 'function f(ip) {\n  console.log(`a ) b ${`(${ip}`} c`)\n}'
  assert.equal(findUnguardedSensitiveLogs(source).length, 1)
})
