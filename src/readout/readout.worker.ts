// Meter worker: computes the metrics and draws the three canvases (plane,
// values, chart). It lives in a worker with OffscreenCanvas for the same reason
// as the glass: a DOM panel only updates at 60 Hz and could not honestly show
// 120 changes per second.
//
// Metrics as in the original (controller-readout):
//  - Updates: fresh readings per second (500 ms window);
//  - Unique values: distinct positions per second in the same window;
//  - Speed: velocity from the samples of the last 80 ms.

import type { SinkToSource, SourceToSink } from '../glass/protocol'
import type { ReadoutLayout, ToReadout } from './protocol'

const RATE_WINDOW = 500
const VELOCITY_WINDOW = 80
const SETTLE = 100
const TAPE = 4000
const TRAIL = 48
const FRAME_MS = 1000 / 120
const SCALE_RESPONSE = 240

const C = {
  bg: '#0b0b0b',
  ink: '#f5f5f3',
  muted: 'rgba(245,245,243,0.5)',
  grid: [245, 245, 243] as const,
  dot: '#409cff',
  reads: '#f5f5f3',
  unique: '#34c759',
  speed: '#ff9500',
}

interface Sample {
  x: number
  y: number
  at: number
}

interface Tick {
  t: number
  reads: number
  unique: number
  speed: number
}

const now = () => performance.timeOrigin + performance.now()

let layout: ReadoutLayout | null = null
let planeCtx: OffscreenCanvasRenderingContext2D | null = null
let valuesCtx: OffscreenCanvasRenderingContext2D | null = null
let plotCtx: OffscreenCanvasRenderingContext2D | null = null

const windowed: Sample[] = []
const uniques = new Map<string, number>()
const trail: Sample[] = []
const tape: Tick[] = []
let activeSince = 0
let lastSampleAt = -Infinity
let last: Sample = { x: 0, y: 0, at: 0 }
let running = false
let lastFrame = 0
const smooth = { reach: 52, rate: 120, speed: 2000 }

const key = (s: Sample) => `${s.x},${s.y}`

function trim(t: number) {
  while (windowed.length && t - windowed[0].at >= RATE_WINDOW) {
    const k = key(windowed.shift()!)
    const n = (uniques.get(k) ?? 1) - 1
    if (n > 0) uniques.set(k, n)
    else uniques.delete(k)
  }
}

function record(s: Sample) {
  trim(s.at)
  if (windowed.length === 0) activeSince = s.at
  windowed.push(s)
  uniques.set(key(s), (uniques.get(key(s)) ?? 0) + 1)
  trail.push(s)
  if (trail.length > TRAIL) trail.shift()
  last = s
  lastSampleAt = s.at
}

function metrics(t: number) {
  trim(t)
  const since = t - activeSince
  const span = Math.min(RATE_WINDOW, Math.max(SETTLE, since))
  // fencepost fix: while the window is still filling, n samples = n−1 intervals
  const fence = since < RATE_WINDOW ? 1 : 0
  const rate = (n: number) => (windowed.length ? (Math.max(0, n - fence) * 1000) / span : 0)
  const recent = trail.filter((s) => t - s.at <= VELOCITY_WINDOW)
  let speed = 0
  if (recent.length > 1) {
    const a = recent[0]
    const b = recent[recent.length - 1]
    if (b.at > a.at) speed = (Math.hypot(b.x - a.x, b.y - a.y) * 1000) / (b.at - a.at)
  }
  return { reads: rate(windowed.length), unique: rate(uniques.size), speed }
}

