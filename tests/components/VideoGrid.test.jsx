/**
 * VideoGrid.test.jsx
 * Tests the two layouts (grid / spotlight), the toggle and sidebar interaction.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VideoGrid from '../../src/components/VideoGrid.jsx'

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

  it('does not show corner self-preview when alone', () => {
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
    expect(container.querySelector('.video-self-preview')).toBeNull()
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

  it('displays corner self-preview when remote peers are present', () => {
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
      />
    )
    expect(container.querySelector('.video-self-preview')).toBeInTheDocument()
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
    const main = document.querySelector('.video-spotlight-main')
    expect(main).toBeInTheDocument()
    expect(main.textContent).toContain('alice')
  })

  it('displays other peers in sidebar', () => {
    spotlightSetup()
    const sidebar = document.querySelector('.video-spotlight-sidebar')
    expect(sidebar).toBeInTheDocument()
    expect(sidebar.textContent).toContain('bob')
  })

  it('displays self-preview in sidebar', () => {
    spotlightSetup()
    const sidebar = document.querySelector('.video-spotlight-sidebar')
    expect(sidebar.textContent).toContain('swift-fox')
  })

  it('toggle in spotlight mode calls onLayoutChange with "grid"', async () => {
    const user = userEvent.setup()
    const { onLayoutChange } = spotlightSetup()
    await user.click(screen.getByTitle(/grid layout/i))
    expect(onLayoutChange).toHaveBeenCalledWith('grid')
  })

  it('click on sidebar tile calls onSpotlightChange with peerId', async () => {
    const user = userEvent.setup()
    const { onSpotlightChange } = spotlightSetup()
    const sidebar = document.querySelector('.video-spotlight-sidebar')
    const clickableTile = sidebar.querySelector('.video-tile--clickable')
    await user.click(clickableTile)
    expect(onSpotlightChange).toHaveBeenCalledWith('peer-2')
  })

  it('local tile in sidebar is not clickable', () => {
    spotlightSetup()
    const sidebar = document.querySelector('.video-spotlight-sidebar')
    const tiles = sidebar.querySelectorAll('.video-tile')
    const localTile = [...tiles].find((t) => t.textContent.includes('swift-fox'))
    expect(localTile).not.toHaveClass('video-tile--clickable')
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
