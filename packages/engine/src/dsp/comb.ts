import type { DspContext, Kernel } from './types'
import { clamp, flush } from './util'

export interface CombConfig {
  /** One-pole lowpass amount in the feedback path, 0..0.99 — higher is darker
   *  and decays high frequencies faster (Karplus-Strong string damping).
   *  Default 0.2. */
  damp?: number
}

/** Minimum frequency the comb can be tuned to — sets the buffer length
 *  (delay = sr/freq, longest at the lowest freq). */
const MIN_FREQ = 20
/** Inaudible-tail floor (~ -80 dBFS): when a whole block's input AND output
 *  stay below this, the resonator has drained and the ring buffer is scrubbed
 *  to exact 0. A scalar flush can't do this — the buffer decays only ~feedback
 *  per round trip, so a silent tail would ring near-forever. See reverb.ts. */
const SETTLE_FLOOR = 1e-4

/** Tuned feedback comb (Karplus-Strong-flavored resonator). Inputs 'in', 'freq'
 *  (Hz, audio-rate, clamped per sample to [20, sr/2]) and 'feedback' (clamped
 *  to [0, 0.98]). The delay length is sr/freq samples, read with linear
 *  interpolation so the resonance tunes continuously; `y[n] = x[n] + feedback *
 *  lp(y[n - delay])`, where lp() is a one-pole lowpass (config `damp`) in the
 *  feedback path. The line resonates at `freq` with a metallic/physical ring.
 *
 *  Buffers: the ring buffer (sized for the lowest tunable freq, 20 Hz) is
 *  allocated EAGERLY at construction from ctx.sampleRate (like delay.ts), so
 *  steady-state process() is allocation-free. Without ctx it allocates lazily
 *  on the first process() call.
 *
 *  Stability: feedback <= 0.98 and the damping lowpass keep the loop gain below
 *  1, so the resonance decays for any bounded input. Denormal/NaN hygiene: the
 *  filter state is flushed each block (flush()), a non-finite last write zeroes
 *  the buffer, and the SETTLE_FLOOR drain lets a silent tail reach exact 0. */
export class CombKernel implements Kernel {
  private readonly damp: number
  private buf: Float32Array | null = null
  private writeIdx = 0
  private lp = 0

  constructor(config: CombConfig = {}, ctx?: DspContext) {
    this.damp = clamp(config.damp ?? 0.2, 0, 0.99)
    if (ctx) this.buf = new Float32Array(Math.ceil(ctx.sampleRate / MIN_FREQ) + 2)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const freq = inputs['freq']!
    const feedback = inputs['feedback']!
    const sr = ctx.sampleRate
    const buf = this.buf ?? (this.buf = new Float32Array(Math.ceil(sr / MIN_FREQ) + 2))
    const len = buf.length
    const maxDelay = len - 2
    const damp = this.damp
    const oneMinusDamp = 1 - damp
    let w = this.writeIdx
    let lp = this.lp
    let inPeak = 0
    let outPeak = 0

    for (let i = 0; i < n; i++) {
      const x = input[i]!
      const ax = x < 0 ? -x : x
      if (ax > inPeak) inPeak = ax
      const f = clamp(freq[i]!, MIN_FREQ, 0.5 * sr)
      let d = sr / f
      if (!(d >= 1)) d = 1
      else if (d > maxDelay) d = maxDelay
      const di = Math.floor(d)
      const frac = d - di
      let r0 = w - di
      if (r0 < 0) r0 += len
      let r1 = r0 - 1
      if (r1 < 0) r1 += len
      const read = buf[r0]! + frac * (buf[r1]! - buf[r0]!)
      // one-pole lowpass in the feedback path
      lp = oneMinusDamp * read + damp * lp
      const y = x + clamp(feedback[i]!, 0, 0.98) * lp
      buf[w] = y
      out[i] = y
      const ay = y < 0 ? -y : y
      if (ay > outPeak) outPeak = ay
      w++
      if (w >= len) w = 0
    }

    // Block-end hygiene. Flush the filter state; zero the buffer on a poison
    // write; drain a fully-silent resonator to exact 0 (see SETTLE_FLOOR).
    lp = flush(lp)
    const last = buf[w === 0 ? len - 1 : w - 1]!
    if (!Number.isFinite(last)) {
      buf.fill(0)
      lp = 0
    } else if (inPeak < SETTLE_FLOOR && outPeak < SETTLE_FLOOR) {
      buf.fill(0)
      lp = 0
    }
    this.writeIdx = w
    this.lp = lp
  }

  reset(): void {
    this.writeIdx = 0
    this.lp = 0
    this.buf?.fill(0)
  }
}
