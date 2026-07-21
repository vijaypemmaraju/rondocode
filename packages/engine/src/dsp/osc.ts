import type { DspContext, Kernel } from './types'
import { flush } from './util'

// Every phase oscillator flushes its phase at block end: a NaN freq input
// would otherwise poison the phase permanently (floor(NaN) never recovers).

const TWO_PI = 2 * Math.PI

/** Polynomial band-limited step correction for discontinuities at phase 0. */
const polyblep = (t: number, dt: number): number => {
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

/** Band-limited square sample: ±1 base (low for phase < 0.5) with polyblep on
 *  both edges. Shared by SquareKernel and TriKernel. */
const blepSquare = (phase: number, dt: number): number => {
  const base = phase < 0.5 ? -1 : 1
  return base - polyblep(phase, dt) + polyblep((phase + 0.5) % 1, dt)
}

/** Sine oscillator. Input 'freq' (Hz, audio-rate); output in [-1, 1]. */
export class SineKernel implements Kernel {
  private phase = 0

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    for (let i = 0; i < n; i++) {
      out[i] = Math.sin(TWO_PI * this.phase)
      this.phase += freq[i]! / ctx.sampleRate
      this.phase -= Math.floor(this.phase)
    }
    this.phase = flush(this.phase)
  }

  reset(): void {
    this.phase = 0
  }
}

/** Polyblep sawtooth. Input 'freq' (Hz, audio-rate, clamped to ±Nyquist);
 *  output ~[-1, 1] (small polyblep overshoot possible near edges). */
export class SawKernel implements Kernel {
  private phase = 0

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    for (let i = 0; i < n; i++) {
      let dt = freq[i]! / ctx.sampleRate
      if (dt > 0.5) dt = 0.5
      else if (dt < -0.5) dt = -0.5
      out[i] = 2 * this.phase - 1 - polyblep(this.phase, dt)
      this.phase += dt
      this.phase -= Math.floor(this.phase)
    }
    this.phase = flush(this.phase)
  }

  reset(): void {
    this.phase = 0
  }
}

/** Hard-synced sawtooth for aggressive lead timbres. Inputs 'freq' (the MASTER
 *  pitch — the perceived fundamental, Hz, clamped to ±Nyquist) and 'ratio' (the
 *  slave:master frequency ratio, >= 1; sweeping it is the classic sync sweep).
 *  A slave saw runs at freq*ratio and its phase HARD-RESETS to 0 every time the
 *  master phase wraps. Output the slave saw, ~[-1, 1] (mild polyblep overshoot
 *  near resets).
 *
 *  Anti-aliasing: two discontinuity sources are band-limited. The slave's own
 *  wraps get the usual polyblep(slavePhase). The hard-reset injects a step whose
 *  size = -2*(slave phase at the sub-sample wrap instant); it is corrected by a
 *  polyblep at the MASTER wrap, scaled by that pre-reset amplitude (a naive
 *  reset aliases badly). The reset half-step is latched at the wrap so both
 *  sides of the two-sample polyblep window share one coefficient; the slave's
 *  own polyblep is suppressed on the sample right after a reset (its "wrap"
 *  there is the reset, already corrected). */
export class SyncSawKernel implements Kernel {
  private mp = 0 // master phase
  private sp = 0 // slave phase
  private resetK = 0 // latched reset half-step coefficient
  private afterReset = 0 // 1 on the sample following a hard reset

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    const ratioIn = inputs['ratio']!
    const sr = ctx.sampleRate
    let mp = this.mp
    let sp = this.sp
    let resetK = this.resetK
    let afterReset = this.afterReset
    for (let i = 0; i < n; i++) {
      let dtm = freq[i]! / sr
      if (dtm > 0.5) dtm = 0.5
      else if (dtm < -0.5) dtm = -0.5
      let ratio = ratioIn[i]!
      if (ratio < 1) ratio = 1
      let dts = dtm * ratio
      if (dts > 0.5) dts = 0.5
      else if (dts < -0.5) dts = -0.5

      // slave saw, with polyblep for its OWN wrap (skipped right after a reset,
      // where the near-zero slave phase is the reset, not a natural wrap)
      let y = 2 * sp - 1
      if (afterReset === 0) y -= polyblep(sp, dts)
      afterReset = 0

      // a master wrap this sample hard-resets the slave: latch the reset
      // half-step, sized by the slave amplitude at the SUB-SAMPLE wrap instant
      if (dtm > 0 && mp + dtm >= 1) {
        const tCross = (1 - mp) / dtm // fraction of the sample before the wrap
        let spAtReset = sp + tCross * dts
        spAtReset -= Math.floor(spAtReset)
        resetK = -spAtReset // step is -2*spAtReset, so the polyblep coeff is -spAtReset
      }
      // reset polyblep: nonzero only within dtm of the master wrap; the latched
      // coeff serves both the just-before (this sample) and just-after (next)
      y += resetK * polyblep(mp, dtm)
      out[i] = y

      mp += dtm
      if (mp >= 1) {
        mp -= 1
        sp = (mp / dtm) * dts // resume from the sub-sample reset point
        sp -= Math.floor(sp)
        afterReset = 1
      } else {
        if (mp < 0) mp += 1 // negative master freq: wrap down, no hard reset
        sp += dts
        sp -= Math.floor(sp)
      }
    }
    this.mp = flush(mp)
    this.sp = flush(sp)
    this.resetK = flush(resetK)
    this.afterReset = afterReset
  }

  reset(): void {
    this.mp = 0
    this.sp = 0
    this.resetK = 0
    this.afterReset = 0
  }
}

