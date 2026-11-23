// Minimal WebGL2 utilities (they run inside the worker).
import type { UniformValue } from './protocol'

export class Program {
  readonly program: WebGLProgram
  private uniforms = new Map<string, { loc: WebGLUniformLocation; type: number; size: number }>()
  private gl: WebGL2RenderingContext

  constructor(gl: WebGL2RenderingContext, vs: string, fs: string, label: string) {
    this.gl = gl
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s)
        throw new Error(`[${label}] shader: ${log}`)
      }
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[${label}] link: ${gl.getProgramInfoLog(p)}`)
    this.program = p
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)
      if (!info) continue
      const name = info.name.replace(/\[0\]$/, '')
      const loc = gl.getUniformLocation(p, info.name)
      if (loc) this.uniforms.set(name, { loc, type: info.type, size: info.size })
    }
  }

  use() {
    this.gl.useProgram(this.program)
    return this
  }

  has(name: string) {
    return this.uniforms.has(name)
  }

  set(name: string, v: UniformValue) {
    const u = this.uniforms.get(name)
    if (!u) return
    const gl = this.gl
    const a = typeof v === 'number' ? [v] : v
    if (u.size > 1) {
      // uniform arrays: flattened values
      const f = a as number[]
      if (u.type === gl.FLOAT) gl.uniform1fv(u.loc, f)
      else if (u.type === gl.FLOAT_VEC2) gl.uniform2fv(u.loc, f)
      else if (u.type === gl.FLOAT_VEC3) gl.uniform3fv(u.loc, f)
      else if (u.type === gl.FLOAT_VEC4) gl.uniform4fv(u.loc, f)
      else gl.uniform1iv(u.loc, f)
      return
    }
    switch (u.type) {
      case gl.FLOAT:
        gl.uniform1f(u.loc, a[0] ?? 0)
        break
      case gl.FLOAT_VEC2:
        gl.uniform2f(u.loc, a[0] ?? 0, a[1] ?? 0)
        break
      case gl.FLOAT_VEC3:
        gl.uniform3f(u.loc, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0)
        break
      case gl.FLOAT_VEC4:
        gl.uniform4f(u.loc, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0)
        break
      case gl.INT:
      case gl.BOOL:
      case gl.SAMPLER_2D:
        gl.uniform1i(u.loc, a[0] ?? 0)
        break
    }
  }

  setAll(values: Record<string, UniformValue>) {
    for (const k in values) this.set(k, values[k])
  }
}

export interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
}

export function createTarget(gl: WebGL2RenderingContext, w: number, h: number): Target {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { tex, fbo, w, h }
}

export function deleteTarget(gl: WebGL2RenderingContext, t: Target | null) {
  if (!t) return
  gl.deleteTexture(t.tex)
  gl.deleteFramebuffer(t.fbo)
}

/** Neutral 1×1 texture for samplers that have no data yet. */
export function blankTexture(gl: WebGL2RenderingContext) {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
  return tex
}
