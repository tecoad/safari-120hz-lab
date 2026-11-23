// Glass tab bar (the article's "Shaders" demo), with the input trick:
// each tab is an invisible native scroll container. The finger drags the
// scroller (compositor, 120 Hz) and we read scrollLeft/scrollTop in the
// high-frequency loop. The pads are DPR× larger and scaled down with a
// transform: 1 scroll px = 1 physical px.
//
// Constants: glass-nav-config from the original bundle (382 pt reference width).

import { clamp, dpr, isDark, lerp, parseColor, prefersReducedMotion, rubberBand, smoothstep } from '../core/env'
import { pump } from '../core/pump'
import { spec, Spring } from '../core/spring'
import type { GlassSurface } from '../glass/client'
import type { FrostRegion, LabelOp, Uniforms } from '../glass/protocol'
import { ICONS, type Icon, type IconName } from '../icons'

const D = {
  refWidth: 382,
  stageH: 176,
  barBottom: 47,
  bar: { height: 66, sideInset: 21, sidePad: 4.67, pillPerSlot: 1.102, pillHeight: 57, lensHeld: 1.5, lensPressShare: 0.18, labelSize: 10.5, iconSize: 25, iconCenter: 26.3, labelCenter: 48, pressWidth: 1.047, pressHeight: 1.073 },
  search: { diameter: 66, gap: 7.33, iconSize: 26, pressScale: 1.164 },
  merge: { maxRadius: 24, startGap: 7.33 },
  stretch: { limit: 5, resistance: 0.12, squeeze: 0.08 },
  snap: { travelTabs: 48, slack: 200, followSlop: 0.5 },
  panExtent: 8000,
  motion: {
    follow: spec(0.75, 0.3),
    press: spec(1, 0.25),
    release: spec(1, 0.2),
    snap: spec(1, 0.3),
    tap: spec(0.8, 0.45),
    barPress: spec(0.7, 0.34),
    growRise: spec(0.62, 0.33),
    growFall: spec(0.62, 0.33),
    searchRise: spec(1, 0.113),
    searchFall: spec(0.62, 0.22),
    lightRise: spec(0.8, 0.18),
    lightFall: spec(1, 0.44),
    deform: spec(0.45, 0.28),
    peakAt: 0.99,
    pillGoneAt: 0.5,
    departureMs: 150,
  },
  deform: { fastAt: 1600, fastest: 0.275, jolt: 9.125, narrowest: -0.25, widest: 0.375, paceSmoothing: 0.03 },
  optics: { centerScale: 0.903, glyphLift: 1.2, fringeReach: 6, edgeScale: 0.68, edgeFalloff: 8, bezel: 36, aberration: 0.44, drop: [0.06, 9, 6] },
  barLens: { bezel: 15, edgeScale: 0.5, edgeFalloff: 2.5 },
  barShadow: [0.012, 2.2, 7],
  glow: { gain: 1.03, falloff: 0.37, reach: 130 },
  grid: { spacing: 32, cellsPerSecond: 1 },
  tabs: [
    { label: 'Home', icon: 'home' },
    { label: 'DMs', icon: 'bubble' },
    { label: 'Inbox', icon: 'inbox' },
    { label: 'Threads', icon: 'thread' },
  ] as { label: string; icon: IconName }[],
}

const hex = (h: string, a = 1) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a]

const THEMES = {
  light: {
    glyph: hex('#0e0e0e'), glyphSelected: hex('#040303'), pill: [0, 0, 0, 0.075], pillGradient: 0.17, barLift: 0.008,
    rim: 1.6, lift: 151 / 255, gain: 0.4, curve: 0, saturation: 0.9, gamma: 1.4,
    finish: { glassShine: 0.125, glassGlint: 0.125, glassSheen: 0.075, glassEdge: 0.34, glassEdgeCap: 0.3 },
  },
  dark: {
    glyph: hex('#fafafa'), glyphSelected: hex('#ffffff'), pill: [0, 0, 0, 0.69], pillGradient: 0, barLift: 0.043,
    rim: 0.4, lift: 40 / 255, gain: 0.85, curve: 0.34, saturation: 1.2, gamma: 0.8,
    finish: { glassShine: 0.17, glassGlint: 0.17, glassSheen: 0.055, glassEdge: 0.34, glassEdgeCap: 0 },
  },
}

