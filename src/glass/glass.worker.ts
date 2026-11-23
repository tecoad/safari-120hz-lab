// Glass worker: receives canvases via transferControlToOffscreen() and draws
// them with WebGL2 in here. The article's key trick: WebKit presents frames from
// an OffscreenCanvas without waiting for the main thread's rendering update
// (capped at 60 Hz), so this worker can deliver 120 frames per second.

import { blankTexture, createTarget, deleteTarget, Program, type Target } from './gl'
import type { DisplayItem, FromWorker, FrostRegion, LabelSpec, RectItem, SinkToSource, SourceRegion, SourceToSink, SurfaceKind, TextItem, ToWorker, Uniforms } from './protocol'
import { BLUR_FS, DOCK_FS, DOWNSAMPLE_GRID_FS, DOWNSAMPLE_PAGE_FS, FULLSCREEN_VS, PAGE_FS } from './shaders'

const scope = self as unknown as {
  postMessage(m: FromWorker): void
  addEventListener(type: 'message', fn: (e: MessageEvent<ToWorker>) => void): void
}

// ---------------------------------------------------------------------------
// Ring texture holding the page "re-render".
// A page can't read its own pixels, so the DOM is re-laid out as a draw list
// and rasterized in the worker: the main thread sends words
// and rectangles with positions; the worker rasterizes only the band near the
// viewport into a ring buffer (new rows come in as the scroll moves).

const RING_MARGIN = 360 // CSS px above/below the viewport
const NEED_MARGIN = 96 // the glass samples up to ~frost+refraction beyond its shape
const CHUNK = 192 // rasterize ahead in chunks
const STRIP_ROWS = 512
const MAX_TEXT_HEIGHT = 64

class Ring {
  tex: WebGLTexture
  W = 1
  H = 1
  s = 1
  docWidth = 1
  private rects: RectItem[] = []
  private texts: TextItem[] = []
  private ground = '#000'
  private valid = false
  private top = 0 // device rows (document space)
  private bottom = 0
  private scratch: OffscreenCanvas
  private ctx: OffscreenCanvasRenderingContext2D
  private gl: WebGL2RenderingContext
  private maxTex: number

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    this.tex = gl.createTexture()!
    this.scratch = new OffscreenCanvas(1, STRIP_ROWS)
    this.ctx = this.scratch.getContext('2d', { willReadFrequently: true, alpha: false })!
  }

  setup(viewW: number, viewH: number, dpr: number) {
    const gl = this.gl
    this.s = dpr
    this.docWidth = viewW
    this.W = Math.min(this.maxTex, Math.ceil(viewW * dpr))
    this.H = Math.min(this.maxTex, Math.ceil((viewH + RING_MARGIN * 2) * dpr))
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.W, this.H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
    this.scratch.width = this.W
    this.scratch.height = STRIP_ROWS
    this.valid = false
  }

  setList(items: DisplayItem[], ground: string) {
    this.rects = items.filter((i): i is RectItem => i.k === 0)
    this.texts = items.filter((i): i is TextItem => i.k === 1).sort((a, b) => a.top - b.top)
    this.ground = ground
    this.valid = false
  }

  get hasContent() {
    return this.rects.length + this.texts.length > 0
  }

  ensure(scrollY: number, viewH: number) {
    const s = this.s
    const a = Math.max(0, Math.floor((scrollY - NEED_MARGIN) * s))
    const b = Math.ceil((scrollY + viewH + NEED_MARGIN) * s)
    const H = this.H
    const chunk = Math.round(CHUNK * s)
    if (!this.valid || a < this.top - H / 2 || b > this.bottom + H / 2) {
      const center = (a + b) / 2
      const top = Math.max(0, Math.round(center - H / 2))
      this.raster(top, top + H)
      this.top = top
      this.bottom = top + H
      this.valid = true
      return
    }
    if (b > this.bottom) {
      const nb = b + chunk
      this.raster(this.bottom, nb)
      this.bottom = nb
      this.top = Math.max(this.top, nb - H)
    }
    if (a < this.top) {
      const na = Math.max(0, a - chunk)
      this.raster(na, this.top)
      this.top = na
      this.bottom = Math.min(this.bottom, na + H)
    }
  }

  private raster(a: number, b: number) {
    while (a < b) {
      const ringRow = a % this.H
      const n = Math.min(b - a, this.H - ringRow, STRIP_ROWS)
      this.drawRows(a, n, ringRow)
      a += n
    }
  }

  private drawRows(row: number, n: number, ringRow: number) {
    const { ctx, s, gl } = this
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = this.ground
    ctx.fillRect(0, 0, this.W, n)
    ctx.setTransform(s, 0, 0, s, 0, -row)
    const y0 = row / s
    const y1 = (row + n) / s
    for (const r of this.rects) {
      if (r.y > y1 || r.y + r.h < y0) continue
      ctx.fillStyle = r.c
      if (r.r > 0) {
        ctx.beginPath()
        ctx.roundRect(r.x, r.y, r.w, r.h, r.r)
        ctx.fill()
      } else ctx.fillRect(r.x, r.y, r.w, r.h)
    }
    const texts = this.texts
    let lo = 0
    let hi = texts.length
    const start = y0 - MAX_TEXT_HEIGHT
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (texts[mid].top < start) lo = mid + 1
      else hi = mid
    }
    let font = ''
    let color = ''
    for (let i = lo; i < texts.length; i++) {
      const t = texts[i]
      if (t.top > y1) break
      if (t.bottom < y0) continue
      if (t.f !== font) ctx.font = font = t.f
      if (t.c !== color) ctx.fillStyle = color = t.c
      ctx.fillText(t.t, t.x, t.y)
    }
    const img = ctx.getImageData(0, 0, this.W, n)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, ringRow, this.W, n, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength))
  }
}

