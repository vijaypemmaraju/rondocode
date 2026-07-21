import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface DelayConfig {
  /** Maximum delay time in seconds (sets the buffer size). Default 2. */
  maxTime?: number
}

/** Feedback delay line. Inputs 'in', 'time' (seconds, audio-rate, clamped to
 *  [0, maxTime]; effective minimum is 1 sample — a true zero-sample feedback
 *  loop is ill-defined) and 'feedback' (clamped to [-0.99, 0.99]). Output is
 *  wet-only: the tap read at t - time with linear interpolation. Each sample
 *  writes in + feedback*read through a soft knee: identity for |v| <= 1,
 *  sign(v)*(2 - 1/|v|) above. The knee is continuous, monotonic, value- AND
 *  slope-matched at |v| = 1 (f(1) = 1, f'(1) = 1) and asymptotes at ±2, so
 *  runaway feedback saturates smoothly. (A tanh applied only above |1| is
 *  NOT monotonic across the threshold — f(1)=1 but f(1+eps)~0.762 — and a
 *  signal riding across it writes ~0.24 steps that recirculate as crackle.)
 *  Stability: every write is < 2 in magnitude, reads interpolate written
 *  values, and |feedback| <= 0.99, so the loop stays bounded by ±2 for any
 *  bounded input.
 *
 *  Buffer allocation: pass ctx at construction (the graph compiler does) and
 *  the ring buffer is allocated EAGERLY there — never on the audio thread.
 *  Without ctx the buffer is allocated lazily on the first process() call
 *  (the sample rate is only known from ctx there); either way it is the one
 *  allocation the kernel ever makes, and steady-state process() is
 *  allocation-free. The construction-time sample rate is assumed to match
 *  the process-time ctx.
 *
 *  NaN hygiene tradeoff: flushing every write is too costly, so at block end
 *  only the most recent write is checked; if it is non-finite the whole buffer
 *  is zeroed (O(n), rare). A NaN in the line does not decay out — it
 *  recirculates through the feedback path (0 * NaN = NaN) and the linear
 *  interpolation smears it across neighboring taps, so in practice it spreads
 *  toward the write head and gets caught at a subsequent block end. Until
 *  that happens (up to roughly one delay round trip) the NaN persists — an
 *  accepted window in exchange for a per-sample-free hot loop. */
export class DelayKernel implements Kernel {
  private readonly maxTime: number
  private buf: Float32Array | null = null
  private writeIdx = 0

  constructor(config: DelayConfig = {}, ctx?: DspContext) {
    this.maxTime = clamp(config.maxTime ?? 2, 0.001, 60)
    if (ctx) this.buf = new Float32Array(Math.ceil(this.maxTime * ctx.sampleRate) + 2)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const time = inputs['time']!
    const feedback = inputs['feedback']!
    const sr = ctx.sampleRate
    // Lazy fallback (no-ctx construction only): +2 so the interpolation tap
    // at the full maxTime never collides with the write head.
    const buf = this.buf ?? (this.buf = new Float32Array(Math.ceil(this.maxTime * sr) + 2))
    const len = buf.length
    const maxDelay = len - 2
    let w = this.writeIdx
    for (let i = 0; i < n; i++) {
      let d = clamp(time[i]!, 0, this.maxTime) * sr
      if (!(d >= 1)) d = 1 // min 1 sample; also catches NaN time
      else if (d > maxDelay) d = maxDelay
      const di = Math.floor(d)
      const frac = d - di
      let r0 = w - di
      if (r0 < 0) r0 += len
      let r1 = r0 - 1
      if (r1 < 0) r1 += len
      const read = buf[r0]! + frac * (buf[r1]! - buf[r0]!)
      out[i] = read
      let v = input[i]! + clamp(feedback[i]!, -0.99, 0.99) * read
      if (v > 1) v = 2 - 1 / v
      else if (v < -1) v = -2 - 1 / v
      buf[w] = v
      w++
      if (w >= len) w = 0
    }
    // Block-end NaN check on the most recent write only (see class doc).
    const last = buf[w === 0 ? len - 1 : w - 1]!
    if (!Number.isFinite(last)) buf.fill(0)
    this.writeIdx = w
  }

  reset(): void {
    this.writeIdx = 0
    this.buf?.fill(0)
  }
}
