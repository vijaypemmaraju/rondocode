import type { DspContext, Kernel } from './types'
import { clamp } from './util'
import { smoothCoeff } from './compress'

/* ------------------------------------------------------------------------- *
 * DE-ESSER — a compressor that only hears the sibilance.
 *
 * "s", "sh" and "t" carry far more energy than the vowels around them, and a
 * close mic plus a high shelf plus a compressor turns them into blades. A
 * broadband compressor cannot fix it: duck enough to tame the "s" and the
 * whole word ducks with it, which is the pumping everyone recognises as a
 * badly de-essed vocal.
 *
 * SPLIT-BAND, NOT A FILTERED SIDECHAIN ONLY. The signal is split into a low
 * part and a high part; the compressor is applied to the HIGH part alone and
 * the two are summed back. So the vowels pass through completely untouched —
 * they are not merely un-ducked, they never entered the detector's path.
 *
 * THE DETECTOR LISTENS TO THE HIGH BAND, which is the whole point: a detector
 * fed the full signal would trigger on a loud vowel and duck the sibilance
 * that was not there.
 *
 * THE SPLIT IS TWO CASCADED ONE-POLES (12 dB/oct). A single pole was the
 * first attempt and it is too gentle to do the job: at 9 kHz against a 6 kHz
 * corner most of the tone is still in the LOW band, so a -6 dBFS sibilant
 * only came down about 4 dB however hard the ratio was set. Cascading has no
 * resonance — the ringing a de-esser must avoid comes from Q, not from slope
 * — so this is steeper AND still cannot ring.
 *
 * `high` is defined as `input - low`, so the two bands sum back to the input
 * EXACTLY whatever the coefficient or the order. That is what makes the vowels
 * untouched rather than merely un-ducked.
 *
 * THE DETECTOR USES ITS OWN HIGH-PASS, not that subtracted band. `x - low`
 * leaks the low band far more than its magnitude suggests, because the poles
 * shift PHASE: at 300 Hz against a 6 kHz corner the magnitudes differ by a
 * fraction of a percent but the vectors differ by ~10%, so a loud vowel showed
 * up in the subtracted band at about -20 dB — over the threshold, and it
 * ducked by 2.5 dB on vowels alone. A cascaded one-pole high-pass puts the
 * same vowel 50 dB down, so the detector only ever hears sibilance.
 * ------------------------------------------------------------------------- */

export interface DeessConfig {
  /** Split frequency, Hz — where sibilance is judged to start. Default 6000.
   *  4000-6000 for a low voice, 6000-9000 for a bright or high one. Clamped
   *  to [1000, 16000]. */
  freq?: number
  /** Level the HIGH band must exceed before it is ducked, dB. Default -30.
   *  Clamped to [-80, 0]. */
  threshold?: number
  /** How hard the high band is ducked above threshold. 1 = none, 4 = 4:1.
   *  Default 4. Clamped to [1, 20]. */
  ratio?: number
  /** How fast it clamps down, ms. Default 1 — sibilance is a transient, and a
   *  slow attack lets the blade through before catching the tail. Clamped to
   *  [0.05, 50]. */
  attack?: number
  /** How fast it recovers, ms. Default 60. Long enough not to chatter inside
   *  one "s", short enough to be gone by the next vowel. Clamped to [5, 500]. */
  release?: number
}

const DB_FLOOR = -120

/** One-pole low-pass coefficient for a corner at `freq`. The high band is
 *  what is left over (input - low), which is why the two always sum back to
 *  the input exactly, whatever the coefficient. */
const lowCoeff = (freq: number, sr: number): number =>
  1 - Math.exp((-2 * Math.PI * freq) / sr)

/**
 * Gain (linear, 0..1) to apply to the high band whose level is `db`.
 *
 * Pure, and separate from the kernel, because this is the part with a
 * musically meaningful contract: nothing below the threshold, and a `ratio`
 * slope above it. Hard knee — sibilance is a transient and a soft knee just
 * blurs when the de-esser engages.
 */
