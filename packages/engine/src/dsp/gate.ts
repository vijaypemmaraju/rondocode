import type { DspContext, Kernel } from './types'
import { clamp } from './util'
import { smoothCoeff } from './compress'

/* ------------------------------------------------------------------------- *
 * NOISE GATE / DOWNWARD EXPANDER — the node a live microphone cannot do
 * without.
 *
 * A compressor turns loud things down. A gate turns QUIET things down, which
 * is the opposite problem and the one a stage has: the drum kit bleeding into
 * the vocal mic between lines, the amp hiss under a guitar, the room tone
 * that turns into feedback the moment you add gain.
 *
 * TWO DETAILS SEPARATE A USABLE GATE FROM A CHATTERING ONE, and both are here
 * because a gate without them is worse than no gate:
 *
 *   HYSTERESIS — it opens at `threshold` but does not close until the signal
 *     falls `hysteresis` dB BELOW it. A single threshold makes a signal
 *     hovering at the line stutter open/shut at audio rate, which is far more
 *     audible than the noise you were removing.
 *   HOLD — once open it stays open for at least `hold` ms. Speech and singing
 *     are full of momentary dips (the gap inside a "t", the trough between
 *     syllables); without hold the gate slams on every one and chops the word
 *     apart.
 *
 * RANGE, NOT ON/OFF. Closed means attenuated by `range` dB, not silent. Full
 * mute is the sound of a gate you can hear working; -20 to -40 dB removes the
 * bleed while leaving the room's floor continuous, which is what makes it
 * disappear.
 * ------------------------------------------------------------------------- */

export interface GateConfig {
  /** Level the signal must EXCEED to open the gate, dB. Default -40. */
  threshold?: number
  /** How far down the signal is pushed when closed, dB below unity. Default
   *  -60. Use -20..-40 on a live vocal: a fully muted gate is audible as a
   *  hole, a partial one just removes the bleed. Clamped to [-120, 0]. */
  range?: number
  /** How fast it opens once the signal crosses, ms. Default 1 — a slow attack
   *  eats the front of a consonant. Clamped to [0.05, 100]. */
  attack?: number
  /** Minimum time it stays open after the level falls back, ms. Default 50.
   *  Clamped to [0, 2000]. */
  hold?: number
  /** How fast it closes once hold expires, ms. Default 100. Clamped to
   *  [1, 5000]. */
  release?: number
  /** How far BELOW threshold the level must fall to start closing, dB.
   *  Default 3. 0 means a single threshold, which chatters. Clamped to
   *  [0, 60]. */
  hysteresis?: number
}

const DB_FLOOR = -120

/**
 * Should the gate be open, given the level now and whether it is open already?
 *
 * The whole of hysteresis, as one pure decision: crossing UP happens at
 * `threshold`, crossing DOWN at `threshold - hysteresis`. Between the two the
 * answer is "whatever it already was", which is precisely what stops a signal
 * sitting on the line from stuttering.
 */
export function gateOpens(
  levelDb: number,
  threshold: number,
  hysteresis: number,
  isOpen: boolean,
): boolean {
  if (levelDb >= threshold) return true
  if (levelDb < threshold - Math.max(0, hysteresis)) return false
  return isOpen
}

/** Gate kernel (mono). Input 'in'. Config is construction-time — dial it in
 *  rather than automating it per sample, same contract as CompressKernel. */
export class GateKernel implements Kernel {
  private readonly threshold: number
  private readonly rangeLin: number
  private readonly attackMs: number
  private readonly holdMs: number
  private readonly releaseMs: number
  private readonly hysteresis: number

  /** Current applied gain, 0..1, smoothed. Starts CLOSED so a gate does not
   *  pass one block of bleed before it engages. */
  private gain = 0
  /** Envelope follower state, linear. */
  private env = 0
  private open = false
  /** Samples remaining on the hold timer. */
  private holdLeft = 0

  private sr = 0
  private atk = 0
  private rel = 0
  private envCoeff = 0
  private holdSamples = 0

  constructor(cfg: GateConfig = {}) {
    this.threshold = cfg.threshold ?? -40
    this.rangeLin = Math.pow(10, clamp(cfg.range ?? -60, -120, 0) / 20)
    this.attackMs = clamp(cfg.attack ?? 1, 0.05, 100)
    this.holdMs = clamp(cfg.hold ?? 50, 0, 2000)
    this.releaseMs = clamp(cfg.release ?? 100, 1, 5000)
    this.hysteresis = clamp(cfg.hysteresis ?? 3, 0, 60)
    this.gain = this.rangeLin
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (ctx.sampleRate !== this.sr) {
      this.sr = ctx.sampleRate
      this.atk = smoothCoeff(this.attackMs, this.sr)
      this.rel = smoothCoeff(this.releaseMs, this.sr)
      // the DETECTOR is deliberately quick (1 ms): it decides when to open, and
      // a sluggish one would miss the transient it is supposed to let through
      this.envCoeff = smoothCoeff(1, this.sr)
      this.holdSamples = Math.round((this.holdMs / 1000) * this.sr)
    }
    const floor = this.rangeLin
    let g = this.gain
    let env = this.env
    let open = this.open
    let hold = this.holdLeft
    for (let i = 0; i < n; i++) {
      const x = input[i]!
      // peak-ish follower: instant attack, smoothed decay, so a transient
      // opens the gate on the sample it arrives rather than a millisecond later
      const lin = Math.abs(x)
      env = lin > env ? lin : env + (lin - env) * this.envCoeff
      const db = env > 0 ? 20 * Math.log10(env) : DB_FLOOR
      const wantOpen = gateOpens(db, this.threshold, this.hysteresis, open)
      if (wantOpen) {
        open = true
        hold = this.holdSamples
      } else if (hold > 0) {
        // still inside the hold window: stay open, count down
        hold--
        open = true
      } else {
        open = false
      }
      const target = open ? 1 : floor
      const coeff = target > g ? this.atk : this.rel
      g += (target - g) * coeff
      out[i] = x * g
    }
    this.gain = Number.isFinite(g) ? g : floor
    this.env = Number.isFinite(env) ? env : 0
    this.open = open
    this.holdLeft = hold
  }

  reset(): void {
    this.gain = this.rangeLin
    this.env = 0
    this.open = false
    this.holdLeft = 0
  }
}
