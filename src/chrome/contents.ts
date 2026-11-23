// Contents menu (table of contents) + reading-progress indicator, both glass.
//
// The DOM is only the accessible layer (a real button, rows
// with transparent text, focus, aria-*). Everything you see is drawn by the
// shader in the worker, including the row text (label texture), at 120 Hz.
//
// Motion/size constants matched to Safari's filter menu in the iOS 27 simulator
// (reference values from the write-up's demo, linked from the README).

import { clamp, dpr, isDark, lerp, parseColor, prefersReducedMotion, smoothstep } from '../core/env'
import { pump } from '../core/pump'
import { spec, Spring } from '../core/spring'
import type { GlassSurface } from '../glass/client'
import type { FrostRegion, LabelOp, Uniforms } from '../glass/protocol'
import { ICONS, type IconName } from '../icons'

const C = {
  edgeInset: 16,
  button: 56,
  pressScale: 1.164,
  holdToOpenMs: 160,
  tapSlop: 10,
  track: { gap: 8, widthShare: 0.5, corner: 28, groove: { inline: 22, height: 6 }, minimumFill: 0.01 },
  panel: { width: 250, corner: 32, maxShare: 0.595, maxHeight: 520, inset: 16, seed: 18 },
  row: { iconCentre: 30.2, iconSide: 21, stroke: 1.7 },
  motion: {
    open: spec(0.75, 0.35),
    close: spec(0.8, 0.49),
    kickOpen: { perDistance: 7, spring: spec(0.64, 0.38) },
    kickClose: { perDistance: 11.2, spring: spec(0.81, 0.335) },
    contentFrom: 1.305,
    content: spec(0.75, 0.61),
    closeGoneBelow: 0.8,
    closeScalePerLost: 3,
    contentBlur: 4,
    pillFade: spec(1, 0.28),
    pillSlide: spec(0.9, 0.15),
    rise: spec(1, 0.113),
    fall: spec(0.62, 0.22),
    endScale: 0.25,
    travelShare: 0.25,
    travelOpen: spec(1, 0.2),
  },
  dissolve: { blurFull: 0.6, blurRadius: 3, fadeStart: 0.15, fadeGone: 0.9 },
  shadowClosed: { opacity: 0.012, sigma: 2.2, offset: 7 },
  shadowOpen: { light: 0.12, dark: 0.18, sigma: 24, offset: 8 },
  mergeRadius: 16,
  frostCell: 4,
  settleMs: 200,
}

const rgb = (r: number, g: number, b: number) => [r / 255, g / 255, b / 255]

const THEMES = {
  light: {
    veil: rgb(253, 253, 253),
    veilAmount: 0.535,
    saturation: 1.2,
    sigma: 12,
    ink: [0, 0, 0, 0.96],
    line: [0, 0, 0, 0.08],
    pill: [0, 0, 0, 0.11],
    fill: [14 / 255, 14 / 255, 14 / 255, 0.9],
    groove: [120 / 255, 120 / 255, 128 / 255, 0.2],
    shadowOpen: C.shadowOpen.light,
    finish: {
      glassBevel: 1.3, glassShine: 0.17, glassGlint: 0.28, glassShinePower: 3,
      glassShade: 0.019, glassShadeStart: 0, glassShadePeak: 7, glassShadeEnd: 18,
      glassSideShade: 0.019, glassSideShadeStart: 5, glassSideShadeEnd: 17,
      glassSheen: 0.039, glassSheenDepth: 6,
      glassEdge: 0.34, glassEdgeCap: 0.31, glassEdgeWidth: 0.67,
    },
  },
  dark: {
    veil: rgb(49, 49, 49),
    veilAmount: 0.651,
    saturation: 1.3,
    sigma: 8.4,
    ink: [1, 1, 1, 0.96],
    line: [1, 1, 1, 0.08],
    pill: [1, 1, 1, 0.12],
    fill: [250 / 255, 250 / 255, 250 / 255, 0.9],
    groove: [235 / 255, 235 / 255, 245 / 255, 0.2],
    shadowOpen: C.shadowOpen.dark,
    finish: {
      glassBevel: 1.3, glassShine: 0.21, glassGlint: 0.23, glassShinePower: 3,
      glassShade: 0.017, glassShadeStart: 0, glassShadePeak: 7, glassShadeEnd: 18,
      glassSideShade: 0.017, glassSideShadeStart: 5, glassSideShadeEnd: 17,
      glassSheen: 0.047, glassSheenDepth: 5.5,
      glassEdge: 0.3, glassEdgeCap: 0, glassEdgeWidth: 0.67,
    },
  },
}

