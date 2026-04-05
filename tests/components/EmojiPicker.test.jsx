/**
 * EmojiPicker.test.jsx
 * Tests for the visual emoji sequence picker component.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import EmojiPicker from '../../src/components/EmojiPicker.jsx'
import { EMOJI_WORDLIST } from '../../src/p2p/emoji-wordlist.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup(props = {}) {
  const onChange = vi.fn()
  const result = render(<EmojiPicker value={[]} onChange={onChange} {...props} />)
  return { onChange, ...result }
}

function firstEmoji() {
  return EMOJI_WORDLIST[0] // dog face
}

function emojiCell(name) {
  return screen.getByRole('option', { name })
}

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('EmojiPicker — rendering', () => {
  it('renders the correct number of empty slots', () => {
    setup()
    const slots = screen.getAllByRole('button', { name: /^Empty slot \d+$/ })
    expect(slots).toHaveLength(6)
  })

  it('respects a custom maxCount', () => {
    setup({ maxCount: 4 })
    const slots = screen.getAllByRole('button', { name: /^Empty slot \d+$/ })
    expect(slots).toHaveLength(4)
  })

  it('renders the All category tab active by default', () => {
    setup()
    const allTab = screen.getByRole('tab', { name: 'All' })
    expect(allTab).toHaveAttribute('aria-selected', 'true')
  })

  it('renders all 9 category tabs', () => {
    setup()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(9)
  })

  it('renders all 128 emoji when All tab is active', () => {
    setup()
    const cells = screen.getAllByRole('option')
    expect(cells).toHaveLength(128)
  })

  it('shows progress as 0 / 6 initially', () => {
    setup()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText('/ 6 selected')).toBeInTheDocument()
  })

  it('shows the hover info hint text by default', () => {
    setup()
    expect(screen.getByText('Hover an emoji to see its name')).toBeInTheDocument()
  })
})

// ── Selecting emoji ───────────────────────────────────────────────────────────

describe('EmojiPicker — selecting emoji', () => {
  it('calls onChange with the emoji added when a cell is clicked', () => {
    const { onChange } = setup()
    fireEvent.click(emojiCell(firstEmoji().name))
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: firstEmoji().name, index: 0 }),
    ])
  })

  it('appends to the existing value on each click', () => {
    const first = { ...EMOJI_WORDLIST[0], index: 0 }
    const { onChange } = setup({ value: [first] })
    const second = EMOJI_WORDLIST[1]
    fireEvent.click(emojiCell(second.name))
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ index: 0 }),
      expect.objectContaining({ index: 1 }),
    ])
  })

  it('allows the same emoji to be selected multiple times', () => {
    const first = { ...EMOJI_WORDLIST[0], index: 0 }
    const { onChange } = setup({ value: [first] })
    fireEvent.click(emojiCell(firstEmoji().name))
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ index: 0 }),
      expect.objectContaining({ index: 0 }),
    ])
  })

  it('does not call onChange when maxCount is already reached', () => {
    const filledValue = Array.from({ length: 6 }, (_, i) => ({
      ...EMOJI_WORDLIST[i],
      index: i,
    }))
    const { onChange } = setup({ value: filledValue })
    fireEvent.click(emojiCell(EMOJI_WORDLIST[0].name))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows ✓ Ready and updated count when maxCount is reached', () => {
    const filledValue = Array.from({ length: 6 }, (_, i) => ({
      ...EMOJI_WORDLIST[i],
      index: i,
    }))
    const { container } = setup({ value: filledValue })
    expect(screen.getByText('✓ Ready')).toBeInTheDocument()
    expect(container.querySelector('.ep-progress-count').textContent).toBe('6')
  })

  it('marks selected emoji cells as aria-selected', () => {
    const selected = { ...EMOJI_WORDLIST[0], index: 0 }
    setup({ value: [selected] })
    expect(emojiCell(firstEmoji().name)).toHaveAttribute('aria-selected', 'true')
  })

  it('shows a count badge when the same emoji appears more than once', () => {
    const repeated = { ...EMOJI_WORDLIST[0], index: 0 }
    const { container } = setup({ value: [repeated, repeated] })
    expect(container.querySelector('.ep-cell-count').textContent).toBe('2')
  })
})

// ── Removing emoji via slots ──────────────────────────────────────────────────

describe('EmojiPicker — removing via slots', () => {
  it('calls onChange with the item removed when a filled slot is clicked', () => {
    const first = { ...EMOJI_WORDLIST[0], index: 0 }
    const second = { ...EMOJI_WORDLIST[1], index: 1 }
    const { onChange } = setup({ value: [first, second] })

    fireEvent.click(screen.getByRole('button', { name: `Remove ${first.name}` }))
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ index: 1 })])
  })

  it('removes the correct position when the same emoji appears twice', () => {
    const e = { ...EMOJI_WORDLIST[0], index: 0 }
    const other = { ...EMOJI_WORDLIST[1], index: 1 }
    const { onChange } = setup({ value: [e, other, e] })

    // Click the third slot (index 2 in value = second occurrence of e)
    const filledSlots = screen.getAllByRole('button', { name: `Remove ${e.name}` })
    fireEvent.click(filledSlots[1])
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ index: 0 }),
      expect.objectContaining({ index: 1 }),
    ])
  })

  it('does not call onChange when clicking an empty slot', () => {
    const { onChange } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Empty slot 1' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

// ── Category tabs ─────────────────────────────────────────────────────────────

describe('EmojiPicker — category tabs', () => {
  it('switches to a category and shows only its emoji', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Mammals' }))
    const cells = screen.getAllByRole('option')
    // All visible cells should be mammals
    cells.forEach((cell) => {
      const name = cell.getAttribute('aria-label')
      const entry = EMOJI_WORDLIST.find((e) => e.name === name)
      expect(entry?.category).toBe('mammals')
    })
  })

  it('marks the clicked tab as aria-selected', () => {
    setup()
    const tab = screen.getByRole('tab', { name: 'Fruits' })
    fireEvent.click(tab)
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false')
  })
})

// ── Hover info bar ────────────────────────────────────────────────────────────

describe('EmojiPicker — hover info bar', () => {
  it('shows the emoji name on mouse enter', () => {
    setup()
    fireEvent.mouseEnter(emojiCell(firstEmoji().name))
    expect(screen.getByText(firstEmoji().name)).toBeInTheDocument()
  })

  it('reverts to the hint text on mouse leave', () => {
    setup()
    const cell = emojiCell(firstEmoji().name)
    fireEvent.mouseEnter(cell)
    fireEvent.mouseLeave(cell)
    expect(screen.getByText('Hover an emoji to see its name')).toBeInTheDocument()
  })

  it('shows the removal hint when the sequence is full', () => {
    const filledValue = Array.from({ length: 6 }, (_, i) => ({
      ...EMOJI_WORDLIST[i],
      index: i,
    }))
    setup({ value: filledValue })
    expect(screen.getByText('Click a slot above to remove an emoji')).toBeInTheDocument()
  })
})

// ── Selected names list ───────────────────────────────────────────────────────

describe('EmojiPicker — selected names list', () => {
  it('shows dashes for empty slots in the names list', () => {
    setup()
    const dashes = screen.getAllByText('—')
    expect(dashes).toHaveLength(6)
  })

  it('shows the emoji name in the names list when selected', () => {
    const selected = { ...EMOJI_WORDLIST[0], index: 0 }
    setup({ value: [selected] })
    // The name appears both in the grid cell aria-label and in the names list
    const nameItems = screen.getAllByText(firstEmoji().name)
    expect(nameItems.length).toBeGreaterThanOrEqual(1)
  })

  it('shows one fewer dash for each selected emoji', () => {
    const selected = [
      { ...EMOJI_WORDLIST[0], index: 0 },
      { ...EMOJI_WORDLIST[1], index: 1 },
    ]
    setup({ value: selected })
    const dashes = screen.getAllByText('—')
    expect(dashes).toHaveLength(4)
  })
})
