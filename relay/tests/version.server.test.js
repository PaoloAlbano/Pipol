// GET /version against the real server.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startRelay } from './helpers/start-relay.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
let relay

before(async () => {
  relay = await startRelay({ APP_VERSION: '0.3.0', GIT_COMMIT: '0123456789abcdef' })
})

after(async () => {
  await relay.stop()
})

test('answers with the name, the version and the commit, to any origin, and is not cached', async () => {
  const res = await fetch(`http://127.0.0.1:${relay.port}/version`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await res.json(), { name: pkg.name, version: '0.3.0', commit: '0123456' })
})

test('writes the version when it starts', () => {
  assert.match(relay.output(), /\[relay\] running v0\.3\.0 · 0123456/)
})
