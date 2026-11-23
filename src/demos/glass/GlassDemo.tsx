// The glass demo page: the article, the contents menu, the reading indicator,
// the tab bar and two controller meters. React renders the markup once; the
// plain-TypeScript engine in ./boot.ts takes over the DOM after mount.

import { useEffect, useRef, type CSSProperties } from 'react'
import { bootGlassDemo } from './boot'

const WRITE_UP = 'https://rida.dev/blog/bypassing-ios-safari-60-fps-limit'

function Meter({ kind, caption }: { kind: 'standard' | 'precise'; caption: string }) {
  const swatch = (c: string) => <span className="readout-swatch" style={{ '--c': c } as CSSProperties} />
  return (
    <figure className="my-8" data-readout={kind}>
      <div className="readout">
        <div className="readout-panel">
          <div className="readout-plane" />
          <dl className="readout-legend">
            <div>
              <dt>
                <span className="readout-key">
                  <span className="readout-dot" />
                </span>
                Position
              </dt>
              <dd>0.00, 0.00</dd>
            </div>
            <div>
              <dt>
                <span className="readout-key">{swatch('#f5f5f3')}</span>
                Updates
              </dt>
              <dd>0/s</dd>
            </div>
            <div>
              <dt>
                <span className="readout-key">{swatch('#34c759')}</span>
                Unique values
              </dt>
              <dd>0/s</dd>
            </div>
            <div>
              <dt>
                <span className="readout-key">{swatch('#ff9500')}</span>
                Speed
              </dt>
              <dd>0 pt/s</dd>
            </div>
          </dl>
          <div className="readout-plot" />
        </div>
        <div className="readout-box">
          <div className="readout-scroller" aria-label="Controller: drag the grid">
            <div className="readout-sheet" />
          </div>
          <span className="readout-tag">✥ Drag</span>
        </div>
      </div>
      <figcaption className="mt-2 text-[13px] text-(--color-muted)">{caption}</figcaption>
    </figure>
  )
}

