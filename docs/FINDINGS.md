# Findings: native-feel web UI at 120 Hz

Lab notes on making web UI feel native at 120 Hz on iOS Safari: each technique tried in this repo, how it was checked,
and the React component it became. The core 60 FPS workaround builds on the approach as written
[here](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit) (cited below as “the write-up”), and the sheet follows
React Aria’s [scroll-snap technique](https://react-aria.adobe.com/blog/sheet).

This document is meant to be read by people and by coding agents. Every finding has the same shape:

1. **Problem**: what goes wrong without it.
2. **Mechanism**: why the technique works.
3. **Evidence**: where each claim comes from, with a validation tag (below).
4. **Code**: where it lives in this repo, and the React component or hook that packages it.
5. **Gotchas**.
6. **Applicability**: what kinds of interfaces it helps.
7. **Where I’d explore it**: concrete experiments for a product with live prices, charts, trade tickets and
   mobile-first flows.

## Validation tags

| Tag | Meaning |
|---|---|
| **[Measured · write-up]** | Measured on an iPhone 18 Pro and reported in the write-up (filmed at 240 fps and played at 1/8 speed, or counted with its readout). Not re-measured here yet. |
| **[Verified · here]** | Built in this repo and checked in Chromium with a phone-sized viewport (rendering, logic, event flow). Not a device measurement. |
| **[Spec]** | Backed by a specification or vendor documentation (linked). |
| **[Undocumented]** | Works today because of an implementation detail in WebKit. Could change without notice. |
| **[Needs device check]** | Plausible and implemented, but nobody has measured it on a real iPhone in this repo yet. The meters on the demo pages exist to close exactly this gap. |

## Contents

- [TL;DR](#tldr)
- [How to try everything](#how-to-try-everything)
- [The mental model: two exits from the 60 Hz main thread](#the-mental-model-two-exits-from-the-60-hz-main-thread)
- Input
  - [F1. Native scrolling as an input sensor](#f1-native-scrolling-as-an-input-sensor)
  - [F2. Sub-point precision with DPR-scaled scrollers](#f2-sub-point-precision-with-dpr-scaled-scrollers)
  - [F3. A high-frequency sampling loop](#f3-a-high-frequency-sampling-loop)
  - [F4. The empty rAF loop that unlocks more scroll positions](#f4-the-empty-raf-loop-that-unlocks-more-scroll-positions)
  - [F5. Keeping ProMotion at 120 Hz](#f5-keeping-promotion-at-120-hz)
  - [F6. Avoiding the 10 Hz throttle while the URL bar resizes](#f6-avoiding-the-10-hz-throttle-while-the-url-bar-resizes)
- Output
  - [F7. Rendering from a worker with OffscreenCanvas](#f7-rendering-from-a-worker-with-offscreencanvas)
  - [F8. Live sources: compositing one canvas into another](#f8-live-sources-compositing-one-canvas-into-another)
  - [F9. The page as a texture (DOM re-render)](#f9-the-page-as-a-texture-dom-re-render)
  - [F10. Glass shader techniques](#f10-glass-shader-techniques)
- Motion
  - [F11. Springs in (dampingRatio, response), with measured constants](#f11-springs-in-dampingratio-response-with-measured-constants)
  - [F12. State machines fed by timestamped events](#f12-state-machines-fed-by-timestamped-events)
  - [F13. Swipeable sheets that are just scroll views](#f13-swipeable-sheets-that-are-just-scroll-views)
- Foundations
  - [F14. An accessible DOM layer under canvas UI](#f14-an-accessible-dom-layer-under-canvas-ui)
  - [F15. Measure it: the input meter and the 240 fps method](#f15-measure-it-the-input-meter-and-the-240-fps-method)
- [Browser support](#browser-support)
- [Adoption playbook](#adoption-playbook)
- [Where I’d start on a live-markets product](#where-id-start-on-a-live-markets-product)
- [React components reference](#react-components-reference)
- [References](#references)

---

## TL;DR

| # | Finding | What it buys you | Risk | Package in this repo |
|---|---|---|---|---|
| F1 | Native scrolling as an input sensor | 120 Hz input on iOS, plus momentum, rubber band and snapping for free | Low | `<ScrollPad>` |
| F2 | DPR-scaled scrollers | Sub-point precision (1 physical px per scroll unit) | Low | `<ScrollPad precise>` |
| F3 | High-frequency sampling loop | 80–90 scroll readings/s instead of 5–26 scroll events/s on iOS | Medium | `useScrollSampler` |
| F4 | Empty rAF loop | ~12.5% more readings on iOS Safari | Medium | built into `useScrollSampler` |
| F5 | ProMotion keep-alive | Display stays at 120 Hz during gestures | High (battery, undocumented) | `useDisplayBoost` |
| F6 | URL-bar anti-throttle | No 10 Hz drop in `window.scrollY` while the URL bar resizes | Low | `<ScrollKeep />` |
| F7 | OffscreenCanvas in a worker | Rendering off the main thread everywhere; 120 fps presentation on iOS | Low off-main-thread, high for the 120 fps part | `useWorkerCanvas` + `defineCanvasWorker` |
| F8 | Live sources | One canvas can show another canvas’s pixels | Medium | glass worker (`feed`, `connectPort`) |
| F9 | Page as a texture | Effects that need what is behind them (glass, magnifiers) | High (fragile) | glass worker (`Ring`) |
| F10 | Glass shader techniques | SDF shapes, fusion, refraction, frost, finish | Low (GPU cost) | `src/glass/shaders.ts` |
| F11 | Springs (ζ, response) + measured constants | iOS-like motion with a vocabulary designers already use | None | `useSpring` |
| F12 | Event-driven state machines | Gestures that are predictable, testable and feel native | None | pattern (`src/dock/dock.ts`) |
| F13 | Sheets as scroll views | Drag, fling, detents and dismissal with native physics | Low | `<SwipeableSheet>` |
| F14 | Accessible DOM layer | Canvas UI that keyboards and screen readers can use | None | pattern (`src/chrome/contents.ts`) |
| F15 | Input meter + 240 fps method | Proof on the device instead of guesses | None | `<InputMeter>` |

The two techniques with the best ratio of value to risk are **F1 (scroll as input)** and **F7 (worker rendering)**.
They help on every browser, and iOS Safari gets the 120 Hz bonus on top.

## How to try everything

```bash
bun install
bun dev
```

- `/` is the glass demo: reading-progress indicator, contents menu, tab bar, two controller meters.
- `/components` is the React components demo: chart scrubbing with native momentum, input meters, a swipeable sheet
  with an amount picker inside.
- It is a single-page React app on Vite: one `index.html`, routes in [`src/main.tsx`](../src/main.tsx). The glass demo
  renders its markup with React ([`GlassDemo.tsx`](../src/demos/glass/GlassDemo.tsx)) and hands the DOM to the
  plain-TypeScript engine ([`boot.ts`](../src/demos/glass/boot.ts)).
- On an iPhone, open the network URL that Vite prints (same Wi-Fi). WebGL2 in a worker needs iOS 17 or later.
- The bottom-left HUD on `/` shows scroll readings per second and glass frames per second.

---

## The mental model: two exits from the 60 Hz main thread

**Problem.** On 120 Hz iPhones, Safari keeps websites at 60 Hz by default: `requestAnimationFrame` fires 60 times per
second, touch and pointer events arrive at 60 Hz, and the DOM is painted 60 times per second. Drags feel heavier than in
native apps. **[Measured · write-up]**
([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#why-the-ios-safari-experience-sucks))

The cap is a WebKit preference, `PreferPageRenderingUpdatesNear60FPSEnabled`, shown in Safari as **“Prefer Page Rendering
Updates near 60fps”** (Settings > Apps > Safari > Advanced > Feature Flags). **[Spec]**
- It was turned on by default in April 2021, citing web compatibility and power
  ([WebKit bug 224133](https://bugs.webkit.org/show_bug.cgi?id=224133)), and marked stable in 2023
  ([bug 263799](https://bugs.webkit.org/show_bug.cgi?id=263799)); it is on everywhere except visionOS
  ([preferences file](https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml)).
- On iOS the display link that drives page rendering is held at 60 fps while the flag is on; WebKit’s own testing notes
  rAF at 60 fps with it on, 120 fps with it off, and about 30 fps in Low Power Mode
  ([bug 304358](https://bugs.webkit.org/show_bug.cgi?id=304358)).
- Until May 2024, turning the flag off didn’t even help on ProMotion iPhones
  ([bug 272165](https://bugs.webkit.org/show_bug.cgi?id=272165)). Apps embedding `WKWebView` have no supported way to get
  120 Hz yet, and Home Screen web apps also run at 60 fps by default
  ([bug 294338](https://bugs.webkit.org/show_bug.cgi?id=294338), open).
- Core Animation-driven CSS animations have been allowed to request higher frame rates on iOS since January 2024
  ([bug 267541](https://bugs.webkit.org/show_bug.cgi?id=267541)), which is consistent with the “rate mark” trick in F5.

Users can’t be asked to flip a feature flag, so the rest of this document works with the default.

**Mechanism.** The cap applies to the page’s main-thread rendering loop. Two things don’t go through it:

1. **Native scrolling.** iOS scrolls in the compositor, at the display’s refresh rate, with momentum, rubber banding and
   snapping, without JavaScript. If the finger drives a scroller, the scroller’s position is a 120 Hz signal.
2. **OffscreenCanvas frames.** When a canvas is handed to a worker with `transferControlToOffscreen()`, WebKit presents
   the frames the worker produces without waiting for the page’s next rendering update.

Everything in this repo is a way to route input through exit 1 and output through exit 2, plus the small hacks that keep
those exits wide open. Keep this split in mind when evaluating any idea below: if a piece of UI is still drawn by the
DOM, it is still 60 Hz on iOS, no matter how fast the input is.

---

## F1. Native scrolling as an input sensor

**Problem.** Touch events on iOS Safari pages arrive at 60 Hz and come with no physics. Re-implementing momentum, rubber
banding and snapping in JavaScript is a lot of code, never quite matches the platform, and runs on the busy main thread.

**Mechanism.** Put an invisible `overflow: scroll` element under the finger. The OS drags it. Your code only reads
`scrollLeft`/`scrollTop` and turns the offset into whatever the gesture means: a crosshair, a lens, a slider value.

- At press, remember the scroll position as the baseline. The finger offset is `baseline − current` (the content moves
  with the finger, so the scroll offset moves the other way).
- To stop on release (no fling), toggle `overflow: hidden` for one frame and restore it; that kills momentum.
- To fling and land on discrete values, keep reading after release and let **CSS scroll snapping** pick the landing
  point. Momentum and the snap animation are native.
- After the gesture, jump back to the middle of the scrollable range (“recenter”), so the next gesture has room in both
  directions. Because the next press re-reads the baseline, absolute scroll positions never matter.
- The tab bar on `/` uses one scroller per tab with 97 snap cells, `scroll-snap-stop: always`, 200 pt of slack at both
  ends, starting in the middle (48 tabs of travel each way). **[Verified · here]**
- Mouse can’t drag a scroller, so pointer events (with pointer capture) stand in for it. Trackpad and wheel scrolling
  over the pad naturally become “momentum” moves.

**Evidence.**

- iOS delivers scroll positions of a dragged scroller at up to 120 Hz once the display is boosted (F5), and a passive
  `touchmove` listener on the scroller also fires at 120 Hz when momentum/snapping aren’t needed.
  **[Measured · write-up]** ([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#creating-the-controller))
- Final benchmark: the controller-driven version averaged **118 fps over 3 s of dragging**; the pointer-events version
  held **60**. **[Measured · write-up]** ([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#performance))
- In this repo, the tab bar, both meters and the React chart scrubber are driven this way. The scrubber lands exactly on
  data points through scroll snapping after a fling. **[Verified · here]**

**Code.**

- Tab bar pads: [`buildPads`](../src/dock/dock.ts#L278), reading at [`readPads`](../src/dock/dock.ts#L442), momentum cut
  at [`haltMomentum`](../src/dock/dock.ts#L267).
- Meter controller: [`setupScroller`](../src/readout/readout.ts#L56).
- **React:** [`<ScrollPad>`](../src/react/ScrollPad.tsx#L77).

```tsx
import { ScrollPad } from './react'

// Chart scrubbing: 7 px of finger travel per data point, fling lands on a point.
<ScrollPad
  axis="x"
  snap={7}
  momentum
  aria-label="Scrub the chart"
  onPressStart={() => (base.current = index.current)}
  onMove={({ dx }) => draw(clamp(base.current + dx / 7))}  // up to 120×/s, no re-render
  onSettle={() => commit(Math.round(index.current))}
>
  <canvas … />   {/* your visual sits under the invisible scroller */}
</ScrollPad>
```

Props worth knowing: `axis` (`x` | `y` | `both`), `precise` (F2), `snap` + `snapStop` (`normal` lets a fling skip
points, `always` stops at the next one), `momentum`, `cellsEachWay` (travel per gesture), `scrollerRef` (to attach an
`<InputMeter>`), and `onPressStart` / `onMove` / `onRelease` (with velocity over the last 80 ms) / `onSettle`.

**Gotchas.**

- Scroll chaining: use `overscroll-behavior: contain` on the pad so a drag never scrolls the page behind it.
- `touch-action` must allow the pad’s axis (`pan-x`, `pan-y`, or both); `ScrollPad` sets it.
- Travel is finite. With snapping, one gesture can move `cellsEachWay` cells; recentering after the gesture resets it.
- Accessibility: the pad is a pointer surface. Give the container a role and keyboard handling (for a scrubber,
  `role="slider"` with arrow keys moving one point).
- Don’t put focusable content inside the pad; it sits on top of your visual.

**Applicability.** Any continuous gesture where the native feel matters more than custom physics: scrubbers (time,
media, charts), sliders and steppers, pickers with detents, segmented controls with a sliding indicator, carousels, pan
surfaces, pull-to-refresh, dials.

**Where I’d explore it.**

- **Chart scrubbing.** Replace pointer-event crosshairs on price charts with a `ScrollPad` over the chart. Flicking
  through time glides with native momentum and lands on a candle or data point via `snap`. Test both
  `snapStop="normal"` (fast travel) and `"always"` (one point per flick).
- **Amount entry in a trade ticket.** A horizontal pad with `snap={8}` as an amount picker (see `AmountPicker` in
  [`ComponentsDemo.tsx`](../src/demos/components/ComponentsDemo.tsx)). Explore non-linear steps (1, 5, 10, 25, 50, 100…) by mapping the offset
  through a table, and a light “pop” spring on settle.
- **Limit price as a wheel.** A vertical pad with one snap point per cent: a native-feeling price wheel that can’t land
  between ticks.
- **Time-range selector.** 1H / 1D / 1W / 1M / ALL as a segmented control whose indicator follows the finger and settles
  on the nearest option (the tab bar pattern, without the glass).
- **Outcome lists.** Swipe between outcomes of a multi-outcome market with snap points per card.

---

## F2. Sub-point precision with DPR-scaled scrollers

**Problem.** `scrollLeft` and `scrollTop` are rounded to integers, while iOS scrolls with sub-point precision. On a 3×
screen, one point is three physical pixels, so a slow scrub moves your crosshair in visible steps.

**Mechanism.** Make the scroller DPR× larger than its box and scale it down with `transform: scale(1/DPR)`. The finger
still moves the content one screen pixel per pixel, but now one scroll unit is one physical pixel. Divide readings by
the DPR.

**Evidence.** Described in the write-up **[Measured · write-up]**
([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#creating-the-controller)). In this repo the precise meter
reports half-point steps in a 2× viewport **[Verified · here]**. The write-up also shows the alternative of making the
viewport itself the controller via `initial-scale=1/DPR`, which needs every unit scaled, text autosizing disabled and
safe areas recomputed; not worth it outside experiments.

**Code.** [`setupScroller`](../src/readout/readout.ts#L56), the `.dock-controllers` layer in
[`buildPads`](../src/dock/dock.ts#L278). **React:** `<ScrollPad precise>`, `<InputMeter precise />`.

**Gotchas.** Use an integer unit (`Math.round(devicePixelRatio)`). Any CSS you draw inside the scaled scroller (grid
lines, snap cells) must be multiplied by the same unit.

**Applicability / where I’d explore it.** Everywhere F1 is used for continuous values: chart crosshairs during slow
scrubs, fine price adjustment, zoomed-in chart panning.

---

## F3. A high-frequency sampling loop

**Problem.** The `scroll` event is a poor sampler on iOS. During momentum it fired **5–26 times per second** on an
iPhone 18 Pro, and about 60 at best during slow scrolls. **[Measured · write-up]**
([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#creating-the-controller))

**Mechanism.** Poll the scroll position yourself, on a loop that isn’t rAF:

- A `MessageChannel` message schedules a `setTimeout` for the next sample slot: two slots per 120 Hz frame (every
  ~4.17 ms), phase-locked to the latest rAF timestamp, 1 ms early:
  `next = vsync + ceil((now − vsync + 1) / slot) · slot − 1`.
- The timer is created from a message event, not from another timer, so its nesting level starts at 0 and it never
  hits the 4 ms clamp for nested timers. **[Spec]** The HTML timer steps clamp a timeout to 4 ms only when the nesting
  level is above 5, and a timer inherits a nesting level only when it is set from inside another timer task
  ([HTML § timers](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timer-initialisation-steps)). A
  port message runs in its own task, so the hop resets it. WebKit is looser than the spec here: its `setTimeout`
  threshold is 10, not 5 ([bug 237168](https://bugs.webkit.org/show_bug.cgi?id=237168),
  [DOMTimer.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/DOMTimer.cpp)), and since October 2025
  it also resets the level at microtask checkpoints ([bug 301008](https://bugs.webkit.org/show_bug.cgi?id=301008)).
- Only readings that changed count. The loop parks after the position has been still for a while and no finger is
  down.
- Outside Safari, plain rAF already runs at the display rate.

**Evidence.** The write-up compares sampling strategies on device **[Measured · write-up]**:

| Strategy | Distinct positions per second | Notes |
|---|---|---|
| `scroll` events | 5–26 (momentum), ~60 (slow) | |
| Recursive `MessageChannel` | ~80 (out of ~50,000 reads/s) | pins a CPU core |
| `Atomics` + `SharedArrayBuffer` | ~80 | requires COOP/COEP, which broke cross-origin assets |
| vsync-phase-locked `MessageChannel` + `setTimeout` | ~80 | the one kept |
| + empty rAF loop (F4) | ~90 | |
| + ProMotion boost (F5) | up to 120 | |

The lesson in that table: **reading more often doesn’t create information**. Count distinct values, not reads (F15).

**Code.** [`pump.ts`](../src/core/pump.ts#L55) (`slotAfter`, `onRaf`, `schedule`, `run`). Shared by everything in the
repo. **React:** [`useScrollSampler`](../src/react/useScrollSampler.ts).

```tsx
useScrollSampler(scrollerRef, ({ left, top, at }) => {
  worker.postMessage({ left, top, at })   // up to 120×/s on iOS; not React state
})
// or the page itself:
useScrollSampler('window', ({ top }) => progressBar.style.transform = `scaleX(${top / max})`)
```

**Gotchas.**

- The callback must not set React state: at 120 Hz that is 120 renders per second. Write to a canvas, a worker or a
  style.
- The loop costs CPU while active. It parks itself when idle; keep `settleMs` short.
- Writing a style from this loop still only shows at 60 Hz on iOS (the DOM is the 60 Hz exit). The loop pays off when
  the output is a worker-rendered canvas (F7).

**Applicability / where I’d explore it.**

- Feeding scrubbers and pads (F1) at full rate.
- Scroll-linked visuals drawn in a worker: a chart that zooms or reveals as the page scrolls, a sticky price header
  rendered in a canvas.
- Reading-progress for long rule or resolution text (with F6 on the page scroll).

---

## F4. The empty rAF loop that unlocks more scroll positions

**Problem.** Even with the loop from F3, readings capped at ~80 distinct values per second.

**Mechanism.** Safari’s UI process sends the web process one scroll position at a time and waits for an acknowledgement
before sending the next; positions that arrive in between overwrite each other. Reading WebKit’s source, the write-up found
that on any tick where the page has a rendering update queued, Safari flushes the position without waiting. An **empty
`requestAnimationFrame` loop** (it draws nothing) keeps a rendering update queued.

**Evidence.** About **12.5% more reads, to ~90 distinct positions per second**. **[Measured · write-up]**
([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#creating-the-controller)) **[Undocumented]**

**Code.** [`onRaf` in pump.ts](../src/core/pump.ts#L61); it also stores the vsync timestamp the sampler phase-locks to.
Built into `useScrollSampler`.

**Gotchas.** Runs only while the loop is active. It is free on other browsers (rAF runs anyway).

---

## F5. Keeping ProMotion at 120 Hz

**Problem.** ProMotion only raises the refresh rate when something needs it. With input alone, the write-up saw the display
sit around 90 Hz.

**Mechanism.** While a finger is on the screen, keep two things running:

- a **pacer**: an invisible 8 px `overflow: scroll` element that smooth-scrolls between 0 and 200 px every 250 ms, so a
  native scroll is always in progress;
- a **rate mark**: a 1 px element with an infinite `1s linear` `translateX(1px)` CSS animation.

Start on `touchstart` (Safari only), stop one second after the last touch ends.

**Evidence.** With the boost, input reached 120 readings per second. **[Measured · write-up]**
([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#creating-the-controller)) **[Undocumented]**

**Code.** [`installDisplayBoost`](../src/core/boost.ts#L17), styles `.display-pacer` / `.rate-mark` in
[`style.css`](../src/style.css#L274). **React:** [`useDisplayBoost`](../src/react/useDisplayBoost.ts).

**Gotchas.** Costs battery and heat, so scope it to interaction windows. Measure on device before
shipping it anywhere. Never run it page-wide all the time.

**Where I’d explore it.** Only during chart scrubbing and sheet drags, behind a flag, with battery and thermal checks on
older iPhones.

---

## F6. Avoiding the 10 Hz throttle while the URL bar resizes

**Problem.** When the page scroll changes direction, Safari collapses or expands the URL bar, and during that animation
it throttles the scroll positions reported to the page (`window.scrollY`) to about 10 Hz. Anything driven by page scroll
stutters right then. **[Measured · write-up]**
([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#creating-the-controller))

**Mechanism.** Give the page a scroll-driven CSS animation (`animation-timeline: scroll(root)`) on a property that the
compositor can’t animate by itself, such as `outline-color`, animating between two transparent colors. The animation
needs the scroll position on the main thread every frame, so WebKit keeps delivering it. Nothing is visible.

**Evidence.** **[Measured · write-up]**, **[Undocumented]**, **[Needs device check]** in this repo.

**Code.** `.scroll-keep` in [`style.css`](../src/style.css#L252) and the element in
[`GlassDemo.tsx`](../src/demos/glass/GlassDemo.tsx). Needs CSS scroll-driven animations (Safari 26+; see
[Browser support](#browser-support)).
**React:** [`<ScrollKeep />`](../src/react/ScrollKeep.tsx).

```tsx
<ScrollKeep />   // once, near the root of pages that react to the page scroll
```

**Gotchas.** Only matters for the page’s own scroll; inner scrollers don’t move the URL bar. Browsers without
scroll-driven animations ignore it. Cost is close to zero.

**Where I’d explore it.** Market pages with a collapsing header that shows the live price once the chart scrolls away;
long rules or resolution text with a reading-progress indicator; any scroll-linked chart.

---

## F7. Rendering from a worker with OffscreenCanvas

**Problem.** Reading input at 120 Hz doesn’t help if the screen only shows 60 frames. On iOS, DOM and main-thread canvas
updates present 60 times per second. On every browser, main-thread drawing competes with React renders, network parsing
and layout.

**Mechanism.** `canvas.transferControlToOffscreen()` turns the `<canvas>` into a placeholder and gives you an
`OffscreenCanvas` you can transfer to a worker. The worker draws with 2D or WebGL. As the write-up found, WebKit presents
those frames without waiting for the page’s next rendering update. Result: **120 fps canvas rendering on iOS**.

What the platform actually promises:

- **Normative [Spec]:** the bitmap is pushed to the placeholder during the “update the rendering” steps of the
  OffscreenCanvas’s *own* event loop; for a canvas in a worker, that is the worker’s loop, not the main thread’s
  ([HTML § OffscreenCanvas](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface)).
- **Non-normative:** a note encourages implementations to short-circuit the window event loop’s graphics update for
  lower latency when a worker draws while the main thread is busy
  ([HTML § offscreen 2D context](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreen-2d-rendering-context)).
  This is the part the technique relies on, and it is a recommendation, not a requirement.
- **WebKit:** no blog post or release note says frames bypass the 60 Hz cap. Commit messages describe updating the
  placeholder directly from the OffscreenCanvas’s thread and sending frames straight to the UI process
  ([bug 244878](https://bugs.webkit.org/show_bug.cgi?id=244878),
  [bug 249116](https://bugs.webkit.org/show_bug.cgi?id=249116),
  [bug 325214](https://bugs.webkit.org/show_bug.cgi?id=325214)). **[Undocumented]**

Flow control: keep at most **2 frames in flight** (the worker acks each one) and at least **6.25 ms**
between sends. Our hook adds coalescing: frames that arrive while the pipe is full are merged, so only the latest one is
sent (“latest state wins”).

**Evidence.**

- 120 fps presentation from an OffscreenCanvas on iOS WebKit. **[Measured · write-up]**
  ([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#breaking-the-60-fps-render-barrier))
  **[Undocumented]**: the write-up warns Apple could make the placeholder wait for the main thread without violating
  the spec.
- Dead ends the write-up reports before this one: plain workers, pre-rendered “flip-book” permutations, and live-generated
  video (laggy, jagged, or out of memory).
- In this repo, the glass, the tab bar, both meters and the React chart render from workers. **[Verified · here]**

**Code.** Main side [`client.ts`](../src/glass/client.ts#L48) (transfer, `canSend`, acks); worker side
[`glass.worker.ts`](../src/glass/glass.worker.ts#L238); the meter worker
[`readout.worker.ts`](../src/readout/readout.worker.ts). **React:**
[`useWorkerCanvas`](../src/react/useWorkerCanvas.ts#L47) + [`defineCanvasWorker`](../src/react/canvasWorker.ts).

```tsx
// main thread
const chart = useWorkerCanvas<Frame>(() =>
  new Worker(new URL('./chart.worker.ts', import.meta.url), { type: 'module' }))
return <div ref={chart.ref} style={{ position: 'relative', height: 240 }} />
// …then, from anywhere (event, socket, ScrollPad.onMove):
chart.post({ points, index })

// chart.worker.ts
import { defineCanvasWorker } from './react/canvasWorker'
let ctx: OffscreenCanvasRenderingContext2D
defineCanvasWorker<Frame>({
  init: ({ canvas }) => { ctx = canvas.getContext('2d')! },
  draw: ({ width, height, dpr }, frame) => { /* draw */ },
})
```

The hook creates the canvas inside the effect, so React StrictMode’s double mount never transfers the same canvas twice,
and it resizes the canvas with a `ResizeObserver` (the worker helper redraws the last frame on resize).

**Gotchas.**

- With WebGL and `preserveDrawingBuffer: false`, the drawing buffer is gone after the frame is committed. Read pixels
  (or `createImageBitmap`) in the same task that drew.
- Don’t pace worker drawing with the worker’s own `requestAnimationFrame` in WebKit: in current WebKit source it runs on
  a fixed 15 ms timer, roughly 66 Hz, regardless of the flag
  ([WorkerAnimationController.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/workers/WorkerAnimationController.cpp);
  read from the code, not measured). Draw when a message arrives, as every worker in this repo does.
- The glass worker passes the WebGL context attribute `desynchronized: true` on iOS, but browser-compat-data lists it as
  unsupported in Safari (Chrome 81+ only), so treat it as a no-op there.
- Fonts in workers: system fonts work without loading; custom fonts must be loaded in the worker (or rasterized on the
  main thread).
- Text drawn into a canvas isn’t accessible; see F14.
- Keep a DOM fallback for browsers without OffscreenCanvas.

**Applicability.** Charts, sparklines, order-book and depth visualizations, maps, games, 3D viewers, handwriting and
signatures, loaders that must keep moving during heavy work.

**Where I’d explore it.**

- **Price charts in a worker.** Move the main chart into a worker canvas. Measure main-thread long tasks and INP during
  live updates before and after.
- **Let the worker own the socket.** A worker can open the WebSocket for live prices, keep the series, and draw the chart
  directly. React only receives throttled summaries (last price every 250 ms for the DOM label). High-frequency ticks
  never touch the main thread.
- **Sparklines in lists.** Dozens of small charts in a feed: draw them in one worker (one OffscreenCanvas per visible
  card, created and released with an IntersectionObserver), instead of SVG nodes that React reconciles.
- **Depth chart and order book heatmap** redrawn on every update without blocking scrolling.
- **Scrubbing**: combine with F1 so the crosshair moves at 120 Hz while the DOM stays untouched.

---

## F8. Live sources: compositing one canvas into another

**Problem.** A canvas can’t see another canvas’s pixels. On `/`, the glass on the page refracts the demos
underneath it (the tab bar, the meters), so it needs their pixels.

**Mechanism.** Right after a source draws, copy the region the consumer needs with
`createImageBitmap(canvas, x, y, w, h)` and upload it as a texture in the consumer.

- Same worker: copy and upload directly (our tab bar → page glass).
- Different workers: open a `MessageChannel` between the two workers. The consumer tells the source which canvases it
  wants (“want”) based on what is under it; the source sends `ImageBitmap`s (transferred, not copied) after each draw.
  The main thread is never involved.
- Capture only on demand and only the needed rectangle.

**Evidence.** In this repo, the reading indicator and menu refract the tab bar (same
worker) and the meters (separate worker) when they pass over them. **[Verified · here]**

**Code.** [`feed`](../src/glass/glass.worker.ts#L518), [`cropFor`](../src/glass/glass.worker.ts#L496),
[`connectPort`](../src/glass/glass.worker.ts#L604) and [`updateWants`](../src/glass/glass.worker.ts#L584) in the glass
worker; [`capture`](../src/readout/readout.worker.ts#L320) in the meter worker; up to six sources in the page shader’s
`scene()` ([`shaders.ts`](../src/glass/shaders.ts#L191)).

**Gotchas.** GLSL ES 3.0 only allows constant indices into sampler arrays, hence one sampler per source and an `if` chain.
Copies cost GPU bandwidth; keep crops small.

**Where I’d explore it.** Low priority. Useful if a glass header or a magnifier ever has to sit over a worker-drawn chart,
or to composite a live video with a canvas overlay in one place.

---

## F9. The page as a texture (DOM re-render)

**Problem.** A page can’t read its own pixels, so an effect that bends or blurs what is behind it has nothing to work
with in WebGL.

**Mechanism.** Re-lay out the DOM as a draw list: walk the article, record every word with its font, color and baseline
position (from `Range.getClientRects()`), plus backgrounds and borders. Send the list to the worker once. The worker
rasterizes only the band near the viewport into a **ring-buffer texture** and fills in new rows as the scroll moves.
The shader samples that texture as “the page”.

**Evidence.** This repo rasterizes words with `fillText` in the worker; a glyph atlas cached in IndexedDB is the
heavier-duty alternative. **[Verified · here]** for text, backgrounds and borders.

**Code.** [`snapshotPage`](../src/glass/snapshot.ts#L25), the [`Ring`](../src/glass/glass.worker.ts#L28) class
([`ensure`](../src/glass/glass.worker.ts#L81), `drawRows` with `getImageData` → `texSubImage2D`).

**Gotchas.** Fragile by nature: images, gradients, transforms, shadows and web fonts need extra work. Re-snapshot after
font loading, resize and theme changes.

**Where I’d explore it.** Mostly as a reason **not** to: for product UI, CSS `backdrop-filter` is the pragmatic glass.
Worth it only for one hero element over controlled content, or a magnifier for accessibility over text.

---

## F10. Glass shader techniques

A toolbox, independent of the 120 Hz story. All in [`shaders.ts`](../src/glass/shaders.ts):

- **SDF shapes with normals** (capsule, rounded rectangle): coverage is `clamp(0.5 − d·scale, 0, 1)` for a one-device-pixel
  anti-aliased edge ([`shapeDistance`](../src/glass/shaders.ts#L59)).
- **Polynomial smooth union** to fuse two shapes into one liquid body:
  `share = clamp(0.5 + 0.5·(dA − dB)/r, 0, 1)`, `d = mix(dA, dB, share) − r·share·(1 − share)`; blend normals, centers
  and lighting by the same `share` ([`bodyDistance`](../src/glass/shaders.ts#L353), [`navShape`](../src/glass/shaders.ts#L604)).
  The bar and the search button fuse when the gap between them closes: `r = 24 · smoothstep((7.33 − gap)/7.33)`.
- **Refraction**: within a bezel near the edge, move the sample along the normal by
  `radius · (edgeScale − 1) · (1 − d/bezel)^falloff` ([`refractShifts`](../src/glass/shaders.ts#L381)).
- **Chromatic aberration**: sample R and B with slightly smaller and larger offsets than G.
- **Frost**: downsample the backdrop into a small texture (averaging in gamma space), then a separable Gaussian, then
  sample it ([`downsample`](../src/glass/shaders.ts#L233), [`BLUR_FS`](../src/glass/shaders.ts#L257)).
- **Material** for the menu panel: blur + saturation + a translucent veil, with values from the write-up’s demo, matched
  against the iOS 27 simulator (light: σ 12, saturation 1.2, 53.5% veil of rgb(253,253,253); dark: σ 8.4, saturation 1.3, 65.1% veil
  of rgb(49,49,49)).
- **Finish**: inner shade below the top edge, sheen, a bevel highlight from a vertical light, and a subtractive hairline
  just outside the edge ([`glassFinish`](../src/glass/shaders.ts#L111), [`glassHairline`](../src/glass/shaders.ts#L143)).
- **Two-channel label texture**: draw outline icons and labels into R, filled icons into G, additively on black. The
  shader shows G only under the pill or lens, so a lens sliding across tabs reveals each filled icon as it passes.
- **Cheap text blur through mipmaps**: sample the label texture at a higher `textureLod` level to blur content during a
  morph.
- **Magnifying lens**: scale the interior by 1/0.903, pull the outer 36 pt toward the edge, and add a chromatic split of
  about 2.6 pt at the rim ([`navColor`](../src/glass/shaders.ts#L752)).

**Where I’d explore it.** WebGL chart lines with SDF-based thickness and glow; a liquid selection indicator in segmented
controls (two capsules fused while moving between options); probability bars with a subtle material.

---

## F11. Springs in (dampingRatio, response), with measured constants

**Problem.** Duration + easing curves don’t respond to velocity and don’t match iOS. Designers already speak in SwiftUI’s
`(dampingRatio, response)`.

**Mechanism.** Convert to a unit-mass spring: stiffness `(2π/response)²`, damping `2·ζ·(2π/response)`, and integrate in
**closed form** (exact for any frame time, under-, critically- and over-damped branches). Rest when
|offset| < 1e‑4 and |velocity| < 1e‑3. An “overshoot clamping” variant stops at the first crossing.

**Evidence.** Same parametrization as SwiftUI; constants from the write-up’s demo, matched in the iOS 27 simulator
(Safari’s filter menu and `glassEffect` subjects). **[Verified · here]** for the math.

**Code.** [`spring.ts`](../src/core/spring.ts#L14). **React:** [`useSpring`](../src/react/useSpring.ts) (imperative, runs on
the shared pump, never re-renders).

```tsx
const pop = useSpring(1, { dampingRatio: 0.55, response: 0.3 }, (s) => {
  label.current!.style.transform = `scale(${s})`
})
pop.jump(1.12); pop.to(1)
```

**Measured constants worth reusing** (from the write-up’s demo; ζ = dampingRatio, r = response in seconds):

| Motion | ζ | r | Notes |
|---|---|---|---|
| Menu open | 0.75 | 0.35 | peaks at 1.028 progress |
| Menu close | 0.80 | 0.49 | |
| Menu content scale (1.305 → 1) | 0.75 | 0.61 | anchored at top center; starts with a 4 pt blur |
| Panel “kick” on open | 0.64 | 0.38 | initial velocity 7 × distance |
| Row highlight fade in / slide | 1.0 / 0.9 | 0.28 / 0.15 | |
| Tab lens follow (drag) | 0.75 | 0.30 | |
| Tab press (lift) / release | 1.0 / 1.0 | 0.25 / 0.20 | release clamped |
| Tab snap after drag / after tap | 1.0 / 0.80 | 0.30 / 0.45 | snap clamped |
| Bar press swell | 0.62 | 0.33 | 1.047 × width, 1.073 × height |
| Search button press rise / fall | 1.0 / 0.62 | 0.113 / 0.22 | 1.164 × |
| Velocity squash | 0.45 | 0.28 | target min(1, speed/1600)·0.275 |

**Where I’d explore it.** A single motion-token file in these terms for sheets, popovers, toasts, the tab indicator and
number tickers (price changes that “roll”), shared by design and engineering.

---

## F12. State machines fed by timestamped events

**Problem.** Gesture code that mixes event handlers and animation state turns into edge cases.

**Mechanism.** Inputs only emit timestamped events (`pressed`, `moved`, `pulled`, `released`, `settled`, `returned`).
Each frame, a reducer derives everything else: lens position, lift, stretch, pill visibility, squash. The details that make
it feel native:

- **The rise always completes.** A quick tap still shows a full lift before it falls: on release during the rise, the phase
  becomes “waiting” and falls only after reaching 0.99.
- **Presence hand-off.** The resting pill fades out by half lift and returns over 150 ms (`cubic-bezier(0, 0, .58, 1)`)
  once the lift falls below half; the lens can only fade as fast as it shrinks. The two never read at full strength.
- **Velocity squash** with constant area (`x·(1+s)`, `y/(1+s)`), plus a rebound when the finger stops suddenly.
- **Rubber band** past the bounds: `(1 − 1/(d·k/L + 1))·L` with L = 5 pt, k = 0.12, and the cross axis thins slightly.
- **Settle on the nearest option** at release, not after momentum.

**Code.** [`dock.ts`](../src/dock/dock.ts): [`barPressed`](../src/dock/dock.ts#L173),
[`thumbSampled`](../src/dock/dock.ts#L192), [`releaseLift`](../src/dock/dock.ts#L214),
[`settled`](../src/dock/dock.ts#L232), [`step`](../src/dock/dock.ts#L493). The menu morph in
[`contents.ts`](../src/chrome/contents.ts#L326) (`setOpen`) and [`frameFor`](../src/chrome/contents.ts#L515).

**Applicability.** Any gesture with more than two states. Because state is a pure function of events and time, you can
record touch traces on a device and replay them in tests.

**Where I’d explore it.** Press-and-hold crosshair on charts (press → lift a label, drag → follow, release → settle or
hide), the trade ticket’s gestures, and a tab bar for a mobile web app or PWA.

---

## F13. Swipeable sheets that are just scroll views

**Problem.** JavaScript bottom sheets re-implement drag physics, fight with inner scrolling, and run gestures on the main
thread.

**Mechanism** (React Aria’s technique, [blog post](https://react-aria.adobe.com/blog/sheet)): the swipe is a scroll.

- A fixed, full-screen scroller with `scroll-snap-type: y mandatory`.
- Inside it: a 100dvh spacer (`scroll-snap-align: start`, so scrollTop 0 = sheet hidden = closed), then the sheet
  (`scroll-snap-align: end`, so scrollTop max = fully open). **The visible height of the sheet always equals scrollTop.**
- **Detents** are 1 px absolutely positioned markers inside the sheet at `top: h`, with `scroll-snap-align: start` and
  `scroll-margin-top: 100dvh`: they snap when `h` px of the sheet are visible.
- **Opening** is a smooth programmatic scroll from 0 to the first detent.
- **Dismissal** is detected by an IntersectionObserver once the sheet has left the screen.
- **Backdrop** dimming follows the scroll through a CSS scroll-driven animation; React Aria drives sheet visuals with view
  timelines (`view-timeline`, `timeline-scope`, `animation-composition: accumulate`).
- **Content** doesn’t scroll until the sheet is fully open (`overflow: hidden` while partial), and
  `overscroll-behavior: auto` on the content lets a downward swipe at its top chain into the sheet, toward dismissal.
- **Software keyboard**: pad the content’s bottom by `100dvh − visualViewport.height` so the last fields stay reachable.
- React Aria also supports non-dismissible sheets (shifting the stage so the first snap point sits at scrollTop 0),
  stacking, and other edges.

**Evidence.** Technique and properties from the React Aria post **[Spec]** for the CSS features used; our implementation
**[Verified · here]**: opens at the 280 px detent, full open enables inner scrolling, closes by swipe, Escape and a Done
button, restores focus, and makes the rest of the page inert while open. **[Needs device check]** for the feel on iOS.

**Code.** **React:** [`<SwipeableSheet>`](../src/react/SwipeableSheet.tsx#L69) (an independent minimal implementation
for study; React Aria ships a complete `Sheet` in `react-aria-components`).

```tsx
<SwipeableSheet isOpen={open} onOpenChange={setOpen} detents={[280]} aria-labelledby="title">
  <h2 id="title">Details</h2>
  …
</SwipeableSheet>
```

**Gotchas.** An edge-adjacent target still counts as intersecting, so the observer’s root is shrunk by 1 px to detect
the fully hidden state. Programmatic scrolls should use `behavior: 'instant'` under reduced motion. Don’t lock body
scroll with `position: fixed` tricks; the overlay scroller already captures the gesture.

**Where I’d explore it.**

- **Trade ticket as a sheet with detents**: a peek detent (outcome and price), a mid detent (amount and the payout
  line), full height for advanced options (limit orders, expiry). Native fling between detents, swipe down to dismiss.
- **Filters and sort** on market lists; **comments** with scroll hand-off (read comments, swipe down at the top to
  close).
- Combine with F1 inside the sheet (amount picker) and F11 for the motion tokens.

---

## F14. An accessible DOM layer under canvas UI

**Problem.** Everything drawn in a canvas is invisible to keyboards and screen readers.

**Mechanism.** Keep real DOM for semantics and hit testing, and draw the visuals in the canvas:

- a real `<button>` with `aria-expanded` / `aria-controls`;
- rows as real links and buttons with **transparent text** (`color: transparent`), so focus rings, hit testing and the
  accessibility tree stay correct;
- `inert` on the closed panel, Escape to close, focus returned to the trigger, `aria-current="location"` on the current
  section, an `aria-live` label for “Link copied”.

**Code.** [`contents.ts`](../src/chrome/contents.ts) (rows built in `buildRows`, keyboard handling, `choose`), the
`.post-contents-*` styles, and the DOM fallback (`.glass-off`) used when WebGL2 or OffscreenCanvas is missing.

**Where I’d explore it.** Canvas charts with a visually hidden table of values, an `aria-live` region announcing the
price at a throttled rate, and arrow keys moving the crosshair one point at a time.

---

## F15. Measure it: the input meter and the 240 fps method

**Problem.** “Feels faster” isn’t evidence, and a DOM-based FPS counter on iOS can’t display more than 60 changes per
second.

**Mechanism.** The meter samples a scroller on the high-frequency loop and draws in a worker:

- **Updates**: fresh readings per second (500 ms window).
- **Unique values**: distinct positions per second. The honest number: reading faster than the source changes only
  produces repeats.
- **Speed**: from the samples of the last 80 ms.
- A plane with the position and a 48-sample trail, and a 4 s chart with a 120/s guide.

End-to-end check from the write-up: film the phone at **240 fps**, play it at **1/8 speed**, and count frames of two oscillating
squares (one driven by input, one by rendering). **[Measured · write-up]**
([source](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit#performance))

**Code.** [`readout.worker.ts`](../src/readout/readout.worker.ts#L86) (`metrics`), [`readout.ts`](../src/readout/readout.ts).
**React:** [`<InputMeter>`](../src/react/InputMeter.tsx) (built-in grid, or `source={ref}` / `'window'`).

**Where I’d explore it.** A debug overlay (`?debug=input`) on staging that shows the meter for the page scroll and for any
scrubbable chart, so QA can compare devices and catch regressions.

---

## Browser support

Checked against MDN browser-compat-data, Apple’s release notes and caniuse (November 2026). iOS Safari has the same
version as desktop Safari in every row.

| Feature | Safari / iOS | Chrome | Firefox | Used by |
|---|---|---|---|---|
| `HTMLCanvasElement.transferControlToOffscreen()` | 16.4 | 69 | 105 | F7, F8 |
| OffscreenCanvas 2D context in a worker | 16.4 | 69 | 105 | F7, F15 |
| OffscreenCanvas **WebGL2** in a worker | **17** | 69 | 105 | glass demo |
| `createImageBitmap(OffscreenCanvas)` | effectively 16.4 (not tracked separately) | 69 | 105 | F8 |
| CSS scroll-driven animations (`animation-timeline: scroll()`) | **26** | 115 | 159 | F6, F13 backdrop |
| `scroll-snap-stop` | 15 | 75 | 103 | F1 |
| `overscroll-behavior` | 16 (partial) | 63 | 59 | F1, F13 |
| `requestAnimationFrame` in a dedicated worker | 16.4 | 69 | 99 | (avoid in WebKit, see F7) |
| WebGL `desynchronized` context attribute | no | 81 | no | — |
| `GestureEvent` (non-standard, WebKit only) | 9 | no | no | Safari detection |
| `PointerEvent.getCoalescedEvents()` | 18.2 | 58 | 59 | alternative for ink/drawing |

Notes:

- Apple’s Safari 16.4 notes describe OffscreenCanvas as 2D-only; WebGL support for OffscreenCanvas arrived in Safari 17.
- caniuse lists Safari 16.2 as partial for OffscreenCanvas; Apple’s notes and WebKit’s 16.4 post contradict it.
- `overscroll-behavior` is marked partial in Safari because it does nothing on scroll containers without overflow.
- `getCoalescedEvents()` deserves a look for drawing and handwriting: even when pointer events are dispatched at
  60 Hz, coalesced events can carry the intermediate samples. We haven’t measured it on iOS.
- **Minimum iOS for the glass demo: 17** (WebGL2 in a worker). The React components work from iOS 16.4 (2D canvases),
  and `<ScrollKeep />` plus the sheet’s CSS backdrop need iOS 26 (the sheet falls back to JS for the backdrop).

---

## Adoption playbook

**Safe now (any browser, helps everywhere):**

1. F11 springs and F12 state machines for motion and gestures.
2. F1 scroll-as-input for scrubbers, pickers and sliders (with keyboard alternatives).
3. F13 sheets as scroll views.
4. F14 accessible DOM layer for anything drawn in canvas.
5. F7 worker rendering for charts and other heavy canvases (the off-main-thread win is real even without 120 Hz).

**Low cost, iOS-specific:** F6 `<ScrollKeep />` on pages that react to page scroll.

**Only with a meter and a fallback:** F3/F4 sampling loop, F5 display boost, F9 page-as-texture. Measure on real
devices (F15) and keep the plain path working.

**Rule of thumb.** If the output is DOM, iOS shows it at 60 Hz no matter what. The 120 Hz pipeline is: native scroll
input → high-frequency sampling → worker-rendered canvas.

---

## Where I’d start on a live-markets product

Ordered by expected value over effort. Each item names the success metric to measure.

1. **Worker-rendered price chart with native scrubbing** (F7 + F1 + F3 + F15). Prototype exactly what `/components`
   does with real data: chart in a worker, `ScrollPad` with `snap` per point and `momentum`. Metrics: unique input
   values per second during scrubs on iPhone (target ≈120 vs ≈60 today), main-thread long tasks during live updates, INP.
2. **Move the live-price socket into the worker that draws the chart** (F7). The main thread receives a throttled summary
   for DOM labels. Metrics: long tasks and dropped frames during volatile periods; React commit counts.
3. **Trade ticket as a swipeable sheet** (F13 + F1 + F11). Detents for peek, amount and advanced. Metrics: time to open,
   drag-to-dismiss success rate, accessibility audit (focus trap, Escape, screen reader labels).
4. **Amount and price pickers on scroll snap** (F1 + F2). Amount steps and price ticks as snap points; no landing between
   ticks. Metric: input errors and corrections in the ticket.
5. **Sparklines for market cards in a worker** (F7). One worker, an OffscreenCanvas per visible card. Metric: scroll jank
   (frame drops) on long feeds on mid-range Android and older iPhones.
6. **Motion tokens in (ζ, response)** (F11) shared by design and engineering, starting from the measured table above.
7. **`<ScrollKeep />` and the page-scroll sampler** (F6 + F3) for collapsing headers that reveal the live price.
8. **Debug overlay with `<InputMeter>`** (F15) on staging builds.
9. **Experimental:** the display boost (F5) only during scrubs, behind a flag, with battery checks; glass (F9/F10) only
   for a single hero surface, if ever.

---

## React components reference

All in [`src/react/`](../src/react/index.ts). They depend on [`src/core/`](../src/core/) (springs, the pump, the boost)
and on [`src/readout/`](../src/readout/) for the meter worker. Every file is SSR-safe to import (`'use client'` where it
renders).

| Export | Kind | Purpose |
|---|---|---|
| `ScrollPad` | component | Native scroll as an input sensor (F1, F2) |
| `useScrollSampler` | hook | High-frequency scroll readings for an element or the window (F3, F4) |
| `useWorkerCanvas` | hook | OffscreenCanvas in a worker with flow control and coalescing (F7) |
| `defineCanvasWorker` | worker helper | Worker side of `useWorkerCanvas` (from `src/react/canvasWorker.ts`) |
| `SwipeableSheet` | component | Bottom sheet driven by native scrolling (F13) |
| `InputMeter` | component | Updates, unique values and speed for any scroller (F15) |
| `useSpring` | hook | Imperative (ζ, response) spring on the pump (F11) |
| `useDisplayBoost` | hook | ProMotion keep-alive during touches (F5) |
| `ScrollKeep` | component | URL-bar anti-throttle element (F6) |

Live usage of every export is in [`src/demos/components/ComponentsDemo.tsx`](../src/demos/components/ComponentsDemo.tsx)
(served at `/components`), with the chart worker in
[`chart.worker.ts`](../src/demos/components/chart.worker.ts).

---

## References

- The write-up this lab builds on:
  https://rida.dev/blog/bypassing-ios-safari-60-fps-limit
- React Aria, “Scrolling is All You Need: Building a Swipeable Sheet” (Devon Govett):
  https://react-aria.adobe.com/blog/sheet
- This repo’s glass demo (`/`) and React components demo (`/components`).
- WebKit: [bug 224133](https://bugs.webkit.org/show_bug.cgi?id=224133) (60 fps preference on by default),
  [bug 304358](https://bugs.webkit.org/show_bug.cgi?id=304358) (iOS display link at 60 fps with the preference on),
  [bug 272165](https://bugs.webkit.org/show_bug.cgi?id=272165), [bug 294338](https://bugs.webkit.org/show_bug.cgi?id=294338),
  [bug 267541](https://bugs.webkit.org/show_bug.cgi?id=267541), [bug 237168](https://bugs.webkit.org/show_bug.cgi?id=237168),
  [bug 244878](https://bugs.webkit.org/show_bug.cgi?id=244878), [bug 249116](https://bugs.webkit.org/show_bug.cgi?id=249116),
  [bug 325214](https://bugs.webkit.org/show_bug.cgi?id=325214).
- WHATWG HTML: [OffscreenCanvas](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface),
  [timers](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timer-initialisation-steps),
  [event loop processing model](https://html.spec.whatwg.org/multipage/webappapis.html#event-loop-processing-model).
- Support data: [MDN browser-compat-data](https://github.com/mdn/browser-compat-data), Apple’s Safari release notes, and
  WebKit’s [Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/) and
  [Safari 17.0](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/) posts.
