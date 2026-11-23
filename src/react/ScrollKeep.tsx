'use client'
// <ScrollKeep />: keeps iOS Safari reporting fresh scroll positions while the
// URL bar collapses or expands (otherwise window.scrollY updates drop to ~10 Hz
// during that animation, per the original author's measurements).
//
// How: a 1 px element runs a scroll-driven animation (animation-timeline:
// scroll(root)) on outline-color, between two transparent colors. The property
// can't be animated by the compositor alone, so WebKit has to keep sending the
// page the scroll position every frame. Nothing is visible.
//
// Mount it once, near the root, on pages that react to the page's own scroll
// (reading progress, collapsing headers, scroll-linked charts). Browsers without
// scroll-driven animations simply ignore it.

import { injectStyle } from './internal'

const CSS = `
.scroll-keep{position:fixed;top:0;left:0;width:1px;height:1px;pointer-events:none;contain:strict;animation:scroll-keep-fresh linear both;animation-timeline:scroll(root)}
@keyframes scroll-keep-fresh{from{outline-color:#0000}to{outline-color:#0000}}
`

export function ScrollKeep() {
  injectStyle('scroll-keep-style', CSS)
  return <div className="scroll-keep" aria-hidden="true" />
}
