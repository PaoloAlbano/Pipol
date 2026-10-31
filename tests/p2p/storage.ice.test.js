/**
 * storage.ice.test.js
 * Persistence of the user's TURN preferences.
 */

describe('storage — ICE settings', () => {
  let storage

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    storage = await import('../../src/p2p/storage.js')
  })

  it('defaults to the workspace/app TURN, calls only, without forcing relay', () => {
    expect(storage.getIceSettings()).toEqual({ mode: 'default', servers: [], forceRelay: false, chatTurn: false })
  })

  it('round-trips custom servers and flags', () => {
    const settings = {
      mode: 'custom',
      servers: [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }],
      forceRelay: true,
      chatTurn: true,
    }
    storage.setIceSettings(settings)
    expect(storage.getIceSettings()).toEqual(settings)
  })

  it('persists "off" (TURN disabled)', () => {
    storage.setIceSettings({ mode: 'off', servers: [], forceRelay: false, chatTurn: false })
    expect(storage.getIceSettings().mode).toBe('off')
  })

  it('ignores unknown modes and non-boolean flags', () => {
    localStorage.setItem(
      'p2p-chat:ice-settings',
      JSON.stringify({ mode: 'weird', servers: 'nope', forceRelay: 'yes', chatTurn: 1 })
    )
    expect(storage.getIceSettings()).toEqual({ mode: 'default', servers: [], forceRelay: false, chatTurn: false })
  })

  it.each([['not json'], ['null'], ['42']])('falls back to defaults for corrupt storage (%s)', (raw) => {
    localStorage.setItem('p2p-chat:ice-settings', raw)
    expect(storage.getIceSettings().mode).toBe('default')
  })
})
