import { render, screen } from '@testing-library/react'
import Home from '../../src/components/Home.jsx'

function setup() {
  return render(
    <Home
      identity={{ username: 'swift-fox' }}
      onCreateWorkspace={vi.fn()}
      onJoinInvite={vi.fn()}
      onJoinDirectRoom={vi.fn()}
      onUsernameChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  )
}

beforeEach(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
})

describe('Home', () => {
  it('shows the version of the app and the commit', () => {
    setup()
    expect(screen.getByText('Pipol v0.0.0-test · abc1234')).toBeInTheDocument()
  })
})