// ---------------------------------------------------------------------------
// Label texture: R and G drawn additively on black.

function rasterLabels(spec: LabelSpec) {
  const w = Math.max(1, Math.ceil(spec.width * spec.scale))
  const h = Math.max(1, Math.ceil(spec.height * spec.scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'lighter'
  ctx.scale(spec.scale, spec.scale)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const op of spec.ops) {
    const color = op.ch === 0 ? '#ff0000' : '#00ff00'
    if (op.k === 'text') {
      ctx.font = op.font
      ctx.fillStyle = color
      let text = op.t
      if (op.maxW && ctx.measureText(text).width > op.maxW) {
        let lo = 0
        let hi = text.length
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (ctx.measureText(text.slice(0, mid) + '…').width <= op.maxW) lo = mid
          else hi = mid - 1
        }
        text = text.slice(0, lo).trimEnd() + '…'
      }
      ctx.fillText(text, op.x, op.y)
    } else if (op.k === 'path') {
      const k = op.size / op.vb
      if (op.fill) {
        // filled with cut-outs: draw on its own layer, then add it to the channel
        const side = Math.ceil((op.size + 4) * spec.scale)
        const layer = new OffscreenCanvas(side, side)
        const lc = layer.getContext('2d')!
        lc.scale(spec.scale, spec.scale)
        lc.translate(2, 2)
        lc.scale(k, k)
        lc.fillStyle = color
        lc.strokeStyle = color
        lc.lineCap = 'round'
        lc.lineJoin = 'round'
        lc.lineWidth = op.stroke / k
        for (const d of op.d) lc.fill(new Path2D(d))
        if (op.cut) {
          lc.globalCompositeOperation = 'destination-out'
          for (const d of op.cut) lc.stroke(new Path2D(d))
        }
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.drawImage(layer, Math.round((op.x - 2) * spec.scale), Math.round((op.y - 2) * spec.scale))
        ctx.restore()
      } else {
        ctx.save()
        ctx.translate(op.x, op.y)
        ctx.scale(k, k)
        ctx.lineWidth = op.stroke / k
        ctx.strokeStyle = color
        for (const d of op.d) ctx.stroke(new Path2D(d))
        ctx.restore()
      }
    } else {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.roundRect(op.x, op.y, op.w, op.h, op.r)
      ctx.fill()
    }
  }
  return canvas
}

