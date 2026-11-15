const KEY = 'p2p-chat:call-defaults'

/** What the person had on the last time they joined a call (the next one starts with the same). */
export function getCallDefaults() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    return { camera: saved?.camera !== false, microphone: saved?.microphone !== false }
  } catch {
    return { camera: true, microphone: true }
  }
}

export function setCallDefaults({ camera, microphone }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ camera, microphone }))
  } catch {
    // storage not available: the next call starts with both on
  }
}
