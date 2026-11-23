// DOM "re-render": walks the page and builds a draw list (words with baseline
// positions + background/border rectangles). The worker rasterizes that list so
// it has, as a texture, what is behind the glass: a page can't read its own
// pixels.

import { parseColor } from '../core/env'
import type { DisplayItem } from './protocol'

const measure = document.createElement('canvas').getContext('2d')!
const metricsCache = new Map<string, { asc: number; desc: number }>()

function metrics(font: string) {
  let m = metricsCache.get(font)
  if (!m) {
    measure.font = font
    const t = measure.measureText('Hg')
    m = { asc: t.fontBoundingBoxAscent, desc: t.fontBoundingBoxDescent }
    metricsCache.set(font, m)
  }
  return m
}

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const

export function snapshotPage(root: HTMLElement) {
  const sx = window.scrollX
  const sy = window.scrollY
  const items: DisplayItem[] = []
  const range = document.createRange()

  const pushText = (node: Text, cs: CSSStyleDeclaration) => {
    const color = cs.color
    if (parseColor(color)[3] < 0.02) return
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const { asc, desc } = metrics(font)
    const upper = cs.textTransform === 'uppercase'
    const data = node.data
    const re = /\S+/g
    let m: RegExpExecArray | null
    const add = (text: string, r: DOMRect) => {
      if (r.width === 0 || r.height === 0) return
      const top = r.top + sy
      const baseline = top + (r.height - (asc + desc)) / 2 + asc
      items.push({ k: 1, x: r.left + sx, y: baseline, top, bottom: top + r.height, t: upper ? text.toUpperCase() : text, f: font, c: color })
    }
    while ((m = re.exec(data))) {
      range.setStart(node, m.index)
      range.setEnd(node, m.index + m[0].length)
      const rects = range.getClientRects()
      if (rects.length === 1) {
        add(m[0], rects[0])
      } else if (rects.length > 1) {
        // word broken across lines: fall back to one character at a time
        for (let i = 0; i < m[0].length; i++) {
          range.setStart(node, m.index + i)
          range.setEnd(node, m.index + i + 1)
          const r = range.getBoundingClientRect()
          add(m[0][i], r)
        }
      }
    }
  }

  const walk = (el: Element) => {
    if (el instanceof HTMLElement && el.dataset.glassSkip !== undefined) return
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return

    const bg = cs.backgroundColor
    if (parseColor(bg)[3] > 0.01) {
      const rects = cs.display === 'inline' ? Array.from(el.getClientRects()) : [el.getBoundingClientRect()]
      const radius = parseFloat(cs.borderTopLeftRadius) || 0
      for (const r of rects) items.push({ k: 0, x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, r: radius, c: bg })
    }

    if (cs.display !== 'inline') {
      const r = el.getBoundingClientRect()
      for (const side of SIDES) {
        const w = parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0
        const style = cs.getPropertyValue(`border-${side.toLowerCase()}-style`)
        const c = cs.getPropertyValue(`border-${side.toLowerCase()}-color`)
        if (w <= 0 || style === 'none' || parseColor(c)[3] < 0.02) continue
        const x = r.left + sx
        const y = r.top + sy
        if (side === 'Top') items.push({ k: 0, x, y, w: r.width, h: w, r: 0, c })
        if (side === 'Bottom') items.push({ k: 0, x, y: y + r.height - w, w: r.width, h: w, r: 0, c })
        if (side === 'Left') items.push({ k: 0, x, y, w, h: r.height, r: 0, c })
        if (side === 'Right') items.push({ k: 0, x: x + r.width - w, y, w, h: r.height, r: 0, c })
      }
    }

    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) pushText(child as Text, cs)
      else if (child.nodeType === Node.ELEMENT_NODE) walk(child as Element)
    }
  }

  walk(root)
  range.detach()
  const ground = getComputedStyle(document.body).backgroundColor
  return {
    items,
    docWidth: document.documentElement.clientWidth,
    docHeight: document.documentElement.scrollHeight,
    ground,
  }
}
