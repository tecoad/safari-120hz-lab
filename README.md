# safari-120hz-lab

A local study that reproduces the three glass elements from
[“Bypassing iOS Safari’s 60 FPS Limit”](https://rida.dev/blog/bypassing-ios-safari-60-fps-limit) by Rida F’kih:

- the **reading-progress indicator** (top-left capsule);
- the **contents menu** (top-right button that grows into a frosted panel);
- the **tab bar** with a magnifying lens, a resting pill and a search button (demo in the middle of the article);

plus the **controller meter** that measures how many scroll readings per second actually arrive.

The original author didn’t publish their source. This code is original, written from the article and from reading the
site’s public bundles (spring, size and material constants come from there).

## Run

```bash
bun install
bun dev
```

Vite runs on the Bun runtime (`bun --bun vite`). Open the URL Vite prints (port 5173 by default). To try it on an
iPhone, open the network URL Vite prints (same Wi-Fi) in Safari. Requires iOS 17 or later (WebGL2 in an
`OffscreenCanvas` inside a worker). `bun run build` runs the typecheck and the production build.

The HUD in the bottom-left corner shows scroll readings per second and glass frames per second. The tab bar demo shows
input readings and fps above it, and the two controller meters show updates, unique values and speed.

## Where each trick lives

| Trick | File |
|---|---|
| High-frequency loop: vsync-aligned `MessageChannel` + `setTimeout`, empty rAF | `src/core/pump.ts` |
| ProMotion boost: “pacer” scroller + 1 px animation | `src/core/boost.ts` |
| Native scrolling as a sensor (DPR× pads, snap cells, momentum halt) | `src/dock/dock.ts`, `src/readout/readout.ts` |
| 120 Hz rendering: `transferControlToOffscreen()` + WebGL2 in a worker | `src/glass/client.ts`, `src/glass/glass.worker.ts` |
| DOM re-render as a draw list, rasterized into a ring texture | `src/glass/snapshot.ts`, `Ring` in the worker |
| Live sources: other canvases composited into the glass backdrop | `feed()` and `connectPort()` in the worker, `linkDock()` in `src/main.ts` |
| Shaders: SDFs, smooth union, refraction, aberration, frost, finish | `src/glass/shaders.ts` |
| Menu: seed → panel morph, kick, content scale and blur | `src/chrome/contents.ts` |
| Controller meter (updates/s, unique values/s, speed, chart) | `src/readout/` |
| URL-bar anti-throttle (`animation-timeline: scroll()`) | `src/style.css` (`.scroll-keep`) |
| Springs (dampingRatio, response) in closed form | `src/core/spring.ts` |

## Limitations

- Depends on undocumented WebKit behavior; Apple may change it.
- The page re-render covers text, backgrounds and borders. Images and CSS gradients are not included.
- Outside Safari the loop uses plain rAF and the display boost stays off.
- Without WebGL2/OffscreenCanvas, the menu falls back to the DOM with `backdrop-filter`.
- Tested in Chromium with a phone-sized viewport. The 120 Hz numbers come from the original author’s measurements and
  still need to be checked on a real iPhone (the meters on the page exist for exactly that).
