#!/usr/bin/env node
/**
 * Works out the next release from the git history: the commits since the last tag `vX.Y.Z` decide the version (see
 * release-lib.mjs). Without arguments it only prints what it found; the release workflow uses the options:
 *
 *   --notes <file>   write the release notes to the file
 *   --github-output  write release, version, tag and previous to $GITHUB_OUTPUT
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { parseCommit, nextVersion, releaseNotes, parseVersion } from './release-lib.mjs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

function lastTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*')
  } catch {
    return null // no release yet: every commit counts
  }
}

const argValue = (name) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}

const previous = lastTag()
const alreadyTagged = git('tag', '--points-at', 'HEAD', '--list', 'v[0-9]*') !== ''
const range = previous ? `${previous}..HEAD` : 'HEAD'
const log = git('log', range, '--format=%B%x1e')
const commits = log
  .split('\x1e')
  .map((message) => message.trim())
  .filter(Boolean)
  .map(parseCommit)

const result = alreadyTagged ? null : nextVersion(previous && parseVersion(previous) ? previous : '0.0.0', commits)
const repoUrl = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : ''

const outputs = {
  release: result ? 'true' : 'false',
  version: result?.version ?? '',
  tag: result ? `v${result.version}` : '',
  previous: previous ?? '',
}

if (result && argValue('--notes')) {
  writeFileSync(argValue('--notes'), releaseNotes(result.version, commits, { repoUrl, previousTag: previous }))
}
if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join('')
  )
}

console.log(
  JSON.stringify(
    { ...outputs, bump: result?.bump ?? null, commits: commits.filter(Boolean).length, alreadyTagged },
    null,
    2
  )
)
