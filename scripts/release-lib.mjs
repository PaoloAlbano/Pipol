/**
 * The rules of the releases, as plain functions (no git, no files): which version a list of commits makes, and the
 * notes that go with it. scripts/next-version.mjs reads git and uses them.
 */

/** What each commit type does to the version: "minor", "patch", or nothing. */
const BUMPS = { feat: 'minor', fix: 'patch', perf: 'patch', revert: 'patch' }
/** Sections of the release notes, in this order. */
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Bug fixes'],
  ['perf', 'Performance'],
  ['revert', 'Reverts'],
]

const RANK = { patch: 1, minor: 2, major: 3 }

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/

/**
 * Reads a commit message written as `type(scope)!: subject (#12)`. Anything else (a merge commit, a message with no
 * type) is not a change to release: null.
 * @param {string} message
 * @returns {{ type: string, scope: string | null, breaking: boolean, subject: string, pr: string | null } | null}
 */
export function parseCommit(message) {
  const [header, ...rest] = message.trim().split('\n')
  const match = HEADER.exec(header)
  if (!match) return null
  const [, type, scope, bang, text] = match
  const pr = /\s*\(#(\d+)\)$/.exec(text)
  return {
    type: type.toLowerCase(),
    scope: scope || null,
    breaking: Boolean(bang) || /^BREAKING[ -]CHANGE:/m.test(rest.join('\n')),
    subject: pr ? text.slice(0, pr.index) : text,
    pr: pr ? pr[1] : null,
  }
}

/** @returns {[number, number, number] | null} */
export function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * The version the commits make on top of `current`, or null when none of them changes anything for the users.
 * A breaking change raises the first number, but before 1.0.0 the middle one (the protocol can still change).
 * @param {string} current  like "0.2.0" or "v0.2.0"
 * @param {ReturnType<typeof parseCommit>[]} commits
 * @returns {{ version: string, bump: 'major' | 'minor' | 'patch' } | null}
 */
export function nextVersion(current, commits) {
  const [major, minor, patch] = parseVersion(current) ?? [0, 0, 0]
  let bump = null
  for (const commit of commits) {
    if (!commit) continue
    const wanted = commit.breaking ? (major >= 1 ? 'major' : 'minor') : BUMPS[commit.type]
    if (wanted && (!bump || RANK[wanted] > RANK[bump])) bump = wanted
  }
  if (!bump) return null
  const version =
    bump === 'major' ? [major + 1, 0, 0] : bump === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1]
  return { version: version.join('.'), bump }
}

/**
 * The notes of a release: the changes by section, each with the pull request it came from.
 * @param {string} version
 * @param {ReturnType<typeof parseCommit>[]} commits
 * @param {{ repoUrl?: string, previousTag?: string | null }} [options]
 */
export function releaseNotes(version, commits, { repoUrl = '', previousTag = null } = {}) {
  const link = (pr) => (pr ? ` ([#${pr}](${repoUrl}/pull/${pr}))` : '')
  const lines = []
  for (const [type, title] of SECTIONS) {
    const own = commits.filter((c) => c?.type === type && !c.breaking)
    const breaking = commits.filter((c) => c?.type === type && c.breaking)
    if (own.length === 0 && breaking.length === 0) continue
    lines.push(`### ${title}`, '')
    for (const c of breaking)
      lines.push(`- **Breaking:** ${c.scope ? `**${c.scope}:** ` : ''}${c.subject}${link(c.pr)}`)
    for (const c of own) lines.push(`- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject}${link(c.pr)}`)
    lines.push('')
  }
  // A breaking change of another type (a `refactor!:`) is not in a section above, but must be seen
  for (const c of commits.filter((x) => x?.breaking && !SECTIONS.some(([type]) => type === x.type))) {
    lines.push(`- **Breaking:** ${c.subject}${link(c.pr)}`)
  }
  if (previousTag && repoUrl) lines.push(`**Full changelog**: ${repoUrl}/compare/${previousTag}...v${version}`)
  return lines.join('\n').trim() + '\n'
}
