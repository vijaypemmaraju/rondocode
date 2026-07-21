import type { DspContext, Kernel } from './types'
import { clamp, flush } from './util'

/* ------------------------------------------------------------------------- *
 * Physical-modeling voices. Both are gate-driven excitation-resonator models:
 * a rising gate edge strikes/plucks, and the resonator rings on its own — the
 * feedback lives inside the kernel (a plain acyclic graph can't express it).
 *
 * pluck  — Karplus-Strong plucked string: a one-period noise burst recirculates
 *          through a tuned (fractional) delay with a damping lowpass in the
 *          loop, the classic string decay.
 * modal  — a bank of tuned two-pole resonators at (in)harmonic ratios, struck
 *          by a short noise burst: bells, bars/marimba, drums, glass.
 * ------------------------------------------------------------------------- */

const MIN_FREQ = 20

export interface PluckConfig {
  /** T60-ish decay in seconds (loop gain). Default 1.5. */
  decay?: number
  /** Loop lowpass 0..0.95: higher = darker and faster HF decay. Default 0.5. */
  damp?: number
  /** PRNG seed for the pluck noise (determinism). */
  seed?: number
}

/** Karplus-Strong plucked string. Inputs 'gate' (rising edge = pluck) and
 *  'freq' (Hz). A one-period white-noise burst is injected on each pluck and
 *  recirculates through a fractional delay line (linear-interpolated read, so
 *  tuning stays accurate up high) with a one-pole damping lowpass; per-sample
 *  loop gain gives a T60 of `decay` seconds. Output ~[-1, 1]. */
export class PluckKernel implements Kernel {
  private readonly buf: Float32Array
  private readonly maxLen: number
  private readonly decaySec: number
  private readonly damp: number
  private readonly seed: number
  private w = 0
  private burst = 0
  private lastY = 0
  private prevGate = 0
  private active = false
  private rng: number

  constructor(config: PluckConfig = {}, ctx?: DspContext) {
    const sr = ctx?.sampleRate ?? 48000
    this.maxLen = Math.ceil(sr / MIN_FREQ) + 4
    this.buf = new Float32Array(this.maxLen)
    this.decaySec = clamp(config.decay ?? 1.5, 0.05, 30)
    this.damp = clamp(config.damp ?? 0.5, 0, 0.95)
    this.seed = (Math.floor(config.seed ?? 0x1a2b3c4d) >>> 0) || 1
    this.rng = this.seed
  }

  private noise(): number {
    let x = this.rng
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    this.rng = x
    return (x / 4294967296) * 2 - 1
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const gate = inputs['gate']!
    const freq = inputs['freq']!
    const sr = ctx.sampleRate
    const g = Math.pow(0.001, 1 / (this.decaySec * sr)) // per-sample loop gain (T60 = decaySec)
    const damp = this.damp
    const maxLen = this.maxLen
    const buf = this.buf
    let w = this.w
    let burst = this.burst
    let lastY = this.lastY
    let active = this.active
    for (let i = 0; i < n; i++) {
      const gt = gate[i]!
      if (gt > 0.5 && this.prevGate <= 0.5) {
        // pluck: clear the line and inject one period of noise
        buf.fill(0)
        burst = clamp(Math.round(sr / Math.max(MIN_FREQ, freq[i]!)), 2, maxLen - 2)
        active = true
        lastY = 0
      }
      this.prevGate = gt
      let y = 0
      if (active) {
        if (burst > 0) {
          y = this.noise()
          buf[w] = y
          burst--
        } else {
          const Lf = clamp(sr / Math.max(MIN_FREQ, freq[i]!), 2, maxLen - 2)
          let readAt = w - Lf
          if (readAt < 0) readAt += maxLen
          const i0 = Math.floor(readAt)
          const frac = readAt - i0
          const a = buf[i0 % maxLen]!
          const b = buf[(i0 + 1) % maxLen]!
          y = a + (b - a) * frac
          const filtered = (1 - damp) * y + damp * lastY
          buf[w] = g * filtered
        }
        lastY = y
        w++
        if (w >= maxLen) w = 0
      }
      out[i] = y
    }
    this.w = w
    this.burst = burst
    this.lastY = flush(lastY)
    this.active = active
  }

  reset(): void {
    this.buf.fill(0)
    this.w = 0
    this.burst = 0
    this.lastY = 0
    this.prevGate = 0
    this.active = false
    this.rng = this.seed
  }
}

export interface ModalConfig {
  /** Resonator bank preset. Default 'bell'. */
  model?: string
  /** Base ring time in seconds (per-mode scaled). Default 1.2. */
  decay?: number
  /** 0..1 darkens the strike by attenuating higher modes. Default 0. */
  damp?: number
}

interface ModeSpec {
  /** Frequency ratios to the fundamental. */
  ratios: number[]
  /** Relative mode amplitudes. */
  amps: number[]
  /** Relative decay factors (× base decay). */
  decays: number[]
}

/** Modal presets: ratios/amps/decays per struck material. Values are the usual
 *  textbook/STK approximations, not physical measurements. */