export function GlassDemo() {
  const scope = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scope.current) bootGlassDemo(scope.current)
  }, [])

  return (
    <div ref={scope}>
      <main data-glass-page className="mx-auto w-full max-w-[640px] px-5 pt-28 pb-48">
        <article className="prose-probe">
          <header>
            <p className="mb-3 text-[13px] font-medium tracking-wide text-(--color-muted) uppercase">safari-120hz-lab · Glass</p>
            <h1 id="top">Liquid Glass at 120 Hz in iOS Safari</h1>
            <p className="mt-1 text-[15px] text-(--color-muted)">
              Can glass UI on a web page keep up with a 120 Hz display? An experiment with native scroll as input and shaders in
              workers. The reusable parts are packaged as React components on <a href="/components">/components</a>.
            </p>
          </header>

          <p>
            The experiment puts three pieces of interface to the test: the <strong>reading-progress indicator</strong> in the top-left
            corner, the <strong>contents menu</strong> in the top-right corner, and the <strong>tab bar</strong> further down. All three are
            glass drawn by a WebGL2 shader running in a worker. Open it in Safari on an iPhone to see the difference.
          </p>
          <p>
            Scroll and watch the indicator: the text under it bends near the edge, with colored fringes. Tap the list button: it grows into a
            frosted glass panel, and the table of contents inside it is drawn by the shader too.
          </p>

          <h2 id="the-problem">The problem: everything is stuck at 60 Hz</h2>
          <p>
            The iPhone has a 120 Hz display, but Safari caps websites at 60. <code>requestAnimationFrame</code> runs 60 times per second,
            touch events arrive 60 times per second, and the DOM is painted 60 times per second. Dragging something on a web page feels
            heavier than in a native app.
          </p>
          <h3 id="where-the-limit-lives">Where the limit lives</h3>
          <p>
            The cap applies to the <em>main thread</em>, where the page’s JavaScript runs. Two things escape it: native scrolling, which runs
            in the compositor, and the frames of an <code>OffscreenCanvas</code>, which don’t wait for the page’s rendering update. The whole
            trick is to use those two exits.
          </p>

          <h2 id="input">Input: native scrolling as a sensor</h2>
          <p>
            Instead of listening to touch events, each control has an invisible scroller under the finger. iOS itself does the dragging, at
            120 Hz. The code only has to read <code>scrollLeft</code> and <code>scrollTop</code> fast enough.
          </p>
          <h3 id="reading-faster">Reading faster than the events</h3>
          <p>
            The <code>scroll</code> event fires only a few times per second during momentum. The fix is a custom loop: a{' '}
            <code>MessageChannel</code> schedules a <code>setTimeout</code> for every half frame at 120 Hz, aligned to the latest vsync
            timestamp. Because the timer is created inside a message event, it doesn’t inherit any timer nesting, so it escapes the 4 ms clamp
            on nested timers.
          </p>
          <pre>
            <code>{`const slot = 1000 / 120 / 2
next = vsync + Math.ceil((now - vsync + 1) / slot) * slot - 1
setTimeout(read, next - now)`}</code>
          </pre>
          <p>
            You can measure it. Drag the grid on the right: it is a native scroller, and the panel shows how many fresh readings arrive per
            second, how many of them carry a different position, and how fast the finger moves. The panel is drawn in a worker; otherwise it
            would be stuck at 60 Hz itself.
          </p>
          <Meter
            kind="standard"
            caption="Controller meter. Updates = fresh positions read per second (500 ms window); unique values = distinct positions; speed from the samples of the last 80 ms."
          />
          <h3 id="ipc-bottleneck">The bottleneck between processes</h3>
          <p>
            Safari’s UI process only sends a new scroll position after the previous one has been acknowledged. Positions in between are lost.
            An empty <code>requestAnimationFrame</code> loop keeps a rendering update queued, and with that WebKit flushes the position
            without waiting.
          </p>
          <h3 id="promotion">Keeping ProMotion awake</h3>
          <p>
            The display only goes up to 120 Hz when something needs it. While a finger is on the screen, an 8 px scroller smooth-scrolls back
            and forth every 250 ms, and a 1 px element runs an infinite CSS animation. Both stop one second after the last touch.
          </p>
          <h3 id="sub-point">Sub-point precision</h3>
          <p>
            <code>scrollLeft</code> is rounded to an integer. The scrollers are created at their size multiplied by the device pixel ratio and
            scaled back down with <code>transform: scale()</code>, so each scroll unit is worth one physical pixel.
          </p>
          <Meter kind="precise" caption="Precise version: the scroller is multiplied by the device pixel ratio, so the position shows fractions of a point." />

          <h2 id="output">Output: OffscreenCanvas</h2>
          <p>
            Reading the finger at 120 Hz doesn’t help if the screen only shows 60 frames. With <code>canvas.transferControlToOffscreen()</code>,
            the canvas becomes a placeholder and the drawing happens in a worker. WebKit presents those frames without waiting for the page’s
            rendering update, and the glass reaches 120 fps.
          </p>
          <blockquote>This behavior is undocumented. Apple could change it without violating the specification.</blockquote>

          <h2 id="glass">Glass without reading pixels</h2>
          <p>
            A page can’t read its own pixels, so the glass has nothing to refract. The fix is to redo the layout: the DOM becomes a list of
            words and rectangles with their positions, and the worker rasterizes only the band near the screen into a ring-buffer texture. The
            shader samples that texture with refraction, chromatic aberration, and blur.
          </p>
          <ul>
            <li>Refraction: near the edge, the sample moves along the shape’s normal.</li>
            <li>Aberration: the red and blue channels move a little less and a little more.</li>
            <li>Frost: the region under the panel is downsampled and run through a separable Gaussian.</li>
            <li>Finish: inner shade, a bevel highlight, and a thin line just outside the edge.</li>
          </ul>

          <h2 id="tab-bar">The tab bar</h2>
          <p>
            Each tab is a native scroller with 97 snap cells. On touch, the lens grows and lifts. On drag, it follows the finger and squashes
            with speed. On release, it settles on the nearest tab. Pulling past the bar stretches the glass toward the finger, and the search
            button fuses with the bar when the two get close.
          </p>

          <figure className="my-8">
            <div className="mb-2 flex items-center justify-between text-[13px] text-(--color-muted)">
              <span>Tap and drag the tabs</span>
              <span data-dock-readout className="font-mono text-[11px]" />
            </div>
            <div data-dock-stage className="dock-stage rounded-2xl">
              <canvas aria-hidden="true" />
            </div>
            <figcaption className="mt-2 text-[13px] text-(--color-muted)">
              A magnifying lens with a chromatic fringe, a resting pill, and fusion with the search button.
            </figcaption>
          </figure>

          <h3 id="state-machine">State machine</h3>
          <p>
            The controls only send timestamped events: pressed, moved, pulled, released. Everything else is derived from them on every frame:
            the lens position, how far it has lifted, how far the bar has stretched, and how visible the pill is. The springs use Apple’s
            format, a damping ratio and a response time.
          </p>
          <h3 id="shaders">Shaders</h3>
          <p>
            The bar, the button, the pill, and the lens are shapes defined by signed distance. The bar and the button merge with a polynomial
            smooth union. The icons come from a two-channel texture: red holds the outline and green holds the filled version, which only shows
            under the pill or the lens.
          </p>

          <h2 id="limitations">Limitations</h2>
          <p>
            All of this depends on undocumented WebKit behavior, so it’s no foundation for a whole app, and native ProMotion support for
            websites would make it unnecessary. This is a lab: the goal is to understand the pieces and keep the ones that hold up.
          </p>
          <p>
            Outside Safari, the loop uses a plain <code>requestAnimationFrame</code> and the display boost stays off. Without WebGL2 or{' '}
            <code>OffscreenCanvas</code>, the menu falls back to a DOM version with <code>backdrop-filter</code>.
          </p>
          <p className="text-[15px] text-(--color-muted)">
            Builds on the 60 FPS workaround as written <a href={WRITE_UP}>here</a>, including its spring, size and material constants.
          </p>
        </article>
      </main>

      <div className="post-contents" data-post-contents>
        <button className="post-contents-button" type="button" aria-label="Table of contents" aria-expanded="false" aria-controls="post-contents-panel">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
            <circle cx="5.4" cy="7" r="0.8" fill="currentColor" />
            <circle cx="5.4" cy="13" r="0.8" fill="currentColor" />
            <circle cx="5.4" cy="19" r="0.8" fill="currentColor" />
            <path d="M10.4 7h11.2M10.4 13h11.2M10.4 19h11.2" />
          </svg>
        </button>
        <div className="post-contents-panel" id="post-contents-panel" inert>
          <div className="post-contents-scroller">
            <div className="post-contents-list" />
          </div>
        </div>
      </div>
      <div className="post-contents-scrim" hidden />
      <canvas className="glass-canvas" aria-hidden="true" />
      <div className="scroll-keep" aria-hidden="true" />
      <div
        data-hud
        className="pointer-events-none fixed bottom-[max(12px,env(safe-area-inset-bottom))] left-3 z-30 rounded-full bg-black/70 px-3 py-1 font-mono text-[11px] text-white"
      />
    </div>
  )
}
