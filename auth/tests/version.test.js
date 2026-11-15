import { readFileSync } from 'node:fs'
import { getVersionInfo, describeVersion } from '../src/version.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const SHA = '0123456789abcdef0123456789abcdef01234567'

describe('getVersionInfo', () => {
  it('has the name of package.json, and neither version nor commit when nobody says them', () => {
    expect(getVersionInfo({})).toEqual({ name: pkg.name, version: null, commit: null })
  })

  it('gives the version of the release (APP_VERSION)', () => {
    expect(getVersionInfo({ APP_VERSION: '0.3.0' }).version).toBe('0.3.0')
  })

  it('gives the short commit from GIT_COMMIT, or the one Render gives', () => {
    expect(getVersionInfo({ GIT_COMMIT: SHA }).commit).toBe('0123456')
    expect(getVersionInfo({ RENDER_GIT_COMMIT: SHA }).commit).toBe('0123456')
    expect(getVersionInfo({ GIT_COMMIT: 'aaaaaaa1111', RENDER_GIT_COMMIT: SHA }).commit).toBe('aaaaaaa')
  })

  it('takes an empty version or commit for none (a Docker build without the arguments)', () => {
    expect(getVersionInfo({ APP_VERSION: '', GIT_COMMIT: '' })).toEqual({ name: pkg.name, version: null, commit: null })
  })
})

describe('describeVersion', () => {
  it('describes what is known', () => {
    expect(describeVersion({ version: '0.3.0', commit: 'abc1234' })).toBe('v0.3.0 · abc1234')
    expect(describeVersion({ version: null, commit: 'abc1234' })).toBe('abc1234')
    expect(describeVersion({ version: '0.3.0', commit: null })).toBe('v0.3.0')
    expect(describeVersion({ version: null, commit: null })).toBe('unknown')
  })
})
