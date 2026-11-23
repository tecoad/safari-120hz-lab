// Messages between the main thread and the glass worker.

export type UniformValue = number | readonly number[]
export type Uniforms = Record<string, UniformValue>

/** Page rectangle (background, border, rule), in document CSS px. */
export interface RectItem {
  k: 0
  x: number
  y: number
  w: number
  h: number
  r: number
  c: string
}

/** Text word: x and baseline in document CSS px. */
export interface TextItem {
  k: 1
  x: number
  y: number
  top: number
  bottom: number
  t: string
  f: string
  c: string
}

export type DisplayItem = RectItem | TextItem

/** Draw op for the label texture (R or G channel). */
export type LabelOp =
  | { k: 'text'; x: number; y: number; t: string; font: string; ch: 0 | 1; maxW?: number }
  | {
      k: 'path'
      d: readonly string[]
      x: number
      y: number
      size: number
      vb: number
      stroke: number
      fill?: boolean
      cut?: readonly string[]
      ch: 0 | 1
    }
  | { k: 'rect'; x: number; y: number; w: number; h: number; r: number; ch: 0 | 1 }

export interface LabelSpec {
  width: number
  height: number
  scale: number
  ops: LabelOp[]
}

/** Region (canvas CSS px) to blur for the glass "frost". */
export interface FrostRegion {
  x: number
  y: number
  w: number
  h: number
  sigma: number
  cell: number
  gamma: number
}

export type SurfaceKind = 'page' | 'dock'

export type ToWorker =
  | {
      kind: 'init'
      id: string
      surface: SurfaceKind
      canvas: OffscreenCanvas
      width: number
      height: number
      dpr: number
      desync: boolean
    }
  | { kind: 'resize'; id: string; width: number; height: number; dpr: number }
  | { kind: 'page'; id: string; items: DisplayItem[]; docWidth: number; docHeight: number; ground: string }
  | { kind: 'labels'; id: string; spec: LabelSpec }
  | { kind: 'frame'; id: string; seq: number; uniforms: Uniforms; frost: FrostRegion | null; scrollY?: number }
  /** Links a surface (source) to another one's backdrop (sink): the source's
   *  pixels enter the sink's scene at `rect` (document CSS px). */
  | { kind: 'link'; id: string; source: string; rect: [number, number, number, number]; radius: number }
  /** Source in another worker: frames arrive over `port` (one ImageBitmap per region). */
  | { kind: 'port'; id: string; key: string; port: MessagePort; regions: SourceRegion[] }
  | { kind: 'regions'; id: string; key: string; regions: SourceRegion[] }

/** One canvas of an external source and where it sits in the document. */
export interface SourceRegion {
  name: string
  rect: [number, number, number, number]
  radius: number
}

/** Messages on the MessagePort between the glass (sink) and an external source. */
export type SinkToSource = { kind: 'want'; names: string[] }
export type SourceToSink = { kind: 'frame'; frames: { name: string; bitmap: ImageBitmap }[] }

export type FromWorker =
  | { kind: 'ready'; id: string; ok: boolean; reason?: string }
  | { kind: 'presented'; id: string; seq: number; ms: number }
