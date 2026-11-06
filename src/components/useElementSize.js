import { useLayoutEffect, useState } from 'react'

// Used until the element has been measured (and in environments without layout, such as tests)
const FALLBACK = { width: 960, height: 540 }

/**
 * Size in px of an element, kept up to date while it is resized. Re-renders only when the size really changes.
 * @param {{ current: HTMLElement|null }} ref
 * @returns {{ width: number, height: number }}
 */
export function useElementSize(ref, fallback = FALLBACK) {
  const [size, setSize] = useState(fallback)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined

    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      if (!(width > 0) || !(height > 0)) return
      setSize((prev) =>
        Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1 ? prev : { width, height }
      )
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return size
}
