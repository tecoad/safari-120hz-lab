// Messages between the meter (main thread) and the worker that draws it.

export interface ReadoutLayout {
  dpr: number
  plane: { w: number; h: number }
  values: { w: number; h: number; rows: { x: number; y: number }[] }
  plot: { w: number; h: number }
  font: string
}

export type ToReadout =
  | {
      type: 'start'
      plane: OffscreenCanvas
      values: OffscreenCanvas
      plot: OffscreenCanvas
      layout: ReadoutLayout
    }
  | { type: 'layout'; layout: ReadoutLayout }
  /** A fresh controller reading. `at` in absolute ms (timeOrigin + now). */
  | { type: 'sample'; x: number; y: number; at: number }
  /** Direct port to the glass worker: the meter becomes a refraction source. */
  | { type: 'refraction'; port: MessagePort }
