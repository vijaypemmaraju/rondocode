import type { DspContext, Kernel } from './types'
import { clamp } from './util'
import { smoothCoeff } from './compress'

/* ------------------------------------------------------------------------- *
 * LOOK-AHEAD BRICKWALL LIMITER.
 *
 * The engine already had a master safety stage and the comment beside it
 * called it a limiter. It is not one — `masterSafety` is a tanh soft-clip at
 * 0.95, which is a fine last resort (it can never output more than ±1, and it
 * distorts gracefully) but it is DISTORTION, not gain control. Ask it to hold
 * a ceiling on a live PA feed and it will hold it by changing the waveform.
 *
 * A limiter holds the ceiling by turning DOWN, and it knows to turn down
 * BEFORE the peak arrives because it delays the audio and looks at the future
 * it has already received. That is the whole trick and the whole cost: the
 * output is late by `lookahead`.
 *
 * THE CEILING IS A GUARANTEE, not a target. Two mechanisms, deliberately
 * belt-and-braces:
 *
 *   the WINDOW MINIMUM — the gain applied is the smallest gain any sample in
 *     the look-ahead window will need, tracked exactly with a monotonic deque
 *     rather than approximated. So the reduction is already in place when the
 *     peak emerges.
 *   the FINAL CLAMP — whatever the smoothing is doing, the gain is clamped to
 *     what THIS sample needs before it is applied. Smoothing can therefore
 *     never cause an overshoot, which is the one bug a limiter must not have.
 *
 * Release only. There is no attack control: the attack IS the lookahead, and
 * exposing both invites a setting where the gain has not finished moving when
 * the transient lands.
 * ------------------------------------------------------------------------- */

export interface LimiterConfig {
  /** Output ceiling in dBFS. Default -0.3 — a hair under 0 so inter-sample
   *  peaks and downstream resampling have somewhere to go. Clamped to
   *  [-40, 0]. */
  ceiling?: number
  /** How far ahead it looks, ms. Default 5. This is also the latency it adds,
   *  which is why it is short. Clamped to [0.1, 50]. */
  lookahead?: number
  /** How fast the gain returns once the peak has passed, ms. Default 60.
   *  Too short and loud material pumps; too long and one transient ducks the
   *  next bar. Clamped to [1, 1000]. */
  release?: number
}

/** Gain a sample of magnitude `lin` needs to sit at or below `ceilingLin`.
 *  1 when it is already under. Pure: this is the contract the whole node is
 *  built to honour, so it is testable on its own. */
export function requiredGain(lin: number, ceilingLin: number): number {
  if (!(lin > ceilingLin)) return 1
  return ceilingLin / lin
}

export class LimiterKernel implements Kernel {
  private readonly ceilingLin: number
  private readonly lookaheadMs: number
  private readonly releaseMs: number

  /** delay line holding the audio while we look at its future */
  private delay = new Float32Array(1)
  private writeIdx = 0
  private len = 1

  /* Monotonic deque over the look-ahead window, holding indices into `req` in
   * increasing order of required gain. The front is always the window's
   * minimum, which is what makes the guarantee exact rather than approximate. */
  private req = new Float32Array(1)
  private dq = new Int32Array(1)
  private dqHead = 0
  private dqTail = 0
  private filled = 0

  private gain = 1
  private sr = 0
  private rel = 0

  constructor(cfg: LimiterConfig = {}) {
    this.ceilingLin = Math.pow(10, clamp(cfg.ceiling ?? -0.3, -40, 0) / 20)
    this.lookaheadMs = clamp(cfg.lookahead ?? 5, 0.1, 50)
    this.releaseMs = clamp(cfg.release ?? 60, 1, 1000)
  }

  private resize(sr: number): void {
    this.sr = sr
    this.len = Math.max(1, Math.round((this.lookaheadMs / 1000) * sr))
    this.delay = new Float32Array(this.len)
    this.req = new Float32Array(this.len)
    this.req.fill(1)
    this.dq = new Int32Array(this.len + 1)
    this.dqHead = 0
    this.dqTail = 0
    this.writeIdx = 0
    this.filled = 0
    this.gain = 1
    this.rel = smoothCoeff(this.releaseMs, sr)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (ctx.sampleRate !== this.sr) this.resize(ctx.sampleRate)
    const L = this.len
    const ceil = this.ceilingLin
    let g = this.gain

    for (let i = 0; i < n; i++) {
      const x = Number.isFinite(input[i]!) ? input[i]! : 0
      const need = requiredGain(Math.abs(x), ceil)

      // the sample about to LEAVE the window stops constraining the gain
      if (this.filled === L && this.dqHead !== this.dqTail && this.dq[this.dqHead] === this.writeIdx) {
        this.dqHead = (this.dqHead + 1) % this.dq.length
      }
      // pop anything the new sample makes irrelevant: it needs less gain and
      // arrives later, so those can never be the window minimum again
      while (this.dqHead !== this.dqTail) {
        const back = (this.dqTail - 1 + this.dq.length) % this.dq.length
        if (this.req[this.dq[back]!]! >= need) this.dqTail = back
        else break
      }
      this.dq[this.dqTail] = this.writeIdx
      this.dqTail = (this.dqTail + 1) % this.dq.length

      const delayed = this.filled === L ? this.delay[this.writeIdx]! : 0
      this.delay[this.writeIdx] = x
      this.req[this.writeIdx] = need
      this.writeIdx = (this.writeIdx + 1) % L
      if (this.filled < L) this.filled++

      // the smallest gain anything in the window will need
      const target = this.req[this.dq[this.dqHead]!]!
      // DOWN immediately (the lookahead is what makes that inaudible), UP on
      // the release curve
      g = target < g ? target : g + (target - g) * this.rel

      /* THE GUARANTEE. Whatever the smoothing is doing, this sample cannot
       * exceed the ceiling: clamp to what it needs, right now. Without this a
       * release curve rising into a transient could overshoot, which is the
       * one bug a brickwall limiter is not allowed to have. */
      const needNow = requiredGain(Math.abs(delayed), ceil)
      const applied = g < needNow ? g : needNow
      out[i] = delayed * applied
    }
    this.gain = Number.isFinite(g) ? g : 1
  }

  reset(): void {
    if (this.sr > 0) this.resize(this.sr)
  }
}
