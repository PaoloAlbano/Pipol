/**
 * sdp.test.js
 * Reading the DTLS fingerprint of a session description.
 */

import { sdpFingerprint } from '../../src/webrtc/sdp.js'

const SDP = ['v=0', 'a=ice-ufrag:abcd', 'a=fingerprint:sha-256 AA:BB:0F:1c', 'a=setup:actpass'].join('\r\n')

describe('sdpFingerprint', () => {
  it('reads it from an SDP text or from a description object, in lower case', () => {
    expect(sdpFingerprint(SDP)).toBe('aa:bb:0f:1c')
    expect(sdpFingerprint({ type: 'offer', sdp: SDP })).toBe('aa:bb:0f:1c')
  })

  it('reads other hash algorithms too', () => {
    expect(sdpFingerprint('a=fingerprint:sha-512 12:34')).toBe('12:34')
  })

  it('is null when there is none, or nothing to read', () => {
    expect(sdpFingerprint('v=0\r\na=ice-ufrag:x')).toBeNull()
    expect(sdpFingerprint({ type: 'offer' })).toBeNull()
    expect(sdpFingerprint(null)).toBeNull()
    expect(sdpFingerprint(undefined)).toBeNull()
  })

  it('tells two connections apart, and an ICE restart of the same one as the same', () => {
    const restart = SDP.replace('abcd', 'new-ufrag')
    expect(sdpFingerprint(restart)).toBe(sdpFingerprint(SDP))
    expect(sdpFingerprint(SDP.replace('AA:BB:0F:1c', 'CC:DD'))).not.toBe(sdpFingerprint(SDP))
  })
})
