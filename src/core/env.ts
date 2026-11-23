// Environment detection. `'GestureEvent' in window` is the "this is
// WebKit/Safari" signal: only Safari exposes GestureEvent.
export const isSafariEngine = typeof window !== 'undefined' && 'GestureEvent' in window

export const isIOS =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

export const isIOSSafari = isIOS && isSafariEngine

// Lazy media queries: importing this module must not touch `window`, so the
// React components stay safe to import during server-side rendering.
const query = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null)

export const prefersReducedMotion = () => query('(prefers-reduced-motion: reduce)')?.matches ?? false
export const isDark = () => query('(prefers-color-scheme: dark)')?.matches ?? false
export const onThemeChange = (fn: (dark: boolean) => void) =>
  query('(prefers-color-scheme: dark)')?.addEventListener('change', (e) => fn(e.matches))

export const dpr = () => (typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3))

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** iOS rubber band: (1 − 1/(d·k/L + 1))·L, saturating at L. */
export const rubberBand = (d: number, limit: number, k: number) => {
  const s = Math.sign(d)
  const a = Math.abs(d)
  return s * (1 - 1 / ((a * k) / limit + 1)) * limit
}

/** Parses "rgb(…)/rgba(…)" into [r,g,b,a] in 0..1. */
export const parseColor = (css: string): [number, number, number, number] => {
  const m = css.match(/rgba?\(([^)]+)\)/)
  if (!m) return [0, 0, 0, 0]
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
  const [r = 0, g = 0, b = 0, a = 1] = parts
  return [r / 255, g / 255, b / 255, a]
}
