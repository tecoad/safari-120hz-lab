'use client'
// useWorkerCanvas: render a canvas from a Web Worker through OffscreenCanvas.
//
// Why: the drawing leaves the main thread (React renders, network parsing and
// layout can't stall it), and on iOS Safari the frames an OffscreenCanvas pushes
// are presented without waiting for the page's 60 Hz rendering update, so a
// worker can draw at 120 Hz (undocumented WebKit behavior, see docs/FINDINGS.md).
//
// Flow control, as in the original: at most `maxInFlight` frames waiting for the
// worker's "presented" ack, and at least `minIntervalMs` between sends. Frames
// that arrive while the pipe is full are coalesced: only the latest one is kept
// and sent as soon as there is room ("latest state wins", nothing piles up).
//
// The canvas element is created inside the effect, so React StrictMode's
// mount → unmount → mount never tries to transfer the same canvas twice.
//
//   const chart = useWorkerCanvas(() => new Worker(new URL('./chart.worker.ts', import.meta.url), { type: 'module' }))
//   <div ref={chart.ref} style={{ position: 'relative', height: 240 }} />
//   chart.post({ index, points })   // any structured-cloneable frame
//
// Pair it with defineCanvasWorker() (./canvasWorker.ts) on the worker side.

import { useCallback, useEffect, useRef, useState } from 'react'
import { devicePixelRatioCapped, useLatest } from './internal'

export interface WorkerCanvasOptions {
  maxInFlight?: number
  minIntervalMs?: number
}

export interface WorkerCanvasStats {
  /** Frames presented during the last second. */
  fps: number
  presented: number
}

export interface WorkerCanvas<F> {
  /** Attach to the element that should hold the canvas (it fills it). */
  ref: (el: HTMLDivElement | null) => void
  /** Send a frame. Returns false when it was coalesced instead of sent right away. */
  post: (frame: F, transfer?: Transferable[]) => boolean
  ready: boolean
  supported: boolean
  stats: WorkerCanvasStats
}

export function useWorkerCanvas<F>(createWorker: () => Worker, { maxInFlight = 2, minIntervalMs = 6.25 }: WorkerCanvasOptions = {}): WorkerCanvas<F> {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)
  const [supported, setSupported] = useState(true)
  const factory = useLatest(createWorker)
  const s = useRef({
    worker: null as Worker | null,
    ready: false,
    inFlight: 0,
    lastSent: 0,
    pending: null as null | { frame: F; transfer: Transferable[] },
    timer: 0,
    times: [] as number[],
    stats: { fps: 0, presented: 0 } as WorkerCanvasStats,
  })

  const flush = useCallback(() => {
    const st = s.current
    if (!st.worker || !st.ready || !st.pending) return
    const now = performance.now()
    const wait = minIntervalMs - (now - st.lastSent)
    if (st.inFlight >= maxInFlight) return // the next "presented" ack flushes
    if (wait > 0) {
      clearTimeout(st.timer)
      st.timer = window.setTimeout(flush, wait)
      return
    }
    const { frame, transfer } = st.pending
    st.pending = null
    st.inFlight++
    st.lastSent = now
    st.worker.postMessage({ type: 'frame', frame }, transfer)
  }, [maxInFlight, minIntervalMs])

  useEffect(() => {
    if (!container) return
    const st = s.current
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
    canvas.setAttribute('aria-hidden', 'true')
    container.append(canvas)
    if (typeof (canvas as Partial<HTMLCanvasElement>).transferControlToOffscreen !== 'function') {
      setSupported(false)
      return () => canvas.remove()
    }
    const worker = factory.current()
    const offscreen = canvas.transferControlToOffscreen()
    const size = () => {
      const r = container.getBoundingClientRect()
      return { width: r.width, height: r.height, dpr: devicePixelRatioCapped() }
    }
    worker.onmessage = (e: MessageEvent<{ type: string }>) => {
      if (e.data?.type === 'ready') {
        st.ready = true
        setReady(true)
        flush()
      } else if (e.data?.type === 'presented') {
        st.inFlight = Math.max(0, st.inFlight - 1)
        const now = performance.now()
        st.times.push(now)
        while (st.times.length && now - st.times[0] > 1000) st.times.shift()
        st.stats.fps = st.times.length
        st.stats.presented++
        flush()
      }
    }
    worker.postMessage({ type: 'init', canvas: offscreen, ...size() }, [offscreen])
    const ro = new ResizeObserver(() => worker.postMessage({ type: 'resize', ...size() }))
    ro.observe(container)
    st.worker = worker
    return () => {
      ro.disconnect()
      clearTimeout(st.timer)
      worker.terminate()
      canvas.remove()
      st.worker = null
      st.ready = false
      st.inFlight = 0
      setReady(false)
    }
  }, [container, factory, flush])

  const post = useCallback(
    (frame: F, transfer: Transferable[] = []) => {
      const st = s.current
      st.pending = { frame, transfer }
      const before = st.inFlight
      flush()
      return st.pending === null && st.inFlight > before
    },
    [flush],
  )

  return { ref: setContainer, post, ready, supported, stats: s.current.stats }
}