// ---------------------------------------------------------------------------

class Surface {
  id = ''
  readonly gl: WebGL2RenderingContext
  readonly kind: SurfaceKind
  private canvas: OffscreenCanvas
  private main: Program
  private down: Program
  private blur: Program
  private vao: WebGLVertexArrayObject
  private ring: Ring | null = null
  private labelTex: WebGLTexture
  private labelSize: [number, number] = [1, 1]
  private blank: WebGLTexture
  private frostA: Target | null = null
  private frostB: Target | null = null
  width = 1
  height = 1
  dpr = 1
  /** Last frame drawn (to redraw without the main thread). */
  last: { uniforms: Uniforms; frost: FrostRegion | null; scrollY: number } | null = null
  /** When this surface is a source: who it delivers pixels to. */
  links: Link[] = []
  /** When it is a sink: the live captures of its sources. */
  private srcs = new Map<string, { tex: WebGLTexture; crop: number[]; rect: number[]; radius: number }>()

  get canvasRef() {
    return this.canvas
  }

  redrawLast() {
    if (this.last) this.draw(this.last.uniforms, this.last.frost, this.last.scrollY)
  }

  /** Document rect this canvas's glass may sample: the canvas plus a margin. */
  neededRect(margin: number): [number, number, number, number] | null {
    if (!this.last) return null
    const sc = this.last.uniforms.scroll as readonly number[] | undefined
    const x = sc?.[0] ?? 0
    const y = this.last.scrollY
    return [x - margin, y - margin, x + this.width + margin, y + this.height + margin]
  }

  setSource(key: string, bmp: ImageBitmap, crop: number[], rect: number[], radius: number) {
    const gl = this.gl
    let src = this.srcs.get(key)
    if (!src) {
      if (this.srcs.size >= MAX_SOURCES) return
      src = { tex: gl.createTexture()!, crop, rect, radius }
      this.srcs.set(key, src)
    }
    gl.bindTexture(gl.TEXTURE_2D, src.tex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    src.crop = crop
    src.rect = rect
    src.radius = radius
  }

  clearSource(key: string) {
    const src = this.srcs.get(key)
    if (!src || src.crop[2] === 0) return false
    src.crop = [0, 0, 0, 0]
    return true
  }

  constructor(canvas: OffscreenCanvas, kind: SurfaceKind, desync: boolean) {
    this.canvas = canvas
    this.kind = kind
    const gl = canvas.getContext('webgl2', {
      alpha: kind === 'page',
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: desync,
    } as WebGLContextAttributes) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 unavailable in the worker')
    this.gl = gl
    this.vao = gl.createVertexArray()!
    this.main = new Program(gl, FULLSCREEN_VS, kind === 'page' ? PAGE_FS : DOCK_FS, `${kind}:main`)
    this.down = new Program(gl, FULLSCREEN_VS, kind === 'page' ? DOWNSAMPLE_PAGE_FS : DOWNSAMPLE_GRID_FS, `${kind}:down`)
    this.blur = new Program(gl, FULLSCREEN_VS, BLUR_FS, 'blur')
    this.blank = blankTexture(gl)
    this.labelTex = this.blank
    if (kind === 'page') this.ring = new Ring(gl)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
  }

  resize(width: number, height: number, dpr: number) {
    this.width = width
    this.height = height
    this.dpr = dpr
    this.canvas.width = Math.max(1, Math.round(width * dpr))
    this.canvas.height = Math.max(1, Math.round(height * dpr))
    this.ring?.setup(width, height, dpr)
  }

  setPage(items: DisplayItem[], ground: string) {
    this.ring?.setList(items, ground)
  }

  setLabels(spec: LabelSpec) {
    const gl = this.gl
    const canvas = rasterLabels(spec)
    if (this.labelTex === this.blank) this.labelTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.labelTex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.labelSize = [spec.width, spec.height]
  }

  private ensureFrost(tw: number, th: number) {
    const gl = this.gl
    const need = (t: Target | null) => !t || t.w < tw || t.h < th
    if (need(this.frostA) || need(this.frostB)) {
      const w = Math.max(tw, this.frostA?.w ?? 0, 64)
      const h = Math.max(th, this.frostA?.h ?? 0, 64)
      deleteTarget(gl, this.frostA)
      deleteTarget(gl, this.frostB)
      this.frostA = createTarget(gl, w, h)
      this.frostB = createTarget(gl, w, h)
    }
    return [this.frostA!, this.frostB!] as const
  }

  private drawTriangle() {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3)
  }

