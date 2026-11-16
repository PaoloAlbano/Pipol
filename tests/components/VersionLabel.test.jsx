import { render, screen } from '@testing-library/react'
import VersionLabel from '../../src/components/VersionLabel.jsx'

describe('VersionLabel', () => {
  it('shows the version of the app and the commit', () => {
    render(<VersionLabel />)
    expect(screen.getByText('Pipol v0.0.0-test')).toBeInTheDocument()
  })

  it('takes the class that places it', () => {
    render(<VersionLabel className="version-label--inline" />)
    expect(screen.getByText(/^Pipol /)).toHaveClass('version-label', 'version-label--inline')
  })

  it('is plain text, not a button', () => {
    render(<VersionLabel />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
