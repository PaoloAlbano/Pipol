import { useEffect, useState } from 'react'
import { versionLabel } from '../version.js'
import '../styles/version.css'

/**
 * "Pipol v0.3.0 · abc1234", the version of the app and the commit it was built from. A click copies it, to put in a
 * report. `className` places it: `version-label--floating` at the bottom of the screen, as on the login screen.
 */
export default function VersionLabel({ className = '' }) {
  const [copied, setCopied] = useState(false)
  const text = `Pipol ${versionLabel()}`

  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // no clipboard here (an insecure page, a refused permission): the text can still be selected
    }
  }

  return (
    <button type="button" className={`version-label ${className}`.trim()} onClick={copy} title="Copy the version">
      {copied ? 'Copied' : text}
    </button>
  )
}
