'use client'
// useScrollSampler: read an element's (or the window's) scroll position as often
// as the platform allows, and get a callback for every reading that changed.
//
// It rides on the shared high-frequency pump (src/core/pump.ts): in Safari a
// vsync-aligned MessageChannel + setTimeout loop with an empty rAF loop next to
// it (which makes WebKit flush scroll positions without waiting for an ack);
// elsewhere plain requestAnimationFrame. The loop parks itself once the position
// has been still for `settleMs` and no finger is down.
//
// The callback is NOT React state on purpose: at 120 readings per second you
// want to write to a canvas, a worker, or a style directly, not re-render.

import { useEffect, type RefObject } from 'react'
import { pump } from '../core/pump'
import { useLatest } from './internal'

export interface ScrollSample {
  left: number
  top: number
  /** performance.now() of the reading. */
  at: number
}

export interface ScrollSamplerOptions {
  /** Keep sampling this long after the last change (ms). Default 1000. */
  settleMs?: number
  enabled?: boolean
}

const WAKE_EVENTS = ['scroll', 'pointerdown', 'touchstart', 'wheel'] as const

export function useScrollSampler(
  target: RefObject<HTMLElement | null> | 'window',
  onSample: (sample: ScrollSample) => void,
  { settleMs = 1000, enabled = true }: ScrollSamplerOptions = {},
) {
  const callback = useLatest(onSample)

  useEffect(() => {
    if (!enabled) return
    const el = target === 'window' ? null : target.current
    if (target !== 'window' && !el) return
    const read = () => (el ? { left: el.scrollLeft, top: el.scrollTop } : { left: window.scrollX, top: window.scrollY })
    let last = read()
    let freshAt = -Infinity
    let touching = false

    const remove = pump.add({
      tick(now) {
        const p = read()
        if (p.left !== last.left || p.top !== last.top) {
          last = p
          freshAt = now
          callback.current({ left: p.left, top: p.top, at: now })
        }
        return touching || now - freshAt < settleMs
      },
    })

    const node: EventTarget = el ?? window
    const wake = () => pump.wake()
    const down = () => {
      touching = true
      pump.wake()
    }
    const up = (e: Event) => {
      if ((e as TouchEvent).touches.length === 0) touching = false
    }
    const opts = { passive: true } as const
    for (const t of WAKE_EVENTS) node.addEventListener(t, wake, opts)
    node.addEventListener('touchstart', down, opts)
    node.addEventListener('touchend', up, opts)
    node.addEventListener('touchcancel', up, opts)
    return () => {
      remove()
      for (const t of WAKE_EVENTS) node.removeEventListener(t, wake)
      node.removeEventListener('touchstart', down)
      node.removeEventListener('touchend', up)
      node.removeEventListener('touchcancel', up)
    }
  }, [target, settleMs, enabled, callback])
}
