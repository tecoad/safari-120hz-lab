'use client'
// <InputMeter>: proves, on the device, how many scroll readings per second you
// actually get. React version of the controller meter from the original post.
//
//  - Updates: fresh readings per second (500 ms window).
//  - Unique values: distinct positions per second (reading faster than the
//    source changes only produces repeats; this is the honest number).
//  - Speed: from the samples of the last 80 ms.
//  - A plane with the position and a trail, and a 4 s chart with a 120/s guide.
//
// The panel is drawn in a worker with OffscreenCanvas; a DOM panel would update
// at 60 Hz and couldn't show 120 changes per second.
//
// Without `source`, it renders its own draggable grid (a native scroller) next
// to the panel, like the original demo. With `source`, it measures any scroller
// you pass (or 'window' for the page scroll).

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { ReadoutLayout, ToReadout } from '../readout/protocol'
import { devicePixelRatioCapped, injectStyle } from './internal'
import { useScrollSampler } from './useScrollSampler'

export interface InputMeterProps {
  source?: RefObject<HTMLElement | null> | 'window'
  /** Scroll units per CSS px of `source` (2 or 3 if it is DPR-scaled). */
  unit?: number
  /** Built-in grid only: DPR-scaled scroller, so positions show fractions of a point. */
  precise?: boolean
  className?: string
}

const CSS = `
.im{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));overflow:hidden;border-radius:16px;border:1px solid rgb(127 127 127/.25)}
.im[data-solo]{grid-template-columns:minmax(0,1fr)}
.im-panel{display:grid;align-content:start;min-width:0;background:#0b0b0b;color:#f5f5f3}
.im-plane{position:relative;height:132px;overflow:hidden;border-bottom:1px solid rgb(245 245 243/.2)}
.im-canvas{position:absolute;inset:0;display:block;width:100%;height:100%;pointer-events:none}
.im-legend{position:relative;display:grid;margin:0;padding:6px 8px;border-bottom:1px solid rgb(245 245 243/.2);font:11px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.im-legend>div{display:flex;justify-content:space-between;gap:6px;white-space:nowrap}
.im-legend dt{display:flex;align-items:center;gap:.4em}
.im-legend dd{margin:0}
.im-legend[data-live] dd{color:transparent}
.im-key{display:inline-flex;justify-content:center;width:12px}
.im-dot{width:7px;height:7px;border-radius:50%;background:#409cff}
.im-swatch{width:12px;height:2px}
.im-plot{position:relative;height:72px;margin:4px 0;overflow:hidden}
.im-box{position:relative;overflow:hidden;background:Canvas}
.im-scroller{position:absolute;top:0;left:0;overflow:scroll;overscroll-behavior:contain;touch-action:pan-x pan-y;scrollbar-width:none;transform-origin:0 0}
.im-scroller::-webkit-scrollbar{display:none}
.im-sheet{background-image:linear-gradient(to right,rgb(127 127 127/.3) var(--lw,1px),transparent var(--lw,1px)),linear-gradient(to bottom,rgb(127 127 127/.3) var(--lw,1px),transparent var(--lw,1px));background-size:var(--cell,16px) var(--cell,16px)}
.im-tag{position:absolute;top:6px;right:6px;padding:2px 6px;border-radius:6px;background:#e5352b;color:#fff;font:11px -apple-system,system-ui,sans-serif;pointer-events:none}
`

const PLANE_SCALE = 25