type RowKind = 'heading' | 'copy' | 'visit'

interface Row {
  el: HTMLElement
  kind: RowKind
  label: string
  icon?: IconName
  target?: HTMLElement
  href?: string
  rect: { x: number; y: number; w: number; h: number }
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ContentsOptions {
  root: HTMLElement
  canvas: HTMLCanvasElement
  surface: GlassSurface
  article: HTMLElement
  column: HTMLElement
  writeUpUrl: string
  pinBoost: (on: boolean) => void
}

export function mountContents(o: ContentsOptions) {
  const { root, surface, article, column } = o
  const button = root.querySelector<HTMLButtonElement>('.post-contents-button')!
  const panelEl = root.querySelector<HTMLElement>('.post-contents-panel')!
  const scroller = root.querySelector<HTMLElement>('.post-contents-scroller')!
  const list = root.querySelector<HTMLElement>('.post-contents-list')!
  const scrim = document.querySelector<HTMLElement>('.post-contents-scrim')!
  const reduced = prefersReducedMotion()

  // ---------------------------------------------------------------- rows
  const rows: Row[] = []
  const buildRows = () => {
    list.replaceChildren()
    rows.length = 0
    const actions = document.createElement('ul')
    actions.setAttribute('aria-label', 'Post actions')
    const addAction = (kind: RowKind, label: string, icon: IconName, href?: string) => {
      const li = document.createElement('li')
      const el = href ? document.createElement('a') : document.createElement('button')
      el.className = 'post-contents-row post-contents-row-with-icon'
      if (el instanceof HTMLAnchorElement) {
        el.href = href!
        el.target = '_blank'
        el.rel = 'noopener'
      } else el.type = 'button'
      el.textContent = label
      li.append(el)
      actions.append(li)
      rows.push({ el, kind, label, icon, href, rect: { x: 0, y: 0, w: 0, h: 0 } })
    }
    addAction('copy', 'Copy link', 'copy')
    addAction('visit', 'Background reading', 'external', o.writeUpUrl)
    const sep = document.createElement('div')
    sep.className = 'post-contents-separator'
    sep.setAttribute('role', 'separator')
    const nav = document.createElement('nav')
    nav.setAttribute('aria-label', 'Table of contents')
    const ol = document.createElement('ol')
    for (const h of article.querySelectorAll<HTMLElement>('h1, h2, h3')) {
      if (!h.id) continue
      const level = h.tagName === 'H1' ? 0 : h.tagName === 'H2' ? 1 : 2
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.className = 'post-contents-row'
      a.href = `#${h.id}`
      a.style.setProperty('--level', String(level))
      a.textContent = h.textContent?.trim() ?? ''
      li.append(a)
      ol.append(li)
      rows.push({ el: a, kind: 'heading', label: a.textContent, target: h, rect: { x: 0, y: 0, w: 0, h: 0 } })
    }
    nav.append(ol)
    list.append(actions, sep, nav)
  }
  buildRows()

  // ---------------------------------------------------------------- geometry
  const geo = {
    vw: 0,
    vh: 0,
    safeTop: 0,
    button: { x: 0, y: 0, w: C.button, h: C.button } as Rect,
    track: { x: 0, y: 0, w: 0, h: C.button } as Rect,
    panel: { x: 0, y: 0, w: C.panel.width, h: 0 } as Rect,
    listHeight: 0,
    canvasH: 0,
    articleTop: 0,
    articleHeight: 0,
    ground: [0, 0, 0, 1] as number[],
  }

  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:100svh;padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);visibility:hidden;pointer-events:none'
  document.body.append(probe)

