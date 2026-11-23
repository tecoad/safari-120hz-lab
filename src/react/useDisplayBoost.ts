'use client'
// useDisplayBoost: keeps iOS ProMotion at 120 Hz while a finger is on the screen
// (Safari only). Installs, once per page, an invisible 8 px "pacer" scroller that
// smooth-scrolls every 250 ms plus a 1 px element with an infinite CSS animation;
// both run from touchstart until 1 s after the last touch ends.
//
// It costs battery. Mount it only on screens with gesture-heavy UI (charts you
// scrub, sheets you drag), and measure. `pin(true)` keeps it on during a long
// programmatic animation.

import { useEffect, useMemo } from 'react'
import { installDisplayBoost } from '../core/boost'

let installed: ReturnType<typeof installDisplayBoost> | null = null
let users = 0

export function useDisplayBoost(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    users++
    if (!installed) installed = installDisplayBoost()
    return () => {
      users--
      // the listeners are cheap and global; keep them installed for the page's lifetime
    }
  }, [enabled])

  return useMemo(
    () => ({
      pin(on: boolean) {
        if (users > 0) installed?.pin(on)
      },
    }),
    [],
  )
}
