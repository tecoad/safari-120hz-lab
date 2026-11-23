'use client'
// <ScrollPad>: native scrolling as an input sensor.
//
// An invisible scroll container sits on top of your visual. The OS drags it
// (on iOS in the compositor, at the display's refresh rate) and gives you
// momentum, rubber banding and scroll snapping for free; this component only
// reads scrollLeft/scrollTop on the high-frequency pump and reports the
// finger's offset since the press. You draw whatever the offset means: a chart
// crosshair, a slider thumb, a lens, a rotation.
//
// - `precise`: the scroller is DPR× larger and scaled down with a transform, so
//   one scroll unit is one physical pixel (scrollLeft is rounded to integers).
// - `snap`: snap points every `snap` CSS px along the axis (scroll-snap).
// - `momentum`: keep reporting after the finger lifts (native fling + snap),
//   then `onSettle`. Without it, momentum is cut at release (overflow: hidden
//   for one frame), like the glass tab bar on `/`.
// - Mouse: a mouse can't drag a scroller, so pointer events stand in for it.
// - Trackpad / wheel scrolling over the pad is reported as a "momentum" move.
//
// Accessibility: this is a pointer surface. Give the container a role and
// keyboard handling (e.g. role="slider" + arrow keys) through the usual props.

import { useMemo, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { devicePixelRatioCapped, injectStyle, useIsoLayoutEffect, useLatest } from './internal'
import { useScrollSampler } from './useScrollSampler'

export type ScrollPadAxis = 'x' | 'y' | 'both'

export interface ScrollPadMove {
  /** Finger offset since the press, in CSS px (positive = right / down). */
  dx: number
  dy: number
  at: number
  phase: 'drag' | 'momentum'
}

export interface ScrollPadRelease {
  dx: number
  dy: number
  /** Velocity over the last 80 ms, CSS px per second. */
  vx: number
  vy: number
  cancelled: boolean
}

export interface ScrollPadProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  axis?: ScrollPadAxis
  precise?: boolean
  snap?: number
  /** 'normal' lets a fling skip snap points; 'always' stops at the next one. */
  snapStop?: 'normal' | 'always'
  /** How many snap cells of travel one gesture gets in each direction. */
  cellsEachWay?: number
  momentum?: boolean
  onPressStart?: (point: { x: number; y: number }) => void
  onMove?: (move: ScrollPadMove) => void
  onRelease?: (release: ScrollPadRelease) => void
  onSettle?: (offset: { dx: number; dy: number }) => void
  /** Receives the inner scroller (e.g. to attach an <InputMeter />). */
  scrollerRef?: RefObject<HTMLDivElement | null>
  children?: ReactNode
}

const SLACK = 200
const EXTENT = 8000
const VELOCITY_WINDOW_MS = 80
const SETTLE_IDLE_MS = 140

const CSS = `
.scrollpad{position:relative;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.scrollpad-scroller{position:absolute;top:0;left:0;overscroll-behavior:contain;scrollbar-width:none;transform-origin:0 0;-webkit-tap-highlight-color:transparent}
.scrollpad-scroller::-webkit-scrollbar{display:none}
`

type Phase = 'idle' | 'drag' | 'momentum'

