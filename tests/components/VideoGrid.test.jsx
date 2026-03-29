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
  it('mostra il tile locale quando non ci sono peer remoti', () => {
    setup()
    expect(screen.getByText(/swift-fox.*you/i)).toBeInTheDocument()
  })

  it('non mostra il pulsante layout toggle quando non ci sono peer remoti', () => {
    setup()
    expect(screen.queryByTitle(/layout/i)).toBeNull()
  })

  it('non mostra il self-preview angolare quando è solo', () => {
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

describe('VideoGrid — layout grid, con peer remoti', () => {
  const peer1 = { id: 'peer-1', username: 'alice' }
  const peer2 = { id: 'peer-2', username: 'bob' }

  it('mostra i tile dei peer remoti', () => {
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

  it('mostra il self-preview angolare quando ci sono peer remoti', () => {
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

  it('mostra il pulsante layout toggle quando ci sono peer remoti', () => {
    setup({
      peers: [peer1],
      remoteStreams: { 'peer-1': makeFakeStream() },
    })
    expect(screen.getByTitle(/spotlight layout/i)).toBeInTheDocument()
  })

  it('chiama onLayoutChange con "spotlight" al click del toggle', async () => {
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

  it('usa la classe video-container--spotlight', () => {
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

  it('mostra il peer in spotlight nel pannello principale', () => {
    spotlightSetup()
    const main = document.querySelector('.video-spotlight-main')
    expect(main).toBeInTheDocument()
    expect(main.textContent).toContain('alice')
  })

  it('mostra gli altri peer nella sidebar', () => {
    spotlightSetup()
    const sidebar = document.querySelector('.video-spotlight-sidebar')
    expect(sidebar).toBeInTheDocument()
    expect(sidebar.textContent).toContain('bob')
  })

  it('mostra il self-preview nella sidebar', () => {
    spotlightSetup()
    const sidebar = document.querySelector('.video-spotlight-sidebar')
    expect(sidebar.textContent).toContain('swift-fox')
  })

  it('il toggle in spotlight mode chiama onLayoutChange con "grid"', async () => {
    const user = userEvent.setup()
    const { onLayoutChange } = spotlightSetup()
    await user.click(screen.getByTitle(/grid layout/i))
    expect(onLayoutChange).toHaveBeenCalledWith('grid')
  })

  it('click su tile sidebar chiama onSpotlightChange con il peerId', async () => {
    const user = userEvent.setup()
    const { onSpotlightChange } = spotlightSetup()
    const sidebar = document.querySelector('.video-spotlight-sidebar')
    const clickableTile = sidebar.querySelector('.video-tile--clickable')
    await user.click(clickableTile)
    expect(onSpotlightChange).toHaveBeenCalledWith('peer-2')
  })

  it('il tile locale nella sidebar non è cliccabile', () => {
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

  it('non mostra stats se showStats=false', () => {
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

  it('mostra il badge stats se showStats=true e ci sono dati', () => {
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
