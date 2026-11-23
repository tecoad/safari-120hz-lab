'use client'
// <SwipeableSheet>: a bottom sheet driven entirely by native scrolling.
//
// Technique: React Aria's "Scrolling is All You Need: Building a Swipeable
// Sheet" (https://react-aria.adobe.com/blog/sheet). The swipe IS a scroll, so the
// browser owns the gesture physics (momentum, rubber band, snapping) and runs it
// off the main thread; JavaScript only reacts to where the scroll ended up.
// This file is an independent, minimal implementation written for study. For
// production, prefer React Aria's own Sheet (react-aria-components).
//
// Geometry (vertical):
//   scroller (fixed, full screen, scroll-snap-type: y mandatory)
//   ├─ spacer: 100dvh tall, snap-align start  → scrollTop 0 = sheet hidden (closed)
//   └─ sheet: snap-align end                  → scrollTop max = sheet fully visible
//        └─ 1 px markers at `top: h` with scroll-margin-top: 100dvh
//                                             → snap at scrollTop h = h px visible (detents)
// The visible height of the sheet is always equal to scrollTop.
//
// - Backdrop dimming follows the scroll through a CSS scroll-driven animation
//   (named scroll-timeline), with a JS fallback where unsupported.
// - Dismissal: an IntersectionObserver notices the sheet left the screen.
// - Content only scrolls when the sheet is fully open; until then every swipe
//   moves the sheet. With overscroll-behavior: auto on the content, a downward
//   swipe at the top of the content chains into the outer scroller (dismiss).
// - Software keyboard: bottom padding of 100dvh − visualViewport.height so the
//   last fields stay reachable behind the keyboard (same idea as React Aria).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { injectStyle, prefersReducedMotion, useLatest } from './internal'

export interface SwipeableSheetProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** Visible heights (CSS px) the sheet can rest at, besides fully open. */
  detents?: number[]
  /** Detent to open at. Defaults to the smallest detent, or fully open. */
  initialDetent?: number
  /** When false, swiping can move between detents but can't close the sheet. */
  dismissible?: boolean
  /** Backdrop opacity when fully open. */
  dim?: number
  'aria-label'?: string
  'aria-labelledby'?: string
  className?: string
  children: ReactNode
}

