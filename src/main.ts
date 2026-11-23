import './style.css'
import { mountContents } from './chrome/contents'
import { installDisplayBoost } from './core/boost'
import { dpr, onThemeChange } from './core/env'
import { pump } from './core/pump'
import { mountDock } from './dock/dock'
import { GlassSurface } from './glass/client'
import { snapshotPage } from './glass/snapshot'
import { mountReadout } from './readout/readout'

const ORIGINAL = 'https://rida.dev/blog/bypassing-ios-safari-60-fps-limit'

const page = document.querySelector<HTMLElement>('[data-glass-page]')!
const article = document.querySelector<HTMLElement>('article')!
const root = document.querySelector<HTMLElement>('[data-post-contents]')!
const canvas = document.querySelector<HTMLCanvasElement>('.glass-canvas')!
const hud = document.querySelector<HTMLElement>('[data-hud]')
const vw = () => document.documentElement.clientWidth

const boost = installDisplayBoost()

const fail = (why: string) => {
  document.documentElement.classList.add('glass-off')
  if (hud) hud.textContent = `glass off: ${why}`
}

// ---------------------------------------------------------------- chrome (track + menu)
const chrome = new GlassSurface(canvas, 'page', vw(), 1, Math.min(dpr(), 3))
if (chrome.failed) fail(chrome.failed)

const contents = mountContents({
  root,
  canvas,
  surface: chrome,
  article,
  column: page,
  originalUrl: ORIGINAL,
  pinBoost: boost.pin,
})

const sizeChrome = () => {
  const h = contents.canvasHeight
  canvas.style.width = `${vw()}px`
  canvas.style.height = `${h}px`
  chrome.resize(vw(), h, Math.min(dpr(), 3))
}

const snapshot = () => {
  const snap = snapshotPage(page)
  chrome.page(snap.items, snap.docWidth, snap.docHeight, snap.ground)
  contents.invalidate()
}

// ---------------------------------------------------------------- tab bar demo
const stage = document.querySelector<HTMLElement>('[data-dock-stage]')
let dock: ReturnType<typeof mountDock> | null = null
let dockSurface: GlassSurface | null = null
if (stage) {
  const dockCanvas = stage.querySelector('canvas')!
  dockSurface = new GlassSurface(dockCanvas, 'dock', stage.clientWidth, 176, Math.min(dpr(), 3))
  if (dockSurface.failed) fail(dockSurface.failed)
  dock = mountDock({ stage, canvas: dockCanvas, surface: dockSurface, readout: document.querySelector('[data-dock-readout]') })
}

/** The tab bar canvas becomes a "source" for the page glass: the indicator and
 *  the menu refract the tab bar when they pass over it (as in the original). */
const linkDock = () => {
  if (!stage || !dockSurface) return
  const c = stage.querySelector('canvas')!.getBoundingClientRect()
  const cs = getComputedStyle(stage)
  const radius = Math.max(0, (parseFloat(cs.borderTopLeftRadius) || 0) - (parseFloat(cs.borderTopWidth) || 0))
  chrome.link(dockSurface, [c.left + window.scrollX, c.top + window.scrollY, c.width, c.height], radius)
}

// ---------------------------------------------------------------- controller meters
const readouts = [...document.querySelectorAll<HTMLElement>('[data-readout]')].map((fig) =>
  mountReadout(fig, {
    precise: fig.dataset.readout === 'precise',
    glass: {
      connect: (key, port, regions) => chrome.connectPort(key, port, regions),
      update: (key, regions) => chrome.updateRegions(key, regions),
    },
  }),
)

// ---------------------------------------------------------------- HUD: scroll reads/s and fps
const hudState = { last: window.scrollY, reads: [] as number[] }
if (hud) {
  pump.add({
    tick(now) {
      const y = window.scrollY
      if (y !== hudState.last) {
        hudState.last = y
        hudState.reads.push(now)
      }
      const r = hudState.reads
      while (r.length && now - r[0] > 1000) r.shift()
      if (!chrome.failed) hud.textContent = `scroll ${r.length}/s · glass ${chrome.stats.fps} fps · ${chrome.stats.workerMs.toFixed(1)} ms`
      return false
    },
  })
  window.addEventListener('scroll', pump.wake, { passive: true })
}

// ---------------------------------------------------------------- lifecycle
const relayoutAll = () => {
  contents.layout()
  sizeChrome()
  dock?.relayout()
  readouts.forEach((r) => r.relayout())
  snapshot()
  linkDock()
}

chrome.whenReady(() => {
  sizeChrome()
  snapshot()
  if (dockSurface) dockSurface.whenReady(linkDock)
})

void document.fonts?.ready.then(relayoutAll)

let resizeTimer = 0
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(relayoutAll, 150)
})

onThemeChange(() => relayoutAll())

// safety net: if the worker reports an error, fall back to the DOM version
window.setTimeout(() => {
  if (chrome.failed) fail(chrome.failed)
}, 2000)
