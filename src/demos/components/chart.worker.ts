// Draws the demo price chart in a worker (OffscreenCanvas 2D). The main thread
// only posts { points, index }; the crosshair and its label are drawn here, so
// scrubbing stays smooth even while React is busy.

import { defineCanvasWorker } from '../../react/canvasWorker'

export interface ChartFrame {
  points: number[]
  /** Fractional index of the crosshair (null = no crosshair). */
  index: number | null
  dark: boolean
}

let ctx: OffscreenCanvasRenderingContext2D | null = null

defineCanvasWorker<ChartFrame>({
  init: ({ canvas }) => {
    ctx = canvas.getContext('2d')
  },
  draw: ({ width: w, height: h, dpr }, f) => {
    if (!ctx) return
    const c = ctx
    const ink = f.dark ? '#f2f2f2' : '#111'
    const muted = f.dark ? 'rgba(242,242,242,0.45)' : 'rgba(17,17,17,0.45)'
    const accent = '#3b82f6'
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.clearRect(0, 0, w, h)
    const pad = { l: 12, r: 12, t: 34, b: 18 }
    const n = f.points.length
    const xOf = (i: number) => pad.l + (i / (n - 1)) * (w - pad.l - pad.r)
    const yOf = (v: number) => pad.t + (1 - v / 100) * (h - pad.t - pad.b)

    // guides at 25 / 50 / 75 %
    c.strokeStyle = f.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'
    c.lineWidth = 1
    for (const g of [25, 50, 75]) {
      const y = Math.round(yOf(g)) + 0.5
      c.beginPath()
      c.moveTo(pad.l, y)
      c.lineTo(w - pad.r, y)
      c.stroke()
    }

    // area + line
    const grad = c.createLinearGradient(0, pad.t, 0, h - pad.b)
    grad.addColorStop(0, 'rgba(59,130,246,0.28)')
    grad.addColorStop(1, 'rgba(59,130,246,0)')
    c.beginPath()
    f.points.forEach((v, i) => (i ? c.lineTo(xOf(i), yOf(v)) : c.moveTo(xOf(i), yOf(v))))
    c.lineTo(xOf(n - 1), h - pad.b)
    c.lineTo(xOf(0), h - pad.b)
    c.closePath()
    c.fillStyle = grad
    c.fill()
    c.beginPath()
    f.points.forEach((v, i) => (i ? c.lineTo(xOf(i), yOf(v)) : c.moveTo(xOf(i), yOf(v))))
    c.strokeStyle = accent
    c.lineWidth = 2
    c.lineJoin = 'round'
    c.stroke()

    if (f.index === null) return
    // crosshair at a fractional index, value interpolated between points
    const i = Math.max(0, Math.min(n - 1, f.index))
    const i0 = Math.floor(i)
    const i1 = Math.min(n - 1, i0 + 1)
    const v = f.points[i0] + (f.points[i1] - f.points[i0]) * (i - i0)
    const x = xOf(i)
    const y = yOf(v)
    c.strokeStyle = muted
    c.setLineDash([3, 3])
    c.beginPath()
    c.moveTo(Math.round(x) + 0.5, pad.t - 6)
    c.lineTo(Math.round(x) + 0.5, h - pad.b)
    c.stroke()
    c.setLineDash([])
    c.fillStyle = accent
    c.beginPath()
    c.arc(x, y, 4.5, 0, Math.PI * 2)
    c.fill()
    c.strokeStyle = f.dark ? '#000' : '#fff'
    c.lineWidth = 2
    c.stroke()

    const label = `${v.toFixed(1)}%`
    const sub = `t−${n - 1 - Math.round(i)}`
    c.font = '600 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'
    const tw = c.measureText(label).width
    c.font = '11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'
    const sw = c.measureText(sub).width
    const bw = tw + sw + 22
    const bx = Math.max(pad.l, Math.min(w - pad.r - bw, x - bw / 2))
    c.fillStyle = f.dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)'
    c.beginPath()
    c.roundRect(bx, 6, bw, 22, 11)
    c.fill()
    c.fillStyle = ink
    c.font = '600 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'
    c.fillText(label, bx + 9, 21.5)
    c.fillStyle = muted
    c.font = '11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'
    c.fillText(sub, bx + 13 + tw, 21)
  },
})
