// Main-thread side of the glass: transfers the canvas to the worker and sends frames.
// Flow control: at most 2 frames "in flight" and a minimum of
// 6.25 ms between sends (avoids building a latency queue).

import { isIOS } from '../core/env'
import type { DisplayItem, FromWorker, FrostRegion, LabelSpec, SourceRegion, SurfaceKind, ToWorker, Uniforms } from './protocol'

const FRAMES_IN_FLIGHT = 2
const MIN_INTERVAL_MS = 6.25

let worker: Worker | null = null
const handlers = new Map<string, (m: FromWorker) => void>()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./glass.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<FromWorker>) => handlers.get(e.data.id)?.(e.data)
  worker.onerror = (e) => console.error('[glass worker]', e.message)
  return worker
}

/** Per-surface stats (for the HUD). */
export interface SurfaceStats {
  presented: number
  lastPresentAt: number
  fps: number
  workerMs: number
}

export class GlassSurface {
  readonly id: string
  ready = false
  failed: string | null = null
  readonly stats: SurfaceStats = { presented: 0, lastPresentAt: 0, fps: 0, workerMs: 0 }
  private inFlight = 0
  private lastSent = 0
  private seq = 0
  private presentTimes: number[] = []
  private onReadyFns: (() => void)[] = []
  private onPresentFns: (() => void)[] = []

  constructor(canvas: HTMLCanvasElement, kind: SurfaceKind, width: number, height: number, dpr: number) {
    this.id = `${kind}-${Math.random().toString(36).slice(2, 8)}`
    if (!('transferControlToOffscreen' in canvas)) {
      this.failed = 'transferControlToOffscreen unavailable'
      return
    }
    const offscreen = canvas.transferControlToOffscreen()
    handlers.set(this.id, (m) => this.onMessage(m))
    const msg: ToWorker = { kind: 'init', id: this.id, surface: kind, canvas: offscreen, width, height, dpr, desync: isIOS }
    getWorker().postMessage(msg, [offscreen])
  }

  private onMessage(m: FromWorker) {
    if (m.kind === 'ready') {
      if (m.ok) {
        this.ready = true
        this.onReadyFns.splice(0).forEach((f) => f())
      } else {
        this.failed = m.reason ?? 'error'
        this.inFlight = Math.max(0, this.inFlight - 1)
        console.error(`[glass ${this.id}]`, m.reason)
      }
      return
    }
    this.inFlight = Math.max(0, this.inFlight - 1)
    const now = performance.now()
    this.stats.presented++
    this.stats.lastPresentAt = now
    this.stats.workerMs = m.ms
    const t = this.presentTimes
    t.push(now)
    while (t.length && now - t[0] > 1000) t.shift()
    this.stats.fps = t.length
    this.onPresentFns.forEach((f) => f())
  }

  whenReady(fn: () => void) {
    if (this.ready) fn()
    else this.onReadyFns.push(fn)
  }

  onPresent(fn: () => void) {
    this.onPresentFns.push(fn)
  }

  private post(msg: ToWorker) {
    if (this.failed) return
    getWorker().postMessage(msg)
  }

  canSend(now: number) {
    return this.ready && !this.failed && this.inFlight < FRAMES_IN_FLIGHT && now - this.lastSent >= MIN_INTERVAL_MS
  }

  frame(uniforms: Uniforms, frost: FrostRegion | null, scrollY = 0) {
    this.inFlight++
    this.lastSent = performance.now()
    this.post({ kind: 'frame', id: this.id, seq: ++this.seq, uniforms, frost, scrollY })
  }

  resize(width: number, height: number, dpr: number) {
    this.post({ kind: 'resize', id: this.id, width, height, dpr })
  }

  page(items: DisplayItem[], docWidth: number, docHeight: number, ground: string) {
    this.post({ kind: 'page', id: this.id, items, docWidth, docHeight, ground })
  }

  labels(spec: LabelSpec) {
    this.post({ kind: 'labels', id: this.id, spec })
  }

  /** Makes the frames of `source` appear behind this glass (a "refraction
   *  source"). `rect` in document CSS px. */
  link(source: GlassSurface, rect: [number, number, number, number], radius: number) {
    if (source.failed) return
    this.post({ kind: 'link', id: this.id, source: source.id, rect, radius })
  }

  /** External source (another worker): its frames arrive directly over `port`. */
  connectPort(key: string, port: MessagePort, regions: SourceRegion[]) {
    if (this.failed) return
    getWorker().postMessage({ kind: 'port', id: this.id, key, port, regions } satisfies ToWorker, [port])
  }

  updateRegions(key: string, regions: SourceRegion[]) {
    this.post({ kind: 'regions', id: this.id, key, regions })
  }
}
