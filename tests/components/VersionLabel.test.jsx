import { render, screen, act, fireEvent } from '@testing-library/react'
import VersionLabel from '../../src/components/VersionLabel.jsx'

const TEXT = 'Pipol v0.0.0-test · abc1234'

// fireEvent, not userEvent: userEvent puts a clipboard of its own on the page, and these tests are about the real call
const click = () => act(async () => fireEvent.click(screen.getByRole('button')))

describe('VersionLabel', () => {
  let writeText

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('shows the version of the app and the commit', () => {
    render(<VersionLabel />)
    expect(screen.getByRole('button', { name: TEXT })).toBeInTheDocument()
  })

  it('takes the class that places it', () => {
    render(<VersionLabel className="version-label--inline" />)
    expect(screen.getByRole('button')).toHaveClass('version-label', 'version-label--inline')
  })

  it('copies the text on a click, says so, and goes back to the version', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<VersionLabel />)

    await click()
    expect(writeText).toHaveBeenCalledWith(TEXT)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()

    await act(async () => vi.advanceTimersByTime(1600))
    expect(screen.getByRole('button', { name: TEXT })).toBeInTheDocument()
  })

  it('does not break when the text cannot be copied, and does not say it was', async () => {
    writeText.mockRejectedValue(new Error('refused'))
    render(<VersionLabel />)
    await click()
    expect(screen.getByRole('button', { name: TEXT })).toBeInTheDocument()
  })

  it('does not break on a page with no clipboard', async () => {
    Reflect.deleteProperty(navigator, 'clipboard')
    render(<VersionLabel />)
    await click()
    expect(screen.getByRole('button', { name: TEXT })).toBeInTheDocument()
  })

  it('stops waiting to go back when it goes away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { unmount } = render(<VersionLabel />)
    await click()
    unmount()
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
  })
})
