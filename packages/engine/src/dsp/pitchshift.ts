import type { DspContext, Kernel } from './types'
import { clamp } from './util'

/* ------------------------------------------------------------------------- *
 * PITCH SHIFT: move a signal in semitones without changing how long it lasts.
 *
 * The engine could already change pitch two ways and neither is this one.
 * `sample speed:` is varispeed — pitch and time move together, like a record
 * at the wrong rpm. `granular rate:` decouples them, but it is a texture
 * generator: you set grain size, density and spray, and you get a cloud.
 * Neither can take a signal that already exists — a microphone, a bus, a
 * synth voice — and hand back the same thing a fifth higher.
 *
 * HOW IT WORKS. The read head runs through a delay line at `ratio` samples
 * per output sample while the write head runs at 1, so the delay slides. Read
 * faster and you get through the material sooner, which raises the pitch; the
 * material never runs out because the read position wraps around a window.
 *
 * That wrap is a splice, and a splice is a click. TWO read heads half a window
 * apart is what hides it: each is faded out exactly where it jumps, while the
 * other is mid-traversal and continuous. The fade is FLAT-TOP rather than a
 * continuous sin/cos — see process() for why that distinction is the
 * difference between working and pulsing 10:1.
 *
 * WHAT IT COSTS, stated plainly because every time-domain shifter pays it:
 * the window is audible. Short windows warble (the pitch of the wrap becomes
 * a tone), long windows smear transients and add an echo of up to `window`
 * ms. 50 ms is a reasonable middle for voice. A phase vocoder would trade
 * this artefact for a different one (smearing) and cost an FFT per block; it
 * is not obviously better, and it is not what this is.
 *
 * ZERO IS BIT-EXACT. At 0 semitones the read heads would sit at two fixed and
 * DIFFERENT delays, and summing those is a comb filter — a node that colours
 * the signal when asked to do nothing. It returns the input untouched instead.
 * ------------------------------------------------------------------------- */

/** Longest window, ms. Bounds the delay line. */
const MAX_WINDOW_MS = 200

/** How much of each cycle is spent crossfading between the two read heads,
 *  either side of the wrap. The rest runs on ONE head, which is what stops
 *  the two coherent taps interfering — see process().
 *
 *  Chosen by measurement, not taste. Worst-case level ripple over a grid of
 *  6 tones x 5 window lengths x 3 shifts:
 *
 *      XFADE   0.40   0.25   0.15   0.10   0.05   0.02
 *      ripple  10.9    7.6    4.4    2.9    2.1    1.6
 *
 *  Monotonic, and the cost that would normally bound it does not appear:
 *  inharmonic energy from the splice measured 0.000 relative to the signal at
 *  every setting. 0.05 rather than 0.02 keeps a little fade in hand for
 *  transient material without giving the ripple back. */
const XFADE = 0.05

export interface PitchShiftConfig {
  /** Shift in semitones. Default 0 (bit-exact passthrough). Clamped to
   *  [-24, 24] — two octaves either way is past where this method sounds
   *  like anything but an effect. */
  semitones?: number
  /** Crossfade window, ms. Default 50. Clamped to [5, 200]. Short warbles,
   *  long smears: this is the artefact control, and it cannot be set to
   *  "none". */
  window?: number
  /** Dry/wet, 0..1. Default 1 (fully shifted). Use 0.5 for a harmoniser that
   *  keeps the original underneath it. */
  mix?: number
}

/** Playback ratio for a shift in semitones. 12 → 2, 0 → 1, -12 → 0.5. */
export function ratioFor(semitones: number): number {
  return Math.pow(2, semitones / 12)
}

export class PitchShiftKernel implements Kernel {
  private readonly ratio: number
  private readonly windowMs: number
  private readonly mix: number
  /** True when the node must not touch the signal at all. */
  private readonly bypass: boolean

  private buf = new Float32Array(1)
  private writeIdx = 0
  private size = 1
  /** Window length in samples, and the read phase within it, 0..1. */
  private win = 1
  private phase = 0
  private sr = 0

  constructor(cfg: PitchShiftConfig = {}) {
    const semis = clamp(cfg.semitones ?? 0, -24, 24)
    this.ratio = ratioFor(semis)
    this.windowMs = clamp(cfg.window ?? 50, 5, MAX_WINDOW_MS)
    this.mix = clamp(cfg.mix ?? 1, 0, 1)
    this.bypass = semis === 0
  }

  private resize(sr: number): void {
    this.sr = sr
    this.win = Math.max(2, Math.round((this.windowMs / 1000) * sr))
    // the line must hold a full window of history plus room for the tap that
    // sits half a window behind it
    this.size = this.win * 2 + 4
    this.buf = new Float32Array(this.size)
    this.writeIdx = 0
    this.phase = 0
  }

  /** Linearly interpolated read `delay` samples behind the write head. */
  private tap(delay: number): number {
    const pos = this.writeIdx - delay
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const a = this.buf[((i0 % this.size) + this.size) % this.size]!
    const b = this.buf[((i0 + 1) % this.size + this.size) % this.size]!
    return a + (b - a) * frac
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (this.bypass) {
      out.set(input.subarray(0, n))
      return
    }
    if (ctx.sampleRate !== this.sr) this.resize(ctx.sampleRate)
    const W = this.win
    // delay slides at (1 - ratio) samples per sample; as a fraction of the
    // window that is the phase increment
    const step = (1 - this.ratio) / W
    const wet = this.mix
    const dryAmt = 1 - wet

    for (let i = 0; i < n; i++) {
      const x = Number.isFinite(input[i]!) ? input[i]! : 0
      this.buf[this.writeIdx] = x

      let p = this.phase
      // wrap into [0,1): the read head circling the window is the whole trick
      p -= Math.floor(p)
      const q = p < 0.5 ? p + 0.5 : p - 0.5

      /* FLAT-TOP crossfade, and the flat part is the point.
       *
       * A continuous sin/cos fade keeps BOTH taps audible at all times, and
       * the two taps are the same signal at two delays — coherent, not
       * independent. So they interfere, and for a steady tone whose half-
       * window delay lands near half a cycle they cancel and STAY cancelled.
       * Measured: a 300 Hz tone through a 50 ms window pulsed 10.8:1.
       *
       * Here one tap runs ALONE for 90% of the cycle and the other is silent,
       * so there is nothing to interfere with. They only overlap in a short
       * equal-power fade placed where the outgoing tap is about to wrap. Same
       * grid after the change: worst case 2.1:1, and the 300 Hz / 50 ms case
       * above goes from 10.8 to 1.4. */
      const d = Math.abs(p - 0.5) // 0 where tap1 is safest, 0.5 at its wrap
      let g1: number
      let g2: number
      if (d <= 0.5 - XFADE) {
        g1 = 1
        g2 = 0
      } else {
        const th = ((d - (0.5 - XFADE)) / XFADE) * (Math.PI / 2)
        g1 = Math.cos(th)
        g2 = Math.sin(th)
      }
      const shifted = this.tap(p * W) * g1 + this.tap(q * W) * g2

      out[i] = dryAmt * x + wet * shifted
      this.phase = p + step
      this.writeIdx = (this.writeIdx + 1) % this.size
    }
    if (!Number.isFinite(this.phase)) this.phase = 0
  }

  reset(): void {
    if (this.sr > 0) this.resize(this.sr)
  }
}
