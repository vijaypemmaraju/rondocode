import type { DspContext, Kernel } from './types'
import { cpsOf, flush } from './util'

const TWO_PI = 2 * Math.PI

export type LfoShape = 'sine' | 'tri' | 'square' | 'saw' | 'rand'

/** Low-frequency oscillator. Input 'freq' (Hz by default, audio-rate, phase
 *  increment clamped to ±0.5); output UNIPOLAR [0, 1]:
 *    sine   0.5 + 0.5*sin(2*pi*p)   (starts at 0.5, rising)
 *    tri    1 - |2p - 1|            (starts at 0, peak at mid-cycle)
 *    square p < 0.5 ? 1 : 0         (high half-cycle first)
 *    saw    p                       (rising ramp)
 *    rand   sample-and-hold: a new random level in [0, 1) latched on each phase
 *           wrap and HELD until the next — a stepped random modulator
 *  Shapes are computed naively from the phase — aliasing is irrelevant at LFO
 *  rates, and unlike TriKernel (whose leaky integrator collapses at sub-audio
 *  frequencies) these are exact at any rate.
 *
 *  The 'rand' source is a seedable xorshift32 (like NoiseKernel), so a render is
 *  stable and reset() replays it exactly. It is FREE-RUNNING per voice — driven
 *  by this kernel's own phase, one draw per LFO cycle — NOT time-locked like the
 *  pattern-side `rand` (whose value is a function of the cycle position). Two
 *  voices with the same seed and freq step through the same levels; give each a
 *  distinct seed for independent random movement.
 *
 *  TEMPO SYNC (`sync`): with sync on, 'freq' is no longer Hz but a length in
 *  CYCLES of the transport — rate 1 is one LFO period per cycle, 0.25 a
 *  quarter-note wobble at four beats to the cycle, 0.0625 a sixteenth. The
 *  kernel reads ctx.cps EVERY BLOCK and converts (Hz = cps / rate), so a
 *  tempo change re-rates the LFO live without a recompile. Only the phase
 *  INCREMENT changes — the phase itself is never touched — so the output is
 *  continuous across a tempo change: no jump, no click. Rate 0 (or a
 *  non-finite rate) parks the LFO instead of dividing by zero: the phase
 *  freezes and the output holds its current level. */
export class LfoKernel implements Kernel {
  private phase = 0
  private readonly seed: number
  private state: number
  /** Current sample-and-hold level, latched on each wrap (rand shape only). */
  private held = 0

  constructor(
    private readonly shape: LfoShape = 'sine',
    seed = 0x2545f491,
    /** 'freq' is a length in transport CYCLES rather than Hz (see class doc). */
    private readonly sync = false,
  ) {
    // xorshift32 needs a nonzero state
    this.seed = (seed >>> 0) || 1
    this.state = this.seed
    this.latch() // hold an initial level before the first wrap
  }

  /** Advance the PRNG and latch a fresh sample-and-hold level in [0, 1). */
  private latch(): void {
    let x = this.state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    this.state = x
    this.held = x / 4294967296
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    const shape = this.shape
    const sr = ctx.sampleRate
    // Synced: 'freq' is a period length in cycles, so Hz = cps / rate. Read
    // once per block — one tempo per block is the engine's control cadence.
    const cps = this.sync ? cpsOf(ctx) : 0
    let phase = this.phase
    for (let i = 0; i < n; i++) {
      out[i] =
        shape === 'sine'
          ? 0.5 + 0.5 * Math.sin(TWO_PI * phase)
          : shape === 'tri'
            ? 1 - Math.abs(2 * phase - 1)
            : shape === 'square'
              ? phase < 0.5
                ? 1
                : 0
              : shape === 'rand'
                ? this.held
                : phase
      // rate 0 (or non-finite) would be an infinite/NaN Hz — park the phase
      // instead, so the LFO holds its level rather than poisoning it.
      const rate = freq[i]!
      const hz = this.sync ? (rate === 0 || !Number.isFinite(rate) ? 0 : cps / rate) : rate
      let dt = hz / sr
      if (dt > 0.5) dt = 0.5
      else if (dt < -0.5) dt = -0.5
      phase += dt
      // A wrap (floor != 0, either direction) latches a new S&H level; the new
      // value takes effect from the NEXT sample so each step is flat.
      const w = Math.floor(phase)
      if (w !== 0) {
        phase -= w
        if (shape === 'rand') this.latch()
      }
    }
    // NaN freq poisons the phase (floor(NaN) never recovers) — flush at block
    // end so a bad control block costs at most one block of output.
    this.phase = flush(phase)
  }

  reset(): void {
    this.phase = 0
    this.state = this.seed
    this.latch()
  }
}
