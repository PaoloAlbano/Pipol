import { versionLabel } from '../version.js'
import '../styles/version.css'

/**
 * "Pipol v0.3.0": the version of the release the app was built for. A build that is not one, such as the preview of
 * a branch, shows its commit instead. `className` places it.
 */
export default function VersionLabel({ className = '' }) {
  return <p className={`version-label ${className}`.trim()}>Pipol {versionLabel()}</p>
}
