/**
 * release-lib.test.js
 * The rules of the releases: which version the commits since the last one make, and the notes.
 */

import { parseCommit, parseVersion, nextVersion, releaseNotes } from '../../scripts/release-lib.mjs'

const commits = (...messages) => messages.map(parseCommit)

describe('parseCommit', () => {
  it('reads the type, the scope and the subject, and the pull request of a squashed commit', () => {
    expect(parseCommit('feat(relay): wait before saying a peer left (#38)')).toEqual({
      type: 'feat',
      scope: 'relay',
      breaking: false,
      subject: 'wait before saying a peer left',
      pr: '38',
    })
  })

  it('reads a commit with no scope and no pull request', () => {
    expect(parseCommit('fix: keep the call')).toMatchObject({
      type: 'fix',
      scope: null,
      subject: 'keep the call',
      pr: null,
    })
  })

  it('does not care about capital letters in the type', () => {
    expect(parseCommit('Feat: x').type).toBe('feat')
  })

  it('knows a breaking change from the ! or from the line in the body', () => {
    expect(parseCommit('feat!: new protocol').breaking).toBe(true)
    expect(parseCommit('feat(relay)!: new protocol').breaking).toBe(true)
    expect(parseCommit('fix: x\n\nBREAKING CHANGE: the message changed').breaking).toBe(true)
    expect(parseCommit('fix: x\n\nBREAKING-CHANGE: the message changed').breaking).toBe(true)
    expect(parseCommit('fix: x\n\nit is not breaking').breaking).toBe(false)
  })

  it('is nothing for a commit that is not written that way', () => {
    expect(parseCommit('Merge pull request #3 from x/y')).toBeNull()
    expect(parseCommit('update the readme')).toBeNull()
    expect(parseCommit('')).toBeNull()
  })
})

describe('parseVersion', () => {
  it('reads a version with or without the v', () => {
    expect(parseVersion('0.2.0')).toEqual([0, 2, 0])
    expect(parseVersion('v1.12.3')).toEqual([1, 12, 3])
  })

  it('is nothing for anything else', () => {
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('v1.2.3-beta')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })
})

describe('nextVersion', () => {
  it('a fix raises the last number', () => {
    expect(nextVersion('0.2.0', commits('fix: a'))).toEqual({ version: '0.2.1', bump: 'patch' })
  })

  it('a feature raises the middle number and sets the last to zero', () => {
    expect(nextVersion('0.2.5', commits('feat: a'))).toEqual({ version: '0.3.0', bump: 'minor' })
  })

  it('the biggest change decides, whatever the order', () => {
    expect(nextVersion('0.2.0', commits('fix: a', 'feat: b', 'fix: c')).version).toBe('0.3.0')
    expect(nextVersion('0.2.0', commits('feat: b', 'fix: a')).version).toBe('0.3.0')
    expect(nextVersion('0.2.0', commits('fix: a', 'fix: b')).version).toBe('0.2.1')
  })

  it('performance changes and reverts count as fixes', () => {
    expect(nextVersion('0.2.0', commits('perf: a')).bump).toBe('patch')
    expect(nextVersion('0.2.0', commits('revert: a')).bump).toBe('patch')
  })

  it('docs, tests, ci, chores and refactors make no version', () => {
    expect(nextVersion('0.2.0', commits('docs: a', 'test: b', 'ci: c', 'chore: d', 'refactor: e'))).toBeNull()
  })

  it('what is not a commit in the format is left out, and with nothing left there is no version', () => {
    expect(nextVersion('0.2.0', commits('Merge branch x', 'something else'))).toBeNull()
    expect(nextVersion('0.2.0', [])).toBeNull()
    expect(nextVersion('0.2.0', commits('Merge branch x', 'fix: a')).version).toBe('0.2.1')
  })

  it('a breaking change raises the middle number before 1.0.0', () => {
    expect(nextVersion('0.4.1', commits('feat!: a'))).toEqual({ version: '0.5.0', bump: 'minor' })
    expect(nextVersion('0.4.1', commits('refactor!: a')).version).toBe('0.5.0')
  })

  it('a breaking change raises the first number from 1.0.0', () => {
    expect(nextVersion('1.4.1', commits('feat!: a', 'fix: b'))).toEqual({ version: '2.0.0', bump: 'major' })
    expect(nextVersion('v1.0.0', commits('fix: x\n\nBREAKING CHANGE: y')).version).toBe('2.0.0')
  })

  it('starts from 0.0.0 when there is no version yet', () => {
    expect(nextVersion('', commits('feat: a')).version).toBe('0.1.0')
    expect(nextVersion('0.0.0', commits('fix: a')).version).toBe('0.0.1')
  })
})

describe('releaseNotes', () => {
  const repoUrl = 'https://github.com/o/r'

  it('lists the changes by section, with the pull request, and a link to the comparison', () => {
    const notes = releaseNotes(
      '0.3.0',
      commits('feat(app): audio calls (#40)', 'fix: keep the call (#38)', 'docs: readme', 'perf: faster (#41)'),
      { repoUrl, previousTag: 'v0.2.0' }
    )
    expect(notes).toBe(
      [
        '### Features',
        '',
        '- **app:** audio calls ([#40](https://github.com/o/r/pull/40))',
        '',
        '### Bug fixes',
        '',
        '- keep the call ([#38](https://github.com/o/r/pull/38))',
        '',
        '### Performance',
        '',
        '- faster ([#41](https://github.com/o/r/pull/41))',
        '',
        '**Full changelog**: https://github.com/o/r/compare/v0.2.0...v0.3.0',
        '',
      ].join('\n')
    )
  })

  it('puts the breaking changes first in their section, and says so', () => {
    const notes = releaseNotes('0.4.0', commits('feat: small', 'feat(relay)!: new message'))
    expect(notes.indexOf('**Breaking:** **relay:** new message')).toBeLessThan(notes.indexOf('- small'))
  })

  it('shows a breaking change with no scope', () => {
    expect(releaseNotes('0.4.0', commits('feat!: new protocol'))).toContain('- **Breaking:** new protocol')
  })

  it('shows a breaking change of a type that has no section', () => {
    expect(releaseNotes('0.4.0', commits('refactor!: new layout'))).toContain('- **Breaking:** new layout')
  })

  it('leaves out the sections with nothing in them, the links without a repository, and the comparison without a tag', () => {
    const notes = releaseNotes('0.1.0', commits('fix: a (#1)'))
    expect(notes).toBe('### Bug fixes\n\n- a ([#1](/pull/1))\n')
    expect(notes).not.toContain('Features')
    expect(notes).not.toContain('Full changelog')
  })

  it('lists the reverts', () => {
    expect(releaseNotes('0.2.1', commits('revert: the last change'))).toContain('### Reverts')
  })
})
