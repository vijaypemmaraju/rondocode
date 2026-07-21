import type { DspContext, Kernel } from './types'
import { clamp, flush } from './util'

const TWO_PI = 2 * Math.PI

export type SvfMode = 'lp' | 'hp' | 'bp' | 'notch' | 'peak'

/** Simper TPT state-variable filter (12dB/oct). Inputs 'in', 'cutoff' (Hz,
 *  audio-rate, clamped per sample to [1, 0.49*sr]) and 'res' (0..1, clamped to
 *  [0, 0.98] — res=1 would be zero damping). Config: mode
 *  'lp'|'hp'|'bp'|'notch'|'peak'. The three canonical SVF outputs are
 *  low = v2, band = v1, high = x - k*band - low; the composites are
 *  notch = low + high (= x - k*band, a rejection dip at cutoff) and
 *  peak = low - high (a resonant bell that boosts at cutoff). */
export class SvfKernel implements Kernel {
  private ic1 = 0
  private ic2 = 0

  constructor(private readonly mode: SvfMode = 'lp') {}

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const cutoff = inputs['cutoff']!
    const res = inputs['res']!
    const sr = ctx.sampleRate
    const mode = this.mode
    let ic1 = this.ic1
    let ic2 = this.ic2
    for (let i = 0; i < n; i++) {
      const x = input[i]!
      const fc = clamp(cutoff[i]!, 1, 0.49 * sr)
      const r = clamp(res[i]!, 0, 0.98)
      const g = Math.tan((Math.PI * fc) / sr)
      const k = 2 - 2 * r
      const a1 = 1 / (1 + g * (g + k))
      const a2 = g * a1
      const a3 = g * a2
      const v3 = x - ic2
      const v1 = a1 * ic1 + a2 * v3
      const v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = 2 * v1 - ic1
      ic2 = 2 * v2 - ic2
      const low = v2
      const band = v1
      const high = x - k * band - low
      out[i] =
        mode === 'lp'
          ? low
          : mode === 'bp'
            ? band
            : mode === 'hp'
              ? high
              : mode === 'notch'
                ? low + high
                : low - high // peak
    }
    this.ic1 = flush(ic1)
    this.ic2 = flush(ic2)
  }

  reset(): void {
    this.ic1 = 0
    this.ic2 = 0
  }
}

/** Classic simplified Moog ladder (24dB/oct): four one-pole stages inside a
 *  tanh-saturated feedback loop. Inputs 'in', 'cutoff' (Hz, audio-rate,
 *  clamped per sample to [1, 0.45*sr]) and 'res' (clamped to [0, 1.1] — above
 *  1 is allowed for self-oscillation/scream; the tanh bounds the output). */
export class LadderKernel implements Kernel {
  private s1 = 0
  private s2 = 0
  private s3 = 0
  private s4 = 0

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const cutoff = inputs['cutoff']!
    const res = inputs['res']!
    const sr = ctx.sampleRate
    let s1 = this.s1
    let s2 = this.s2
    let s3 = this.s3
    let s4 = this.s4
    for (let i = 0; i < n; i++) {
      const x = input[i]!
      const fc = clamp(cutoff[i]!, 1, 0.45 * sr)
      const r = clamp(res[i]!, 0, 1.1)
      const g = 1 - Math.exp((-TWO_PI * fc) / sr)
      const fb = 4 * r
      const drive = Math.tanh(x - fb * s4)
      s1 += g * (drive - s1)
      s2 += g * (s1 - s2)
      s3 += g * (s2 - s3)
      s4 += g * (s3 - s4)
      out[i] = s4
    }
    this.s1 = flush(s1)
    this.s2 = flush(s2)
    this.s3 = flush(s3)
    this.s4 = flush(s4)
  }

  reset(): void {
    this.s1 = 0
    this.s2 = 0
    this.s3 = 0
    this.s4 = 0
  }
}

/** One-pole lowpass (6dB/oct): s += g*(x - s) with g = 1 - exp(-2*pi*fc/sr).
 *  Inputs 'in' and 'cutoff' (Hz, audio-rate, clamped per sample to
 *  [1, 0.49*sr]). Cheap smoother for control signals and gentle tone shaping. */
export class OnePoleKernel implements Kernel {
  private s = 0

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const cutoff = inputs['cutoff']!
    const sr = ctx.sampleRate
    let s = this.s
    for (let i = 0; i < n; i++) {
      const fc = clamp(cutoff[i]!, 1, 0.49 * sr)
      const g = 1 - Math.exp((-TWO_PI * fc) / sr)
      s += g * (input[i]! - s)
      out[i] = s
    }
    this.s = flush(s)
  }

  reset(): void {
    this.s = 0
  }
}