  draw(uniforms: Uniforms, frost: FrostRegion | null, scrollY: number) {
    const gl = this.gl
    gl.bindVertexArray(this.vao)
    const shared: Uniforms = { view: [this.width, this.height], scale: this.dpr }
    if (this.ring) {
      if (this.ring.hasContent) this.ring.ensure(scrollY, this.height)
      shared.ringSize = [this.ring.W, this.ring.H]
      shared.ringScale = this.ring.s
      shared.docWidth = this.ring.docWidth
    }
    const srcList = [...this.srcs.values()]
    const crops: number[] = []
    const rects: number[] = []
    const radii: number[] = []
    for (let i = 0; i < MAX_SOURCES; i++) {
      const src = srcList[i]
      crops.push(...(src ? src.crop : [0, 0, 0, 0]))
      rects.push(...(src ? src.rect : [0, 0, 0, 0]))
      radii.push(src ? src.radius : 0)
      gl.activeTexture(gl.TEXTURE3 + i)
      gl.bindTexture(gl.TEXTURE_2D, src ? src.tex : this.blank)
      shared[`srcTex${i}`] = 3 + i
    }
    shared.srcCrop = crops
    shared.srcRect = rects
    shared.srcRadius = radii
    shared.srcCount = srcList.length
    this.last = { uniforms, frost, scrollY }

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.ring ? this.ring.tex : this.blank)

    let frostU: Uniforms = { frostLive: 0 }
    if (frost && frost.w > 1 && frost.h > 1) {
      const tw = Math.max(1, Math.ceil(frost.w / frost.cell))
      const th = Math.max(1, Math.ceil(frost.h / frost.cell))
      const [A, B] = this.ensureFrost(tw, th)
      // 1) downsample the scene
      gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo)
      gl.viewport(0, 0, tw, th)
      this.down.use()
      this.down.setAll(uniforms)
      this.down.setAll(shared)
      this.down.set('ringTex', 0)
      this.down.set('passOrigin', [frost.x, frost.y])
      this.down.set('passCell', [frost.w / tw, frost.h / th])
      this.down.set('passGamma', frost.gamma)
      this.drawTriangle()
      // 2) horizontal and vertical Gaussian
      const sigma = frost.sigma / (frost.w / tw)
      this.blur.use()
      this.blur.set('texSize', [A.w, A.h])
      this.blur.set('limit', [tw / A.w, th / A.h])
      this.blur.set('sigma', sigma)
      this.blur.set('src', 1)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbo)
      gl.bindTexture(gl.TEXTURE_2D, A.tex)
      this.blur.set('dir', [1, 0])
      this.drawTriangle()
      gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo)
      gl.bindTexture(gl.TEXTURE_2D, B.tex)
      this.blur.set('dir', [0, 1])
      this.drawTriangle()
      gl.bindTexture(gl.TEXTURE_2D, A.tex)
      frostU = {
        frostLive: 1,
        frostOrigin: [frost.x, frost.y],
        frostSize: [frost.w, frost.h],
        frostUV: [tw / A.w, th / A.h],
        frostGamma: frost.gamma,
      }
    } else {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.blank)
    }

    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.labelTex)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    this.main.use()
    this.main.setAll(uniforms)
    this.main.setAll(shared)
    this.main.setAll(frostU)
    this.main.set('ringTex', 0)
    this.main.set('frostTex', 1)
    this.main.set('labelTex', 2)
    this.main.set('labelSize', this.labelSize)
    this.drawTriangle()
  }
}

