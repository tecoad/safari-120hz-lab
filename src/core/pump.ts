// The high-frequency heart of the page.
//
// In Safari, requestAnimationFrame and touch events are stuck at 60 Hz.
// The original author works around it like this:
//   1. A MessageChannel schedules a setTimeout for the next sample "slot".
//      There are 2 slots per 120 Hz frame (every ~4.17 ms), phase-locked to the
//      latest rAF timestamp, with a 1 ms lead.
//      The setTimeout is called from inside a "message" event, not from inside
//      another timer, so it escapes the 4 ms clamp on nested timers.
//   2. An *empty* rAF loop runs alongside. It draws nothing: it only keeps a
//      rendering update queued. With that, WebKit sends the scroll position from
//      the UI process without waiting for the previous one's ack (~12.5% more reads).
//   3. Outside Safari, plain rAF is used (Chrome already runs rAF at the display rate).
//
// Each client gets tick(now) and decides whether to read input, step springs and
// send a frame to the worker. If nobody asks for ticks for 400 ms, the loop parks.

import { isSafariEngine } from './env'

const DISPLAY_HZ = 120
const SAMPLES_PER_FRAME = 2
const LEAD_MS = 1
const PARK_AFTER_MS = 400
const SLOT_MS = 1000 / DISPLAY_HZ / SAMPLES_PER_FRAME

export interface PumpClient {
  /** Return true while you want more ticks (live input or animating). */
  tick(now: number): boolean
}

class Pump {
  private clients = new Set<PumpClient>()
  private running = false
  private vsync = 0
  private raf = 0
  private target = 0
  private activeAt = 0
  private channel = new MessageChannel()
  /** Counters for the diagnostic HUD. */
  readonly stats = { ticks: 0, rafs: 0 }

  constructor() {
    this.channel.port1.onmessage = () => {
      const now = performance.now()
      this.target = this.slotAfter(Math.max(now, this.target + SLOT_MS / 2))
      setTimeout(this.run, Math.max(0, this.target - now))
    }
  }

  private slotAfter(t: number) {
    const v = this.vsync
    return v + Math.ceil((t - v + LEAD_MS) / SLOT_MS) * SLOT_MS - LEAD_MS
  }

  /** Empty rAF loop: stores the vsync timestamp and forces WebKit to flush scroll positions. */
  private onRaf = (t: number) => {
    if (!this.running) return
    this.vsync = t
    this.stats.rafs++
    this.raf = requestAnimationFrame(this.onRaf)
  }

  add(client: PumpClient) {
    this.clients.add(client)
    this.wake()
    return () => this.clients.delete(client)
  }

  wake = () => {
    this.activeAt = performance.now()
    if (this.running) return
    this.running = true
    this.vsync = performance.now()
    this.raf = requestAnimationFrame(this.onRaf)
    this.schedule()
  }

  private schedule() {
    if (isSafariEngine) this.channel.port2.postMessage(0)
    else requestAnimationFrame(this.run)
  }

  private run = () => {
    if (!this.running) return
    const now = performance.now()
    this.stats.ticks++
    let busy = false
    for (const c of this.clients) busy = c.tick(now) || busy
    if (busy) this.activeAt = now
    if (!busy && now - this.activeAt > PARK_AFTER_MS) {
      this.running = false
      cancelAnimationFrame(this.raf)
      return
    }
    this.schedule()
  }
}

export const pump = new Pump()