function sizeCanvas(ctx: OffscreenCanvasRenderingContext2D | null, w: number, h: number, dpr: number) {
  if (!ctx) return
  const c = ctx.canvas
  const pw = Math.max(1, Math.round(w * dpr))
  const ph = Math.max(1, Math.round(h * dpr))
  if (c.width !== pw) c.width = pw
  if (c.height !== ph) c.height = ph
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function applyLayout(l: ReadoutLayout) {
  layout = l
  sizeCanvas(planeCtx, l.plane.w, l.plane.h, l.dpr)
  sizeCanvas(valuesCtx, l.values.w, l.values.h, l.dpr)
  sizeCanvas(plotCtx, l.plot.w, l.plot.h, l.dpr)
  draw(now(), 0)
}

const approach = (from: number, to: number, dt: number) => from + (to - from) * (1 - Math.exp(-dt / (SCALE_RESPONSE / 4)))

// ---------------------------------------------------------------- plane
function drawPlane(dt: number) {
  const ctx = planeCtx
  if (!ctx || !layout) return
  const { w, h } = layout.plane
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, w, h)
  const cx = w / 2
  const cy = h / 2
  // zoom: show the origin and the whole trail (52 pt minimum reach, 1.2× headroom)
  let far = 0
  for (const s of trail) far = Math.max(far, Math.abs(s.x), Math.abs(s.y))
  smooth.reach = approach(smooth.reach, Math.max(52, far * 1.2), dt)
  const k = Math.min(w, h) / 2 / smooth.reach
  // grid whose step grows as the zoom widens
  let step = 8
  while (step * k < 2.5) step *= 4
  const major = step * 4
  ctx.lineWidth = 0.5
  const drawLines = (horizontal: boolean) => {
    const span = horizontal ? cy : cx
    const first = Math.ceil(-span / k / step) * step
    for (let g = first; g * k <= span; g += step) {
      const isMajor = Math.abs(g % major) < 1e-6
      ctx.strokeStyle = `rgba(${C.grid.join(',')},${isMajor ? 0.6 : 0.25})`
      ctx.beginPath()
      if (horizontal) {
        const y = Math.round(cy + g * k) + 0.25
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
      } else {
        const x = Math.round(cx + g * k) + 0.25
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
      }
      ctx.stroke()
    }
  }
  drawLines(false)
  drawLines(true)
  // axes
  ctx.strokeStyle = C.ink
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(Math.round(cx) + 0.5, 0)
  ctx.lineTo(Math.round(cx) + 0.5, h)
  ctx.moveTo(0, Math.round(cy) + 0.5)
  ctx.lineTo(w, Math.round(cy) + 0.5)
  ctx.stroke()
  // trail of the last 48 readings
  const zoomShare = Math.min(1, k / (Math.min(w, h) / 2 / 52))
  const n = trail.length
  for (let i = 1; i < n; i++) {
    const a = trail[i - 1]
    const b = trail[i]
    const alpha = 0.2 + 0.8 * (i / (n - 1))
    ctx.strokeStyle = C.dot
    ctx.globalAlpha = alpha
    ctx.lineWidth = 0.75 + 0.75 * zoomShare
    ctx.beginPath()
    ctx.moveTo(cx + a.x * k, cy + a.y * k)
    ctx.lineTo(cx + b.x * k, cy + b.y * k)
    ctx.stroke()
    ctx.fillStyle = C.dot
    ctx.beginPath()
    ctx.arc(cx + b.x * k, cy + b.y * k, 1.25 + 0.75 * zoomShare, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = C.dot
  ctx.beginPath()
  ctx.arc(cx + last.x * k, cy + last.y * k, 2 + 1.5 * zoomShare, 0, Math.PI * 2)
  ctx.fill()
}

// ---------------------------------------------------------------- values
function drawValues(m: { reads: number; unique: number; speed: number }) {
  const ctx = valuesCtx
  if (!ctx || !layout) return
  const { w, h, rows } = layout.values
  ctx.clearRect(0, 0, w, h)
  ctx.font = layout.font
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = C.ink
  const texts = [
    `${last.x.toFixed(2)}, ${last.y.toFixed(2)}`,
    `${Math.round(m.reads)}/s`,
    `${Math.round(m.unique)}/s`,
    `${Math.round(m.speed)} pt/s`,
  ]
  texts.forEach((t, i) => {
    const r = rows[i]
    if (r) ctx.fillText(t, r.x, r.y)
  })
}

// ---------------------------------------------------------------- chart
function dashedLine(ctx: OffscreenCanvasRenderingContext2D, y: number, x0: number, x1: number) {
  ctx.save()
  ctx.setLineDash([1, 2])
  ctx.lineWidth = 1
  ctx.strokeStyle = C.muted
  ctx.beginPath()
  ctx.moveTo(x0, Math.round(y) + 0.5)
  ctx.lineTo(x1, Math.round(y) + 0.5)
  ctx.stroke()
  ctx.restore()
}

function drawPlot(t: number, dt: number) {
  const ctx = plotCtx
  if (!ctx || !layout) return
  const { w, h } = layout.plot
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, w, h)
  const gutter = 64
  const pad = 4
  const pw = Math.max(1, w - gutter - 4)
  let peakRate = 0
  let peakSpeed = 0
  for (const s of tape) {
    peakRate = Math.max(peakRate, s.reads, s.unique)
    peakSpeed = Math.max(peakSpeed, s.speed)
  }
  smooth.rate = approach(smooth.rate, Math.max(120, peakRate * 1.15), dt)
  smooth.speed = approach(smooth.speed, Math.max(2000, peakSpeed * 1.15), dt)
  const yOf = (v: number, max: number) => h - pad - (v / max) * (h - pad * 2)
  const xOf = (time: number) => ((time - (t - TAPE)) / TAPE) * pw
  ctx.font = layout.font
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  // guides: 120/s and the peak speed
  const y120 = yOf(120, smooth.rate)
  dashedLine(ctx, y120, 0, pw)
  ctx.fillStyle = C.muted
  ctx.fillText('120/s', pw + 6, y120)
  if (peakSpeed > 1) {
    const yPeak = yOf(peakSpeed, smooth.speed)
    dashedLine(ctx, yPeak, 0, pw)
    ctx.fillText(`${Math.round(peakSpeed)} pt/s`, pw + 6, Math.max(yPeak, y120 + 12))
  }
  // series
  const series: [keyof Omit<Tick, 't'>, string, number][] = [
    ['speed', C.speed, smooth.speed],
    ['reads', C.reads, smooth.rate],
    ['unique', C.unique, smooth.rate],
  ]
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  for (const [k, color, max] of series) {
    ctx.strokeStyle = color
    ctx.beginPath()
    let started = false
    for (const s of tape) {
      const x = xOf(s.t)
      if (x < -2) continue
      const y = yOf(s[k], max)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  // current values stacked in the corner
  const cur = tape[tape.length - 1] ?? { reads: 0, unique: 0, speed: 0 }
  const lines: [string, string][] = [
    [`${Math.round(cur.reads)}/s`, C.reads],
    [`${Math.round(cur.unique)}/s`, C.unique],
    [`${Math.round(cur.speed)} pt/s`, C.speed],
  ]
  lines.forEach(([text, color], i) => {
    ctx.fillStyle = color
    ctx.fillText(text, pw + 6, h - pad - 6 - (lines.length - 1 - i) * 13)
  })
}

function draw(t: number, dt: number) {
  const m = metrics(t)
  tape.push({ t, ...m })
  while (tape.length && tape[0].t < t - TAPE - 200) tape.shift()
  drawPlane(dt)
  drawValues(m)
  drawPlot(t, dt)
  capture()
}

// ---------------------------------------------------------------- refraction source
// When the page glass passes over the meter, it asks ("want") for the canvases
// underneath; after each draw we send a copy (ImageBitmap) straight to the
// glass worker, without going through the main thread.
let port: MessagePort | null = null
const wanted = new Set<string>()
let capturing = false
let captureDirty = false

function capture() {
  if (!port || wanted.size === 0) return
  if (capturing) {
    captureDirty = true
    return
  }
  const canvases: Record<string, OffscreenCanvas | undefined> = {
    plane: planeCtx?.canvas,
    values: valuesCtx?.canvas,
    plot: plotCtx?.canvas,
  }
  const names = [...wanted].filter((n) => canvases[n])
  if (!names.length) return
  capturing = true
  Promise.all(names.map((n) => createImageBitmap(canvases[n]!)))
    .then((bitmaps) => {
      capturing = false
      const msg: SourceToSink = { kind: 'frame', frames: names.map((name, i) => ({ name, bitmap: bitmaps[i] })) }
      port?.postMessage(msg, bitmaps)
      if (captureDirty) {
        captureDirty = false
        capture()
      }
    })
    .catch(() => {
      capturing = false
    })
}

function loop() {
  const t = now()
  const dt = lastFrame ? Math.min(100, t - lastFrame) : FRAME_MS
  lastFrame = t
  draw(t, dt)
  if (t - lastSampleAt < TAPE + 400) setTimeout(loop, FRAME_MS)
  else {
    running = false
    lastFrame = 0
  }
}

function wake() {
  if (running) return
  running = true
  lastFrame = 0
  loop()
}

addEventListener('message', (e: MessageEvent<ToReadout>) => {
  const msg = e.data
  if (msg.type === 'start') {
    planeCtx = msg.plane.getContext('2d', { alpha: false })
    valuesCtx = msg.values.getContext('2d')
    plotCtx = msg.plot.getContext('2d', { alpha: false })
    applyLayout(msg.layout)
  } else if (msg.type === 'layout') {
    applyLayout(msg.layout)
  } else if (msg.type === 'sample') {
    record({ x: msg.x, y: msg.y, at: msg.at })
    wake()
  } else if (msg.type === 'refraction') {
    port = msg.port
    port.onmessage = ({ data }: MessageEvent<SinkToSource>) => {
      if (data.kind !== 'want') return
      wanted.clear()
      for (const n of data.names) wanted.add(n)
      if (wanted.size) draw(now(), 0)
    }
  }
})
