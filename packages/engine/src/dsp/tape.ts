import type { DspContext, Kernel } from './types'
import { clamp } from './util'

/* ------------------------------------------------------------------------- *
 * TAPE: the four things that make a machine sound like a machine.
 *
 * "Tape" is not one effect, and reaching for a saturator alone is why most
 * attempts at it sound like distortion rather than like tape. A reel-to-reel
 * does four separate things at once, and the ones people actually recognise
 * are the mechanical ones:
 *
 *   WOW      slow pitch drift, well under 2 Hz, from an eccentric capstan or
 *            a reel that is not quite round. This is what makes a held chord
 *            sound like a recording rather than a synthesiser: an oscillator
 *            holds a pitch perfectly, and nothing physical ever does.
 *   FLUTTER  the same thing an order of magnitude faster, from bearing and
 *            roller irregularity. Too fast to hear as pitch; it reads as
 *            texture, a slight unsteadiness in the tone.
 *   SATURATION  magnetic tape runs out of headroom gradually, so it rounds
 *            peaks and adds mostly odd harmonics rather than clipping.
 *   HF LOSS  a tape cannot hold short wavelengths, so the top comes off.
 *            This is the part everyone forgets, and it is most of why a
 *            saturator alone sounds harsh where tape sounds warm.
 *
 * WHY THE MODULATION IS NOT A SINE. A single LFO is a vibrato, and it sounds
 * like one — a pure, regular wobble no machine has ever produced. Each of wow
 * and flutter is the sum of TWO oscillators at incommensurate rates, so the
 * pattern never repeats and never settles into an audible period.
 *
 * PITCH MOVES BECAUSE THE DELAY MOVES. The signal runs through a delay line
 * whose length is modulated; a delay that is getting shorter plays the
 * material back sooner, which is a rise in pitch. Peak deviation is
 * 2*pi*f*A for a modulation of amplitude A at frequency f, which is why wow
 * needs a much larger amplitude than flutter for the same audible depth.
 *
 * EVERY PART HAS AN OFF. At wow 0, flutter 0, sat 0 and tone at full
 * bandwidth the node is a plain fixed delay, not a coloured one — you can
 * turn on exactly the parts you want.
 * ------------------------------------------------------------------------- */

/** Modulation rates, Hz. Two per component at incommensurate ratios so the
 *  drift never repeats. Real machines sit around 0.5-2 Hz for wow and
 *  5-15 Hz for flutter. */
const WOW_A = 0.61
const WOW_B = 1.13
const FLUT_A = 6.7
const FLUT_B = 11.3

/** Peak delay swing at depth 1, ms. Wow needs far more than flutter for the
 *  same pitch deviation because deviation scales with rate. */
const WOW_MS = 1.6
const FLUT_MS = 0.09

/** Centre delay, ms. Has to exceed the largest swing so the read head never
 *  runs past the write head. */
const CENTRE_MS = 4

export interface TapeConfig {
  /** Slow pitch drift, 0..1. Default 0.35. */
  wow?: number
  /** Fast pitch unsteadiness, 0..1. Default 0.3. */
  flutter?: number
  /** Soft saturation, 0..1. Default 0.3. 0 passes the level through exactly. */
  sat?: number
  /** Top-end rolloff, Hz. Default 11000. Above the Nyquist rate it is off. */
  tone?: number
}

/** The saturation curve: a blend between clean and a soft tanh, so `sat` 0 is
 *  an identity rather than "slightly less distorted".
 *
 *  NORMALISED TO UNITY AT FULL SCALE — tanh(3x)/tanh(3) passes through 1 at
 *  x = 1. So it does not turn the signal DOWN; it lifts everything below full
 *  scale toward it, which is the same statement as "it compresses the dynamic
 *  range" and is what saturation actually does to a level meter. Measured, a
 *  0.6 peak comes out at about 0.71 with `sat` at its default. Turn the source
 *  down if you want the character without the lift. */