const surfaces = new Map<string, Surface>()

// ---------------------------------------------------------------------------
// Live sources ("refraction sources"): a canvas drawn here (the tab bar)
// delivers its pixels to the page glass's backdrop. Both surfaces share this
// worker, so capturing and uploading a texture is enough; canvases in other
// workers arrive over a MessagePort (PortSource, below).
// Only the region the page glass can sample is captured (its "demand"), and
// only right after drawing: with preserveDrawingBuffer=false the buffer is no
// longer valid after the commit.

interface Link {
  sink: string
  rect: [number, number, number, number]
  radius: number
  pending: boolean
  dirty: boolean
  key: string
}

const SOURCE_MARGIN = 96
const MAX_SOURCES = 6

function cropFor(source: Surface, link: Link) {
  const sink = surfaces.get(link.sink)
  const need = sink?.neededRect(SOURCE_MARGIN)
  if (!sink || !need) return null
  const [rx, ry, rw, rh] = link.rect
  const x0 = Math.max(rx, need[0])
  const y0 = Math.max(ry, need[1])
  const x1 = Math.min(rx + rw, need[2])
  const y1 = Math.min(ry + rh, need[3])
  if (x1 <= x0 || y1 <= y0) return { sink, empty: true as const }
  const k = source.dpr
  const cw = source.canvasRef.width
  const ch = source.canvasRef.height
  const sx = Math.min(cw - 1, Math.max(0, Math.floor((x0 - rx) * k)))
  const sy = Math.min(ch - 1, Math.max(0, Math.floor((y0 - ry) * k)))
  const ex = Math.min(cw, Math.max(sx + 1, Math.ceil((x1 - rx) * k)))
  const ey = Math.min(ch, Math.max(sy + 1, Math.ceil((y1 - ry) * k)))
  const crop = [rx + sx / k, ry + sy / k, (ex - sx) / k, (ey - sy) / k]
  return { sink, empty: false as const, sx, sy, sw: ex - sx, sh: ey - sy, crop, key: `${sx},${sy},${ex},${ey}` }
}

/** Call right after `source` draws. */
function feed(source: Surface) {
  for (const link of source.links) {
    const c = cropFor(source, link)
    if (!c) continue
    if (c.empty) {
      link.key = ''
      if (c.sink.clearSource(`surface:${source.id}`)) c.sink.redrawLast()
      continue
    }
    if (link.pending) {
      link.dirty = true
      continue
    }
    link.pending = true
    link.key = c.key
    createImageBitmap(source.canvasRef, c.sx, c.sy, c.sw, c.sh)
      .then((bmp) => {
        link.pending = false
        const sink = surfaces.get(link.sink)
        if (sink) {
          sink.setSource(`surface:${source.id}`, bmp, c.crop, link.rect, link.radius)
          sink.redrawLast()
        }
        bmp.close()
        if (link.dirty) {
          link.dirty = false
          source.redrawLast()
          feed(source)
        }
      })
      .catch(() => {
        link.pending = false
      })
  }
}

/** After a sink draws: if the region it needs changed, request a fresh capture. */
function refreshSourcesOf(sinkId: string) {
  for (const s of surfaces.values()) {
    for (const link of s.links) {
      if (link.sink !== sinkId || link.pending) continue
      const c = cropFor(s, link)
      if (!c) continue
      if ((c.empty ? '' : c.key) !== link.key) {
        s.redrawLast()
        feed(s)
      }
    }
  }
  for (const ps of portSources.values()) if (ps.sink === sinkId) updateWants(ps)
}

// Sources in other workers (the meter): the glass says which canvases it wants
// ("want") based on what is under it; the source answers with frames.
interface PortSource {
  sink: string
  key: string
  port: MessagePort
  regions: (SourceRegion & { wanted: boolean })[]
}

const portSources = new Map<string, PortSource>()

