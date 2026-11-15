import { useEffect, useRef } from 'react'

/** Keys of the call, plain (no Ctrl, Cmd or Alt, so the browser's own shortcuts are left alone). */
export const SHORTCUTS = { audio: 'm', video: 'v', hand: 'h' }

/** Where a key means typing, or pressing the control that has the focus: the call keys must not take it. */
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const PRESSABLE = 'button, a, summary, [role="button"], [role="menuitem"]'

function target(event) {
  return event.target instanceof Element ? event.target : null
}

/**
 * Keyboard shortcuts for a call, while `active` (and not while typing in a text field): `M` mutes or unmutes the
 * microphone, `V` turns the camera off or on, `H` raises or lowers the hand, and holding `Space` while muted talks
 * until it is let go (push-to-talk).
 *
 * A key whose handler is missing does nothing, which is how a device that has no camera or microphone is left out.
 * `talk` is `{ start, end }`: `start()` returns false when there is nothing to start (the microphone is not muted).
 *
 * @param {boolean} active
 * @param {{ toggleAudio?: Function, toggleVideo?: Function, toggleHand?: Function,
 *           talk?: { start: () => boolean, end: () => void } }} handlers
 * @param {EventTarget | null} [pipWindow]  The Picture-in-Picture window of the call, to listen on as well
 */
export function useCallShortcuts(active, handlers, pipWindow = null) {
  const latest = useRef(handlers)
  // The listeners below are bound once and always call the handlers of the last render
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    if (!active) return undefined

    let talking = false
    const endTalk = () => {
      if (!talking) return
      talking = false
      latest.current.talk?.end()
    }

    function onKeyDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
      const el = target(event)
      if (el?.closest(TYPING)) return
      const h = latest.current

      if (event.code === 'Space') {
        // A button or link with the focus uses Space to be pressed
        if (!h.talk || el?.closest(PRESSABLE)) return
        if (!event.repeat && !talking && h.talk.start()) talking = true
        // The key is taken from the page (it would scroll) only while it is the push-to-talk key
        if (talking) event.preventDefault()
        return
      }
      if (event.repeat) return

      const key = event.key.toLowerCase()
      const action = {
        [SHORTCUTS.audio]: h.toggleAudio,
        [SHORTCUTS.video]: h.toggleVideo,
        [SHORTCUTS.hand]: h.toggleHand,
      }[key]
      if (!action) return
      event.preventDefault()
      action()
    }

    function onKeyUp(event) {
      if (event.code === 'Space') endTalk()
    }

    // The microphone must not stay open when the window loses the focus before the key is let go
    const targets = pipWindow ? [window, pipWindow] : [window]
    for (const t of targets) {
      t.addEventListener('keydown', onKeyDown)
      t.addEventListener('keyup', onKeyUp)
      t.addEventListener('blur', endTalk)
    }
    return () => {
      for (const t of targets) {
        t.removeEventListener('keydown', onKeyDown)
        t.removeEventListener('keyup', onKeyUp)
        t.removeEventListener('blur', endTalk)
      }
      endTalk()
    }
  }, [active, pipWindow])
}
