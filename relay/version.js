import { readFileSync } from 'node:fs'

/**
 * What this server is running: its name (package.json), the version of the release it was built for (APP_VERSION,
 * set by the release when it builds the Docker image; null for any other build) and the commit when the host says
 * so (GIT_COMMIT, or RENDER_GIT_COMMIT on Render).
 * @param {Record<string, string | undefined>} [env]
 */
export function getVersionInfo(env = process.env) {
  const { name } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const commit = env.GIT_COMMIT || env.RENDER_GIT_COMMIT || null
  return { name, version: env.APP_VERSION || null, commit: commit ? commit.slice(0, 7) : null }
}

/** "v0.3.0 · abc1234", the part that is known, or "unknown". */
export function describeVersion({ version, commit }) {
  return [version && `v${version}`, commit].filter(Boolean).join(' · ') || 'unknown'
}
