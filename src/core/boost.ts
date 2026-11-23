// Keeps ProMotion at 120 Hz while the user is touching the screen.
//
// iOS only raises the display to 120 Hz when something "needs" it: a scroll in
// progress or a compositor animation. So while a finger is down, keep:
//   - a "pacer": an invisible 8 px scroller that smooth-scrolls 0 ↔ 200 px every
//     250 ms (so a native scroll is always happening);
//   - a "rate mark": a 1 px element with an infinite CSS translateX(1px) animation.
// Turned on at touchstart; turned off 1 s after the last touch.
// Safari only (there is no cap elsewhere).

import { isSafariEngine } from './env'

const PERIOD_MS = 250
const TRAVEL_PX = 200
const RELEASE_AFTER_MS = 1000

export function installDisplayBoost(host: HTMLElement = document.body) {
  if (!isSafariEngine) return { pin: (_on: boolean) => {} }

  const pacer = document.createElement('div')
  pacer.className = 'display-pacer'
  pacer.setAttribute('aria-hidden', 'true')
  const travel = document.createElement('div')
  travel.style.height = `${TRAVEL_PX * 2}px`
  pacer.append(travel)
  host.append(pacer)

  const mark = document.createElement('span')
  mark.className = 'rate-mark'
  mark.setAttribute('aria-hidden', 'true')

  const state = { active: false, pinned: false, frame: 0, release: 0, forward: true, lastAt: -Infinity }

  const pace = (t: number) => {
    if (t - state.lastAt < PERIOD_MS) return
    state.lastAt = t
    pacer.scrollTo({ top: state.forward ? TRAVEL_PX : 0, behavior: 'smooth' })
    state.forward = !state.forward
  }

  const loop = (t: number) => {
    if (!state.active) return
    pace(t)
    state.frame = requestAnimationFrame(loop)
  }

  const start = () => {
    clearTimeout(state.release)
    if (state.active) return
    state.active = true
    host.append(mark)
    state.lastAt = -Infinity
    state.frame = requestAnimationFrame(loop)
  }

  const stop = () => {
    if (!state.active || state.pinned) return
    state.active = false
    cancelAnimationFrame(state.frame)
    mark.remove()
  }

  const releaseSoon = () => {
    clearTimeout(state.release)
    state.release = window.setTimeout(stop, RELEASE_AFTER_MS)
  }

  const opts = { passive: true, capture: true } as const
  window.addEventListener('touchstart', start, opts)
  const end = (e: TouchEvent) => {
    if (e.touches.length === 0) releaseSoon()
  }
  window.addEventListener('touchend', end, opts)
  window.addEventListener('touchcancel', end, opts)

  return {
    /** Pins the boost on (e.g. during a long animation). */
    pin(on: boolean) {
      state.pinned = on
      if (on) start()
      else releaseSoon()
    },
  }
}
