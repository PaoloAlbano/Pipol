/**
 * resolve-version.test.js
 * Which version an app build is for: the one the release tells, and none for a build that is not for a release.
 */

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { resolveVersion, cleanVersion } from '../../scripts/resolve-version.mjs'

describe('cleanVersion', () => {
  it('takes a version written as 1.2.3, without the spaces around it', () => {
    expect(cleanVersion('0.2.2')).toBe('0.2.2')
    expect(cleanVersion('12.0.10\n')).toBe('12.0.10')
    expect(cleanVersion('  1.2.3  ')).toBe('1.2.3')
  })

  it('is nothing for anything else', () => {
    for (const text of ['v1.2.3', '1.2', '1.2.3-beta', 'latest', '', '  ', undefined, null]) {
      expect(cleanVersion(text)).toBe('')
    }
  })
})

describe('resolveVersion', () => {
  const file = (text) => () => text

  it('is the one of the release when the build is for one (the Docker images)', () => {
    expect(resolveVersion({ env: { APP_VERSION: '1.4.0' }, readFile: file('9.9.9') })).toBe('1.4.0')
  })

  it('is the one the release wrote in the branch of production', () => {
    expect(resolveVersion({ env: {}, readFile: file('0.3.0\n') })).toBe('0.3.0')
  })

  it('is none on a branch the release did not write to (a preview, a build of a developer)', () => {
    const missing = () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
    }
    expect(resolveVersion({ env: {}, readFile: missing })).toBe('')
  })

  it('does not take a strange APP_VERSION or file for a version', () => {
    expect(resolveVersion({ env: { APP_VERSION: 'latest' }, readFile: file('0.3.0') })).toBe('0.3.0')
    expect(resolveVersion({ env: { APP_VERSION: 'x' }, readFile: file('y') })).toBe('')
  })

  it('reads the file that it is told, and the default one is not there on a branch the release did not write to', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-version-'))
    const written = path.join(dir, 'release-version.txt')
    fs.writeFileSync(written, '7.8.9\n')
    try {
      expect(resolveVersion({ env: {}, file: written })).toBe('7.8.9')
      expect(resolveVersion({ env: {}, file: path.join(dir, 'nothing.txt') })).toBe('')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
    expect(resolveVersion({ env: {} })).toBe('') // release-version.txt is not in this branch
  })
})
