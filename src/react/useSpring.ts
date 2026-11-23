'use client'
// useSpring: an imperative spring in Apple's (dampingRatio, response) format,
// stepped on the shared high-frequency pump. It never re-renders: you get the
// value in `onChange` and write it wherever it goes (a style, a canvas, a worker).
//
//   const x = useSpring(0, { dampingRatio: 0.8, response: 0.4 }, (v) => {
//     el.current!.style.transform = `translateX(${v}px)`
//   })
//   x.to(120)               // animate
//   x.to(0, SNAP, true)     // with another spec, clamped at the first crossing
//   x.jump(0)               // set without animating

import { useEffect, useMemo, useRef } from 'react'
import { pump } from '../core/pump'
import { Spring, type SpringSpec } from '../core/spring'
import { useLatest } from './internal'

export type { SpringSpec }

export interface SpringHandle {
  readonly value: number
  readonly velocity: number
  readonly target: number
  to(target: number, spec?: SpringSpec, clamp?: boolean): void
  jump(value: number): void
  /** Adds velocity (units per second), e.g. a "kick" toward a target. */
  kick(velocity: number): void
}

export function useSpring(initial: number, spec: SpringSpec, onChange: (value: number) => void): SpringHandle {
  const springRef = useRef<Spring | null>(null)
  if (!springRef.current) springRef.current = new Spring(initial, spec)
  const defaults = useLatest(spec)
  const change = useLatest(onChange)
  const stopRef = useRef<null | (() => void)>(null)

  const handle = useMemo<SpringHandle>(() => {
    const spring = springRef.current!
    const ensureRunning = () => {
      pump.wake()
      if (stopRef.current) return
      let last = performance.now()
      let remove = () => {}
      remove = pump.add({
        tick(now) {
          // cap the step at 3 frames so a stalled tab doesn't teleport the value
          const dt = Math.min((now - last) / 1000, 3 / 120)
          last = now
          const moving = spring.step(dt)
          change.current(spring.value)
          if (!moving) {
            remove()
            stopRef.current = null
          }
          return moving
        },
      })
      stopRef.current = () => {
        remove()
        stopRef.current = null
      }
    }
    return {
      get value() {
        return spring.value
      },
      get velocity() {
        return spring.velocity
      },
      get target() {
        return spring.target
      },
      to(target, nextSpec, clamp) {
        spring.to(target, nextSpec ?? defaults.current, clamp)
        ensureRunning()
      },
      jump(value) {
        spring.jump(value)
        change.current(value)
      },
      kick(velocity) {
        spring.velocity += velocity
        ensureRunning()
      },
    }
  }, [change, defaults])

  useEffect(() => () => stopRef.current?.(), [])

  return handle
}
