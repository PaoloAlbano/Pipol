/**
 * sdp.js
 * Small readers of session descriptions.
 */

/**
 * DTLS fingerprint of a session description (the object or its SDP text), or null. Every RTCPeerConnection has its
 * own certificate, so the same fingerprint means the same connection (an ICE restart keeps it) and a different one
 * means the other side has made a new connection.
 */
export function sdpFingerprint(description) {
  const sdp = typeof description === 'string' ? description : description?.sdp
  const match = /a=fingerprint:\S+ ([0-9A-Fa-f:]+)/.exec(sdp ?? '')
  return match ? match[1].toLowerCase() : null
}
