/**
 * version.test.js
 * What the app shows of the version: the one of the release when the build is one, else the commit.
 */

import { versionLabel, APP_VERSION, APP_COMMIT } from '../src/version.js'

describe('versionLabel', () => {
  it('shows only the version for a release, not the commit', () => {
    expect(versionLabel('1.2.3', 'abc1234')).toBe('v1.2.3')
  })

  it('shows only the commit for a build that is not a release (the app on Cloudflare Pages)', () => {
    expect(versionLabel('', 'abc1234')).toBe('abc1234')
  })

  it('says it is a build of the developer when nothing is known', () => {
    expect(versionLabel('', '')).toBe('dev build')
  })

  it('uses what Vite put in at build time', () => {
    expect(versionLabel()).toBe(APP_VERSION ? `v${APP_VERSION}` : APP_COMMIT)
  })
})
