// Worker-side half of useWorkerCanvas. Import it from your worker file:
//
//   import { defineCanvasWorker } from '../react/canvasWorker'
//   defineCanvasWorker<Frame>({
//     init: ({ canvas }) => { ctx = canvas.getContext('2d')! },
//     draw: ({ width, height, dpr }, frame) => { ... },
//   })
//
// It sizes the canvas to CSS size × DPR, redraws the last frame on resize, and
// acknowledges every frame with "presented" so the main thread can keep at most
// two frames in flight.

export interface CanvasWorkerContext {
  canvas: OffscreenCanvas
  /** CSS px. */
  width: number
  height: number
  dpr: number
}

export interface CanvasWorkerHandlers<F> {
  init: (ctx: CanvasWorkerContext) => void
  draw: (ctx: CanvasWorkerContext, frame: F) => void
  resize?: (ctx: CanvasWorkerContext) => void
}

type Incoming<F> =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'frame'; frame: F }

const scope = globalThis as unknown as {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void
}

export function defineCanvasWorker<F>(handlers: CanvasWorkerHandlers<F>) {
  let ctx: CanvasWorkerContext | null = null
  let last: F | null = null

  const applySize = (c: CanvasWorkerContext) => {
    const w = Math.max(1, Math.round(c.width * c.dpr))
    const h = Math.max(1, Math.round(c.height * c.dpr))
    if (c.canvas.width !== w) c.canvas.width = w
    if (c.canvas.height !== h) c.canvas.height = h
  }

  scope.addEventListener('message', (e: MessageEvent<Incoming<F>>) => {
    const msg = e.data
    if (msg.type === 'init') {
      ctx = { canvas: msg.canvas, width: msg.width, height: msg.height, dpr: msg.dpr }
      applySize(ctx)
      handlers.init(ctx)
      scope.postMessage({ type: 'ready' })
    } else if (msg.type === 'resize' && ctx) {
      ctx.width = msg.width
      ctx.height = msg.height
      ctx.dpr = msg.dpr
      applySize(ctx)
      handlers.resize?.(ctx)
      if (last !== null) handlers.draw(ctx, last)
    } else if (msg.type === 'frame' && ctx) {
      last = msg.frame
      handlers.draw(ctx, msg.frame)
      scope.postMessage({ type: 'presented' })
    }
  })
}
