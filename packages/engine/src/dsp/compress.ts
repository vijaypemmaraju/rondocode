import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface CompressConfig {
  /** Level above which gain reduction begins, in dB. Default -18. */
  threshold?: number
  /** Compression ratio (input:output above threshold). 1 = none, 4 = 4:1,
   *  20+ ≈ limiting. Default 4. Clamped to [1, 60]. */
  ratio?: number
  /** How fast gain clamps DOWN when the signal exceeds threshold, ms.
   *  Default 10. Clamped to [0.05, 500]. */
  attack?: number
  /** How fast gain RECOVERS when the signal drops, ms. Default 120.
   *  Clamped to [1, 3000]. */
  release?: number
  /** Soft-knee width in dB around the threshold (0 = hard knee). Default 6. */
  knee?: number
  /** Output makeup gain in dB, applied after compression. Default 0. */
  makeup?: number
}

/** Static gain-reduction curve (feed-forward): how many dB to pull DOWN a
 *  signal whose level is `levelDb`, given threshold/ratio/knee. Returns a
 *  non-negative reduction; 0 below the (soft) knee. Shared by the per-voice
 *  CompressKernel and the master-bus compressor so both hear identically. */
export function gainReductionDb(
  levelDb: number,
  threshold: number,
  ratio: number,
  knee: number,
): number {
  const slope = 1 - 1 / ratio // 0 at 1:1, ->1 at ∞:1
  const over = levelDb - threshold
  if (knee <= 0) return over > 0 ? slope * over : 0
  if (over < -knee / 2) return 0
  if (over > knee / 2) return slope * over
  // inside the knee: quadratic blend from 0 to full slope
  const t = over + knee / 2
  return (slope * t * t) / (2 * knee)
}

/** One-pole smoothing coefficient for a time constant `ms` at `sr`. */
export const smoothCoeff = (ms: number, sr: number): number => 1 - Math.exp(-1 / ((ms / 1000) * sr))

const DB_FLOOR = -120 // level of (near-)silence; avoids log(0) = -Infinity

/** Feed-forward peak compressor (mono). Input 'in'; threshold/ratio/attack/
 *  release/knee/makeup are construction config (dial it in, not per-sample
 *  automated). Detects the instantaneous peak, computes gain reduction on the
 *  soft-knee curve, then smooths the applied gain with separate attack (gain
 *  falling = signal got louder) and release (gain recovering) time constants.
 *
 *  Parallel compression comes free: mix the dry signal back with
 *  `input.mix(compress(input, {...}), amount)`. */
export class CompressKernel implements Kernel {
  private readonly threshold: number
  private readonly ratio: number
  private readonly attackMs: number
  private readonly releaseMs: number
  private readonly knee: number
  private readonly makeupLin: number
  /** Current gain reduction in dB (>= 0). Smoothed across samples. */
  private grDb = 0
  private sr = 0
  private atk = 0
  private rel = 0

  constructor(cfg: CompressConfig = {}) {
    this.threshold = cfg.threshold ?? -18
    this.ratio = clamp(cfg.ratio ?? 4, 1, 60)
    this.attackMs = clamp(cfg.attack ?? 10, 0.05, 500)
    this.releaseMs = clamp(cfg.release ?? 120, 1, 3000)
    this.knee = Math.max(0, cfg.knee ?? 6)
    this.makeupLin = Math.pow(10, (cfg.makeup ?? 0) / 20)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (ctx.sampleRate !== this.sr) {
      this.sr = ctx.sampleRate
      this.atk = smoothCoeff(this.attackMs, this.sr)
      this.rel = smoothCoeff(this.releaseMs, this.sr)
    }
    const makeup = this.makeupLin
    let gr = this.grDb
    for (let i = 0; i < n; i++) {
      const x = input[i]!
      const lin = Math.abs(x)
      const db = lin > 0 ? 20 * Math.log10(lin) : DB_FLOOR
      // target reduction from the static curve, clamped so it can't run away
      const target = clamp(gainReductionDb(db, this.threshold, this.ratio, this.knee), 0, 60)
      // attack when we need MORE reduction (target > current), release when less
      const coeff = target > gr ? this.atk : this.rel
      gr += (target - gr) * coeff
      const g = Math.pow(10, -gr / 20) * makeup
      out[i] = x * g
    }
    this.grDb = Number.isFinite(gr) ? gr : 0
  }

  reset(): void {
    this.grDb = 0
  }
}
