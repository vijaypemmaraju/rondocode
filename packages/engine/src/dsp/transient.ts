import type { DspContext, Kernel } from './types'
import { clamp, flush } from './util'

export interface TransientConfig {
  /** Onset shaping, -1..1. Positive sharpens the attack (a harder click on a
   *  drum, more pick on a bass); negative softens it. 0 (default) = untouched. */
  attack?: number
  /** Tail shaping, -1..1. Positive lifts the body/decay (more room, longer
   *  ring); negative cuts it (drier, tighter, less room mic). 0 (default) =
   *  untouched. */
  sustain?: number
}

/** Envelope time constants, in ms.
 *
 *  FAST is an asymmetric peak follower on |x| (quick up, slower down) followed
 *  by a short symmetric DERIPPLE smoother. The deripple stage is not cosmetic:
 *  a rectified waveform dips to zero twice per cycle, so a raw peak follower
 *  ripples by tens of percent on low material and the ratio below would
 *  modulate the gain at twice the fundamental. With it, a steady 220 Hz tone
 *  holds the ratio inside 1.000..1.024 and a 55 Hz tone inside 0.985..1.034.
 *
 *  SLOW is a symmetric smoother OF the fast envelope, not an independent
 *  follower on |x|. That is what makes the ratio sit at exactly 1 in steady
 *  state: two independent followers with different attack times settle at
 *  different fractions of the peak, so their ratio is biased away from 1
 *  forever and one of the two shaping branches can never fire. */
const FAST_ATTACK_MS = 1
const FAST_RELEASE_MS = 40
const DERIPPLE_MS = 4
const SLOW_MS = 130

/** One-pole smoothing coefficient for a time constant `ms` at `sr`. */
const coeff = (ms: number, sr: number): number => 1 - Math.exp(-1 / ((ms / 1000) * sr))

/** Additive floor on both envelopes so their ratio is 1 (unity gain) in
 *  silence instead of 0/0. At -100 dBFS it perturbs the ratio by ~1e-5; above
 *  that it is inaudible, and level independence holds to better than 1e-5
 *  relative for any signal above about -80 dBFS. */
const EPS = 1e-10

/** The detector ratio is clamped to [1/8, 8] before the exponent (a hard onset
 *  out of silence would otherwise read in the thousands and make every setting
 *  slam the same ceiling), and the resulting gain to ±12 dB. */
const MAX_RATIO = 8
const MIN_RATIO = 1 / 8
const MAX_GAIN = 4
const MIN_GAIN = 1 / 4

/** Transient shaper (mono). Input 'in'; attack/sustain are construction
 *  config. A FAST envelope (1 ms attack / 40 ms release peak follower, then a
 *  4 ms deripple smoother) and a SLOW one (a 130 ms smoothing of the fast
 *  envelope) run on |x|, and their RATIO r = fast/slow is the transient
 *  detector:
 *
 *    r > 1  the signal is rising faster than the reference: an ONSET
 *    r ≈ 1  steady state
 *    r < 1  the signal is falling away from the reference: the TAIL
 *
 *  The gain is `r^attack` on the onset side and `r^(-sustain)` on the tail
 *  side, clamped to ±12 dB. Both branches meet at exactly 1 when r = 1, so the
 *  gain is continuous; `attack = sustain = 0` is a bit-exact passthrough.
 *
 *  THIS IS NOT A COMPRESSOR, and the difference is structural, not a matter of
 *  taste: the gain depends only on the RATIO of two envelopes, never on the
 *  absolute level. Scale the input by any k and both envelopes scale by k, the
 *  ratio is unchanged, and the SAME gain curve is applied — a quiet hit and a
 *  loud hit are shaped identically. A compressor's threshold makes exactly the
 *  opposite promise. The corollary is that it does not control level: it will
 *  happily make a loud hit louder, so leave headroom (or follow it with
 *  compress()).
 *
 *  Limits worth knowing: the follower times are fixed, so the onset window is
 *  fixed too — this reads drum-shaped material (a fast rise over a slower
 *  body) and does very little to a sustained pad, where r sits at 1. On dense
 *  polyphonic material the detector hears the SUM, so it shapes the mix's
 *  transients, not each note's. And a bass-heavy source still ripples the
 *  detector a few percent (see DERIPPLE_MS), so extreme settings can add a
 *  faint amplitude wobble at twice the fundamental.
 *
 *  Hygiene: all three envelope states are flushed at block end (flush()), so a
 *  NaN arriving on the input poisons at most one block, and a silent tail
 *  settles to exact 0. */
export class TransientKernel implements Kernel {
  private readonly attack: number
  private readonly sustain: number
  private envFast = 0
  private envSmooth = 0
  private envSlow = 0
  private sr = 0
  private fastAtk = 0
  private fastRel = 0
  private deripple = 0
  private slowK = 0

  constructor(cfg: TransientConfig = {}) {
    this.attack = clamp(cfg.attack ?? 0, -1, 1)
    this.sustain = clamp(cfg.sustain ?? 0, -1, 1)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    // Neutral settings are the identity — skip the followers entirely (the
    // general path would compute r^0 === 1 and multiply by it, same result).
    if (this.attack === 0 && this.sustain === 0) {
      for (let i = 0; i < n; i++) out[i] = input[i]!
      return
    }
    if (ctx.sampleRate !== this.sr) {
      this.sr = ctx.sampleRate
      this.fastAtk = coeff(FAST_ATTACK_MS, this.sr)
      this.fastRel = coeff(FAST_RELEASE_MS, this.sr)
      this.deripple = coeff(DERIPPLE_MS, this.sr)
      this.slowK = coeff(SLOW_MS, this.sr)
    }
    const atkExp = this.attack
    const susExp = -this.sustain
    let ef = this.envFast
    let em = this.envSmooth
    let es = this.envSlow

    for (let i = 0; i < n; i++) {
      const x = input[i]!
      const ax = x < 0 ? -x : x
      ef += (ax - ef) * (ax > ef ? this.fastAtk : this.fastRel)
      em += (ef - em) * this.deripple
      es += (em - es) * this.slowK
      const r = clamp((em + EPS) / (es + EPS), MIN_RATIO, MAX_RATIO)
      // r > 1 is the onset half of the detector, r < 1 the tail half; both
      // exponents give exactly 1 at r === 1, so the gain never steps.
      const g = clamp(Math.pow(r, r > 1 ? atkExp : susExp), MIN_GAIN, MAX_GAIN)
      out[i] = x * g
    }

    this.envFast = flush(ef)
    this.envSmooth = flush(em)
    this.envSlow = flush(es)
  }

  reset(): void {
    this.envFast = 0
    this.envSmooth = 0
    this.envSlow = 0
  }
}
