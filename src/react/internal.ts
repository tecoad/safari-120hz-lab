// Small shared helpers for the React components.
import { useEffect, useLayoutEffect, useRef } from 'react'

/** useLayoutEffect on the client, useEffect on the server (no SSR warning). */
export const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** Keeps a ref pointing at the latest value, so effects can call fresh callbacks
 *  without re-subscribing on every render. */
export function useLatest<T>(value: T) {
  const ref = useRef(value)
  useIsoLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

/** Injects a <style> block once per id (components stay self-contained). */
export function injectStyle(id: string, css: string) {
  if (typeof document === 'undefined' || document.getElementById(id)) return
  const el = document.createElement('style')
  el.id = id
  el.textContent = css
  document.head.append(el)
}

export const devicePixelRatioCapped = () => (typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3))

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
