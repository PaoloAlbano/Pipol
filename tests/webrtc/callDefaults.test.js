import { getCallDefaults, setCallDefaults } from '../../src/webrtc/callDefaults.js'

const KEY = 'p2p-chat:call-defaults'

beforeEach(() => localStorage.removeItem(KEY))

describe('call defaults', () => {
  it('starts with the camera and the microphone on', () => {
    expect(getCallDefaults()).toEqual({ camera: true, microphone: true })
  })

  it('remembers what was chosen', () => {
    setCallDefaults({ camera: false, microphone: true })
    expect(getCallDefaults()).toEqual({ camera: false, microphone: true })
    setCallDefaults({ camera: false, microphone: false })
    expect(getCallDefaults()).toEqual({ camera: false, microphone: false })
  })

  it('takes anything but a saved "off" as on', () => {
    localStorage.setItem(KEY, JSON.stringify({ camera: 'no' }))
    expect(getCallDefaults()).toEqual({ camera: true, microphone: true })
  })

  it('starts with both on when what is saved cannot be read', () => {
    localStorage.setItem(KEY, '{not json')
    expect(getCallDefaults()).toEqual({ camera: true, microphone: true })
  })

  it('does not fail when the storage cannot be written', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    try {
      expect(() => setCallDefaults({ camera: false, microphone: false })).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})
