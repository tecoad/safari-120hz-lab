// Controller meter: a native scroller you drag (right column) and a panel
// (left column) with position, updates/s, unique values/s, speed, and a chart
// of the last 4 s.
//
// Readings come from the same high-frequency loop as the rest of the page
// (pump: vsync-aligned MessageChannel + empty rAF). Only readings that changed
// become samples, as in the original. The panel is drawn in a worker.
//
// `precise`: the scroller is created DPR× larger and scaled down with a
// transform, so each scrollLeft/scrollTop unit is one physical pixel.

import { dpr } from '../core/env'
import { pump } from '../core/pump'
import type { SourceRegion } from '../glass/protocol'
import type { ReadoutLayout, ToReadout } from './protocol'

const PLANE_SCALE = 25
const CELL = 16
const SETTLE_MS = 1000
const WAKE_EVENTS = ['pointerdown', 'touchstart', 'wheel', 'scroll'] as const

export interface ReadoutGlass {
  connect(key: string, port: MessagePort, regions: SourceRegion[]): void
  update(key: string, regions: SourceRegion[]): void
}

let counter = 0

export function mountReadout(fig: HTMLElement, opts: { precise: boolean; glass?: ReadoutGlass }) {
  const key = `readout-${++counter}`
  const box = fig.querySelector<HTMLElement>('.readout-box')!
  const scroller = fig.querySelector<HTMLElement>('.readout-scroller')!
  const sheet = fig.querySelector<HTMLElement>('.readout-sheet')!
  const plane = fig.querySelector<HTMLElement>('.readout-plane')!
  const legend = fig.querySelector<HTMLElement>('.readout-legend')!
  const plot = fig.querySelector<HTMLElement>('.readout-plot')!
  const dds = [...legend.querySelectorAll<HTMLElement>('dd')]

  const canvases = {
    plane: document.createElement('canvas'),
    values: document.createElement('canvas'),
    plot: document.createElement('canvas'),
  }
  canvases.values.className = 'readout-values'
  plane.append(canvases.plane)
  legend.append(canvases.values)
  plot.append(canvases.plot)

  const live = 'transferControlToOffscreen' in canvases.plane
  const worker = live ? new Worker(new URL('./readout.worker.ts', import.meta.url), { type: 'module' }) : null
  const post = (m: ToReadout, transfer: Transferable[] = []) => worker?.postMessage(m, transfer)

  // ------------------------------------------------------------ scroller
  const st = { unit: 1, start: { left: 0, top: 0 }, last: { left: 0, top: 0 }, freshAt: -Infinity, pressed: false, visible: true }

  const setupScroller = () => {
    st.unit = opts.precise ? Math.max(1, Math.round(dpr())) : 1
    const u = st.unit
    scroller.style.width = `${100 * u}%`
    scroller.style.height = `${100 * u}%`
    scroller.style.transform = u === 1 ? '' : `scale(${1 / u})`
    const side = Math.round(Math.max(box.clientWidth, box.clientHeight) * PLANE_SCALE * u)
    sheet.style.width = `${side}px`
    sheet.style.height = `${side}px`
    sheet.style.setProperty('--cell', `${CELL * u}px`)
    sheet.style.setProperty('--lw', `${u}px`)
    // start in the middle of the plane: room to drag in any direction
    scroller.scrollLeft = Math.round((scroller.scrollWidth - scroller.clientWidth) / 2)
    scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2)
    st.start = { left: scroller.scrollLeft, top: scroller.scrollTop }
    st.last = { ...st.start }
  }

  // ------------------------------------------------------------ layout for the worker
  const measure = document.createElement('canvas').getContext('2d')!
  const layout = (): ReadoutLayout => {
    const lr = legend.getBoundingClientRect()
    const cs = getComputedStyle(dds[0])
    const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    measure.font = font
    const m = measure.measureText('Hg')
    const rows = dds.map((dd) => {
      const r = dd.getBoundingClientRect()
      const y = r.top - lr.top + (r.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent
      return { x: r.right - lr.left, y }
    })
    return {
      dpr: Math.min(dpr(), 3),
      plane: { w: plane.clientWidth, h: plane.clientHeight },
      values: { w: lr.width, h: lr.height, rows },
      plot: { w: plot.clientWidth, h: plot.clientHeight },
      font,
    }
  }

  // regions in the document, so the page glass can refract the meter
  const regions = (): SourceRegion[] => {
    const rectOf = (el: HTMLElement): [number, number, number, number] => {
      const r = el.getBoundingClientRect()
      return [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height]
    }
    return [
      { name: 'plane', rect: rectOf(canvases.plane), radius: 0 },
      { name: 'values', rect: rectOf(canvases.values), radius: 0 },
      { name: 'plot', rect: rectOf(canvases.plot), radius: 0 },
    ]
  }

  let started = false
  const start = () => {
    if (!worker || started) return
    started = true
    const p = canvases.plane.transferControlToOffscreen()
    const v = canvases.values.transferControlToOffscreen()
    const g = canvases.plot.transferControlToOffscreen()
    post({ type: 'start', plane: p, values: v, plot: g, layout: layout() }, [p, v, g])
    fig.classList.add('readout-live')
    if (opts.glass) {
      const ch = new MessageChannel()
      post({ type: 'refraction', port: ch.port1 }, [ch.port1])
      opts.glass.connect(key, ch.port2, regions())
    }
  }

  // ------------------------------------------------------------ reading (high frequency)
  const fmt = (n: number) => n.toFixed(2)
  const client = {
    tick(now: number) {
      if (!st.visible) return false
      const left = scroller.scrollLeft
      const top = scroller.scrollTop
      if (left !== st.last.left || top !== st.last.top) {
        st.last = { left, top }
        st.freshAt = now
        const x = (left - st.start.left) / st.unit
        const y = (top - st.start.top) / st.unit
        if (worker) post({ type: 'sample', x, y, at: performance.timeOrigin + now })
        else dds[0].textContent = `${fmt(x)}, ${fmt(y)}`
      }
      return st.pressed || now - st.freshAt < SETTLE_MS
    },
  }

  for (const ev of WAKE_EVENTS) scroller.addEventListener(ev, pump.wake, { passive: true })
  scroller.addEventListener('touchstart', () => (st.pressed = true), { passive: true })
  const release = (e: TouchEvent) => {
    if (e.touches.length === 0) st.pressed = false
  }
  scroller.addEventListener('touchend', release, { passive: true })
  scroller.addEventListener('touchcancel', release, { passive: true })

  new IntersectionObserver(([e]) => {
    st.visible = e.isIntersecting
  }).observe(fig)

  setupScroller()
  start()
  pump.add(client)

  return {
    relayout() {
      setupScroller()
      post({ type: 'layout', layout: layout() })
      opts.glass?.update(key, regions())
    },
  }
}