const SHEET_CSS = `
.ss-root{position:fixed;inset:0;z-index:60;timeline-scope:--ss-scroll}
.ss-backdrop{position:absolute;inset:0;background:#000;opacity:0;pointer-events:none}
@supports (animation-timeline: scroll()){
  .ss-backdrop{animation:ss-dim linear both;animation-timeline:--ss-scroll}
}
@keyframes ss-dim{from{opacity:0}to{opacity:var(--ss-dim,.4)}}
.ss-scroller{position:absolute;inset:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scroll-snap-type:y mandatory;scrollbar-width:none;scroll-timeline:--ss-scroll y;outline:none}
.ss-scroller::-webkit-scrollbar{display:none}
.ss-spacer{height:100dvh}
.ss-spacer[data-dismissible]{scroll-snap-align:start}
.ss-sheet{position:relative;display:flex;flex-direction:column;max-height:calc(100dvh - 24px);border-radius:18px 18px 0 0;background:Canvas;color:CanvasText;box-shadow:0 -1px 0 rgb(127 127 127/.15),0 -12px 40px rgb(0 0 0/.18);scroll-snap-align:end;outline:none}
.ss-marker{position:absolute;left:0;width:1px;height:1px;pointer-events:none;scroll-snap-align:start;scroll-margin-top:100dvh}
.ss-grabber{flex:none;align-self:center;width:36px;height:5px;margin:8px 0 4px;border-radius:3px;background:rgb(127 127 127/.45)}
.ss-content{flex:1;min-height:0;overflow-y:hidden;overscroll-behavior:auto;padding-bottom:calc(100dvh - var(--ss-vvh,100dvh))}
.ss-content[data-scroll]{overflow-y:auto}
`

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function SwipeableSheet(props: SwipeableSheetProps) {
  const { isOpen, onOpenChange, detents = [], initialDetent, dismissible = true, dim = 0.4, className, children } = props
  injectStyle('swipeable-sheet-style', SHEET_CSS)
  const [mounted, setMounted] = useState(isOpen)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const openChange = useLatest(onOpenChange)
  const state = useRef({ shown: false, closing: false, restoreFocus: null as HTMLElement | null })

  if (isOpen && !mounted) setMounted(true)

  const behavior = (): ScrollBehavior => (prefersReducedMotion() ? 'instant' : 'smooth')

  const requestClose = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !dismissible) return
    state.current.closing = true
    scroller.scrollTo({ top: 0, behavior: behavior() })
  }, [dismissible])

  // parent closed it: animate out first, then unmount
  useEffect(() => {
    if (!isOpen && mounted) {
      if (state.current.shown && scrollerRef.current && scrollerRef.current.scrollTop > 1) requestCloseInternal()
      else setMounted(false)
    }
    function requestCloseInternal() {
      state.current.closing = true
      scrollerRef.current!.scrollTo({ top: 0, behavior: behavior() })
    }
  }, [isOpen, mounted])

  // open: start closed (scrollTop 0), then scroll to the first detent
  useEffect(() => {
    if (!mounted) return
    const root = rootRef.current!
    const scroller = scrollerRef.current!
    const sheet = sheetRef.current!
    const content = contentRef.current!
    const st = state.current
    st.shown = false
    st.closing = false
    st.restoreFocus = document.activeElement as HTMLElement | null

    // the rest of the page is inert while the sheet is up
    const siblings = [...document.body.children].filter((el) => el !== root.parentElement && !el.contains(root)) as HTMLElement[]
    const wasInert = siblings.map((el) => el.inert)
    siblings.forEach((el) => (el.inert = true))

    scroller.scrollTop = 0
    const max = () => scroller.scrollHeight - scroller.clientHeight
    const target = initialDetent ?? (detents.length ? Math.min(...detents) : Infinity)
    const raf = requestAnimationFrame(() => {
      scroller.scrollTo({ top: Math.min(target, max()), behavior: behavior() })
      const first = sheet.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? sheet).focus({ preventScroll: true })
    })

    // dismissal: the sheet left the screen after having been on it
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          st.shown = true
          return
        }
        if (st.shown && (dismissible || st.closing)) {
          st.shown = false
          setMounted(false)
          openChange.current(false)
        }
      },
      // shrink the root by 1 px: at scrollTop 0 the sheet's top edge touches the
      // root's bottom edge, and an edge-adjacent target still counts as intersecting
      { root: scroller, threshold: 0, rootMargin: '0px 0px -1px 0px' },
    )
    io.observe(sheet)

    // content scrolls only when fully open; JS fallback for the backdrop
    const timelines = typeof CSS !== 'undefined' && CSS.supports?.('animation-timeline: scroll()')
    const onScroll = () => {
      const m = max()
      const full = scroller.scrollTop >= m - 1
      if (full) content.dataset.scroll = ''
      else delete content.dataset.scroll
      if (!timelines && backdropRef.current) backdropRef.current.style.opacity = String(m > 0 ? (dim * scroller.scrollTop) / m : 0)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })

    // software keyboard: track the visual viewport height
    const vv = window.visualViewport
    const onViewport = () => root.style.setProperty('--ss-vvh', `${vv?.height ?? window.innerHeight}px`)
    onViewport()
    vv?.addEventListener('resize', onViewport)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        requestClose()
      } else if (e.key === 'Tab') {
        // keep focus inside the sheet
        const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)]
        if (!items.length) return e.preventDefault()
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    root.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      vv?.removeEventListener('resize', onViewport)
      root.removeEventListener('keydown', onKey)
      siblings.forEach((el, i) => (el.inert = wasInert[i]))
      st.restoreFocus?.focus?.({ preventScroll: true })
    }
    // detents/initialDetent are read once per open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted])

  if (!mounted || typeof document === 'undefined') return null

  return createPortal(
    <div className="ss-root" ref={rootRef} style={{ ['--ss-dim' as string]: dim }}>
      <div className="ss-backdrop" ref={backdropRef} />
      <div className="ss-scroller" ref={scrollerRef} tabIndex={-1}>
        <div className="ss-spacer" data-dismissible={dismissible ? '' : undefined} onClick={requestClose} />
        <div
          className={className ? `ss-sheet ${className}` : 'ss-sheet'}
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label={props['aria-label']}
          aria-labelledby={props['aria-labelledby']}
          tabIndex={-1}
        >
          {detents.map((h) => (
            <div key={h} className="ss-marker" style={{ top: h }} aria-hidden="true" />
          ))}
          <div className="ss-grabber" aria-hidden="true" />
          <div className="ss-content" ref={contentRef}>
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