export function ScrollPad(props: ScrollPadProps) {
  const {
    axis = 'x',
    precise = false,
    snap,
    snapStop = 'normal',
    cellsEachWay = 48,
    momentum = false,
    onPressStart,
    onMove,
    onRelease,
    onSettle,
    scrollerRef,
    children,
    className,
    ...rest
  } = props
  injectStyle('scrollpad-style', CSS)

  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [unit, setUnit] = useState(1)
  const handlers = useLatest({ onPressStart, onMove, onRelease, onSettle })
  const st = useRef({
    phase: 'idle' as Phase,
    base: { left: 0, top: 0 },
    home: { left: 0, top: 0 },
    last: { dx: 0, dy: 0 },
    history: [] as { dx: number; dy: number; at: number }[],
    mouse: null as null | { id: number; x0: number; y0: number },
    settleTimer: 0,
  })

  const scrollX = axis !== 'y'
  const scrollY = axis !== 'x'
  const cell = snap && axis !== 'both' ? Math.max(1, Math.round(snap * unit)) : 0

  useIsoLayoutEffect(() => {
    setUnit(precise ? Math.max(1, Math.round(devicePixelRatioCapped())) : 1)
  }, [precise])

  const recenter = () => {
    const el = innerRef.current
    if (!el) return
    el.scrollLeft = st.current.home.left
    el.scrollTop = st.current.home.top
    st.current.base = { left: el.scrollLeft, top: el.scrollTop }
  }

  // home = the middle of the travel, aligned to a snap point when snapping
  useIsoLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    if (scrollerRef) scrollerRef.current = el
    const slack = SLACK * unit
    const snapped = slack + cellsEachWay * cell
    st.current.home = {
      left: scrollX ? (cell && axis === 'x' ? snapped : Math.round((el.scrollWidth - el.clientWidth) / 2)) : 0,
      top: scrollY ? (cell && axis === 'y' ? snapped : Math.round((el.scrollHeight - el.clientHeight) / 2)) : 0,
    }
    recenter()
  }, [unit, cell, axis, cellsEachWay])

  const report = (dx: number, dy: number, at: number, phase: 'drag' | 'momentum') => {
    const p = st.current
    p.last = { dx, dy }
    if (phase === 'drag') {
      p.history.push({ dx, dy, at })
      while (p.history.length > 2 && at - p.history[0].at > VELOCITY_WINDOW_MS) p.history.shift()
    }
    handlers.current.onMove?.({ dx, dy, at, phase })
  }

  const settle = () => {
    const p = st.current
    if (p.phase !== 'momentum') return
    p.phase = 'idle'
    handlers.current.onSettle?.(p.last)
    recenter()
  }

  const scheduleSettle = () => {
    const p = st.current
    clearTimeout(p.settleTimer)
    p.settleTimer = window.setTimeout(settle, SETTLE_IDLE_MS)
  }

  useScrollSampler(innerRef, (s) => {
    const p = st.current
    if (p.mouse) return
    if (p.phase === 'idle') {
      // a change while idle (trackpad, wheel, keyboard) counts as a momentum move,
      // except our own recentering, which always lands exactly on home
      if (s.left === p.home.left && s.top === p.home.top) return
      p.phase = 'momentum'
      p.base = { ...p.home }
    }
    const dx = scrollX ? (p.base.left - s.left) / unit : 0
    const dy = scrollY ? (p.base.top - s.top) / unit : 0
    report(dx, dy, s.at, p.phase === 'drag' ? 'drag' : 'momentum')
    if (p.phase === 'momentum') scheduleSettle()
  })

  const velocity = () => {
    const h = st.current.history
    if (h.length < 2) return { vx: 0, vy: 0 }
    const a = h[0]
    const b = h[h.length - 1]
    const dt = (b.at - a.at) / 1000
    return dt > 0 ? { vx: (b.dx - a.dx) / dt, vy: (b.dy - a.dy) / dt } : { vx: 0, vy: 0 }
  }

  const press = (clientX: number, clientY: number) => {
    const p = st.current
    const el = innerRef.current
    if (!el) return
    clearTimeout(p.settleTimer)
    p.phase = 'drag'
    p.base = { left: el.scrollLeft, top: el.scrollTop }
    p.last = { dx: 0, dy: 0 }
    p.history = [{ dx: 0, dy: 0, at: performance.now() }]
    const r = containerRef.current!.getBoundingClientRect()
    handlers.current.onPressStart?.({ x: clientX - r.left, y: clientY - r.top })
  }

  const haltThenRecenter = () => {
    const el = innerRef.current
    if (!el) return
    const left = el.scrollLeft
    const top = el.scrollTop
    el.style.overflow = 'hidden'
    el.scrollLeft = left
    el.scrollTop = top
    requestAnimationFrame(() => {
      el.style.overflow = ''
      recenter()
    })
  }

  const release = (cancelled: boolean) => {
    const p = st.current
    if (p.phase !== 'drag') return
    const v = velocity()
    handlers.current.onRelease?.({ ...p.last, vx: v.vx, vy: v.vy, cancelled })
    if (momentum && !cancelled && !p.mouse) {
      p.phase = 'momentum'
      scheduleSettle()
      return
    }
    p.phase = 'idle'
    handlers.current.onSettle?.(p.last)
    if (p.mouse) recenter()
    else haltThenRecenter()
  }

  const content = useMemo(() => {
    if (cell) {
      const slack = SLACK * unit
      const n = cellsEachWay * 2 + 1
      const horizontal = axis === 'x'
      const cellStyle = horizontal ? { width: cell, height: '100%' } : { width: '100%', height: cell }
      const slackStyle = horizontal ? { width: slack, height: '100%' } : { width: '100%', height: slack }
      const total = slack * 2 + n * cell
      return (
        <div style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', ...(horizontal ? { width: total, height: '100%' } : { width: '100%', height: total }) }}>
          <div style={{ flex: 'none', ...slackStyle }} />
          {Array.from({ length: n }, (_, i) => (
            <div key={i} style={{ flex: 'none', ...cellStyle, scrollSnapAlign: 'start', scrollSnapStop: snapStop }} />
          ))}
          <div style={{ flex: 'none', ...slackStyle }} />
        </div>
      )
    }
    const size = EXTENT * unit
    return <div style={{ width: scrollX ? size : '100%', height: scrollY ? size : '100%' }} />
  }, [cell, axis, unit, scrollX, scrollY, cellsEachWay, snapStop])

  return (
    <div ref={containerRef} className={className ? `scrollpad ${className}` : 'scrollpad'} {...rest}>
      {children}
      <div
        ref={innerRef}
        className="scrollpad-scroller"
        style={{
          width: `${100 * unit}%`,
          height: `${100 * unit}%`,
          transform: unit === 1 ? undefined : `scale(${1 / unit})`,
          overflowX: scrollX ? 'scroll' : 'hidden',
          overflowY: scrollY ? 'scroll' : 'hidden',
          touchAction: axis === 'x' ? 'pan-x' : axis === 'y' ? 'pan-y' : 'pan-x pan-y',
          scrollSnapType: cell ? `${axis} mandatory` : undefined,
        }}
        onTouchStart={(e) => {
          if (e.targetTouches.length === 1) press(e.targetTouches[0].clientX, e.targetTouches[0].clientY)
        }}
        onTouchEnd={(e) => {
          if (e.targetTouches.length === 0) release(false)
        }}
        onTouchCancel={(e) => {
          if (e.targetTouches.length === 0) release(true)
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'mouse' || e.button !== 0) return
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* synthetic pointer */
          }
          st.current.mouse = { id: e.pointerId, x0: e.clientX, y0: e.clientY }
          press(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => {
          const m = st.current.mouse
          if (!m || m.id !== e.pointerId) return
          report(scrollX ? e.clientX - m.x0 : 0, scrollY ? e.clientY - m.y0 : 0, performance.now(), 'drag')
        }}
        onPointerUp={(e) => {
          const m = st.current.mouse
          if (!m || m.id !== e.pointerId) return
          release(false)
          st.current.mouse = null
        }}
        onPointerCancel={(e) => {
          const m = st.current.mouse
          if (!m || m.id !== e.pointerId) return
          release(true)
          st.current.mouse = null
        }}
        onScroll={() => {
          if (st.current.phase === 'momentum') scheduleSettle()
        }}
      >
        {content}
      </div>
    </div>
  )
}
