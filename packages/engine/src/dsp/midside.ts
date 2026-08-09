/* ------------------------------------------------------------------------- *
 * MID / SIDE — the one stereo move the engine could not make.
 *
 * Every kernel here is mono. A voice graph stays mono until its terminal pan,
 * and a post chain gets its stereo by compiling the SAME graph twice and
 * running one instance per side (see post.ts). That buys per-side networks
 * like `width`, and it structurally rules out mid/side: no kernel can see both
 * channels at once, so none of them can form M = (L+R)/2.
 *
 * So this is not a node. It is a MASTER-BUS STAGE, in the one place both
 * channels exist, alongside the glue compressor and the output gain — and it
 * is deliberately the smallest useful pair of controls rather than a general
 * M/S chain:
 *
 *   width      scale the SIDE against the mid. 0 collapses to mono, 1 is
 *              untouched, >1 widens. Unlike a Haas or Lauridsen widener this
 *              is exact and reversible: it adds nothing, it only rebalances
 *              what is already there.
 *   monoBelow  collapse everything under a frequency to mono. The standard
 *              mastering move, and the one that actually matters on a system
 *              with a single sub: stereo bass either cancels or wanders.
 *
 * BOTH ARE MONO-SAFE BY CONSTRUCTION. Scaling S never changes M, and M is
 * exactly the mono sum — so a mix folded to mono is bit-identical whatever the
 * width is set to. That is the property a Haas widener cannot offer, and the
 * reason this is worth having as well as `width`.
 * ------------------------------------------------------------------------- */
import { clamp } from './util'

export interface StereoConfig {
  /** Side scale: 0 = mono, 1 = untouched, >1 wider. Clamped to [0, 4]. */
  width?: number
  /** Collapse to mono below this frequency, Hz. 0 = off. Clamped to [0, 800]. */
  monoBelow?: number
}

export const STEREO_DEFAULTS = { width: 1, monoBelow: 0 }

/** One-pole low-pass coefficient for a corner at `freq`. */
export const lowCoeff = (freq: number, sr: number): number =>
  freq <= 0 ? 0 : 1 - Math.exp((-2 * Math.PI * freq) / sr)

/**
 * The width transform for one sample pair, as a pure function.
 *
 * Pure and exported because this is the whole contract: mono compatibility is
 * a claim about arithmetic, and a test can check it exactly rather than
 * approximately.
 */
export function applyWidth(l: number, r: number, width: number): [number, number] {
  // width 1 short-circuits to a BIT-EXACT passthrough. Going round the
  // encode/decode at unity is not identity in floating point — (l+r)/2 +
  // (l-r)/2 turned -0.3 into -0.30000000000000004 — and "does nothing when
  // set to 1" should mean nothing, not nearly nothing.
  if (width === 1) return [l, r]
  const m = (l + r) / 2
  const s = ((l - r) / 2) * width
  return [m + s, m - s]
}

/** Master-bus stereo stage. Holds only the low-pass state the mono-below
 *  crossover needs; width itself is stateless. */
export class StereoStage {
  private width = STEREO_DEFAULTS.width
  private monoBelow = STEREO_DEFAULTS.monoBelow
  private lpL = 0
  private lpR = 0
  private coeff = 0
  private sr = 0

  set(cfg: StereoConfig, sampleRate: number): void {
    this.width = clamp(cfg.width ?? STEREO_DEFAULTS.width, 0, 4)
    this.monoBelow = clamp(cfg.monoBelow ?? STEREO_DEFAULTS.monoBelow, 0, 800)
    this.sr = sampleRate
    this.coeff = lowCoeff(this.monoBelow, sampleRate)
  }

  /** True when this stage would change nothing — the caller skips it, so an
   *  untouched project stays sample-identical rather than merely close. */
  get idle(): boolean {
    return this.width === 1 && this.monoBelow <= 0
  }

  /** Process one sample pair in place-ish; returns [l, r]. */
  step(l: number, r: number): [number, number] {
    /* A non-finite sample would poison the crossover's filter state for
     * good — one NaN and every later block comes out NaN. Scrub on the way
     * in, the same discipline the rest of the engine's kernels follow. */
    let outL = Number.isFinite(l) ? l : 0
    let outR = Number.isFinite(r) ? r : 0
    if (this.monoBelow > 0) {
      // split each channel, mono the two low bands, keep the highs as they are
      this.lpL += (outL - this.lpL) * this.coeff
      this.lpR += (outR - this.lpR) * this.coeff
      if (!Number.isFinite(this.lpL)) this.lpL = 0
      if (!Number.isFinite(this.lpR)) this.lpR = 0
      const lowMono = (this.lpL + this.lpR) / 2
      const hiL = outL - this.lpL
      const hiR = outR - this.lpR
      outL = lowMono + hiL
      outR = lowMono + hiR
    }
    if (this.width !== 1) {
      const [wl, wr] = applyWidth(outL, outR, this.width)
      outL = wl
      outR = wr
    }
    return [outL, outR]
  }

  reset(): void {
    this.lpL = 0
    this.lpR = 0
  }
}
