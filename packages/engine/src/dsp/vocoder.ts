import type { DspContext, Kernel } from './types'
import { smoothCoeff } from './compress'
import { flush, clamp, softClipTanh } from './util'

/* ------------------------------------------------------------------------- *
 * Classic analysis/synthesis VOCODER — a bank of matched bandpass filters
 * imposes the MODULATOR's per-band spectral envelope onto the CARRIER, the
 * source–filter effect behind robot voices and talking synths.
 *
 * Per band: bandpass the modulator → rectify + one-pole smooth → a band
 * envelope; bandpass the carrier → scale by that envelope; sum all bands.
 * Bands are log-spaced (constant-Q), so speech formants land cleanly across
 * the range. Everything is inline RBJ bandpass biquads + a one-pole follower
 * (see FormantKernel / CompressKernel), state as parallel Float32Arrays so
 * process() allocates nothing.
 *
 * Usage: carrier = a harmonically rich synth (saw / supersaw / pulse), so
 * every band has energy to shape; modulator = a voice sample, noise, or
 * another synth. See the `vocoder` DSL method.
 * ------------------------------------------------------------------------- */

export interface VocoderConfig {
  /** Filter-bank size (2–64). More bands = more intelligible, more CPU. Default 16. */
  bands?: number
  /** Lowest band center (Hz). Default 120. */
  low?: number
  /** Highest band center (Hz). Default 7500. */
  high?: number
  /** Band-Q scale (×) over the constant-Q default. <1 = wider/blurrier bands,
   *  >1 = narrower/sharper. Default 1. */
  q?: number
  /** Envelope-follower time (seconds): the response of each band envelope.
   *  Smaller = crisper consonants but more ripple; larger = smoother, slurred.
   *  Default 0.012. */
  response?: number
}

export class VocoderKernel implements Kernel {
  private readonly n: number
  // per-band bandpass coefficients (b1 = 0, b2 = -b0) shared by both filterbanks
  private readonly b0: Float32Array
  private readonly a1: Float32Array
  private readonly a2: Float32Array
  // modulator biquad state (Direct Form I)
  private readonly mx1: Float32Array
  private readonly mx2: Float32Array
  private readonly my1: Float32Array
  private readonly my2: Float32Array
  // carrier biquad state
  private readonly cx1: Float32Array
  private readonly cx2: Float32Array
  private readonly cy1: Float32Array
  private readonly cy2: Float32Array
  // per-band envelope follower state
  private readonly env: Float32Array
  private readonly envCoeff: number
  private readonly outGain: number

  constructor(cfg: VocoderConfig, ctx: DspContext) {
    const sr = ctx.sampleRate
    const nyq = sr * 0.5
    const n = Math.max(2, Math.min(64, Math.floor(cfg.bands ?? 16)))
    const low = clamp(cfg.low ?? 120, 20, nyq - 100)
    const high = clamp(cfg.high ?? 7500, low * 1.5, nyq - 1)
    this.n = n

    const f = (): Float32Array => new Float32Array(n)
    this.b0 = f()
    this.a1 = f()
    this.a2 = f()
    this.mx1 = f()
    this.mx2 = f()
    this.my1 = f()
    this.my2 = f()
    this.cx1 = f()
    this.cx2 = f()
    this.cy1 = f()
    this.cy2 = f()
    this.env = f()

    // log-spaced centers; constant-Q so adjacent bands tile the spectrum
    const ratio = Math.pow(high / low, 1 / (n - 1))
    const q = (Math.sqrt(ratio) / (ratio - 1)) * Math.max(0.2, cfg.q ?? 1)
    for (let i = 0; i < n; i++) {
      const fc = low * Math.pow(ratio, i)
      const w0 = (2 * Math.PI * fc) / sr
      const alpha = Math.sin(w0) / (2 * q)
      const a0 = 1 + alpha
      this.b0[i] = alpha / a0 // RBJ bandpass, 0 dB peak gain
      this.a1[i] = (-2 * Math.cos(w0)) / a0
      this.a2[i] = (1 - alpha) / a0
    }

    const respMs = Math.max(1, (cfg.response ?? 0.012) * 1000)
    this.envCoeff = smoothCoeff(respMs, sr)
    // The band-sum × envelope loses a lot of level vs the carrier; makeup gain
    // lands it at a usable level, soft-clipped so extremes stay bounded.
    this.outGain = 6
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const car = inputs['carrier']!
    const mod = inputs['modulator']!
    const bands = this.n
    const { b0, a1, a2, mx1, mx2, my1, my2, cx1, cx2, cy1, cy2, env, envCoeff, outGain } = this
    for (let s = 0; s < n; s++) {
      const cin = car[s]!
      const min = mod[s]!
      let acc = 0
      for (let k = 0; k < bands; k++) {
        // modulator bandpass (b1 = 0, b2 = -b0 → b0*(x[n]-x[n-2]))
        const my = b0[k]! * (min - mx2[k]!) - a1[k]! * my1[k]! - a2[k]! * my2[k]!
        mx2[k] = mx1[k]!
        mx1[k] = min
        my2[k] = my1[k]!
        my1[k] = my
        // band envelope: rectify + one-pole toward |band|
        const e = env[k]! + (Math.abs(my) - env[k]!) * envCoeff
        env[k] = e
        // carrier bandpass, scaled by the modulator's band envelope
        const cy = b0[k]! * (cin - cx2[k]!) - a1[k]! * cy1[k]! - a2[k]! * cy2[k]!
        cx2[k] = cx1[k]!
        cx1[k] = cin
        cy2[k] = cy1[k]!
        cy1[k] = cy
        acc += cy * e
      }
      out[s] = softClipTanh(acc * outGain, 0.9)
    }
    // block-end denormal / NaN hygiene on the recursive + envelope state
    for (let k = 0; k < bands; k++) {
      my1[k] = flush(my1[k]!)
      my2[k] = flush(my2[k]!)
      cy1[k] = flush(cy1[k]!)
      cy2[k] = flush(cy2[k]!)
      env[k] = flush(env[k]!)
    }
  }

  reset(): void {
    this.mx1.fill(0)
    this.mx2.fill(0)
    this.my1.fill(0)
    this.my2.fill(0)
    this.cx1.fill(0)
    this.cx2.fill(0)
    this.cy1.fill(0)
    this.cy2.fill(0)
    this.env.fill(0)
  }
}
