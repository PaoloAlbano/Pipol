// getVersionInfo: the name from package.json, the version of the release it was built for, and the commit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getVersionInfo, describeVersion } from '../version.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const SHA = '0123456789abcdef0123456789abcdef01234567'

test('has the name of package.json, and neither version nor commit when nobody says them', () => {
  assert.deepEqual(getVersionInfo({}), { name: pkg.name, version: null, commit: null })
})

test('gives the version of the release (APP_VERSION)', () => {
  assert.equal(getVersionInfo({ APP_VERSION: '0.3.0' }).version, '0.3.0')
})

test('gives the short commit from GIT_COMMIT', () => {
  assert.equal(getVersionInfo({ GIT_COMMIT: SHA }).commit, '0123456')
})

test('takes the commit Render gives when GIT_COMMIT is not set, and GIT_COMMIT first', () => {
  assert.equal(getVersionInfo({ RENDER_GIT_COMMIT: SHA }).commit, '0123456')
  assert.equal(getVersionInfo({ GIT_COMMIT: 'aaaaaaa1111', RENDER_GIT_COMMIT: SHA }).commit, 'aaaaaaa')
})

test('an empty version or commit is none (a Docker build without the arguments)', () => {
  assert.deepEqual(getVersionInfo({ APP_VERSION: '', GIT_COMMIT: '' }), { name: pkg.name, version: null, commit: null })
})

test('describes what is known', () => {
  assert.equal(describeVersion({ version: '0.3.0', commit: 'abc1234' }), 'v0.3.0 · abc1234')
  assert.equal(describeVersion({ version: null, commit: 'abc1234' }), 'abc1234')
  assert.equal(describeVersion({ version: '0.3.0', commit: null }), 'v0.3.0')
  assert.equal(describeVersion({ version: null, commit: null }), 'unknown')
})