const FINISH = {
  glassBevel: 1.2, glassShinePower: 3,
  glassShade: 0.019, glassShadeStart: 0, glassShadePeak: 7, glassShadeEnd: 18,
  glassSideShade: 0.019, glassSideShadeStart: 5, glassSideShadeEnd: 17,
  glassSheenDepth: 6, glassEdgeWidth: 0.85,
}

type LiftPhase = 'resting' | 'rising' | 'peaked' | 'waiting' | 'falling'
type Touch = 'idle' | 'pressed' | 'dragging' | 'settling'

interface Geometry {
  w: number
  h: number
  s: number
  bar: { x: number; y: number; w: number; h: number }
  search: { cx: number; cy: number; d: number }
  slot: number
  pill: { w: number; h: number }
  centers: number[]
}

export interface DockOptions {
  stage: HTMLElement
  canvas: HTMLCanvasElement
  surface: GlassSurface
  readout?: HTMLElement | null
}

export function mountDock(o: DockOptions) {
  const { stage, surface } = o
  const reduced = prefersReducedMotion()
  const count = D.tabs.length
  let unit = Math.max(1, Math.round(dpr()))
  const g: Geometry = { w: 0, h: D.stageH, s: 1, bar: { x: 0, y: 0, w: 0, h: 0 }, search: { cx: 0, cy: 0, d: 0 }, slot: 0, pill: { w: 0, h: 0 }, centers: [] }

  const computeGeometry = () => {
    const w = stage.clientWidth
    const s = Math.min(1, w / D.refWidth)
    const barH = D.bar.height * s
    const side = D.bar.sideInset * s
    const gap = D.search.gap * s
    const sd = D.search.diameter * s
    const barW = w - side * 2 - gap - sd
    const barY = D.stageH - D.barBottom - barH
    const slot = (barW - 2 * D.bar.sidePad * s) / (count - 1 + D.bar.pillPerSlot)
    const pillW = D.bar.pillPerSlot * slot
    g.w = w
    g.s = s
    g.bar = { x: side, y: barY, w: barW, h: barH }
    g.search = { cx: side + barW + gap + sd / 2, cy: barY + barH / 2, d: sd }
    g.slot = slot
    g.pill = { w: pillW, h: D.bar.pillHeight * s }
    g.centers = D.tabs.map((_, i) => side + D.bar.sidePad * s + pillW / 2 + i * slot)
  }

  // ------------------------------------------------------------ state
  const st = {
    selected: 0,
    touch: 'idle' as Touch,
    phase: 'resting' as LiftPhase,
    active: -1,
    pressX: 0,
    pressY: 0,
    thumb: 0,
    fingerX: 0,
    fingerY: 0,
    lastThumb: 0,
    lastThumbAt: 0,
    speed: 0,
    pace: 0,
    searchTouch: false,
    lensPresence: 0,
    departAt: -1,
    departFrom: 0,
    pillReturnAt: -1,
    pillGone: false,
    last: performance.now(),
    lastPayload: '',
    visible: true,
    gridT: 0,
    samples: 0,
    sampleWindow: [] as number[],
  }
  const x = new Spring(0, D.motion.follow)
  const lift = new Spring(0, D.motion.press)
  const pressed = new Spring(0, D.motion.barPress)
  const grow = new Spring(0, D.motion.growRise)
  const pullX = new Spring(0, D.motion.follow)
  const pullY = new Spring(0, D.motion.follow)
  const light = new Spring(0, D.motion.lightRise)
  const sGrow = new Spring(0, D.motion.searchRise)
  const sPullX = new Spring(0, D.motion.follow)
  const sPullY = new Spring(0, D.motion.follow)
  const sLight = new Spring(0, D.motion.lightRise)
  const deform = new Spring(0, D.motion.deform)
  const springs = [x, lift, pressed, grow, pullX, pullY, light, sGrow, sPullX, sPullY, sLight, deform]

  const nearest = (px: number) => clamp(Math.round((px - g.centers[0]) / g.slot), 0, count - 1)

  // ------------------------------------------------------------ state machine events
  const barPressed = (index: number, px: number, py: number) => {
    st.touch = 'pressed'
    st.active = index
    st.pressX = px
    st.pressY = py
    st.thumb = g.centers[index]
    st.lastThumb = st.thumb
    st.lastThumbAt = performance.now()
    st.fingerX = px
    st.fingerY = py
    lift.to(1, D.motion.press, false)
    st.phase = 'rising'
    st.departAt = -1
    if (Math.abs(x.value - g.centers[index]) > 0.5) x.to(g.centers[index], D.motion.tap, false)
    light.to(1, D.motion.lightRise)
    grow.to(1, D.motion.growRise)
    pressed.to(1, D.motion.barPress)
  }

  const thumbSampled = (thumb: number, fx: number, fy: number) => {
    const now = performance.now()
    const dtS = Math.max(1e-3, (now - st.lastThumbAt) / 1000)
    if (thumb !== st.lastThumb) {
      st.speed = Math.abs(thumb - st.lastThumb) / dtS
      st.lastThumb = thumb
      st.lastThumbAt = now
    }
    st.thumb = thumb
    st.fingerX = fx
    st.fingerY = fy
    if (st.touch === 'pressed' && Math.abs(thumb - g.centers[st.active]) > D.snap.followSlop) st.touch = 'dragging'
    if (st.touch === 'dragging') x.to(clamp(thumb, g.centers[0], g.centers[count - 1]), D.motion.follow, false)
    // stretch past the bar's edges (rubber band)
    const b = g.bar
    const L = D.stretch.limit * g.s
    const ox = fx < b.x ? fx - b.x : fx > b.x + b.w ? fx - (b.x + b.w) : 0
    const oy = fy < b.y ? fy - b.y : fy > b.y + b.h ? fy - (b.y + b.h) : 0
    pullX.to(rubberBand(ox, L, D.stretch.resistance), D.motion.follow)
    pullY.to(rubberBand(oy, L, D.stretch.resistance), D.motion.follow)
  }

  const releaseLift = () => {
    if (st.phase === 'rising') st.phase = 'waiting'
    else if (st.phase === 'peaked') {
      st.phase = 'falling'
      lift.to(0, D.motion.release, true)
    }
  }

  const barReleased = () => {
    st.touch = 'settling'
    light.to(0, D.motion.lightFall)
    grow.to(0, D.motion.growFall)
    pullX.to(0, D.motion.growFall)
    pullY.to(0, D.motion.growFall)
    pressed.to(0, D.motion.barPress)
    releaseLift()
  }

  const settled = (index: number, kind: 'snap' | 'tap') => {
    st.selected = index
    st.active = -1
    if (kind === 'snap') x.to(g.centers[index], D.motion.snap, true)
    else x.to(g.centers[index], D.motion.tap, false)
    if (st.touch === 'settling') st.touch = 'idle'
  }

  const returned = () => {
    barReleased()
    settled(st.selected, 'tap')
  }

  // ------------------------------------------------------------ controllers (scroll pads)
  const layer = document.createElement('div')
  layer.className = 'dock-controllers'
  stage.append(layer)

  interface Pad {
    el: HTMLDivElement
    index: number
    baseLeft: number
    baseTop: number
    home: number
    homeTop: number
  }
  let pads: Pad[] = []
  let searchPad: Pad | null = null
  let mouse: null | { pad: Pad; x0: number; y0: number; id: number } = null

  const stagePoint = (cx: number, cy: number) => {
    const r = stage.getBoundingClientRect()
    return { x: cx - r.left, y: cy - r.top }
  }

  const haltMomentum = (el: HTMLElement) => {
    const l = el.scrollLeft
    const t = el.scrollTop
    el.style.overflow = 'hidden'
    el.scrollLeft = l
    el.scrollTop = t
    requestAnimationFrame(() => {
      el.style.overflow = ''
    })
  }

  const buildPads = () => {
    layer.replaceChildren()
    unit = Math.max(1, Math.round(dpr()))
    layer.style.width = `${g.w * unit}px`
    layer.style.height = `${g.h * unit}px`
    layer.style.transform = `scale(${1 / unit})`
    const cell = Math.round(g.slot * unit)
    const slack = Math.round(D.snap.slack * unit)
    const cells = D.snap.travelTabs * 2 + 1
    const extent = D.panExtent * unit
    pads = D.tabs.map((tab, i) => {
      const el = document.createElement('div')
      el.className = 'dock-controller'
      el.setAttribute('aria-label', tab.label)
      el.style.left = `${(g.centers[i] - g.slot / 2) * unit}px`
      el.style.top = `${g.bar.y * unit}px`
      el.style.width = `${g.slot * unit}px`
      el.style.height = `${g.bar.h * unit}px`
      el.style.scrollSnapType = 'x mandatory'
      const content = document.createElement('div')
      content.style.cssText = `display:flex;width:${cells * cell + slack * 2}px;height:${extent}px`
      const spacer = () => {
        const sdiv = document.createElement('div')
        sdiv.style.cssText = `flex:none;width:${slack}px;height:100%`
        return sdiv
      }
      content.append(spacer())
      for (let c = 0; c < cells; c++) {
        const cd = document.createElement('div')
        cd.style.cssText = `flex:none;width:${cell}px;height:100%;scroll-snap-align:start;scroll-snap-stop:always`
        content.append(cd)
      }
      content.append(spacer())
      el.append(content)
      layer.append(el)
      const home = slack + D.snap.travelTabs * cell
      const homeTop = Math.round(extent / 2)
      el.scrollLeft = home
      el.scrollTop = homeTop
      return { el, index: i, baseLeft: home, baseTop: homeTop, home, homeTop }
    })
    // search: pad without snapping, endless on both axes
    const se = document.createElement('div')
    se.className = 'dock-controller'
    se.setAttribute('aria-label', 'Search')
    const sd = g.search.d
    se.style.left = `${(g.search.cx - sd / 2) * unit}px`
    se.style.top = `${(g.search.cy - sd / 2) * unit}px`
    se.style.width = `${sd * unit}px`
    se.style.height = `${sd * unit}px`
    const sc = document.createElement('div')
    sc.style.cssText = `width:${extent}px;height:${extent}px`
    se.append(sc)
    layer.append(se)
    const h = Math.round(extent / 2)
    se.scrollLeft = h
    se.scrollTop = h
    searchPad = { el: se, index: -1, baseLeft: h, baseTop: h, home: h, homeTop: h }
    wirePads()
  }

  const recenter = (p: Pad) => {
    p.el.scrollLeft = p.home
    p.el.scrollTop = p.homeTop
    p.baseLeft = p.el.scrollLeft
    p.baseTop = p.el.scrollTop
  }

  const wirePads = () => {
    for (const p of [...pads, searchPad!]) {
      const isSearch = p.index === -1
      p.el.addEventListener('pointerdown', (e) => {
        if (st.touch !== 'idle' && st.touch !== 'settling' && !isSearch) return
        const pt = stagePoint(e.clientX, e.clientY)
        p.baseLeft = p.el.scrollLeft
        p.baseTop = p.el.scrollTop
        if (isSearch) {
          st.searchTouch = true
          st.fingerX = pt.x
          st.fingerY = pt.y
          st.pressX = pt.x
          st.pressY = pt.y
          sGrow.to(1, D.motion.searchRise)
          sLight.to(1, D.motion.lightRise)
        } else {
          for (const q of pads) {
            q.baseLeft = q.el.scrollLeft
            q.baseTop = q.el.scrollTop
          }
          barPressed(p.index, pt.x, pt.y)
        }
        if (e.pointerType === 'mouse') {
          try {
            p.el.setPointerCapture(e.pointerId)
          } catch {
            /* synthetic pointer */
          }
          mouse = { pad: p, x0: e.clientX, y0: e.clientY, id: e.pointerId }
        }
        pump.wake()
      })
      p.el.addEventListener('pointermove', (e) => {
        if (!mouse || mouse.id !== e.pointerId || mouse.pad !== p) return
        const dx = e.clientX - mouse.x0
        const dy = e.clientY - mouse.y0
        if (isSearch) searchMoved(dx, dy)
        else thumbSampled(g.centers[p.index] + dx, st.pressX + dx, st.pressY + dy)
        pump.wake()
      })
      const end = (cancelled: boolean) => {
        if (isSearch) {
          st.searchTouch = false
          sGrow.to(0, D.motion.searchFall)
          sLight.to(0, D.motion.lightFall)
          sPullX.to(0, D.motion.searchFall)
          sPullY.to(0, D.motion.searchFall)
          haltMomentum(p.el)
          setTimeout(() => recenter(p), 250)
        } else if (cancelled) {
          returned()
        } else {
          const wasDragging = st.touch === 'dragging'
          const release = nearest(st.thumb)
          barReleased()
          if (wasDragging) {
            haltMomentum(p.el)
            settled(release, 'snap')
          } else settled(p.index, 'tap')
          setTimeout(() => pads.forEach(recenter), 250)
        }
        pump.wake()
      }
      p.el.addEventListener('pointerup', (e) => {
        if (mouse && mouse.id === e.pointerId) {
          mouse = null
          end(false)
        }
      })
      p.el.addEventListener('touchend', (e) => {
        if (e.targetTouches.length === 0) end(false)
      }, { passive: true })
      p.el.addEventListener('touchcancel', (e) => {
        if (e.targetTouches.length === 0) end(true)
      }, { passive: true })
      p.el.addEventListener('contextmenu', (e) => e.preventDefault())
    }
  }

  const searchMoved = (dx: number, dy: number) => {
    const fx = st.pressX + dx
    const fy = st.pressY + dy
    st.fingerX = fx
    st.fingerY = fy
    const r = (g.search.d / 2) * (1 + (D.search.pressScale - 1) * sGrow.value)
    const L = D.stretch.limit * g.s
    const ddx = fx - g.search.cx
    const ddy = fy - g.search.cy
    const ox = Math.abs(ddx) > r ? ddx - Math.sign(ddx) * r : 0
    const oy = Math.abs(ddy) > r ? ddy - Math.sign(ddy) * r : 0
    sPullX.to(rubberBand(ox, L, D.stretch.resistance), D.motion.follow)
    sPullY.to(rubberBand(oy, L, D.stretch.resistance), D.motion.follow)
  }

  /** Reads the scroll pads (touch). Called on every tick of the high-frequency loop. */
  const readPads = () => {
    if (mouse) return false
    if (st.active >= 0 && (st.touch === 'pressed' || st.touch === 'dragging')) {
      const p = pads[st.active]
      const dx = (p.baseLeft - p.el.scrollLeft) / unit
      const dy = (p.baseTop - p.el.scrollTop) / unit
      const thumb = g.centers[p.index] + dx
      if (thumb !== st.thumb || st.pressY + dy !== st.fingerY) {
        thumbSampled(thumb, st.pressX + dx, st.pressY + dy)
        return true
      }
    }
    if (st.searchTouch && searchPad) {
      const dx = (searchPad.baseLeft - searchPad.el.scrollLeft) / unit
      const dy = (searchPad.baseTop - searchPad.el.scrollTop) / unit
      if (st.pressX + dx !== st.fingerX || st.pressY + dy !== st.fingerY) {
        searchMoved(dx, dy)
        return true
      }
    }
    return false
  }

  // ------------------------------------------------------------ labels (R/G strip)
  const labelFont = () => `600 ${D.bar.labelSize * g.s}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`
  const measureCtx = document.createElement('canvas').getContext('2d')!
  const rasterStrip = () => {
    const ops: LabelOp[] = []
    const font = labelFont()
    measureCtx.font = font
    const m = measureCtx.measureText('Hg')
    const iconSize = D.bar.iconSize * g.s
    D.tabs.forEach((tab, i) => {
      const cx = g.centers[i]
      const iy = g.bar.y + D.bar.iconCenter * g.s - iconSize / 2
      const icon: Icon = ICONS[tab.icon]
      ops.push({ k: 'path', d: icon.stroke, ch: 0, vb: 24, size: iconSize, stroke: 1.7, x: cx - iconSize / 2, y: iy })
      ops.push({ k: 'path', d: icon.fill ?? icon.stroke, cut: icon.cut, fill: true, ch: 1, vb: 24, size: iconSize, stroke: 1.7, x: cx - iconSize / 2, y: iy })
      const tw = measureCtx.measureText(tab.label).width
      const baseline = g.bar.y + D.bar.labelCenter * g.s + (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2
      ops.push({ k: 'text', x: cx - tw / 2, y: baseline, t: tab.label, font, ch: 0 })
      ops.push({ k: 'text', x: cx - tw / 2, y: baseline, t: tab.label, font, ch: 1 })
    })
    const ss = D.search.iconSize * g.s
    for (const ch of [0, 1] as const) {
      ops.push({ k: 'path', d: ICONS.search.stroke, ch, vb: 24, size: ss, stroke: 1.9, x: g.search.cx - ss / 2, y: g.search.cy - ss / 2 })
    }
    surface.labels({ width: g.w, height: g.h, scale: Math.min(dpr(), 3) * 1.25, ops })
  }

  // ------------------------------------------------------------ simulation step
  const step = (now: number, dt: number) => {
    let animating = false
    for (const s of springs) animating = s.step(dt) || animating
    // lift phases: the rise always completes
    if ((st.phase === 'rising' || st.phase === 'waiting') && lift.value >= D.motion.peakAt) {
      if (st.phase === 'waiting') {
        st.phase = 'falling'
        lift.to(0, D.motion.release, true)
      } else st.phase = 'peaked'
      animating = true
    }
    if (st.phase === 'falling' && lift.resting && lift.value === 0) st.phase = 'resting'
    // lens presence
    const lensScale = 1 + (D.bar.lensHeld - 1) * ((1 - D.bar.lensPressShare) * lift.value + D.bar.lensPressShare * pressed.value)
    const strength = clamp((lensScale - 1) / (D.bar.lensHeld - 1), 0, 1)
    if (st.phase === 'rising' || st.phase === 'peaked' || st.phase === 'waiting') {
      st.lensPresence = Math.min(1, st.lensPresence + 0.2 * dt * 120)
      st.departAt = -1
      if (st.lensPresence < 1) animating = true
    } else if (st.lensPresence > 0) {
      if (st.departAt < 0) {
        st.departAt = now
        st.departFrom = st.lensPresence
      }
      const t = (now - st.departAt) / D.motion.departureMs
      const eased = cubicBezierEase(clamp(t, 0, 1))
      st.lensPresence = Math.max(st.departFrom * (1 - eased), strength)
      if ((t >= 1 && strength <= 0.01) || t > 8) st.lensPresence = 0
      animating = true
    }
    // pill: gone by half lift; returns over 150 ms afterwards
    if (st.phase === 'rising' || st.phase === 'peaked' || st.phase === 'waiting' || (st.phase === 'falling' && lift.value >= D.motion.pillGoneAt)) {
      st.pillGone = lift.value > 0.02
      st.pillReturnAt = -1
    } else if (st.pillGone && st.pillReturnAt < 0) {
      st.pillReturnAt = now
    }
    if (st.pillReturnAt >= 0 && now - st.pillReturnAt > D.motion.departureMs) {
      st.pillGone = false
      st.pillReturnAt = -1
    }
    if (st.pillReturnAt >= 0) animating = true
    // velocity squash (constant area)
    const speedNow = st.touch === 'dragging' ? (now - st.lastThumbAt > 25 ? 0 : st.speed) : Math.abs(x.velocity)
    const paceRaw = speedNow / D.deform.fastAt
    const prevPace = st.pace
    st.pace += (paceRaw - st.pace) * (1 - Math.exp(-dt / D.deform.paceSmoothing))
    const drop = st.pace - prevPace
    if (drop < 0) deform.velocity += D.deform.jolt * drop
    deform.to(Math.min(1, st.pace) * D.deform.fastest, D.motion.deform)
    deform.value = clamp(deform.value, D.deform.narrowest, D.deform.widest)
    if (Math.abs(deform.value) > 5e-4 || st.pace > 5e-4) animating = true
    return { animating, lensScale, strength }
  }

  const frameFor = (now: number, lensScale: number, strength: number): { uniforms: Uniforms; frost: FrostRegion } => {
    const th = isDark() ? THEMES.dark : THEMES.light
    const b = g.bar
    // bar: swells on press and stretches toward the finger
    let bw = b.w * (1 + (D.bar.pressWidth - 1) * grow.value)
    let bh = b.h * (1 + (D.bar.pressHeight - 1) * grow.value)
    const px = pullX.value
    const py = pullY.value
    bw += Math.abs(px)
    bh += Math.abs(py)
    bw /= 1 + (Math.abs(py) / b.h) * D.stretch.squeeze
    bh /= 1 + (Math.abs(px) / b.w) * D.stretch.squeeze
    const bcx = b.x + b.w / 2 + px / 2
    const bcy = b.y + b.h / 2 + py / 2
    // search
    const sd = g.search.d * (1 + (D.search.pressScale - 1) * sGrow.value)
    const sw = sd + Math.abs(sPullX.value)
    const sh = sd + Math.abs(sPullY.value)
    const scx = g.search.cx + sPullX.value / 2
    const scy = g.search.cy + sPullY.value / 2
    // fusion: the union radius grows as the 7.33 pt gap closes
    const gapNow = scx - sw / 2 - (bcx + bw / 2)
    const startGap = D.merge.startGap * g.s
    const merge = D.merge.maxRadius * g.s * smoothstep(0, 1, (startGap - gapNow) / startGap)
    // lens and pill
    const lensW = g.pill.w * lensScale * (1 + deform.value)
    const lensH = (g.pill.h * lensScale) / (1 + deform.value)
    const liftNow = lift.value
    let pillA = 1
    if (st.pillGone) {
      pillA = Math.max(0, 1 - liftNow / D.motion.pillGoneAt)
      if (st.pillReturnAt >= 0) pillA = Math.max(pillA, cubicBezierEase(clamp((now - st.pillReturnAt) / D.motion.departureMs, 0, 1)))
    }
    const pillW = lerp(g.pill.w, g.pill.w * D.bar.lensHeld, liftNow)
    const pillH = lerp(g.pill.h, g.pill.h * D.bar.lensHeld, liftNow)
    // drifting grid (paused under reduced motion)
    const gridPan = [reduced ? 0 : (st.gridT * D.grid.spacing * D.grid.cellsPerSecond) % D.grid.spacing, 0]
    const { ground, line } = colors
    const uniforms: Uniforms = {
      ...FINISH,
      ...th.finish,
      dark: isDark() ? 1 : 0,
      ground: [ground[0], ground[1], ground[2]],
      gridLine: [lerp(ground[0], line[0], line[3]), lerp(ground[1], line[1], line[3]), lerp(ground[2], line[2], line[3])],
      gridSpacing: D.grid.spacing,
      gridPan,
      dockCenter: [bcx, bcy],
      dockSize: [bw, bh],
      dockCorner: Math.min(bw, bh) / 2,
      buttonCenter: [scx, scy],
      buttonSize: [sw, sh],
      mergeRadius: merge,
      dockTouch: [st.fingerX, st.fingerY],
      dockGlow: (D.glow.gain - 1) * light.value,
      buttonGlow: (D.glow.gain - 1) * sLight.value,
      dockBarLift: th.barLift * light.value,
      barBezel: D.barLens.bezel * g.s,
      barEdgeScale: D.barLens.edgeScale,
      barEdgeFalloff: D.barLens.edgeFalloff,
      barLift: [th.lift, th.lift, th.lift],
      barGain: th.gain,
      barCurve: th.curve,
      barSaturation: th.saturation,
      glowFalloff: D.glow.falloff,
      glowReach: D.glow.reach,
      barShadow: D.barShadow,
      pillCenter: [x.value, b.y + b.h / 2 + py / 2],
      pillSize: [pillW, pillH],
      pillAlpha: pillA,
      pillColor: th.pill,
      pillGradient: th.pillGradient,
      lensCenter: [x.value, b.y + b.h / 2 + py / 2],
      lensSize: [lensW, lensH],
      lensPresence: st.lensPresence,
      lensStrength: strength,
      centerScale: [D.optics.centerScale, D.optics.centerScale],
      edgeScale: D.optics.edgeScale,
      edgeFalloff: D.optics.edgeFalloff,
      bezel: D.optics.bezel * g.s,
      aberration: D.optics.aberration,
      fringeReach: D.optics.fringeReach,
      rimIntensity: th.rim,
      lensDrop: [D.optics.drop[0], D.optics.drop[1] * g.s, D.optics.drop[2] * g.s],
      glyphColor: th.glyph,
      glyphSelected: th.glyphSelected,
      dockRest: [b.x + b.w / 2, b.y + b.h / 2],
      buttonRest: [g.search.cx, g.search.cy],
      barGrow: [bw / b.w, bh / b.h],
      buttonGrow: [sw / g.search.d, sh / g.search.d],
      iconSplit: [1, 0, (bcx + bw / 2 + scx - sw / 2) / 2],
      slots: [g.centers[0], g.slot, count],
      glyphLift: D.optics.glyphLift,
    }
    const m = 10 * 2.5 + 16
    const x0 = Math.min(bcx - bw / 2, x.value - lensW / 2) - m
    const x1 = Math.max(scx + sw / 2, x.value + lensW / 2) + m
    const y0 = Math.min(bcy - bh / 2, scy - sh / 2, b.y + b.h / 2 - lensH / 2) - m
    const y1 = Math.max(bcy + bh / 2, scy + sh / 2, b.y + b.h / 2 + lensH / 2) + m
    return { uniforms, frost: { x: x0, y: y0, w: x1 - x0, h: y1 - y0, sigma: 10, cell: 4, gamma: th.gamma } }
  }

  // ------------------------------------------------------------ loop
  const client = {
    tick(now: number) {
      const dt = clamp((now - st.last) / 1000, 0, 3 / 120)
      st.last = now
      if (!st.visible) return false
      const fresh = readPads()
      if (fresh) {
        st.samples++
        st.sampleWindow.push(now)
      }
      const sw = st.sampleWindow
      while (sw.length && now - sw[0] > 1000) sw.shift()
      const drifting = !reduced
      if (drifting) st.gridT += dt
      const { animating, lensScale, strength } = step(now, dt)
      const touching = st.touch === 'pressed' || st.touch === 'dragging' || st.searchTouch
      if ((fresh || animating || drifting || st.lastPayload === '') && surface.canSend(now)) {
        const { uniforms, frost } = frameFor(now, lensScale, strength)
        const payload = JSON.stringify(uniforms)
        if (payload !== st.lastPayload) {
          st.lastPayload = payload
          surface.frame(uniforms, frost)
        }
      }
      if (o.readout) o.readout.textContent = `input ${sw.length}/s · render ${surface.stats.fps} fps`
      return animating || touching || drifting
    },
  }

  const colors = { ground: [0, 0, 0, 1], line: [0.5, 0.5, 0.5, 0.2] }
  const readColors = () => {
    const cs = getComputedStyle(stage)
    colors.ground = parseColor(cs.backgroundColor)
    colors.line = parseColor(cs.getPropertyValue('--stage-line-rgb') ? `rgba(${cs.getPropertyValue('--stage-line-rgb')})` : 'rgba(128,128,128,0.2)')
  }

  const relayout = () => {
    readColors()
    computeGeometry()
    stage.style.height = `${D.stageH}px`
    if (!x.value || x.resting) x.jump(g.centers[st.selected] ?? 0)
    buildPads()
    surface.resize(g.w, g.h, Math.min(dpr(), 3))
    surface.whenReady(rasterStrip)
    st.lastPayload = ''
    pump.wake()
  }

  relayout()
  pump.add(client)

  new IntersectionObserver(([e]) => {
    st.visible = e.isIntersecting
    if (st.visible) {
      st.lastPayload = ''
      pump.wake()
    }
  }).observe(stage)

  return { relayout, size: () => ({ w: g.w, h: g.h }) }
}

/** cubic-bezier(0, 0, .58, 1) solved by bisection (24 steps), as in the original. */
function cubicBezierEase(t: number) {
  const x1 = 0
  const x2 = 0.58
  const y1 = 0
  const y2 = 1
  const bez = (u: number, a: number, b: number) => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (bez(mid, x1, x2) < t) lo = mid
    else hi = mid
  }
  return bez((lo + hi) / 2, y1, y2)
}