  let labelsDirty = true
  const layout = () => {
    const ps = getComputedStyle(probe)
    geo.safeTop = parseFloat(ps.paddingTop) || 0
    const safeRight = parseFloat(ps.paddingRight) || 0
    const svh = probe.getBoundingClientRect().height - geo.safeTop
    geo.ground = parseColor(getComputedStyle(document.body).backgroundColor)
    geo.vw = document.documentElement.clientWidth
    geo.vh = window.innerHeight
    const col = column.getBoundingClientRect()
    const right = Math.max(C.edgeInset + safeRight, geo.vw - col.right)
    const b = geo.button
    b.x = geo.vw - right - C.button
    b.y = C.edgeInset + geo.safeTop
    const t = geo.track
    t.x = geo.vw - (b.x + b.w)
    t.y = b.y
    t.w = Math.max(0, (b.x - C.track.gap - t.x) * C.track.widthShare)
    t.h = b.h
    // panel: its top-right corner sits on the button's corner
    const pw = Math.min(C.panel.width, geo.vw - C.panel.inset * 2)
    root.style.left = `${b.x}px`
    root.style.top = `${b.y}px`
    panelEl.style.width = `${pw}px`
    scroller.style.width = `${pw}px`
    const listH = list.scrollHeight
    const maxH = Math.min(svh * C.panel.maxShare, svh - C.edgeInset - geo.safeTop - C.panel.inset * 2, C.panel.maxHeight)
    const ph = Math.min(listH, maxH)
    panelEl.style.height = `${ph}px`
    scroller.style.height = `${ph}px`
    geo.panel = { x: b.x + b.w - pw, y: b.y, w: pw, h: ph }
    geo.listHeight = listH
    geo.canvasH = Math.ceil(b.y + Math.max(b.h, ph) + 64)
    const ar = article.getBoundingClientRect()
    geo.articleTop = ar.top + window.scrollY
    geo.articleHeight = ar.height
    // rows in panel coordinates (= the label texture's origin)
    const lr = list.getBoundingClientRect()
    for (const r of rows) {
      const rr = r.el.getBoundingClientRect()
      r.rect = { x: rr.left - lr.left, y: rr.top - lr.top, w: rr.width, h: rr.height }
    }
    labelsDirty = true
  }

  // ---------------------------------------------------------------- labels
  const copiedUntil = { at: 0 }
  const rasterLabels = () => {
    labelsDirty = false
    const ops: LabelOp[] = []
    const lr = list.getBoundingClientRect()
    for (const r of rows) {
      const cs = getComputedStyle(r.el)
      const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const m = textMetrics(font)
      const padL = parseFloat(cs.paddingLeft) || 0
      const padR = parseFloat(cs.paddingRight) || 0
      const baseline = r.rect.y + r.rect.h / 2 + (m.asc - m.desc) / 2
      const copied = r.kind === 'copy' && performance.now() < copiedUntil.at
      const label = copied ? 'Link copied!' : r.label
      ops.push({ k: 'text', x: r.rect.x + padL, y: baseline, t: label, font, ch: 0, maxW: r.rect.w - padL - padR })
      const icon = copied ? 'check' : r.icon
      if (icon) {
        const side = C.row.iconSide
        ops.push({
          k: 'path', d: ICONS[icon].stroke, ch: 0, vb: 24, size: side, stroke: C.row.stroke,
          x: r.rect.x + C.row.iconCentre - side / 2, y: r.rect.y + r.rect.h / 2 - side / 2,
        })
      }
    }
    for (const sep of list.querySelectorAll<HTMLElement>('.post-contents-separator')) {
      const s = sep.getBoundingClientRect()
      ops.push({ k: 'rect', x: s.left - lr.left, y: s.top - lr.top, w: s.width, h: Math.max(1, s.height), r: 0, ch: 1 })
    }
    surface.labels({ width: Math.max(1, lr.width), height: Math.max(1, geo.listHeight), scale: Math.min(dpr(), 3), ops })
  }