/** Polyblep square (50% duty). Input 'freq' (Hz, audio-rate, clamped to ±Nyquist); output ~[-1, 1],
 *  low half-cycle first. */
export class SquareKernel implements Kernel {
  private phase = 0

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    for (let i = 0; i < n; i++) {
      let dt = freq[i]! / ctx.sampleRate
      if (dt > 0.5) dt = 0.5
      else if (dt < -0.5) dt = -0.5
      out[i] = blepSquare(this.phase, dt)
      this.phase += dt
      this.phase -= Math.floor(this.phase)
    }
    this.phase = flush(this.phase)
  }

  reset(): void {
    this.phase = 0
  }
}

/** Polyblep pulse. Inputs 'freq' (Hz, clamped to ±Nyquist) and 'width' (duty cycle, clamped per
 *  sample to [0.01, 0.99]), both audio-rate; output ~[-1, 1], high for the
 *  first `width` of each cycle so mean ~ 2*width - 1. */
export class PulseKernel implements Kernel {
  private phase = 0

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    const width = inputs['width']!
    for (let i = 0; i < n; i++) {
      let dt = freq[i]! / ctx.sampleRate
      if (dt > 0.5) dt = 0.5
      else if (dt < -0.5) dt = -0.5
      let w = width[i]!
      if (w < 0.01) w = 0.01
      else if (w > 0.99) w = 0.99
      let v = this.phase < w ? 1 : -1
      v += polyblep(this.phase, dt)
      v -= polyblep((this.phase + 1 - w) % 1, dt)
      out[i] = v
      this.phase += dt
      this.phase -= Math.floor(this.phase)
    }
    this.phase = flush(this.phase)
  }

  reset(): void {
    this.phase = 0
  }
}

/** Triangle via leaky integration of the polyblep square. Input 'freq' (Hz,
 *  audio-rate, clamped to ±Nyquist); output ~[-1, 1] once the integrator settles (a few cycles).
 *
 *  NOTE: the fixed 0.999 per-sample leak is not sample-rate invariant and
 *  collapses the amplitude at sub-audio rates (~±0.17 at 2Hz @ 48kHz). Do NOT
 *  reuse this kernel blindly for LFOs — a dedicated LFO triangle is needed. */
export class TriKernel implements Kernel {
  private phase = 0
  private y = 0

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    for (let i = 0; i < n; i++) {
      let dt = freq[i]! / ctx.sampleRate
      if (dt > 0.5) dt = 0.5
      else if (dt < -0.5) dt = -0.5
      this.y += 4 * dt * blepSquare(this.phase, dt)
      this.y *= 0.999
      out[i] = this.y
      this.phase += dt
      this.phase -= Math.floor(this.phase)
    }
    this.phase = flush(this.phase)
    this.y = flush(this.y)
  }

  reset(): void {
    this.phase = 0
    this.y = 0
  }
}

/** FM / phase-modulation operator: a sine carrier whose phase is offset by an
 *  external modulator plus optional self-feedback. This is the building block
 *  of operator-FM — chain operators (each other's `mod`) to get DX-style
 *  algorithms, and use `feedback` for the self-modulating operator that a pure
 *  DAG can't express (the loop lives inside this kernel's own history).
 *
 *  Inputs: 'freq' (Hz, audio-rate), 'mod' (phase offset in CYCLES — add another
 *  operator's output; its amplitude is the modulation index, default 0),
 *  'feedback' (self-modulation 0..~1, default 0). Output in [-1, 1].
 *
 *  Feedback uses the classic Yamaha 2-sample average of the operator's own
 *  history, which stays stable up to feedback ~= 1 (a single-sample loop would
 *  scream and blow up). Phase is flushed at block end like the other phase
 *  oscillators so a NaN freq can't poison it permanently. */
export class FMKernel implements Kernel {
  private phase = 0
  private y1 = 0
  private y2 = 0

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    const mod = inputs['mod']!
    const fb = inputs['feedback']!
    const sr = ctx.sampleRate
    let phase = this.phase
    let y1 = this.y1
    let y2 = this.y2
    for (let i = 0; i < n; i++) {
      const self = fb[i]! * (y1 + y2) * 0.5
      const y = Math.sin(TWO_PI * (phase + mod[i]! + self))
      out[i] = y
      y2 = y1
      y1 = y
      phase += freq[i]! / sr
      phase -= Math.floor(phase)
    }
    this.phase = flush(phase)
    this.y1 = flush(y1)
    this.y2 = flush(y2)
  }

  reset(): void {
    this.phase = 0
    this.y1 = 0
    this.y2 = 0
  }
}

/** White noise via xorshift32. No inputs; output uniform in [-1, 1), seeded
 *  and deterministic: same seed always yields the same sequence. */
export class NoiseKernel implements Kernel {
  private readonly seed: number
  private state: number

  constructor(seed = 0x9e3779b9) {
    // xorshift32 requires a nonzero state
    this.seed = (seed >>> 0) || 1
    this.state = this.seed
  }

  process(n: number, _inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    let x = this.state
    for (let i = 0; i < n; i++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      x >>>= 0
      out[i] = (x / 4294967296) * 2 - 1
    }
    this.state = x
  }

  reset(): void {
    this.state = this.seed
  }
}
