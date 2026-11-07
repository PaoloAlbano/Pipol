/**
 * videoLayout.js
 * Pure geometry of the video area: where each tile goes, in pixels, for a given size of the area.
 *
 * Tiles are placed with absolute positions computed here (not by CSS grid), so that:
 *  - the arrangement follows the real shape of the area (2 people side by side on a wide screen, stacked on a
 *    phone held upright) instead of a fixed rows × columns table;
 *  - a tile keeps its element when the layout changes, so the video does not restart and the move can animate.
 */

/** Space between tiles, in px. */
export const GAP = 6

const WIDE = 16 / 9
const BOXY = 4 / 3
// A 4:3 tile wastes less space in narrow areas, but crops 16:9 webcams more. Use it only when it is clearly bigger.
const BOXY_MUST_BE_BIGGER_BY = 1.15
// An area wider than this (width / height) gets the strip of thumbnails at its side, a narrower one below
const SIDE_STRIP_FROM_RATIO = 1.6

const clamp = (n, min, max) => Math.min(max, Math.max(min, n))

function bestForAspect(count, width, height, gap, aspect) {
  let best = null
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    let w = (width - gap * (cols - 1)) / cols
    let h = w / aspect
    const maxH = (height - gap * (rows - 1)) / rows
    if (h > maxH) {
      h = maxH
      w = h * aspect
    }
    if (!(w > 0 && h > 0)) continue
    const area = w * h
    const empty = cols * rows - count
    // Biggest tiles win; with the same size, the arrangement with fewer empty places
    if (!best || area > best.area + 1 || (Math.abs(area - best.area) <= 1 && empty < best.empty)) {
      best = { cols, rows, w, h, area, empty, aspect }
    }
  }
  return best
}

/**
 * Arranges `count` equal tiles in an area, as big as they can be, centred (an incomplete last row is centred too).
 *
 * @param {number} count
 * @param {number} width   Width of the area
 * @param {number} height  Height of the area
 * @param {{ gap?: number }} [options]
 * @returns {{ cols: number, rows: number, aspect: number, rects: { x: number, y: number, width: number, height: number }[] }}
 */
export function layoutGrid(count, width, height, { gap = GAP } = {}) {
  const none = { cols: 0, rows: 0, aspect: WIDE, rects: [] }
  if (count <= 0 || !(width > 0) || !(height > 0)) return none

  const wide = bestForAspect(count, width, height, gap, WIDE)
  const boxy = bestForAspect(count, width, height, gap, BOXY)
  const pick = wide && boxy && boxy.area > wide.area * BOXY_MUST_BE_BIGGER_BY ? boxy : (wide ?? boxy)
  if (!pick) return none

  const { cols, rows } = pick
  const tileWidth = Math.floor(pick.w)
  const tileHeight = Math.floor(pick.h)
  const top = Math.floor((height - (rows * tileHeight + (rows - 1) * gap)) / 2)
  const inLastRow = count - (rows - 1) * cols

  const rects = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const inRow = row === rows - 1 ? inLastRow : cols
    const left = Math.floor((width - (inRow * tileWidth + (inRow - 1) * gap)) / 2)
    rects.push({
      x: left + col * (tileWidth + gap),
      y: top + row * (tileHeight + gap),
      width: tileWidth,
      height: tileHeight,
    })
  }
  return { cols, rows, aspect: pick.aspect, rects }
}

/**
 * Geometry of the spotlight layout: one big tile and a strip of thumbnails. A wide area puts the strip in a column
 * on the right, a narrow one in a row at the bottom, so the big tile keeps a shape that suits a video.
 *
 * @returns {{ orientation: 'side'|'bottom', tileWidth: number, tileHeight: number, slots: number,
 *             main: { x: number, y: number, width: number, height: number } }}
 *   `slots` is how many thumbnails fit in the strip.
 */
export function spotlightGeometry(width, height, { gap = GAP } = {}) {
  if (width / height >= SIDE_STRIP_FROM_RATIO) {
    // At least two thumbnails must fit in the height
    const tileWidth = Math.min(
      clamp(Math.round(width * 0.17), 110, 230),
      Math.max(0, Math.floor(((height - gap) / 2) * (16 / 9)))
    )
    const tileHeight = Math.round((tileWidth * 9) / 16)
    const slots = Math.max(2, Math.floor((height + gap) / (tileHeight + gap)))
    return {
      orientation: 'side',
      tileWidth,
      tileHeight,
      slots,
      main: { x: 0, y: 0, width: Math.max(0, width - tileWidth - gap), height },
    }
  }
  // At least two thumbnails must fit in the width
  const tileHeight = Math.min(
    clamp(Math.round(height * 0.2), 70, 140),
    Math.max(0, Math.floor(((width - gap) / 2) * (9 / 16)))
  )
  const tileWidth = Math.round((tileHeight * 16) / 9)
  const slots = Math.max(2, Math.floor((width + gap) / (tileWidth + gap)))
  return {
    orientation: 'bottom',
    tileWidth,
    tileHeight,
    slots,
    main: { x: 0, y: 0, width, height: Math.max(0, height - tileHeight - gap) },
  }
}

/**
 * Positions of `count` thumbnails in the strip described by `geometry` (see spotlightGeometry).
 * @returns {{ x: number, y: number, width: number, height: number }[]}
 */
export function stripRects(geometry, count, width, height, { gap = GAP } = {}) {
  const { orientation, tileWidth, tileHeight } = geometry
  const rects = []
  for (let i = 0; i < count; i++) {
    if (orientation === 'side') {
      rects.push({
        x: width - tileWidth,
        y: i * (tileHeight + gap),
        width: tileWidth,
        height: tileHeight,
      })
    } else {
      const left = Math.floor((width - (count * tileWidth + (count - 1) * gap)) / 2)
      rects.push({
        x: left + i * (tileWidth + gap),
        y: height - tileHeight,
        width: tileWidth,
        height: tileHeight,
      })
    }
  }
  return rects
}

/**
 * How a camera fills a tile. `cover` crops the picture to fill the tile, which is fine while the tile has about the
 * shape of a video and cuts off faces when it is very wide or very tall; then the whole picture is kept (`contain`).
 */
export function cameraFit(width, height) {
  if (!(width > 0) || !(height > 0)) return 'cover'
  const ratio = width / height
  return ratio >= 1.25 && ratio <= 2.1 ? 'cover' : 'contain'
}

/** Up to two letters standing for a name ("swift-fox" → "SF", "alice" → "AL"), "?" when there is none. */
export function initials(name) {
  const words = String(name ?? '')
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const first = (word) => Array.from(word)[0]
  if (words.length >= 2) return (first(words[0]) + first(words[1])).toUpperCase()
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase()
  return '?'
}

/** A stable colour (hue, 0–359) for a name, so that somebody keeps the same avatar colour. */
export function avatarHue(name) {
  let hash = 0
  for (const ch of String(name ?? '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0
  return hash % 360
}
