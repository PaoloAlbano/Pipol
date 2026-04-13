import { useState } from 'react'
import { EMOJI_WORDLIST, emojiSvgUrl } from '../p2p/emoji-wordlist.js'
import '../styles/emoji-picker.css'

const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'mammals', label: 'Mammals' },
  { key: 'creatures', label: 'Animals' },
  { key: 'fruits', label: 'Fruits' },
  { key: 'vegetables', label: 'Vegetables' },
  { key: 'nature', label: 'Nature' },
  { key: 'sports', label: 'Sports' },
  { key: 'music', label: 'Misc' },
  { key: 'objects', label: 'Objects' },
]

const BY_CATEGORY = { all: EMOJI_WORDLIST.map((e, i) => ({ ...e, index: i })) }
EMOJI_WORDLIST.forEach((e, i) => {
  const cat = e.category || 'other'
  if (!BY_CATEGORY[cat]) BY_CATEGORY[cat] = []
  BY_CATEGORY[cat].push({ ...e, index: i })
})

/**
 * Visual emoji sequence picker.
 * Each emoji can be used more than once. Click a cell to add it to the sequence.
 * Click a filled slot to remove that position.
 *
 * @param {{ value: object[], onChange: function, maxCount?: number }} props
 *   value    — array of selected emoji entries ({ hex, name, category, index })
 *   onChange — called with updated array
 *   maxCount — defaults to 6
 */
export default function EmojiPicker({ value = [], onChange, maxCount = 6 }) {
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].key)
  const [hoveredName, setHoveredName] = useState(null)

  const isComplete = value.length === maxCount

  // Count how many times each index appears in value
  const indexCount = {}
  value.forEach((e) => {
    indexCount[e.index] = (indexCount[e.index] || 0) + 1
  })

  function handleCellClick(emoji) {
    if (isComplete) return
    onChange([...value, emoji])
  }

  function handleSlotClick(pos) {
    onChange(value.filter((_, i) => i !== pos))
  }

  const cells = BY_CATEGORY[activeCategory] || []

  return (
    <div className="ep">
      {/* Sequence slots */}
      <div className="ep-sequence" aria-label="Selected emoji sequence">
        {Array.from({ length: maxCount }).map((_, i) => {
          const e = value[i]
          return (
            <button
              key={i}
              type="button"
              className={`ep-slot${e ? ' ep-slot--filled' : ''}`}
              onClick={() => e && handleSlotClick(i)}
              title={e ? `Remove "${e.name}"` : `Slot ${i + 1}`}
              aria-label={e ? `Remove ${e.name}` : `Empty slot ${i + 1}`}
            >
              {e ? (
                <img src={emojiSvgUrl(e.hex)} alt={e.name} width="30" height="30" />
              ) : (
                <span className="ep-slot-num">{i + 1}</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Selected names list */}
      <div className="ep-names" aria-label="Selected emoji names">
        {Array.from({ length: maxCount }).map((_, i) => {
          const e = value[i]
          return (
            <span key={i} className={`ep-name-item${e ? ' ep-name-item--filled' : ''}`}>
              <span className="ep-name-num">{i + 1}</span>
              {e ? e.name : '—'}
            </span>
          )
        })}
      </div>

      {/* Progress */}
      <div className={`ep-progress${isComplete ? ' ep-progress--complete' : ''}`}>
        <span>
          <span className="ep-progress-count">{value.length}</span> / {maxCount} selected
        </span>
        {isComplete && <span style={{ color: 'var(--success)' }}>✓ Ready</span>}
      </div>

      {/* Category tabs */}
      <div className="ep-tabs" role="tablist" aria-label="Emoji categories">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            type="button"
            role="tab"
            aria-selected={activeCategory === cat.key}
            className={`ep-tab${activeCategory === cat.key ? ' ep-tab--active' : ''}`}
            onClick={() => setActiveCategory(cat.key)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Emoji grid */}
      <div className="ep-grid" role="listbox" aria-multiselectable="true">
        {cells.map((e) => {
          const count = indexCount[e.index] || 0
          const isSelected = count > 0
          const isDisabled = isComplete
          return (
            <button
              key={e.index}
              type="button"
              role="option"
              aria-selected={isSelected}
              aria-label={e.name}
              className={`ep-cell${isSelected ? ' ep-cell--selected' : ''}${isDisabled ? ' ep-cell--disabled' : ''}`}
              onClick={() => handleCellClick(e)}
              onMouseEnter={() => setHoveredName(e.name)}
              onMouseLeave={() => setHoveredName(null)}
            >
              <img src={emojiSvgUrl(e.hex)} alt={e.name} loading="lazy" />
              {count > 1 && <span className="ep-cell-count">{count}</span>}
            </button>
          )
        })}
      </div>

      {/* Hover info bar */}
      <div className="ep-info-bar">
        {hoveredName ?? (isComplete ? 'Click a slot above to remove an emoji' : 'Hover an emoji to see its name')}
      </div>
    </div>
  )
}