  // ---------------------------------------------------------------- state
  const st = {
    open: false,
    navigatingUntil: 0,
    scrollY: window.scrollY,
    scrollChangedAt: 0,
    listScroll: 0,
    last: performance.now(),
    pointer: null as null | { id: number; x: number; y: number; at: number; onButton: boolean; heldOpen: boolean; moved: boolean },
    holdTimer: 0,
    armed: -1,
    hover: -1,
    lastPayload: '',
  }
  const open = new Spring(0, C.motion.open)
  const kick = new Spring(0, C.motion.kickOpen.spring)
  const press = new Spring(0, C.motion.rise)
  const travel = new Spring(0, C.motion.travelOpen)
  const contentScale = new Spring(1, C.motion.content)
  const pillAlpha = new Spring(0, C.motion.pillFade)
  const pillY = new Spring(0, C.motion.pillSlide)
  const pillH = new Spring(42, C.motion.pillSlide)
  const springs = [open, kick, press, travel, contentScale, pillAlpha, pillY, pillH]

  const currentRowIndex = () => {
    let idx = -1
    rows.forEach((r, i) => {
      if (r.kind !== 'heading' || !r.target) return
      if (r.target.getBoundingClientRect().top <= geo.vh * 0.3) idx = i
    })
    return idx === -1 ? rows.findIndex((r) => r.kind === 'heading') : idx
  }

  const movePill = (index: number, instant = false) => {
    const r = rows[index]
    if (!r) return
    const cy = r.rect.y + r.rect.h / 2
    if (instant) {
      pillY.jump(cy)
      pillH.jump(r.rect.h)
    } else {
      pillY.to(cy)
      pillH.to(r.rect.h)
    }
    pillAlpha.to(1)
    rows.forEach((row) => row.el.removeAttribute('data-highlight'))
    r.el.setAttribute('data-highlight', '')
  }

  const setOpen = (next: boolean, focusRow = false) => {
    if (st.open === next) return
    st.open = next
    const b = geo.button
    const p = geo.panel
    const dy = p.y + p.h / 2 - (b.y + b.h / 2)
    if (next) {
      open.to(1, C.motion.open)
      kick.to(0, C.motion.kickOpen.spring)
      kick.velocity += C.motion.kickOpen.perDistance * dy
      travel.to(1, C.motion.travelOpen)
      contentScale.jump(C.motion.contentFrom).to(1, C.motion.content)
      const cur = currentRowIndex()
      rows.forEach((r) => r.el.removeAttribute('aria-current'))
      if (cur >= 0) {
        rows[cur].el.setAttribute('aria-current', 'location')
        movePill(cur, true)
        pillAlpha.jump(0).to(1)
        // scroll the list so the current section is visible
        const r = rows[cur].rect
        if (r.y + r.h > p.h) scroller.scrollTop = r.y - p.h / 2
      }
      panelEl.inert = false
      scrim.hidden = false
      button.setAttribute('aria-expanded', 'true')
      if (focusRow) (rows[cur >= 0 ? cur : 0]?.el as HTMLElement | undefined)?.focus({ preventScroll: true })
    } else {
      open.to(0, C.motion.close)
      kick.to(0, C.motion.kickClose.spring)
      kick.velocity += C.motion.kickClose.perDistance * dy * 0.25
      travel.to(0, C.motion.close)
      pillAlpha.to(0)
      panelEl.inert = true
      scrim.hidden = true
      button.setAttribute('aria-expanded', 'false')
      st.armed = -1
      if (panelEl.contains(document.activeElement)) button.focus({ preventScroll: true })
    }
    if (reduced) {
      open.jump(next ? 1 : 0)
      kick.jump(0)
      travel.jump(next ? 1 : 0)
      contentScale.jump(1)
    }
    o.pinBoost(true)
    window.setTimeout(() => o.pinBoost(false), 700)
    pump.wake()
  }