export function deessGain(db: number, threshold: number, ratio: number): number {
  const over = db - threshold
  if (over <= 0) return 1
  const reduced = over - over / Math.max(1, ratio)
  return Math.pow(10, -reduced / 20)
}

/** De-esser kernel (mono). Input 'in'. */
export class DeessKernel implements Kernel {
  private readonly freq: number
  private readonly threshold: number
  private readonly ratio: number
  private readonly attackMs: number
  private readonly releaseMs: number

  /** two-pole state for the band split (cascaded, no resonance) */
  private low1 = 0
  private low2 = 0
  /** separate two-pole state for the DETECTOR's high-pass — see the note
   *  above on why the subtracted band is not good enough to detect on. */
  private dLow1 = 0
  private dLow2 = 0
  /** smoothed gain applied to the high band */
  private g = 1
  /** detector envelope, linear, on the HIGH band */
  private env = 0

  private sr = 0
  private lp = 0
  private atk = 0
  private rel = 0
  private det = 0

  constructor(cfg: DeessConfig = {}) {
    this.freq = clamp(cfg.freq ?? 6000, 1000, 16000)
    this.threshold = clamp(cfg.threshold ?? -30, -80, 0)
    this.ratio = clamp(cfg.ratio ?? 4, 1, 20)
    this.attackMs = clamp(cfg.attack ?? 1, 0.05, 50)
    this.releaseMs = clamp(cfg.release ?? 60, 5, 500)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (ctx.sampleRate !== this.sr) {
      this.sr = ctx.sampleRate
      this.lp = lowCoeff(this.freq, this.sr)
      this.atk = smoothCoeff(this.attackMs, this.sr)
      this.rel = smoothCoeff(this.releaseMs, this.sr)
      // quick detector: sibilance is short, and a sluggish follower would
      // report it after it had already passed
      this.det = smoothCoeff(0.5, this.sr)
    }
    let low1 = this.low1
    let low2 = this.low2
    let dLow1 = this.dLow1
    let dLow2 = this.dLow2
    let g = this.g
    let env = this.env
    for (let i = 0; i < n; i++) {
      const x = input[i]!
      low1 += (x - low1) * this.lp
      low2 += (low1 - low2) * this.lp
      const low = low2
      const high = x - low
      /* DETECTOR: a cascaded one-pole HIGH-PASS, not the subtracted band.
       * Each stage is (signal - its own lowpass), so a vowel lands ~50 dB down
       * instead of the ~20 dB the subtracted band leaks. A full-band detector
       * would be worse still: it would duck on a loud vowel outright. */
      dLow1 += (x - dLow1) * this.lp
      const d1 = x - dLow1
      dLow2 += (d1 - dLow2) * this.lp
      const det = d1 - dLow2
      const lin = Math.abs(det)
      env = lin > env ? lin : env + (lin - env) * this.det
      const db = env > 0 ? 20 * Math.log10(env) : DB_FLOOR
      const target = deessGain(db, this.threshold, this.ratio)
      const coeff = target < g ? this.atk : this.rel
      g += (target - g) * coeff
      // the low band is passed through UNTOUCHED, which is what keeps the
      // vowels out of it entirely
      out[i] = low + high * g
    }
    this.low1 = Number.isFinite(low1) ? low1 : 0
    this.low2 = Number.isFinite(low2) ? low2 : 0
    this.dLow1 = Number.isFinite(dLow1) ? dLow1 : 0
    this.dLow2 = Number.isFinite(dLow2) ? dLow2 : 0
    this.g = Number.isFinite(g) ? g : 1
    this.env = Number.isFinite(env) ? env : 0
  }

  reset(): void {
    this.low1 = 0
    this.low2 = 0
    this.dLow1 = 0
    this.dLow2 = 0
    this.g = 1
    this.env = 0
  }
}
