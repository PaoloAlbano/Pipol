import { versionLabel } from '../version.js'
import '../styles/version.css'

/**
 * "Pipol v0.3.0 · abc1234": the version of the app and the commit it was built from (the version is left out for a
 * build that is not for a release, such as the preview of a branch). `className` places it.
 */
export default function VersionLabel({ className = '' }) {
  return <p className={`version-label ${className}`.trim()}>Pipol {versionLabel()}</p>
}
