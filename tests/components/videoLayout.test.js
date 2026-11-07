/**
 * videoLayout.test.js
 * Geometry of the video area: tiles stay inside it, never overlap and are as big as they can be.
 */

import {
  GAP,
  layoutGrid,
  spotlightGeometry,
  stripRects,
  cameraFit,
  initials,
  avatarHue,
} from '../../src/components/videoLayout.js'

function overlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function expectInside(rects, width, height) {
  for (const r of rects) {
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y).toBeGreaterThanOrEqual(0)
    expect(r.x + r.width).toBeLessThanOrEqual(width)
    expect(r.y + r.height).toBeLessThanOrEqual(height)
  }
}

function expectNoOverlap(rects) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBe(false)
  }
}

const AREAS = [
  [1200, 700],
  [900, 890],
  [390, 330],
  [360, 620],
  [1900, 900],
]

describe('layoutGrid', () => {
  it('returns nothing for no tiles or an area without size', () => {
    expect(layoutGrid(0, 800, 600).rects).toEqual([])
    expect(layoutGrid(3, 0, 600).rects).toEqual([])
    expect(layoutGrid(3, 800, -1).rects).toEqual([])
  })

  it.each(AREAS)('keeps 1 to 12 tiles inside a %i×%i area without overlap', (width, height) => {
    for (let count = 1; count <= 12; count++) {
      const { rects } = layoutGrid(count, width, height)
      expect(rects).toHaveLength(count)
      expectInside(rects, width, height)
      expectNoOverlap(rects)
    }
  })

  it('gives every tile the same size', () => {
    const { rects } = layoutGrid(5, 1200, 700)
    expect(new Set(rects.map((r) => `${r.width}x${r.height}`)).size).toBe(1)
  })

  it('puts two people side by side in a wide area and stacked in a tall one', () => {
    const wide = layoutGrid(2, 1200, 600)
    expect(wide.cols).toBe(2)
    expect(wide.rects[0].y).toBe(wide.rects[1].y)

    const tall = layoutGrid(2, 360, 700)
    expect(tall.cols).toBe(1)
    expect(tall.rects[0].x).toBe(tall.rects[1].x)
  })

  it('centres the tiles in the area', () => {
    const { rects } = layoutGrid(1, 1000, 800)
    const [r] = rects
    expect(Math.abs(r.x - (1000 - (r.x + r.width)))).toBeLessThanOrEqual(1)
    expect(Math.abs(r.y - (800 - (r.y + r.height)))).toBeLessThanOrEqual(1)
  })

  it('centres an incomplete last row', () => {
    const { cols, rects } = layoutGrid(5, 1200, 700)
    expect(cols).toBe(3)
    const last = rects[4]
    const lastRowCentre = (rects[3].x + (rects[4].x + last.width)) / 2
    expect(Math.abs(lastRowCentre - 600)).toBeLessThanOrEqual(1)
  })

  it('leaves the gap between neighbours', () => {
    const { rects } = layoutGrid(4, 1200, 700)
    expect(rects[1].x - (rects[0].x + rects[0].width)).toBe(GAP)
  })

  it('uses 16:9 tiles, falling back to 4:3 only when that is clearly bigger', () => {
    expect(layoutGrid(1, 1280, 720).aspect).toBeCloseTo(16 / 9)
    expect(layoutGrid(1, 800, 600).aspect).toBeCloseTo(4 / 3)
  })

  it('is as big as the area allows: one tile fills the width of a 16:9 area', () => {
    const { rects } = layoutGrid(1, 1280, 720)
    expect(rects[0].width).toBe(1280)
  })
})

describe('spotlightGeometry and stripRects', () => {
  it('puts the strip at the side of a wide area and below a narrow one', () => {
    expect(spotlightGeometry(1200, 600).orientation).toBe('side')
    expect(spotlightGeometry(390, 330).orientation).toBe('bottom')
  })

  it.each(AREAS)('keeps the main tile and the strip inside a %i×%i area without overlap', (width, height) => {
    const geometry = spotlightGeometry(width, height)
    for (let count = 1; count <= geometry.slots; count++) {
      const rects = [geometry.main, ...stripRects(geometry, count, width, height)]
      expectInside(rects, width, height)
      expectNoOverlap(rects)
    }
  })

  it('makes the main tile use all the space left by the strip', () => {
    const side = spotlightGeometry(1200, 600)
    expect(side.main.height).toBe(600)
    expect(side.main.width + GAP + side.tileWidth).toBe(1200)

    const bottom = spotlightGeometry(400, 800)
    expect(bottom.main.width).toBe(400)
    expect(bottom.main.height + GAP + bottom.tileHeight).toBe(800)
  })

  it('always has room for at least two thumbnails', () => {
    expect(spotlightGeometry(1600, 120).slots).toBeGreaterThanOrEqual(2)
    expect(spotlightGeometry(200, 600).slots).toBeGreaterThanOrEqual(2)
  })

  it('keeps thumbnails within a readable size range', () => {
    expect(spotlightGeometry(4000, 1500).tileWidth).toBe(230)
    expect(spotlightGeometry(400, 200).tileWidth).toBeGreaterThanOrEqual(110)
  })

  it('centres a bottom strip', () => {
    const geometry = spotlightGeometry(400, 800)
    const [first, , last] = stripRects(geometry, 3, 400, 800)
    expect(Math.abs(first.x - (400 - (last.x + last.width)))).toBeLessThanOrEqual(1)
  })
})

describe('cameraFit', () => {
  it('crops (cover) a tile with the shape of a video', () => {
    expect(cameraFit(640, 360)).toBe('cover')
    expect(cameraFit(400, 300)).toBe('cover')
  })

  it('keeps the whole picture (contain) in a very wide or very tall tile', () => {
    expect(cameraFit(1000, 300)).toBe('contain')
    expect(cameraFit(300, 600)).toBe('contain')
  })

  it('defaults to cover without a size', () => {
    expect(cameraFit(0, 0)).toBe('cover')
  })
})

describe('initials', () => {
  it('takes the first letters of the first two words', () => {
    expect(initials('swift-fox')).toBe('SF')
    expect(initials('Mario Rossi')).toBe('MR')
    expect(initials('a b c')).toBe('AB')
  })

  it('takes the first two letters of a single word', () => {
    expect(initials('alice')).toBe('AL')
    expect(initials('x')).toBe('X')
  })

  it('handles accents, emoji and non-latin names', () => {
    expect(initials('élodie')).toBe('ÉL')
    expect(initials('李 雷')).toBe('李雷')
    expect(initials('😀 smile')).not.toBe('?')
  })

  it('shows a question mark without a name', () => {
    expect(initials('')).toBe('?')
    expect(initials('   ')).toBe('?')
    expect(initials(null)).toBe('?')
    expect(initials(undefined)).toBe('?')
    expect(initials('---')).toBe('?')
  })
})

describe('avatarHue', () => {
  it('is stable for a name and within the colour wheel', () => {
    expect(avatarHue('alice')).toBe(avatarHue('alice'))
    for (const name of ['alice', 'bob', '', null, '李雷']) {
      expect(avatarHue(name)).toBeGreaterThanOrEqual(0)
      expect(avatarHue(name)).toBeLessThan(360)
    }
  })

  it('differs between different names', () => {
    expect(avatarHue('alice')).not.toBe(avatarHue('bob'))
  })
})
