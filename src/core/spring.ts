// Springs in Apple's format: (dampingRatio, response).
// stiffness = (2π/response)², damping = 2·ζ·(2π/response), unit mass.
// Closed-form integration (exact for any dt).

export interface SpringSpec {
  dampingRatio: number
  response: number
}

export const REST_DISPLACEMENT = 1e-4
export const REST_SPEED = 1e-3

/** Advances (x0 = displacement from the target, v0) by dt seconds. */
export function stepSpring(x0: number, v0: number, spec: SpringSpec, dt: number): [number, number] {
  const w0 = (2 * Math.PI) / Math.max(spec.response, 1e-4)
  const z = spec.dampingRatio
  if (Math.abs(z - 1) < 1e-6) {
    const e = Math.exp(-w0 * dt)
    const c = v0 + w0 * x0
    return [e * (x0 + c * dt), e * (v0 - w0 * c * dt)]
  }
  if (z < 1) {
    const a = z * w0
    const wd = w0 * Math.sqrt(1 - z * z)
    const e = Math.exp(-a * dt)
    const c = Math.cos(wd * dt)
    const s = Math.sin(wd * dt)
    return [e * (x0 * c + ((v0 + a * x0) / wd) * s), e * (v0 * c - ((a * v0 + w0 * w0 * x0) / wd) * s)]
  }
  const r = Math.sqrt(z * z - 1)
  const r1 = -w0 * (z - r)
  const r2 = -w0 * (z + r)
  const c2 = (v0 - r1 * x0) / (r2 - r1)
  const c1 = x0 - c2
  const e1 = Math.exp(r1 * dt)
  const e2 = Math.exp(r2 * dt)
  return [c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2]
}

export class Spring {
  value: number
  target: number
  velocity = 0
  spec: SpringSpec
  /** overshootClamping: stops at the first crossing of the target. */
  clamp: boolean

  constructor(value: number, spec: SpringSpec, clamp = false) {
    this.value = value
    this.target = value
    this.spec = spec
    this.clamp = clamp
  }

  to(target: number, spec?: SpringSpec, clamp?: boolean) {
    this.target = target
    if (spec) this.spec = spec
    if (clamp !== undefined) this.clamp = clamp
    return this
  }

  jump(value: number) {
    this.value = this.target = value
    this.velocity = 0
    return this
  }

  get resting() {
    return Math.abs(this.value - this.target) < REST_DISPLACEMENT && Math.abs(this.velocity) < REST_SPEED
  }

  /** Returns true while moving. */
  step(dt: number): boolean {
    if (this.resting) {
      this.value = this.target
      this.velocity = 0
      return false
    }
    const x0 = this.value - this.target
    const [x, v] = stepSpring(x0, this.velocity, this.spec, dt)
    if (this.clamp && x0 !== 0 && Math.sign(x) !== Math.sign(x0)) {
      this.value = this.target
      this.velocity = 0
      return false
    }
    this.value = this.target + x
    this.velocity = v
    return true
  }
}

export const spec = (dampingRatio: number, response: number): SpringSpec => ({ dampingRatio, response })
