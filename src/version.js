/** The version of the release the app was built for, and the commit it was built from (empty when not known). */
export const APP_VERSION = __APP_VERSION__
export const APP_COMMIT = __APP_COMMIT__

/** "v0.3.0" for a release; the commit for a build that is not one; "dev build" when nothing is known. */
export function versionLabel(version = APP_VERSION, commit = APP_COMMIT) {
  return version ? `v${version}` : commit || 'dev build'
}
