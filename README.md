# safari-120hz-lab

A lab for making web UI feel native at 120 Hz on iOS Safari, which caps pages at 60. Each experiment isolates one idea,
checks it, and turns what holds up into a React component: native scrolling as a 120 Hz input sensor, workers that
present `OffscreenCanvas` frames off the main thread, liquid glass drawn by WebGL2 shaders, and sheets driven by scroll
snapping.

It builds on the 60 FPS workaround as written [here](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit),
including its tuned spring, size and material constants, and on React Aria’s
[scroll-snap sheet](https://react-aria.adobe.com/blog/sheet).

**Read [docs/FINDINGS.md](docs/FINDINGS.md)**: every technique, how it works, how it was validated, the code that
implements it, and where it pays off in a product.

## Experiments

- **`/`: liquid glass at 120 Hz.** A reading-progress lens, a contents menu that grows into a frosted panel, and a tab
  bar, all drawn by WebGL2 shaders in a worker. The lens and the menu refract whatever passes under them, other
  canvases included. Two controller meters count scroll readings per second, so the 120 Hz claims can be checked on a
  phone.
- **`/components`: from experiment to component.** A chart you scrub with native momentum, input meters, and a
  swipeable sheet with an amount picker.
- **[`src/react/`](src/react/index.ts): the components.** `ScrollPad`, `useScrollSampler`, `useWorkerCanvas`
  (+ `defineCanvasWorker`), `SwipeableSheet`, `InputMeter`, `useSpring`, `useDisplayBoost` and `ScrollKeep`.

## Run

```bash
bun install
bun dev
```

A single-page React app on Vite (one `index.html`, routes in `src/main.tsx`). Vite runs on the Bun runtime
(`bun --bun vite`). Open the URL it prints (port 5173 by default). To try it on an iPhone, open the network URL Vite
prints (same Wi-Fi) in Safari. The glass demo needs iOS 17+ (WebGL2 in a worker). `bun run build` runs the typecheck and
the production build; serve `dist/` with an SPA fallback so `/components` resolves to `index.html`.

## Where each trick lives

| Trick | Files |
|---|---|
| High-frequency loop: vsync-aligned `MessageChannel` + `setTimeout`, empty rAF | `src/core/pump.ts`, `src/react/useScrollSampler.ts` |
| ProMotion boost: “pacer” scroller + 1 px animation | `src/core/boost.ts`, `src/react/useDisplayBoost.ts` |
| Native scrolling as a sensor (DPR× pads, snap cells, momentum halt) | `src/dock/dock.ts`, `src/readout/readout.ts`, `src/react/ScrollPad.tsx` |
| Rendering from a worker: `transferControlToOffscreen()` + flow control | `src/glass/client.ts`, `src/glass/glass.worker.ts`, `src/react/useWorkerCanvas.ts` |
| DOM re-render as a draw list, rasterized into a ring texture | `src/glass/snapshot.ts`, `Ring` in `src/glass/glass.worker.ts` |
| Live sources: other canvases composited into the glass backdrop | `feed()` / `connectPort()` in the glass worker, `linkDock()` in `src/demos/glass/boot.ts` |
| Shaders: SDFs, smooth union, refraction, aberration, frost, finish | `src/glass/shaders.ts` |
| Menu morph: seed → panel, kick, content scale and blur | `src/chrome/contents.ts` |
| Tab bar state machine: lift, squash, stretch, presence hand-off | `src/dock/dock.ts` |
| Swipeable sheet driven by native scroll snapping | `src/react/SwipeableSheet.tsx` |
| Controller meter (updates/s, unique values/s, speed, chart) | `src/readout/`, `src/react/InputMeter.tsx` |
| URL-bar anti-throttle (`animation-timeline: scroll()`) | `.scroll-keep` in `src/style.css`, `src/react/ScrollKeep.tsx` |
| Springs (dampingRatio, response) in closed form | `src/core/spring.ts`, `src/react/useSpring.ts` |

## Limitations

- The 120 Hz rendering path depends on undocumented WebKit behavior; Apple may change it. The off-main-thread benefits
  of the same techniques hold on every browser.
- The page re-render covers text, backgrounds and borders. Images and CSS gradients are not included.
- Outside Safari the loop uses plain rAF and the display boost stays off. Without WebGL2/OffscreenCanvas, the menu falls
  back to the DOM with `backdrop-filter`.
- Tested in Chromium with a phone-sized viewport. The 120 Hz figures are the ones reported in the write-up and
  still need to be checked on a real iPhone; the meters on both pages exist for exactly that.
