import type { DspContext, Kernel } from './types'
import { flush } from './util'

const TWO_PI = 2 * Math.PI

export type LfoShape = 'sine' | 'tri' | 'square' | 'saw' | 'rand'

/** Low-frequency oscillator. Input 'freq' (Hz, audio-rate, phase increment
 *  clamped to ±0.5); output UNIPOLAR [0, 1]:
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
 *  distinct seed for independent random movement. */
export class LfoKernel implements Kernel {
  private phase = 0
  private readonly seed: number
  private state: number
  /** Current sample-and-hold level, latched on each wrap (rand shape only). */
  private held = 0

  constructor(
    private readonly shape: LfoShape = 'sine',
    seed = 0x2545f491,
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
      let dt = freq[i]! / sr
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
