/** The version of the release the app was built for, and the commit it was built from (empty when not known). */
export const APP_VERSION = __APP_VERSION__
export const APP_COMMIT = __APP_COMMIT__

/** "v0.3.0 · abc1234", the part that is known, or "dev build". */
export function versionLabel(version = APP_VERSION, commit = APP_COMMIT) {
  return [version && `v${version}`, commit].filter(Boolean).join(' · ') || 'dev build'
}
