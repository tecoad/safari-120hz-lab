import { useEffect, useMemo, useRef, useState } from 'react'
import { InputMeter, ScrollKeep, ScrollPad, SwipeableSheet, useDisplayBoost, useSpring, useWorkerCanvas } from '../../react'
import type { ChartFrame } from './chart.worker'

// A deterministic, price-like series between 5 and 95 (%).
function makeSeries(n: number) {
  let v = 42
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  return Array.from({ length: n }, () => (v = Math.max(5, Math.min(95, v + rand() * 4 + (50 - v) * 0.02))))
}

const STEP = 7 // finger travel (CSS px) per data point

function useDark() {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const q = matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent) => setDark(e.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return dark
}

/** Chart scrubbing: native momentum + snap to data points, drawn in a worker. */
function PriceScrubber() {
  const points = useMemo(() => makeSeries(120), [])
  const dark = useDark()
  const chart = useWorkerCanvas<ChartFrame>(() => new Worker(new URL('./chart.worker.ts', import.meta.url), { type: 'module' }))
  const index = useRef(points.length - 1)
  const base = useRef(index.current)
  const [settled, setSettled] = useState(points.length - 1)
  const scrollerRef = useRef<HTMLDivElement>(null)

  const draw = (i: number | null) => chart.post({ points, index: i, dark })
  useEffect(() => {
    if (chart.ready) draw(index.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.ready, dark])

  const clampIndex = (i: number) => Math.max(0, Math.min(points.length - 1, i))

  return (
    <div className="space-y-3">
      <ScrollPad
        axis="x"
        snap={STEP}
        momentum
        scrollerRef={scrollerRef}
        aria-label="Scrub the chart"
        className="h-56 rounded-2xl border border-(--color-line)"
        onPressStart={() => (base.current = index.current)}
        onMove={({ dx }) => {
          index.current = clampIndex(base.current + dx / STEP)
          draw(index.current)
        }}
        onSettle={() => {
          index.current = clampIndex(Math.round(index.current))
          draw(index.current)
          setSettled(index.current)
        }}
      >
        <div ref={chart.ref} className="absolute inset-0" />
      </ScrollPad>
      <p className="text-[13px] text-(--color-muted)">
        Drag or flick across the chart. The fling uses the browser’s own momentum and lands on a data point through scroll
        snapping. Settled on point {settled + 1} of {points.length} · worker {chart.stats.fps} fps
        {chart.supported ? '' : ' · OffscreenCanvas unavailable'}
      </p>
      <InputMeter source={scrollerRef} />
    </div>
  )
}

/** An amount picker: a ScrollPad with a snap every 8 px = one unit. */
function AmountPicker() {
  const [amount, setAmount] = useState(25)
  const base = useRef(amount)
  const live = useRef<HTMLSpanElement>(null)
  const pop = useSpring(1, { dampingRatio: 0.55, response: 0.3 }, (s) => {
    if (live.current) live.current.style.transform = `scale(${s})`
  })
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-(--color-muted)">Amount</span>
        <span ref={live} className="inline-block text-[28px] font-semibold tabular-nums">
          ${amount}
        </span>
      </div>
      <ScrollPad
        axis="x"
        snap={8}
        momentum
        aria-label="Amount"
        className="h-12 rounded-xl bg-[repeating-linear-gradient(90deg,var(--color-line)_0_1px,transparent_1px_8px)]"
        onPressStart={() => (base.current = amount)}
        onMove={({ dx }) => {
          const next = Math.max(1, Math.min(500, Math.round(base.current - dx / 8)))
          if (next !== amount) setAmount(next)
        }}
        onSettle={() => {
          pop.jump(1.12)
          pop.to(1)
        }}
      />
    </div>
  )
}

export function ComponentsDemo() {
  useDisplayBoost()
  const [open, setOpen] = useState(false)
  return (
    <main className="prose-probe mx-auto w-full max-w-[640px] space-y-10 px-5 pt-16 pb-40">
      <ScrollKeep />
      <header>
        <p className="mb-3 text-[13px] font-medium tracking-wide text-(--color-muted) uppercase">safari-120hz-lab · React</p>
        <h1>Reusable pieces, as React components</h1>
        <p className="text-[15px] text-(--color-muted)">
          Each block below uses the components in <code>src/react/</code>. See <code>docs/FINDINGS.md</code> for the reasoning,
          the validation and where each one pays off. <a href="/">Back to the glass demo</a>.
        </p>
      </header>

      <section className="space-y-4">
        <h2>Scroll as input: scrubbing a chart</h2>
        <PriceScrubber />
      </section>

      <section className="space-y-4">
        <h2>Measure your input</h2>
        <InputMeter />
        <InputMeter precise />
      </section>

      <section className="space-y-4">
        <h2>A sheet that is just a scroll view</h2>
        <p>
          The sheet below uses no touch handlers: swiping is scrolling, so momentum, rubber banding and snapping come from the
          browser. It rests at 280 px or fully open, and swiping it off closes it.
        </p>
        <button
          type="button"
          className="rounded-full bg-(--color-ink) px-5 py-2.5 text-[15px] font-medium text-(--color-page)"
          onClick={() => setOpen(true)}
        >
          Open the sheet
        </button>
      </section>

      <SwipeableSheet isOpen={open} onOpenChange={setOpen} detents={[280]} aria-labelledby="sheet-title">
        <div className="space-y-6 px-5 pt-2 pb-8">
          <div className="flex items-center justify-between">
            <h2 id="sheet-title" className="m-0 text-[19px] font-semibold">
              Details
            </h2>
            <button type="button" className="text-[15px] text-(--color-accent)" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
          <AmountPicker />
          <label className="block space-y-1">
            <span className="text-[13px] text-(--color-muted)">Note (tests the software keyboard)</span>
            <input className="w-full rounded-lg border border-(--color-line) bg-transparent px-3 py-2 text-[16px]" placeholder="Type here" />
          </label>
          <ul className="m-0 list-none space-y-0 p-0">
            {Array.from({ length: 24 }, (_, i) => (
              <li key={i} className="border-b border-(--color-line) py-3 text-[15px]">
                Row {i + 1}: content scrolls only once the sheet is fully open
              </li>
            ))}
          </ul>
        </div>
      </SwipeableSheet>
    </main>
  )
}