  const choose = (index: number) => {
    const r = rows[index]
    if (!r) return
    if (r.kind === 'copy') {
      void navigator.clipboard?.writeText(location.href.split('#')[0]).catch(() => {})
      copiedUntil.at = performance.now() + 1600
      labelsDirty = true
      window.setTimeout(() => {
        labelsDirty = true
        pump.wake()
      }, 1650)
      pump.wake()
      return
    }
    if (r.kind === 'visit') {
      window.open(r.href, '_blank', 'noopener')
      setOpen(false)
      return
    }
    if (r.target) {
      st.navigatingUntil = performance.now() + 1500
      history.replaceState(null, '', `#${r.target.id}`)
      r.target.setAttribute('tabindex', '-1')
      r.target.focus({ preventScroll: true })
      r.target.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'start' })
      setOpen(false)
    }
  }

  // ---------------------------------------------------------------- events
  const rowIndexAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest('.post-contents-row')
    return el ? rows.findIndex((r) => r.el === el) : -1
  }

  button.addEventListener('pointerdown', (e) => {
    st.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now(), onButton: true, heldOpen: false, moved: false }
    press.to(1, C.motion.rise)
    clearTimeout(st.holdTimer)
    // holding 160 ms opens the menu "under the finger"; drag to a row and lift to choose
    if (!st.open) {
      st.holdTimer = window.setTimeout(() => {
        if (st.pointer && !st.pointer.moved) {
          st.pointer.heldOpen = true
          setOpen(true)
        }
      }, C.holdToOpenMs)
    }
    pump.wake()
  })
  button.addEventListener('pointermove', (e) => {
    const p = st.pointer
    if (!p || p.id !== e.pointerId) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > C.tapSlop) p.moved = true
    if (p.heldOpen) {
      const i = rowIndexAt(e.clientX, e.clientY)
      if (i !== st.armed && i >= 0) movePill(i)
      st.armed = i
      pump.wake()
    }
  })
  const endButton = (e: PointerEvent, cancelled: boolean) => {
    const p = st.pointer
    if (!p || p.id !== e.pointerId) return
    clearTimeout(st.holdTimer)
    press.to(0, C.motion.fall)
    st.pointer = null
    if (p.heldOpen) {
      if (!cancelled && st.armed >= 0) choose(st.armed)
      st.armed = -1
      button.dataset.swallowClick = '1'
    }
    pump.wake()
  }
  button.addEventListener('pointerup', (e) => endButton(e, false))
  button.addEventListener('pointercancel', (e) => endButton(e, true))
  button.addEventListener('click', (e) => {
    if (button.dataset.swallowClick) {
      delete button.dataset.swallowClick
      e.preventDefault()
      return
    }
    setOpen(!st.open, e.detail === 0)
  })

  // rows: hover (mouse) slides the pill; hold (touch) arms it and it follows the finger
  list.addEventListener('pointermove', (e) => {
    if (!st.open) return
    if (e.pointerType === 'mouse' || st.armed >= 0) {
      const i = rowIndexAt(e.clientX, e.clientY)
      if (i >= 0 && i !== st.hover) {
        st.hover = i
        movePill(i)
        if (st.armed >= 0) st.armed = i
        pump.wake()
      }
    }
  })
  let rowHold = 0
  list.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return
    const i = rowIndexAt(e.clientX, e.clientY)
    const startTop = scroller.scrollTop
    clearTimeout(rowHold)
    rowHold = window.setTimeout(() => {
      if (Math.abs(scroller.scrollTop - startTop) <= 6 && i >= 0) {
        st.armed = i
        movePill(i)
        pump.wake()
      }
    }, C.holdToOpenMs)
  })
  list.addEventListener('pointerup', () => clearTimeout(rowHold))
  list.addEventListener('pointercancel', () => {
    clearTimeout(rowHold)
    st.armed = -1
  })
  list.addEventListener('click', (e) => {
    const el = (e.target as Element).closest('.post-contents-row')
    const i = rows.findIndex((r) => r.el === el)
    if (i < 0) return
    e.preventDefault()
    choose(i)
  })
  scroller.addEventListener('scroll', () => pump.wake(), { passive: true })

  scrim.addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.open) setOpen(false)
  })
  window.addEventListener(
    'scroll',
    () => {
      if (st.open && performance.now() > st.navigatingUntil && !st.pointer) setOpen(false)
      pump.wake()
    },
    { passive: true },
  )

  // ---------------------------------------------------------------- frame
  const frameFor = (): { uniforms: Uniforms; frost: FrostRegion | null } => {
    const th = isDark() ? THEMES.dark : THEMES.light
    const b = geo.button
    const p = geo.panel
    const ov = open.value
    const oc = clamp(ov, 0, 1)
    const opening = st.open

    // button: shrinks and travels 25% toward the panel's center
    const bcx = b.x + b.w / 2
    const bcy = b.y + b.h / 2
    const pcxRest = p.x + p.w / 2
    const pcyRest = p.y + p.h / 2
    const bScale = (1 + (C.pressScale - 1) * press.value) * lerp(1, C.motion.endScale, oc)
    const tv = travel.value * C.motion.travelShare
    const btn = [lerp(bcx, pcxRest, tv), lerp(bcy, pcyRest, tv)]

    // panel: an 18 pt seed at the button's center → the full panel
    const showPanel = ov > 0.002
    const pw = lerp(C.panel.seed, p.w, Math.max(ov, 0))
    const ph = pw * lerp(1, p.h / p.w, oc)
    const pcx = lerp(bcx, pcxRest, oc)
    const pcy = lerp(bcy, pcyRest, oc) + kick.value
    const corner = Math.min(C.panel.corner, pw / 2, ph / 2)

    // content
    const cAlpha = opening ? oc : clamp((ov - C.motion.closeGoneBelow) / (1 - C.motion.closeGoneBelow), 0, 1)
    const cScale = opening ? contentScale.value : 1 + C.motion.closeScalePerLost * (1 - oc)
    const blur = C.motion.contentBlur * (1 - oc)
    const lod = blur > 0.05 ? Math.max(0, Math.log2(blur * dpr())) : 0

    // track (dissolves as the menu opens)
    const t = geo.track
    const progress = geo.articleHeight - geo.vh <= 0 ? 1 : clamp((st.scrollY - geo.articleTop) / (geo.articleHeight - geo.vh), 0, 1)
    const grooveW = Math.max(0, t.w - C.track.groove.inline * 2)
    const grooveL = t.x + t.w / 2 - grooveW / 2
    const tAlpha = 1 - smoothstep(C.dissolve.fadeStart, C.dissolve.fadeGone, oc)
    const tBlurShare = smoothstep(0, C.dissolve.blurFull, oc)

    const so = C.shadowClosed
    const shadow = [lerp(so.opacity, th.shadowOpen, oc), lerp(so.sigma, C.shadowOpen.sigma, oc), lerp(so.offset, C.shadowOpen.offset, oc)]

    const ground = geo.ground
    const pillRow = { cy: pillY.value, h: pillH.value }

    const uniforms: Uniforms = {
      ...th.finish,
      dark: isDark() ? 1 : 0,
      scroll: [window.scrollX, st.scrollY],
      ground: [ground[0], ground[1], ground[2]],
      bezel: 15,
      edgeScale: 2 / 3,
      edgeFalloff: 2.5,
      aberration: 0.22,
      trackCenter: [t.x + t.w / 2, t.y + t.h / 2],
      trackSize: [t.w, t.h],
      trackCorner: C.track.corner,
      trackAlpha: tAlpha,
      trackSoft: C.dissolve.blurRadius * tBlurShare,
      trackBend: 1 - tBlurShare,
      groove: [t.x + t.w / 2, t.y + t.h / 2, grooveW / 2, C.track.groove.height / 2],
      fillEnd: grooveL + grooveW * Math.max(progress, C.track.minimumFill),
      fillColor: th.fill,
      grooveColor: th.groove,
      trackShadow: [so.opacity, so.sigma, so.offset],
      panelCenter: [pcx, pcy],
      panelSize: showPanel ? [pw, ph] : [0, 0],
      panelCorner: corner,
      buttonCenter: btn,
      buttonRadius: (C.button / 2) * bScale,
      mergeRadius: C.mergeRadius,
      bodyAlpha: 1,
      bodyShadow: shadow,
      veilColor: th.veil,
      veilAmount: th.veilAmount,
      saturation: th.saturation,
      contentAnchor: [pcx, pcy - ph / 2],
      contentRestAnchor: [p.w / 2, 0],
      contentScale: cScale,
      contentAlpha: showPanel ? cAlpha : 0,
      contentLod: lod,
      contentScroll: st.listScroll,
      inkColor: th.ink,
      lineColor: th.line,
      pillRect: [p.w / 2, pillRow.cy, p.w / 2 - 10, pillRow.h / 2],
      pillAlpha: pillAlpha.value,
      pillColor: th.pill,
      iconAlpha: 1 - oc,
      iconScale: bScale,
      iconColor: th.ink,
    }

    // frost: bounding box of button ⊕ panel + 3σ
    const r = (C.button / 2) * bScale
    let x0 = btn[0] - r
    let y0 = btn[1] - r
    let x1 = btn[0] + r
    let y1 = btn[1] + r
    if (showPanel) {
      x0 = Math.min(x0, pcx - pw / 2)
      y0 = Math.min(y0, pcy - ph / 2)
      x1 = Math.max(x1, pcx + pw / 2)
      y1 = Math.max(y1, pcy + ph / 2)
    }
    const m = th.sigma * 3 + 16
    const frost: FrostRegion = { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m, sigma: th.sigma, cell: C.frostCell, gamma: 1 }
    return { uniforms, frost }
  }

  const client = {
    tick(now: number) {
      const dt = clamp((now - st.last) / 1000, 0, 3 / 120)
      st.last = now
      let dirty = false
      const sy = window.scrollY
      if (sy !== st.scrollY) {
        st.scrollY = sy
        st.scrollChangedAt = now
        dirty = true
      }
      const ls = scroller.scrollTop
      if (ls !== st.listScroll) {
        st.listScroll = ls
        st.scrollChangedAt = now
        dirty = true
      }
      if (labelsDirty && surface.ready) {
        rasterLabels()
        dirty = true
      }
      let animating = false
      for (const s of springs) animating = s.step(dt) || animating
      if ((dirty || animating || st.lastPayload === '') && surface.canSend(now)) {
        const { uniforms, frost } = frameFor()
        const payload = JSON.stringify(uniforms) + JSON.stringify(frost)
        if (payload !== st.lastPayload) {
          st.lastPayload = payload
          surface.frame(uniforms, frost, st.scrollY)
        }
      }
      return animating || now - st.scrollChangedAt < C.settleMs || st.pointer !== null
    },
  }

  layout()
  pump.add(client)

  return {
    layout: () => {
      layout()
      st.lastPayload = ''
      pump.wake()
    },
    get canvasHeight() {
      return geo.canvasH
    },
    invalidate: () => {
      st.lastPayload = ''
      pump.wake()
    },
  }
}

const tm = document.createElement('canvas').getContext('2d')!
const textMetrics = (font: string) => {
  tm.font = font
  const m = tm.measureText('Hg')
  return { asc: m.fontBoundingBoxAscent, desc: m.fontBoundingBoxDescent }
}
