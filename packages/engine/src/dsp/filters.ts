import type { DspContext, Kernel } from './types'
import { clamp, flush } from './util'

const TWO_PI = 2 * Math.PI

/** Every SVF response mode, as a VALUE — the editor needs to enumerate these
 *  (completion, the mode chips, the response-curve widget's scanners) and a
 *  bare type cannot be iterated, so three separate copies of this list grew in
 *  the app. The type is derived from the list, so a new mode reaches all of
 *  them by adding one entry here. */
export const SVF_MODES = ['lp', 'hp', 'bp', 'notch', 'peak', 'allpass'] as const

export type SvfMode = (typeof SVF_MODES)[number]

/** Simper TPT state-variable filter (12dB/oct). Inputs 'in', 'cutoff' (Hz,
 *  audio-rate, clamped per sample to [1, 0.49*sr]) and 'res' (0..1, clamped to
 *  [0, 0.98] — res=1 would be zero damping). Config: mode
 *  'lp'|'hp'|'bp'|'notch'|'peak'|'allpass'. The three canonical SVF outputs
 *  are low = v2, band = v1, high = x - k*band - low; the composites are
 *  notch = low + high (= x - k*band, a rejection dip at cutoff),
 *  peak = low - high (a resonant bell that boosts at cutoff) and
 *  allpass = low + high - k*band (= x - 2k*band: unity magnitude everywhere,
 *  the phase sweeps through -180° at cutoff — phaser building block). */
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
                : mode === 'allpass'
                  ? low + high - k * band
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

export type DualSvfRouting = 'serial' | 'parallel'

export interface DualSvfConfig {
  /** Stage routing: 'serial' (A then B, default — e.g. hp into lp for a
   *  steep band carve) or 'parallel' (A + B summed — e.g. lp + hp leaves a
   *  spectral hole between the two cutoffs). */
  mode?: DualSvfRouting
  /** Stage A response ('lp' default). */
  a?: SvfMode
  /** Stage B response ('lp' default). */
  b?: SvfMode
}

/** One Simper SVF stage's tap mix for `mode` (same math as SvfKernel). */
const svfTap = (mode: SvfMode, k: number, low: number, band: number, high: number): number =>
  mode === 'lp'
    ? low
    : mode === 'bp'
      ? band
      : mode === 'hp'
        ? high
        : mode === 'notch'
          ? low + high
          : mode === 'allpass'
            ? low + high - k * band
            : low - high // peak

/** Serum-style DUAL filter: two Simper SVF stages, each with its OWN cutoff
 *  and response type, sharing one 'res'. Inputs 'in', 'cutoff' (stage A, Hz),
 *  'cutoff2' (stage B, Hz) and 'res' (0..1); cutoffs are clamped per sample to
 *  [1, 0.49*sr], res to [0, 0.98]. Config: DualSvfConfig (routing + per-stage
 *  modes; unknown mode words fall back to 'peak' like SvfKernel's mix). */
export class DualSvfKernel implements Kernel {
  private a1 = 0
  private a2 = 0
  private b1 = 0
  private b2 = 0
  private readonly routing: DualSvfRouting
  private readonly modeA: SvfMode
  private readonly modeB: SvfMode

  constructor(cfg?: DualSvfConfig) {
    this.routing = cfg?.mode === 'parallel' ? 'parallel' : 'serial'
    this.modeA = cfg?.a ?? 'lp'
    this.modeB = cfg?.b ?? 'lp'
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const cutA = inputs['cutoff']!
    const cutB = inputs['cutoff2']!
    const res = inputs['res']!
    const sr = ctx.sampleRate
    const parallel = this.routing === 'parallel'
    const mA = this.modeA
    const mB = this.modeB
    let a1 = this.a1
    let a2 = this.a2
    let b1 = this.b1
    let b2 = this.b2
    for (let i = 0; i < n; i++) {
      const x = input[i]!
      const r = clamp(res[i]!, 0, 0.98)
      const k = 2 - 2 * r

      // stage A
      const fa = clamp(cutA[i]!, 1, 0.49 * sr)
      const ga = Math.tan((Math.PI * fa) / sr)
      const aa1 = 1 / (1 + ga * (ga + k))
      const aa2 = ga * aa1
      const aa3 = ga * aa2
      const av3 = x - a2
      const av1 = aa1 * a1 + aa2 * av3
      const av2 = a2 + aa2 * a1 + aa3 * av3
      a1 = 2 * av1 - a1
      a2 = 2 * av2 - a2
      const ya = svfTap(mA, k, av2, av1, x - k * av1 - av2)

      // stage B: serial eats stage A's output, parallel eats the dry input
      const xb = parallel ? x : ya
      const fb = clamp(cutB[i]!, 1, 0.49 * sr)
      const gb = Math.tan((Math.PI * fb) / sr)
      const ba1 = 1 / (1 + gb * (gb + k))
      const ba2 = gb * ba1
      const ba3 = gb * ba2
      const bv3 = xb - b2
      const bv1 = ba1 * b1 + ba2 * bv3
      const bv2 = b2 + ba2 * b1 + ba3 * bv3
      b1 = 2 * bv1 - b1
      b2 = 2 * bv2 - b2
      const yb = svfTap(mB, k, bv2, bv1, xb - k * bv1 - bv2)

      out[i] = parallel ? ya + yb : yb
    }
    this.a1 = flush(a1)
    this.a2 = flush(a2)
    this.b1 = flush(b1)
    this.b2 = flush(b2)
  }

  reset(): void {
    this.a1 = 0
    this.a2 = 0
    this.b1 = 0
    this.b2 = 0
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
