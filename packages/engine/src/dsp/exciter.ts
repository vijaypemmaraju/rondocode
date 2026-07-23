import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface ExciterConfig {
  /** Crossover Hz — only content ABOVE this is excited. Default 3500. */
  freq?: number
  /** How much of the saturated high band to add back, 0..1. Default 0.3. */
  amount?: number
  /** Saturation drive on the isolated highs (more = more harmonics). Default 3. */
  drive?: number
}

/** Aural exciter: split off the high band (1-pole HP), saturate it to synthesize
 *  harmonically-related upper partials, and mix that back with the dry signal.
 *  Adds "air"/sheen and presence WITHOUT the broadband hiss of added noise —
 *  the new highs are harmonics of what's already there. Mono. */
export class ExciterKernel implements Kernel {
  private readonly freq: number
  private readonly amount: number
  private readonly drive: number
  private sr = 0
  private a = 0 // 1-pole lowpass coefficient
  private lp = 0 // lowpass state; highpass = input - lp

  constructor(cfg: ExciterConfig = {}) {
    this.freq = clamp(cfg.freq ?? 3500, 200, 18000)
    this.amount = clamp(cfg.amount ?? 0.3, 0, 1)
    this.drive = clamp(cfg.drive ?? 3, 1, 16)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (ctx.sampleRate !== this.sr) {
      this.sr = ctx.sampleRate
      this.a = Math.exp((-2 * Math.PI * this.freq) / this.sr)
    }
    const a = this.a
    const drive = this.drive
    const amount = this.amount
    let lp = this.lp
    for (let i = 0; i < n; i++) {
      const dry = input[i]!
      lp = a * lp + (1 - a) * dry
      if (!Number.isFinite(lp)) lp = 0 // scrub state PER SAMPLE so one NaN input can't burst the rest of the block (match eq/ott)
      const hi = dry - lp
      // saturate the highs; /drive keeps small signals near unity so `amount`
      // reads as a clean mix knob. The added band carries generated harmonics.
      const ex = Math.tanh(hi * drive) / drive
      const y = dry + ex * amount * 2.5
      out[i] = Number.isFinite(y) ? y : 0
    }
    this.lp = lp
  }

  reset(): void {
    this.lp = 0
  }
}