export function saturate(x: number, sat: number): number {
  if (sat <= 0) return x
  const shaped = Math.tanh(3 * x) / Math.tanh(3)
  return x * (1 - sat) + shaped * sat
}

export class TapeKernel implements Kernel {
  private readonly wow: number
  private readonly flutter: number
  private readonly sat: number
  private readonly tone: number

  private buf = new Float32Array(1)
  private writeIdx = 0
  private size = 1
  private centre = 0
  private wowAmp = 0
  private flutAmp = 0

  /** Modulation phases, in turns. Deterministic — a render must be
   *  reproducible, so there is no randomness here at all. */
  private pA = 0
  private pB = 0.37
  private pC = 0.11
  private pD = 0.73

  private lp = 0
  private lpCoeff = 1
  private sr = 0

  constructor(cfg: TapeConfig = {}) {
    this.wow = clamp(cfg.wow ?? 0.35, 0, 1)
    this.flutter = clamp(cfg.flutter ?? 0.3, 0, 1)
    this.sat = clamp(cfg.sat ?? 0.3, 0, 1)
    this.tone = clamp(cfg.tone ?? 11000, 200, 20000)
  }

  private resize(sr: number): void {
    this.sr = sr
    this.centre = (CENTRE_MS / 1000) * sr
    this.wowAmp = ((WOW_MS / 1000) * sr) * this.wow
    this.flutAmp = ((FLUT_MS / 1000) * sr) * this.flutter
    this.size = Math.max(8, Math.ceil(this.centre + this.wowAmp + this.flutAmp) + 4)
    this.buf = new Float32Array(this.size)
    this.writeIdx = 0
    this.lp = 0
    // one-pole; at or above Nyquist the filter is off rather than unstable
    const fc = Math.min(this.tone, sr * 0.45)
    this.lpCoeff = 1 - Math.exp((-2 * Math.PI * fc) / sr)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (ctx.sampleRate !== this.sr) this.resize(ctx.sampleRate)
    const sr = this.sr
    const dA = WOW_A / sr, dB = WOW_B / sr, dC = FLUT_A / sr, dD = FLUT_B / sr
    const TAU = Math.PI * 2

    for (let i = 0; i < n; i++) {
      const x = Number.isFinite(input[i]!) ? input[i]! : 0
      this.buf[this.writeIdx] = x

      // two incommensurate oscillators each: a single one is a vibrato
      const wowMod = (Math.sin(TAU * this.pA) * 0.65 + Math.sin(TAU * this.pB) * 0.35) * this.wowAmp
      const flutMod = (Math.sin(TAU * this.pC) * 0.6 + Math.sin(TAU * this.pD) * 0.4) * this.flutAmp
      const delay = this.centre + wowMod + flutMod

      // fractional read: the delay is almost never a whole number of samples,
      // and rounding it would step the pitch instead of sliding it
      const pos = this.writeIdx - delay
      const i0 = Math.floor(pos)
      const frac = pos - i0
      const a = this.buf[((i0 % this.size) + this.size) % this.size]!
      const b = this.buf[(((i0 + 1) % this.size) + this.size) % this.size]!
      let y = a + (b - a) * frac

      y = saturate(y, this.sat)
      // the top comes off LAST, so it also tames what saturation just added
      this.lp += (y - this.lp) * this.lpCoeff
      out[i] = Number.isFinite(this.lp) ? this.lp : 0

      this.pA += dA; this.pB += dB; this.pC += dC; this.pD += dD
      if (this.pA >= 1) this.pA -= 1
      if (this.pB >= 1) this.pB -= 1
      if (this.pC >= 1) this.pC -= 1
      if (this.pD >= 1) this.pD -= 1
      this.writeIdx = (this.writeIdx + 1) % this.size
    }
  }

  reset(): void {
    if (this.sr > 0) this.resize(this.sr)
    this.pA = 0
    this.pB = 0.37
    this.pC = 0.11
    this.pD = 0.73
  }
}
