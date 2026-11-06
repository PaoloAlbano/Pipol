/**
 * VideoGrid.test.jsx
 * Tests the two layouts (grid / spotlight), the toggle, the thumbnail strip, the avatar and the speaking highlight.
 * jsdom has no layout: the area measures the fallback size of useElementSize (960×540).
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VideoGrid from '../../src/components/VideoGrid.jsx'
import { useSpeaking } from '../../src/webrtc/useSpeaking.js'

vi.mock('../../src/webrtc/useSpeaking.js', () => ({ useSpeaking: vi.fn(() => false) }))

// jsdom does not support HTMLVideoElement.srcObject — we stub it
Object.defineProperty(HTMLVideoElement.prototype, 'srcObject', {
  set() {},
  get() {
    return null
  },
})

// ── Fake stream ────────────────────────────────────────────────────────────────

function makeFakeStream() {
  return { id: Math.random().toString() }
}

// ── Default props ─────────────────────────────────────────────────────────────

function setup(overrides = {}) {
  const defaults = {
    localStream: makeFakeStream(),
    remoteStreams: {},
    peers: [],
    localUsername: 'swift-fox',
    showStats: false,
    peerStats: {},
    layout: 'grid',
    spotlightPeerId: null,
    onLayoutChange: vi.fn(),
    onSpotlightChange: vi.fn(),
  }
  const props = { ...defaults, ...overrides }
  render(<VideoGrid {...props} />)
  return props
}

// ── Layout grid — solo ────────────────────────────────────────────────────────

describe('VideoGrid — layout grid, solo', () => {
  it('displays local tile when no remote peers', () => {
    setup()
    expect(screen.getByText(/swift-fox.*you/i)).toBeInTheDocument()
  })

  it('does not show layout toggle button when no remote peers', () => {
    setup()
    expect(screen.queryByTitle(/layout/i)).toBeNull()
  })

  it('shows only your own tile when alone', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{}}
        peers={[]}
        localUsername="swift-fox"
        showStats={false}
        peerStats={{}}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    expect(container.querySelectorAll('.video-tile')).toHaveLength(1)
  })
})

// ── Layout grid — with remote peers ───────────────────────────────────────────

describe('VideoGrid — layout grid, with remote peers', () => {
  const peer1 = { id: 'peer-1', username: 'alice' }
  const peer2 = { id: 'peer-2', username: 'bob' }

  it('displays remote peer tiles', () => {
    setup({
      peers: [peer1, peer2],
      remoteStreams: {
        'peer-1': makeFakeStream(),
        'peer-2': makeFakeStream(),
      },
    })
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  it('puts your own tile last, in the same grid as the others', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{ 'peer-1': makeFakeStream(), 'peer-2': makeFakeStream() }}
        peers={[peer1, peer2]}
        localUsername="swift-fox"
        showStats={false}
        peerStats={{}}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    const tiles = [...container.querySelectorAll('.video-tile--grid')]
    expect(tiles).toHaveLength(3)
    expect(tiles[2].textContent).toContain('swift-fox')
    // Same size for everybody
    expect(new Set(tiles.map((t) => `${t.style.width}x${t.style.height}`)).size).toBe(1)
  })

  it('never overlaps the tiles', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={Object.fromEntries([1, 2, 3, 4].map((n) => [`p${n}`, makeFakeStream()]))}
        peers={[1, 2, 3, 4].map((n) => ({ id: `p${n}`, username: `user${n}` }))}
        localUsername="swift-fox"
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    const boxes = [...container.querySelectorAll('.video-tile')].map((t) => ({
      l: parseFloat(t.style.left),
      t: parseFloat(t.style.top),
      r: parseFloat(t.style.left) + parseFloat(t.style.width),
      b: parseFloat(t.style.top) + parseFloat(t.style.height),
    }))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        expect(a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b).toBe(false)
      }
    }
  })

  it('displays layout toggle button when remote peers are present', () => {
    setup({
      peers: [peer1],
      remoteStreams: { 'peer-1': makeFakeStream() },
    })
    expect(screen.getByTitle(/spotlight layout/i)).toBeInTheDocument()
  })

  it('calls onLayoutChange with "spotlight" on toggle click', async () => {
    const user = userEvent.setup()
    const { onLayoutChange } = setup({
      peers: [peer1],
      remoteStreams: { 'peer-1': makeFakeStream() },
      layout: 'grid',
    })
    await user.click(screen.getByTitle(/spotlight layout/i))
    expect(onLayoutChange).toHaveBeenCalledWith('spotlight')
  })
})

// ── Layout spotlight ───────────────────────────────────────────────────────────

describe('VideoGrid — layout spotlight', () => {
  const peer1 = { id: 'peer-1', username: 'alice' }
  const peer2 = { id: 'peer-2', username: 'bob' }

  function spotlightSetup(overrides = {}) {
    return setup({
      peers: [peer1, peer2],
      remoteStreams: {
        'peer-1': makeFakeStream(),
        'peer-2': makeFakeStream(),
      },
      layout: 'spotlight',
      spotlightPeerId: 'peer-1',
      ...overrides,
    })
  }

  it('uses video-container--spotlight class', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{ 'peer-1': makeFakeStream(), 'peer-2': makeFakeStream() }}
        peers={[peer1, peer2]}
        localUsername="swift-fox"
        showStats={false}
        peerStats={{}}
        layout="spotlight"
        spotlightPeerId="peer-1"
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    expect(container.querySelector('.video-container--spotlight')).toBeInTheDocument()
  })

  it('displays spotlight peer in main panel', () => {
    spotlightSetup()
    const main = document.querySelector('.video-tile--main')
    expect(main).toBeInTheDocument()
    expect(main.textContent).toContain('alice')
  })

  it('displays other peers in the strip', () => {
    spotlightSetup()
    const strip = [...document.querySelectorAll('.video-tile--strip')]
    expect(strip.map((t) => t.textContent).join(' ')).toContain('bob')
  })

  it('displays your own tile in the strip', () => {
    spotlightSetup()
    const strip = [...document.querySelectorAll('.video-tile--strip')]
    expect(strip.at(-1).textContent).toContain('swift-fox')
  })

  it('makes the main tile fill the area next to the strip', () => {
    spotlightSetup()
    const main = document.querySelector('.video-tile--main')
    // Fallback area 960×540: a side strip, so the main tile takes the full height
    expect(main.style.height).toBe('528px')
  })

  it('toggle in spotlight mode calls onLayoutChange with "grid"', async () => {
    const user = userEvent.setup()
    const { onLayoutChange } = spotlightSetup()
    await user.click(screen.getByTitle(/grid layout/i))
    expect(onLayoutChange).toHaveBeenCalledWith('grid')
  })

  it('click on a strip tile calls onSpotlightChange with peerId', async () => {
    const user = userEvent.setup()
    const { onSpotlightChange } = spotlightSetup()
    await user.click(document.querySelector('.video-tile--clickable'))
    expect(onSpotlightChange).toHaveBeenCalledWith('peer-2')
  })

  it('your own tile in the strip is not clickable', () => {
    spotlightSetup()
    const localTile = [...document.querySelectorAll('.video-tile--strip')].find((t) =>
      t.textContent.includes('swift-fox')
    )
    expect(localTile).not.toHaveClass('video-tile--clickable')
  })

  it('shows a "+N" tile for the people that do not fit in the strip, which goes back to the grid', async () => {
    const user = userEvent.setup()
    const ids = [1, 2, 3, 4, 5, 6].map((n) => `p${n}`)
    const { onLayoutChange } = setup({
      peers: ids.map((id) => ({ id, username: id })),
      remoteStreams: Object.fromEntries(ids.map((id) => [id, makeFakeStream()])),
      layout: 'spotlight',
      spotlightPeerId: 'p1',
    })
    // 5 places in the strip: 3 people, the "+N" tile and you (6 peers, one of them in the main tile)
    expect(document.querySelectorAll('.video-tile--strip')).toHaveLength(4)
    const more = document.querySelector('.video-tile--more')
    expect(more.textContent).toBe('+2')
    expect([...document.querySelectorAll('.video-tile--strip')].at(-1).textContent).toContain('swift-fox')
    await user.click(more)
    expect(onLayoutChange).toHaveBeenCalledWith('grid')
  })

  it('has no "+N" tile when everybody fits', () => {
    spotlightSetup()
    expect(document.querySelector('.video-tile--more')).toBeNull()
  })
})

// ── Own camera off, speaking, timer ───────────────────────────────────────────

describe('VideoGrid — avatar, speaking and timer', () => {
  const peer1 = { id: 'peer-1', username: 'alice' }

  it('shows your initials when your camera is off, keeping the video element', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{}}
        peers={[]}
        localUsername="swift-fox"
        localVideoMuted
        layout="grid"
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    expect(container.querySelector('.video-avatar').textContent).toBe('SF')
    expect(container.querySelector('video')).toHaveClass('video-element--hidden')
  })

  it('shows no avatar while your camera is on', () => {
    setup()
    expect(document.querySelector('.video-avatar')).toBeNull()
  })

  it('highlights the tile of whoever is speaking', () => {
    useSpeaking.mockReturnValue(true)
    setup({ peers: [peer1], remoteStreams: { 'peer-1': makeFakeStream() } })
    expect(document.querySelector('.video-tile--speaking')).toBeInTheDocument()
    useSpeaking.mockReturnValue(false)
  })

  it('does not highlight anybody in silence', () => {
    setup({ peers: [peer1], remoteStreams: { 'peer-1': makeFakeStream() } })
    expect(document.querySelector('.video-tile--speaking')).toBeNull()
  })

  it('shows the call duration in the top bar', () => {
    setup({ callElapsed: '05:42' })
    expect(screen.getByLabelText('Call duration')).toHaveTextContent('05:42')
  })

  it('shows no top bar when there is neither a timer nor a toggle', () => {
    setup()
    expect(document.querySelector('.video-topbar')).toBeNull()
  })
})

// ── autopictureinpicture ───────────────────────────────────────────────────────

describe('VideoGrid — autopictureinpicture attribute', () => {
  const peer1 = { id: 'peer-1', username: 'alice' }

  it('remote (unmuted) videos have the autopictureinpicture attribute', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{ 'peer-1': makeFakeStream() }}
        peers={[peer1]}
        localUsername="me"
        showStats={false}
        peerStats={{}}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    const videos = container.querySelectorAll('video')
    const remoteVideos = [...videos].filter((v) => !v.muted)
    expect(remoteVideos.length).toBeGreaterThan(0)
    remoteVideos.forEach((v) => {
      expect(v.hasAttribute('autopictureinpicture')).toBe(true)
    })
  })

  it('local (muted) video does not have the autopictureinpicture attribute', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{ 'peer-1': makeFakeStream() }}
        peers={[peer1]}
        localUsername="me"
        showStats={false}
        peerStats={{}}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    const videos = container.querySelectorAll('video')
    const localVideos = [...videos].filter((v) => v.muted)
    expect(localVideos.length).toBeGreaterThan(0)
    localVideos.forEach((v) => {
      expect(v.hasAttribute('autopictureinpicture')).toBe(false)
    })
  })
})

// ── Stats overlay ─────────────────────────────────────────────────────────────

describe('VideoGrid — stats overlay: connection route', () => {
  function renderWithStats(stats) {
    return render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{ 'peer-a': makeFakeStream() }}
        peers={[{ id: 'peer-a', username: 'alice' }]}
        localUsername="swift-fox"
        showStats
        peerStats={{ 'peer-a': { rtt: 20, bytesSentPerSec: 1, bytesReceivedPerSec: 1, ...stats } }}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
  }

  it('labels a direct connection', () => {
    const { container } = renderWithStats({
      localType: 'host',
      remoteType: 'srflx',
      relayed: false,
    })
    const route = container.querySelector('.video-stats-route')
    expect(route.textContent).toBe('direct')
    expect(route.className).not.toContain('--relay')
  })

  it('highlights a connection relayed through TURN, with its protocol', () => {
    const { container } = renderWithStats({
      localType: 'relay',
      remoteType: 'host',
      relayed: true,
      relayProtocol: 'tls',
    })
    const route = container.querySelector('.video-stats-route')
    expect(route.textContent).toBe('via TURN (tls)')
    expect(route.className).toContain('--relay')
  })

  it('also flags the case where only the remote side relays', () => {
    const { container } = renderWithStats({ localType: 'host', remoteType: 'relay', relayed: true })
    expect(container.querySelector('.video-stats-route').textContent).toBe('via TURN')
  })
})

describe('VideoGrid — stats overlay', () => {
  const peer1 = { id: 'peer-1', username: 'alice' }

  it('does not show stats if showStats=false', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{ 'peer-1': makeFakeStream() }}
        peers={[peer1]}
        localUsername="swift-fox"
        showStats={false}
        peerStats={{
          'peer-1': {
            localType: 'host',
            remoteType: 'srflx',
            rtt: 20,
            bytesSentPerSec: 1024,
            bytesReceivedPerSec: 2048,
          },
        }}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    expect(container.querySelector('.video-stats-badge')).toBeNull()
  })

  it('displays stats badge if showStats=true and data is present', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{ 'peer-1': makeFakeStream() }}
        peers={[peer1]}
        localUsername="swift-fox"
        showStats={true}
        peerStats={{
          'peer-1': {
            localType: 'host',
            remoteType: 'srflx',
            rtt: 20,
            bytesSentPerSec: 1024,
            bytesReceivedPerSec: 2048,
          },
        }}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    expect(container.querySelector('.video-stats-badge')).toBeInTheDocument()
    expect(container.querySelector('.video-stats-path').textContent).toContain('host')
    expect(container.querySelector('.video-stats-path').textContent).toContain('srflx')
    expect(container.querySelector('.video-stats-rtt').textContent).toContain('20ms')
  })
})

// ── Mirror video ──────────────────────────────────────────────────────────────

describe('VideoGrid — mirrorVideo prop', () => {
  it('applies video-element--mirror to local tile when mirrorVideo=true (solo)', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{}}
        peers={[]}
        localUsername="swift-fox"
        showStats={false}
        peerStats={{}}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
        mirrorVideo={true}
      />
    )
    expect(container.querySelector('.video-element--mirror')).toBeInTheDocument()
  })

  it('does not apply video-element--mirror when mirrorVideo=false (solo)', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{}}
        peers={[]}
        localUsername="swift-fox"
        showStats={false}
        peerStats={{}}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
        mirrorVideo={false}
      />
    )
    expect(container.querySelector('.video-element--mirror')).toBeNull()
  })

  it('does not apply mirror to remote peer tiles', () => {
    const peer1 = { id: 'peer-1', username: 'bob' }
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{ 'peer-1': makeFakeStream() }}
        peers={[peer1]}
        localUsername="swift-fox"
        showStats={false}
        peerStats={{}}
        layout="grid"
        spotlightPeerId={null}
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
        mirrorVideo={true}
      />
    )
    // Only the self-preview tile should be mirrored, not the remote tile
    const mirroredVideos = container.querySelectorAll('.video-element--mirror')
    const allLabels = container.querySelectorAll('.video-label')
    // All mirrored tiles must be the "You" self-preview, not remote peers
    for (const mirrored of mirroredVideos) {
      const tile = mirrored.closest('.video-tile')
      const label = tile?.querySelector('.video-label')
      expect(label?.textContent).toMatch(/you/i)
    }
    expect(allLabels.length).toBeGreaterThan(0)
  })
})

// ── Screen share tiles ───────────────────────────────────────────────────────

describe('VideoGrid — screen share', () => {
  const peers = [{ id: 'peer-a', username: 'alice' }]

  it('shows the camera and the screen of a presenting peer as separate tiles', () => {
    setup({
      peers,
      remoteStreams: { 'peer-a': makeFakeStream() },
      remoteScreens: { 'peer-a': makeFakeStream() },
    })
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('alice (screen)')).toBeInTheDocument()
  })

  it('puts the screen in the spotlight and the camera in the strip', () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={{ 'peer-a': makeFakeStream() }}
        remoteScreens={{ 'peer-a': makeFakeStream() }}
        peers={peers}
        localUsername="swift-fox"
        layout="spotlight"
        spotlightPeerId="peer-a"
        onLayoutChange={vi.fn()}
        onSpotlightChange={vi.fn()}
      />
    )
    const main = container.querySelector('.video-tile--main')
    const strip = [...container.querySelectorAll('.video-tile--strip')].map((t) => t.textContent).join(' ')
    expect(main.textContent).toContain('alice (screen)')
    expect(strip).toContain('alice')
    expect(strip).not.toContain('(screen)')
  })
})