export function InputMeter({ source, unit = 1, precise = false, className }: InputMeterProps) {
  injectStyle('input-meter-style', CSS)
  const planeRef = useRef<HTMLDivElement>(null)
  const legendRef = useRef<HTMLDListElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const ctl = useRef({ worker: null as Worker | null, start: { left: 0, top: 0 }, unit })

  const builtIn = !source
  const target = source ?? scrollerRef

  // built-in controller: a big grid, DPR-scaled when precise, starting in the middle
  useEffect(() => {
    if (!builtIn) return
    const box = boxRef.current!
    const scroller = scrollerRef.current!
    const sheet = sheetRef.current!
    const u = precise ? Math.max(1, Math.round(devicePixelRatioCapped())) : 1
    scroller.style.width = `${100 * u}%`
    scroller.style.height = `${100 * u}%`
    scroller.style.transform = u === 1 ? '' : `scale(${1 / u})`
    const side = Math.round(Math.max(box.clientWidth, box.clientHeight) * PLANE_SCALE * u)
    sheet.style.width = `${side}px`
    sheet.style.height = `${side}px`
    sheet.style.setProperty('--cell', `${16 * u}px`)
    sheet.style.setProperty('--lw', `${u}px`)
    scroller.scrollLeft = Math.round((scroller.scrollWidth - scroller.clientWidth) / 2)
    scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2)
    ctl.current.unit = u
    ctl.current.start = { left: scroller.scrollLeft, top: scroller.scrollTop }
  }, [builtIn, precise])

  useEffect(() => {
    if (!builtIn) {
      ctl.current.unit = unit
      const el = source === 'window' ? null : source?.current
      ctl.current.start = el ? { left: el.scrollLeft, top: el.scrollTop } : { left: window.scrollX, top: window.scrollY }
    }
  }, [builtIn, source, unit])

  // worker + three canvases (created here, so StrictMode's double mount is safe)
  useEffect(() => {
    const plane = planeRef.current!
    const legend = legendRef.current!
    const plot = plotRef.current!
    const hosts = [plane, legend, plot]
    const canvases = hosts.map((host) => {
      const c = document.createElement('canvas')
      c.className = 'im-canvas'
      host.append(c)
      return c
    })
    if (typeof (canvases[0] as Partial<HTMLCanvasElement>).transferControlToOffscreen !== 'function') {
      canvases.forEach((c) => c.remove())
      return
    }
    const worker = new Worker(new URL('../readout/readout.worker.ts', import.meta.url), { type: 'module' })
    const measure = document.createElement('canvas').getContext('2d')!
    const layout = (): ReadoutLayout => {
      const dds = [...legend.querySelectorAll('dd')]
      const lr = legend.getBoundingClientRect()
      const cs = getComputedStyle(dds[0])
      const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      measure.font = font
      const m = measure.measureText('Hg')
      return {
        dpr: devicePixelRatioCapped(),
        plane: { w: plane.clientWidth, h: plane.clientHeight },
        values: {
          w: lr.width,
          h: lr.height,
          rows: dds.map((dd) => {
            const r = dd.getBoundingClientRect()
            return { x: r.right - lr.left, y: r.top - lr.top + (r.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent }
          }),
        },
        plot: { w: plot.clientWidth, h: plot.clientHeight },
        font,
      }
    }
    const [p, v, g] = canvases.map((c) => c.transferControlToOffscreen())
    const start: ToReadout = { type: 'start', plane: p, values: v, plot: g, layout: layout() }
    worker.postMessage(start, [p, v, g])
    legend.dataset.live = ''
    const ro = new ResizeObserver(() => worker.postMessage({ type: 'layout', layout: layout() } satisfies ToReadout))
    ro.observe(plane)
    ro.observe(legend)
    ctl.current.worker = worker
    return () => {
      ro.disconnect()
      worker.terminate()
      canvases.forEach((c) => c.remove())
      delete legend.dataset.live
      ctl.current.worker = null
    }
  }, [])

  useScrollSampler(target, (s) => {
    const c = ctl.current
    if (!c.worker) return
    const msg: ToReadout = {
      type: 'sample',
      x: (s.left - c.start.left) / c.unit,
      y: (s.top - c.start.top) / c.unit,
      at: performance.timeOrigin + s.at,
    }
    c.worker.postMessage(msg)
  })

  const row = (label: string, value: string, key: ReactNode) => (
    <div>
      <dt>
        <span className="im-key">{key}</span>
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  )

  return (
    <div className={className ? `im ${className}` : 'im'} data-solo={builtIn ? undefined : ''}>
      <div className="im-panel">
        <div className="im-plane" ref={planeRef} />
        <dl className="im-legend" ref={legendRef}>
          {row('Position', '0.00, 0.00', <span className="im-dot" />)}
          {row('Updates', '0/s', <span className="im-swatch" style={{ background: '#f5f5f3' }} />)}
          {row('Unique values', '0/s', <span className="im-swatch" style={{ background: '#34c759' }} />)}
          {row('Speed', '0 pt/s', <span className="im-swatch" style={{ background: '#ff9500' }} />)}
        </dl>
        <div className="im-plot" ref={plotRef} />
      </div>
      {builtIn && (
        <div className="im-box" ref={boxRef}>
          <div className="im-scroller" ref={scrollerRef} aria-label="Controller: drag the grid">
            <div className="im-sheet" ref={sheetRef} />
          </div>
          <span className="im-tag">✥ Drag</span>
        </div>
      )}
    </div>
  )
}
