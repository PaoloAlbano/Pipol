/**
 * version.test.js
 * What Settings shows of the version: the one of the release, when the build is one, and the commit.
 */

import { versionLabel, APP_VERSION, APP_COMMIT } from '../src/version.js'

describe('versionLabel', () => {
  it('shows the version and the commit', () => {
    expect(versionLabel('1.2.3', 'abc1234')).toBe('v1.2.3 · abc1234')
  })

  it('shows only the commit for a build that is not a release (the app on Cloudflare Pages)', () => {
    expect(versionLabel('', 'abc1234')).toBe('abc1234')
  })

  it('shows only the version when the commit is not known', () => {
    expect(versionLabel('1.2.3', '')).toBe('v1.2.3')
  })

  it('says it is a build of the developer when nothing is known', () => {
    expect(versionLabel('', '')).toBe('dev build')
  })

  it('uses what Vite put in at build time', () => {
    expect(versionLabel()).toBe(`v${APP_VERSION} · ${APP_COMMIT}`)
  })
})
