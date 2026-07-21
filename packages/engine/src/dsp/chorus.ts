import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface ChorusConfig {
  /** LFO rate in Hz (the slowest voice; the other two run at 1.31x and 0.73x).
   *  Clamped to [0.01, 20]. Default 0.6. */
  rate?: number
  /** Modulation depth in seconds — how far each tap sweeps around the ~11 ms
   *  base delay. Clamped to [0, 0.05]. Default 0.003. */
  depth?: number
  /** Dry/wet blend, 0..1: out = in*(1-mix) + wet*mix. Default 0.5. */
  mix?: number
}

const TWO_PI = 2 * Math.PI
/** Base delay, ~11 ms — the center each modulated tap sweeps around. */
const BASE = 0.011
/** LFO frequency multipliers for the three voices. Mutually irrational-ish
 *  ratios (1, 1.31, 0.73) so the taps never lock in phase — that non-repeating
 *  drift is what thickens a single tone into an ensemble. */
const MULT = [1.0, 1.31, 0.73]
/** Max modulated delay for buffer sizing: BASE + max depth (0.05). */
const MAX_DELAY = BASE + 0.05

/** Three-voice modulated-delay chorus (an ensemble). Input 'in'; rate/depth/mix
 *  are construction config, NOT per-sample inputs. Three taps each read the
 *  delay line at a fractional (linear-interpolated) position
 *  `BASE + depth*sin(phase_k)`, where the three LFO phases advance at
 *  rate * {1.0, 1.31, 0.73}. The detuned, non-repeating phase relationship
 *  gives a lush, slowly beating thickness; the wet signal is the average of the
 *  three taps, and the output crossfades dry<->wet by `mix`.
 *
 *  Stereo width: this kernel is mono. In the post-chain it runs TWICE, once per
 *  stereo side, with INDEPENDENT state — the two instances' LFOs drift apart,
 *  so identical (centered) input comes out decorrelated L/R. That channel
 *  decorrelation, not anything in this kernel, is what makes chorus feel wide.
 *
 *  Buffers: the ring buffer is allocated EAGERLY at construction from
 *  ctx.sampleRate (like delay.ts), covering BASE + max depth + margin, so
 *  steady-state process() is allocation-free. Without ctx it allocates lazily
 *  on the first process() call.
 *
 *  Hygiene: there is NO feedback path — each write is the raw input — so the
 *  line drains to silence within one buffer length and denormals never
 *  accumulate; a steady silent input yields exact-0 output. The only state that
 *  could carry a poison value is a NaN in the buffer, caught at block end by the
 *  same last-write check delay.ts uses (non-finite -> zero the buffer). */
export class ChorusKernel implements Kernel {
  private readonly rate: number
  private readonly depth: number
  private readonly mix: number
  private buf: Float32Array | null = null
  private writeIdx = 0
  /** LFO phases for the three voices, radians in [0, 2*pi). */
  private readonly phase = new Float64Array(3)

  constructor(config: ChorusConfig = {}, ctx?: DspContext) {
    this.rate = clamp(config.rate ?? 0.6, 0.01, 20)
    this.depth = clamp(config.depth ?? 0.003, 0, 0.05)
    this.mix = clamp(config.mix ?? 0.5, 0, 1)
    if (ctx) this.buf = new Float32Array(Math.ceil(MAX_DELAY * ctx.sampleRate) + 2)
    // Stereo spread: the post-chain compiles its RIGHT instance with a nonzero
    // ctx.spread (see DspContext.spread). Offset the LFO start phases on that
    // side so the two mono chorus instances DON'T evolve identically from
    // identical (centered) input — that phase difference is the stereo width.
    // Without this, L and R chorus are bit-identical and add no width.
    if ((ctx?.spread ?? 0) > 0) {
      this.phase[0] = Math.PI * 0.5
      this.phase[1] = Math.PI * 1.1
      this.phase[2] = Math.PI * 1.7
    }
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const sr = ctx.sampleRate
    const buf = this.buf ?? (this.buf = new Float32Array(Math.ceil(MAX_DELAY * sr) + 2))
    const len = buf.length
    const maxDelay = len - 2
    const base = BASE * sr
    const depth = this.depth * sr
    const mix = this.mix
    const dry = 1 - mix
    // per-sample phase increments for the three voices
    const inc0 = (TWO_PI * this.rate * MULT[0]!) / sr
    const inc1 = (TWO_PI * this.rate * MULT[1]!) / sr
    const inc2 = (TWO_PI * this.rate * MULT[2]!) / sr
    let p0 = this.phase[0]!
    let p1 = this.phase[1]!
    let p2 = this.phase[2]!
    let w = this.writeIdx

    for (let i = 0; i < n; i++) {
      const x = input[i]!
      const wet =
        (this.tap(buf, len, maxDelay, w, base + depth * Math.sin(p0)) +
          this.tap(buf, len, maxDelay, w, base + depth * Math.sin(p1)) +
          this.tap(buf, len, maxDelay, w, base + depth * Math.sin(p2))) /
        3
      out[i] = x * dry + wet * mix
      buf[w] = x
      w++
      if (w >= len) w = 0
      p0 += inc0
      if (p0 >= TWO_PI) p0 -= TWO_PI
      p1 += inc1
      if (p1 >= TWO_PI) p1 -= TWO_PI
      p2 += inc2
      if (p2 >= TWO_PI) p2 -= TWO_PI
    }

    // Block-end NaN check on the most recent write only (see delay.ts).
    const last = buf[w === 0 ? len - 1 : w - 1]!
    if (!Number.isFinite(last)) buf.fill(0)
    this.writeIdx = w
    this.phase[0] = p0
    this.phase[1] = p1
    this.phase[2] = p2
  }

  /** Linear-interpolated read `d` samples behind write head `w`, d clamped to
   *  [1, maxDelay] (also catches a NaN d). */
  private tap(buf: Float32Array, len: number, maxDelay: number, w: number, d: number): number {
    if (!(d >= 1)) d = 1
    else if (d > maxDelay) d = maxDelay
    const di = Math.floor(d)
    const frac = d - di
    let r0 = w - di
    if (r0 < 0) r0 += len
    let r1 = r0 - 1
    if (r1 < 0) r1 += len
    return buf[r0]! + frac * (buf[r1]! - buf[r0]!)
  }

  reset(): void {
    this.writeIdx = 0
    this.phase.fill(0)
    this.buf?.fill(0)
  }
}