export const MODAL_MODELS: Record<string, ModeSpec> = {
  bell: {
    ratios: [0.56, 0.92, 1.19, 1.71, 2, 2.74, 3, 3.76, 4.07],
    amps: [1, 0.6, 0.9, 0.5, 0.55, 0.35, 0.3, 0.2, 0.15],
    decays: [1, 0.9, 0.85, 0.7, 0.9, 0.6, 0.6, 0.5, 0.4],
  },
  bar: {
    // marimba-tuned bar: fundamental + roughly 4× and 10×
    ratios: [1, 3.98, 10.65],
    amps: [1, 0.35, 0.12],
    decays: [1, 0.5, 0.3],
  },
  drum: {
    // ideal circular membrane modes
    ratios: [1, 1.59, 2.14, 2.3, 2.65, 2.92],
    amps: [1, 0.6, 0.45, 0.4, 0.3, 0.25],
    decays: [1, 0.5, 0.4, 0.35, 0.3, 0.25],
  },
  glass: {
    ratios: [1, 2.32, 4.25, 6.63, 9.38],
    amps: [1, 0.5, 0.35, 0.2, 0.12],
    decays: [1, 0.9, 0.8, 0.7, 0.6],
  },
}

const isModel = (m: string): boolean => Object.prototype.hasOwnProperty.call(MODAL_MODELS, m)

/** A bank of tuned two-pole resonators struck by a short noise burst. Inputs
 *  'gate' (rising edge = strike) and 'freq' (Hz fundamental). Each mode is a
 *  resonator at freq×ratio with its own decay; a ~3 ms noise burst excites the
 *  whole bank on each strike. Coefficients are latched at the strike (no glide
 *  mid-ring). Output is summed and scaled; ~[-1, 1] after the master safety. */
export class ModalKernel implements Kernel {
  private readonly spec: ModeSpec
  private readonly decaySec: number
  private readonly damp: number
  private readonly nModes: number
  private readonly a1: Float32Array
  private readonly a2: Float32Array
  private readonly b0: Float32Array
  private readonly y1: Float32Array
  private readonly y2: Float32Array
  private strike = false
  private prevGate = 0

  constructor(config: ModalConfig = {}, _ctx?: DspContext) {
    const model = config.model ?? 'bell'
    if (!isModel(model)) throw new Error(`unknown modal model '${model}' (known: ${Object.keys(MODAL_MODELS).join(', ')})`)
    this.spec = MODAL_MODELS[model]!
    this.decaySec = clamp(config.decay ?? 1.2, 0.02, 30)
    this.damp = clamp(config.damp ?? 0, 0, 1)
    this.nModes = this.spec.ratios.length
    this.a1 = new Float32Array(this.nModes)
    this.a2 = new Float32Array(this.nModes)
    this.b0 = new Float32Array(this.nModes)
    this.y1 = new Float32Array(this.nModes)
    this.y2 = new Float32Array(this.nModes)
  }

  /** Latch resonator coefficients for a strike at `freq`. */
  private tune(freq: number, sr: number): void {
    const { ratios, amps, decays } = this.spec
    const damp = this.damp
    for (let k = 0; k < this.nModes; k++) {
      const fk = freq * ratios[k]!
      if (fk >= sr * 0.49 || fk <= 0) {
        this.b0[k] = 0
        this.a1[k] = 0
        this.a2[k] = 0
        continue
      }
      const decK = Math.max(0.01, this.decaySec * decays[k]!)
      const r = Math.exp(-1 / (decK * sr))
      const w = (2 * Math.PI * fk) / sr
      this.a1[k] = 2 * r * Math.cos(w)
      this.a2[k] = r * r
      // Normalize the impulse response peak to ~amp: an all-pole resonator's
      // impulse response peaks at ~b0/sin(w), so the input gain carries sin(w).
      // Excited by a single impulse (below) this gives a controlled level per
      // mode regardless of decay length. damp attenuates higher modes.
      this.b0[k] = amps[k]! * Math.pow(1 - damp, k) * Math.sin(w)
      this.y1[k] = 0
      this.y2[k] = 0
    }
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const gate = inputs['gate']!
    const freq = inputs['freq']!
    const sr = ctx.sampleRate
    const nModes = this.nModes
    const a1 = this.a1
    const a2 = this.a2
    const b0 = this.b0
    const y1 = this.y1
    const y2 = this.y2
    const norm = 0.35
    let strike = this.strike
    for (let i = 0; i < n; i++) {
      const gt = gate[i]!
      if (gt > 0.5 && this.prevGate <= 0.5) {
        this.tune(Math.max(MIN_FREQ, freq[i]!), sr)
        strike = true // inject a single impulse next (no resonant build-up)
      }
      this.prevGate = gt
      const x = strike ? 1 : 0
      strike = false
      let acc = 0
      for (let k = 0; k < nModes; k++) {
        const y = b0[k]! * x + a1[k]! * y1[k]! - a2[k]! * y2[k]!
        y2[k] = y1[k]!
        y1[k] = y
        acc += y
      }
      // tanh keeps the in-phase attack transient bounded and adds a little
      // strike warmth; the decayed ring passes through essentially linear.
      out[i] = Math.tanh(acc * norm)
    }
    this.strike = strike
    for (let k = 0; k < nModes; k++) {
      y1[k] = flush(y1[k]!)
      y2[k] = flush(y2[k]!)
    }
  }

  reset(): void {
    this.strike = false
    this.prevGate = 0
    this.y1.fill(0)
    this.y2.fill(0)
  }
}