const overlaps = (r: readonly number[], need: readonly number[]) =>
  r[0] < need[2] && r[0] + r[2] > need[0] && r[1] < need[3] && r[1] + r[3] > need[1]

function updateWants(ps: PortSource, force = false) {
  const sink = surfaces.get(ps.sink)
  const need = sink?.neededRect(SOURCE_MARGIN)
  if (!sink || !need) return
  let changed = force
  let cleared = false
  for (const r of ps.regions) {
    const want = overlaps(r.rect, need)
    if (want === r.wanted) continue
    r.wanted = want
    changed = true
    if (!want && sink.clearSource(`${ps.key}:${r.name}`)) cleared = true
  }
  if (changed) {
    const msg: SinkToSource = { kind: 'want', names: ps.regions.filter((r) => r.wanted).map((r) => r.name) }
    ps.port.postMessage(msg)
  }
  if (cleared) sink.redrawLast()
}

function connectPort(sinkId: string, key: string, port: MessagePort, regions: SourceRegion[]) {
  portSources.get(key)?.port.close()
  const ps: PortSource = { sink: sinkId, key, port, regions: regions.map((r) => ({ ...r, wanted: false })) }
  portSources.set(key, ps)
  port.onmessage = ({ data }: MessageEvent<SourceToSink>) => {
    if (data.kind !== 'frame') return
    const sink = surfaces.get(ps.sink)
    let drew = false
    for (const f of data.frames) {
      const r = ps.regions.find((x) => x.name === f.name)
      if (r?.wanted && sink) {
        sink.setSource(`${ps.key}:${r.name}`, f.bitmap, r.rect, r.rect, r.radius)
        drew = true
      }
      f.bitmap.close()
    }
    if (drew) sink?.redrawLast()
  }
  updateWants(ps, true)
}

scope.addEventListener('message', ({ data: msg }) => {
  try {
    switch (msg.kind) {
      case 'init': {
        const s = new Surface(msg.canvas, msg.surface, msg.desync)
        s.id = msg.id
        s.resize(msg.width, msg.height, msg.dpr)
        surfaces.set(msg.id, s)
        scope.postMessage({ kind: 'ready', id: msg.id, ok: true })
        break
      }
      case 'resize':
        surfaces.get(msg.id)?.resize(msg.width, msg.height, msg.dpr)
        break
      case 'page':
        surfaces.get(msg.id)?.setPage(msg.items, msg.ground)
        break
      case 'labels':
        surfaces.get(msg.id)?.setLabels(msg.spec)
        break
      case 'frame': {
        const s = surfaces.get(msg.id)
        if (!s) return
        const t0 = performance.now()
        s.draw(msg.uniforms, msg.frost, msg.scrollY ?? 0)
        if (s.links.length) feed(s)
        refreshSourcesOf(msg.id)
        scope.postMessage({ kind: 'presented', id: msg.id, seq: msg.seq, ms: performance.now() - t0 })
        break
      }
      case 'link': {
        const source = surfaces.get(msg.source)
        if (!source) return
        source.links = source.links.filter((l) => l.sink !== msg.id)
        source.links.push({ sink: msg.id, rect: msg.rect, radius: msg.radius, pending: false, dirty: false, key: '' })
        if (source.last) {
          source.redrawLast()
          feed(source)
        }
        break
      }
      case 'port':
        connectPort(msg.id, msg.key, msg.port, msg.regions)
        break
      case 'regions': {
        const ps = portSources.get(msg.key)
        const sink = surfaces.get(msg.id)
        if (!ps || !sink) return
        for (const r of ps.regions) sink.clearSource(`${ps.key}:${r.name}`)
        ps.regions = msg.regions.map((r) => ({ ...r, wanted: false }))
        updateWants(ps, true)
        sink.redrawLast()
        break
      }
    }
  } catch (err) {
    const id = 'id' in msg ? msg.id : '?'
    scope.postMessage({ kind: 'ready', id, ok: false, reason: String((err as Error)?.message ?? err) })
  }
})
