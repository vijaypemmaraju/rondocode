import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface WidthConfig {
  /** Decorrelation delay character. 'wide' (default) = 12 ms, a broad
   *  pseudo-stereo spread that reaches down into the low mids; 'tight' = 3 ms,
   *  a subtler spread that leaves the low end more coherent per channel. */
  mode?: 'wide' | 'tight'
}

/** Decorrelation delay per mode, in seconds. */
const MODE_DELAY: Record<'wide' | 'tight', number> = { wide: 0.012, tight: 0.003 }

/** Lauridsen pseudo-stereo widener. Inputs 'in' and 'amount' (0..1,
 *  audio-rate). `mode` is construction config.
 *
 *  WHERE THE STEREO IS. Every kernel in this engine is mono, and a voice graph
 *  stays mono until its terminal pan. The one place a graph is genuinely
 *  stereo is the POST chain (and a bus): PostChain compiles the SAME graph
 *  TWICE and runs one instance per side, marking the right-hand instance with
 *  a nonzero ctx.spread (see post.ts). So a mid/side scaler is not expressible
 *  here — no kernel can see both channels — but a per-side network is, and
 *  that is what this kernel is.
 *
 *  Each instance emits `(x ± amount * x[n - D]) / sqrt(1 + amount^2)`, taking
 *  PLUS on the left instance and MINUS on the right (the ctx.spread marker
 *  picks the sign). That is the Lauridsen network, and it buys three
 *  properties worth stating exactly:
 *
 *  1. Correlation. For a source whose delayed copy is uncorrelated with
 *     itself, corr(L, R) = (1 - a^2) / (1 + a^2): 1 at amount 0, 0.60 at 0.5,
 *     0 at amount 1. Width rises monotonically with amount.
 *  2. MONO COMPATIBILITY, exactly. (L + R) / 2 = x / sqrt(1 + a^2) — the
 *     delayed term cancels, so the mono sum is the DRY signal with a flat,
 *     frequency-independent level trim of 0 dB at amount 0 down to -3.01 dB at
 *     amount 1. No comb notches, no null, nothing cancels but the widening
 *     itself. (A Haas-style one-sided delay would instead comb the mono sum to
 *     deep periodic nulls; that is why this shape was chosen.)
 *  3. The honest cost. Each channel ALONE is comb filtered: L peaks where R
 *     notches and vice versa, spaced 1/D apart (83 Hz for 'wide', 333 Hz for
 *     'tight'). Broadband energy is equal on both sides, so the image stays
 *     centered, but a single channel soloed sounds phasey. That is the trade
 *     for creating stereo out of mono.
 *
 *  amount 0 is a bit-exact passthrough (`x + 0 * read === x`, `x * 1 === x`).
 *
 *  IN A VOICE GRAPH there is only ONE instance and ctx.spread is always 0, so
 *  the minus half never runs and this degrades to a fixed comb filter — a mild
 *  phasey colour, no width at all. Put it in a `post` chain or a bus.
 *
 *  Buffers: the ring buffer is allocated EAGERLY at construction from
 *  ctx.sampleRate (like delay.ts), so steady-state process() is
 *  allocation-free; without ctx it allocates lazily on the first process().
 *  The delay is a whole number of samples, so no interpolation is needed.
 *
 *  Hygiene: there is no feedback path — every write is the raw input — so the
 *  line drains to silence within one buffer length and a steady silent input
 *  yields exact 0. A non-finite last write zeroes the buffer at block end
 *  (the check delay.ts uses). */
export class WidthKernel implements Kernel {
  /** +1 on the left post instance, -1 on the right (see class doc). */
  private readonly side: number
  private readonly seconds: number
  private delaySamples = 0
  private sr = 0
  private buf: Float32Array | null = null
  private writeIdx = 0
  /** Cached normalization for the last `amount` seen — amount is usually a
   *  constant, so this skips a sqrt per sample. */
  private lastAmount = -1
  private lastGain = 1

  constructor(config: WidthConfig = {}, ctx?: DspContext) {
    this.seconds = MODE_DELAY[config.mode === 'tight' ? 'tight' : 'wide']
    // The right-hand post instance is the one PostChain compiles with a
    // nonzero spread; it takes the minus sign so the pair sums back to dry.
    this.side = (ctx?.spread ?? 0) > 0 ? -1 : 1
    if (ctx) this.size(ctx.sampleRate)
  }

  /** Size the ring buffer for `sr`. Called at construction (so the audio
   *  thread never allocates) and again only if the rate ever changes. */
  private size(sr: number): void {
    this.sr = sr
    this.delaySamples = Math.max(1, Math.round(this.seconds * sr))
    this.buf = new Float32Array(this.delaySamples + 1)
    this.writeIdx = 0
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    const amount = inputs['amount']!
    if (ctx.sampleRate !== this.sr) this.size(ctx.sampleRate)
    const buf = this.buf!
    const len = buf.length
    const d = this.delaySamples
    const side = this.side
    let w = this.writeIdx
    let lastA = this.lastAmount
    let g = this.lastGain

    for (let i = 0; i < n; i++) {
      const x = input[i]!
      const a = clamp(amount[i]!, 0, 1)
      if (a !== lastA) {
        // NaN amount clamps through to NaN; g then goes NaN for that sample
        // and the flush below is not needed (no state carries it).
        lastA = a
        g = 1 / Math.sqrt(1 + a * a)
      }
      buf[w] = x
      let r = w - d
      if (r < 0) r += len
      // a === 0 => `x + 0 * read === x` and `x * 1 === x`: bit-exact dry.
      out[i] = (x + side * a * buf[r]!) * g
      w++
      if (w >= len) w = 0
    }

    // Block-end NaN check on the most recent write only (see delay.ts).
    const last = buf[w === 0 ? len - 1 : w - 1]!
    if (!Number.isFinite(last)) buf.fill(0)
    this.writeIdx = w
    this.lastAmount = Number.isFinite(lastA) ? lastA : -1
    this.lastGain = Number.isFinite(g) ? g : 1
  }

  reset(): void {
    this.writeIdx = 0
    this.buf?.fill(0)
    this.lastAmount = -1
    this.lastGain = 1
  }
}
