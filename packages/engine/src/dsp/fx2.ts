import type { DspContext, Kernel } from './types'
import { clamp, flush } from './util'

/* ------------------------------------------------------------------------- *
 * Extra colour: a swept allpass phaser and a vowel/formant filter. Both are
 * insert effects — they process whatever signal feeds their 'in' port, so they
 * work per-voice or in a post-chain like chorus/reverb.
 * ------------------------------------------------------------------------- */

/** Classic phaser: a cascade of first-order allpass stages swept by an LFO,
 *  with feedback, mixed against the dry signal to make moving notches. Input
 *  'in'. Config: rate (Hz), depth (0..1), feedback (0..0.9), stages (even,
 *  2..12), mix (0..1). Output ~[-1, 1]. */
export interface PhaserConfig {
  rate?: number
  depth?: number
  feedback?: number
  stages?: number
  mix?: number
}

export class PhaserKernel implements Kernel {
  private readonly rate: number
  private readonly depth: number
  private readonly feedback: number
  private readonly mix: number
  private readonly nStages: number
  private readonly ap: Float32Array // one state per allpass stage
  private lfo = 0
  private last = 0

  constructor(config: PhaserConfig = {}) {
    this.rate = clamp(config.rate ?? 0.5, 0.001, 20)
    this.depth = clamp(config.depth ?? 0.7, 0, 1)
    this.feedback = clamp(config.feedback ?? 0.4, 0, 0.9)
    this.mix = clamp(config.mix ?? 0.5, 0, 1)
    this.nStages = Math.round(clamp(config.stages ?? 4, 2, 12))
    this.ap = new Float32Array(this.nStages)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const x = inputs['in']!
    const sr = ctx.sampleRate
    const inc = this.rate / sr
    const ap = this.ap
    const ns = this.nStages
    const fb = this.feedback
    const mix = this.mix
    let lfo = this.lfo
    let last = this.last
    for (let i = 0; i < n; i++) {
      // sine LFO 0..1 → allpass coefficient centred ~0.5, swept by depth
      const mod = 0.5 - 0.5 * Math.cos(2 * Math.PI * lfo)
      const a = clamp(0.15 + this.depth * 0.8 * mod, -0.98, 0.98)
      let s = x[i]! + fb * last
      for (let k = 0; k < ns; k++) {
        const y = -a * s + ap[k]!
        ap[k] = s + a * y // one-state first-order allpass
        s = y
      }
      last = s
      out[i] = x[i]! * (1 - mix) + s * mix
      lfo += inc
      if (lfo >= 1) lfo -= 1
    }
    this.lfo = lfo
    this.last = flush(last)
    for (let k = 0; k < ns; k++) ap[k] = flush(ap[k]!)
  }

  reset(): void {
    this.lfo = 0
    this.last = 0
    this.ap.fill(0)
  }
}

/* --------------------------------- formant -------------------------------- */

/** Male-voice formant frequencies (F1, F2, F3) per vowel, in order a e i o u. */
const VOWELS: [number, number, number][] = [
  [730, 1090, 2440], // a
  [530, 1840, 2480], // e
  [270, 2290, 3010], // i
  [570, 840, 2410], // o
  [300, 870, 2240], // u
]
const FORMANT_Q = [10, 12, 12]
const FORMANT_AMP = [1, 0.55, 0.4]

/** Vowel / formant filter: three band-pass resonators at a vowel's formant
 *  frequencies, so a buzzy source (saw/pulse) turns into a singing "aah/eee".
 *  Input 'in'; 'morph' (0..1) scans a→e→i→o→u. Formants are re-tuned per block
 *  from morph (block-rate, ~3 ms — smooth for vowel sweeps). Output ~[-1, 1]. */
export class FormantKernel implements Kernel {
  // three biquad band-pass states
  private readonly x1 = new Float32Array(3)
  private readonly x2 = new Float32Array(3)
  private readonly y1 = new Float32Array(3)
  private readonly y2 = new Float32Array(3)
  // coefficients, recomputed per block
  private readonly b0 = new Float32Array(3)
  private readonly b2 = new Float32Array(3) // b1 is always 0 for BPF; b2 = -b0
  private readonly a1 = new Float32Array(3)
  private readonly a2 = new Float32Array(3)

  /** Re-tune the three band-passes for a morph position. */
  private tune(morph: number, sr: number): void {
    const m = clamp(morph, 0, 1) * (VOWELS.length - 1)
    const lo = Math.min(Math.floor(m), VOWELS.length - 2)
    const frac = m - lo
    const va = VOWELS[lo]!
    const vb = VOWELS[lo + 1]!
    for (let k = 0; k < 3; k++) {
      let f = va[k]! + (vb[k]! - va[k]!) * frac
      if (f > sr * 0.45) f = sr * 0.45
      const w0 = (2 * Math.PI * f) / sr
      const alpha = Math.sin(w0) / (2 * FORMANT_Q[k]!)
      const a0 = 1 + alpha
      this.b0[k] = (alpha / a0) * FORMANT_AMP[k]!
      this.b2[k] = -this.b0[k]!
      this.a1[k] = (-2 * Math.cos(w0)) / a0
      this.a2[k] = (1 - alpha) / a0
    }
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const x = inputs['in']!
    const morph = inputs['morph']!
    this.tune(morph[0]!, ctx.sampleRate) // block-rate re-tune
    const { x1, x2, y1, y2, b0, b2, a1, a2 } = this
    for (let i = 0; i < n; i++) {
      const xi = x[i]!
      let acc = 0
      for (let k = 0; k < 3; k++) {
        const y = b0[k]! * xi + b2[k]! * x2[k]! - a1[k]! * y1[k]! - a2[k]! * y2[k]!
        x2[k] = x1[k]!
        x1[k] = xi
        y2[k] = y1[k]!
        y1[k] = y
        acc += y
      }
      out[i] = acc
    }
    for (let k = 0; k < 3; k++) {
      y1[k] = flush(y1[k]!)
      y2[k] = flush(y2[k]!)
    }
  }

  reset(): void {
    this.x1.fill(0)
    this.x2.fill(0)
    this.y1.fill(0)
    this.y2.fill(0)
  }
}
