# safari-120hz-lab

A study of how to make web UI feel native at 120 Hz on iOS Safari, built by reverse engineering
[“Bypassing iOS Safari’s 60 FPS Limit”](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit) by Rida F’kih and
React Aria’s [“Scrolling is All You Need”](https://react-aria.adobe.com/blog/sheet) sheet.

**Read [docs/FINDINGS.md](docs/FINDINGS.md)**: every technique, how it works, how it was validated, the code that
implements it, and where it pays off in a product.

## What’s inside

- **`/`: the glass demo.** The reading-progress indicator, the contents menu and the tab bar from the original article,
  drawn by WebGL2 shaders in a worker, plus two controller meters that count scroll readings per second.
- **`/components`: reusable React components.** A chart you scrub with native momentum, input meters, and a swipeable
  sheet with an amount picker.
- **[`src/react/`](src/react/index.ts): the components themselves.** `ScrollPad`, `useScrollSampler`,
  `useWorkerCanvas` (+ `defineCanvasWorker`), `SwipeableSheet`, `InputMeter`, `useSpring`, `useDisplayBoost` and
  `ScrollKeep`.

The original author didn’t publish their source. This code is original, written from the article and from reading the
site’s public bundles (spring, size and material constants come from there).

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
- Tested in Chromium with a phone-sized viewport. The 120 Hz numbers come from the original author’s measurements and
  still need to be checked on a real iPhone; the meters on both pages exist for exactly that.
