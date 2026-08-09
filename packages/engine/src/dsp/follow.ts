import type { DspContext, Kernel } from './types'
import { clamp } from './util'
import { smoothCoeff } from './compress'

/* ------------------------------------------------------------------------- *
 * ENVELOPE FOLLOWER: audio in, a control signal out.
 *
 * The engine already contained three of these and exposed none. GateKernel
 * has one to decide when to open, OttKernel has one per band, DeessKernel has
 * one watching the sibilance band — each written privately, each unreachable
 * from a program. This is that capability with a front door.
 *
 * WHY IT MATTERS BEYOND TIDINESS: `sidechain` ducks on note ONSETS, not on
 * level. That is a deliberate and often useful choice (the pump survives
 * turning the kick down, and survives muting it), but it means the engine had
 * no way at all to react to how loud something actually IS. A follower is
 * that missing half — and because it returns an ordinary signal, it composes
 * with everything: multiply by it, subtract it, map it through `->` into a
 * cutoff, feed it to anything that takes a Sig.
 *
 *     cut = follow mic -> 400..5000     a filter that opens when you sing
 *     * (1 - follow voice)              duck this voice under another
 *
 * OUTPUT RANGE: linear amplitude, 0..1 for signals inside ±1. Not dB — dB
 * needs a floor and a reference, and every consumer here wants a multiplier
 * or a `->` range, both of which want linear. Take logs downstream if you
 * want them.
 *
 * ATTACK AND RELEASE ARE ASYMMETRIC, which is the whole craft of a follower:
 * a fast attack catches transients, a slow release stops the control signal
 * chattering between them. Equal times give you a tremolo of the source's own
 * waveform, which is the classic way to make this useless.
 * ------------------------------------------------------------------------- */

/** How long `rms` mode averages power over. Long enough to span a cycle of
 *  the lowest musical material (25 ms ~ 40 Hz), short enough to still feel
 *  immediate. Not exposed: it is what makes the reading a mean rather than a
 *  taste control, and `attack`/`release` are the shaping knobs. */
const RMS_WINDOW_MS = 25

export interface FollowConfig {
  /** How fast it rises, ms. Default 5. Clamped to [0.05, 500]. */
  attack?: number
  /** How fast it falls, ms. Default 100. Clamped to [1, 5000]. */
  release?: number
  /** `peak` tracks the waveform's crest, `rms` its power. Default `peak`.
   *  RMS reads roughly 3 dB lower on a sine and is much steadier on
   *  program material, which is what you want for a filter follower; peak is
   *  what you want for catching hits. */
  mode?: 'peak' | 'rms'
}

/** The instantaneous detector value for one sample — what the smoother chases.
 *  Pure, so the two modes can be pinned without running a kernel. */
export function detect(x: number, mode: 'peak' | 'rms'): number {
  if (!Number.isFinite(x)) return 0
  return mode === 'rms' ? x * x : Math.abs(x)
}

export class FollowKernel implements Kernel {
  private readonly attackMs: number
  private readonly releaseMs: number
  private readonly mode: 'peak' | 'rms'

  private env = 0
  /** Mean square, `rms` mode only. Averaged SYMMETRICALLY — see process(). */
  private ms = 0
  private sr = 0
  private atk = 0
  private rel = 0
  private avg = 0

  constructor(cfg: FollowConfig = {}) {
    this.attackMs = clamp(cfg.attack ?? 5, 0.05, 500)
    this.releaseMs = clamp(cfg.release ?? 100, 1, 5000)
    this.mode = cfg.mode === 'rms' ? 'rms' : 'peak'
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (ctx.sampleRate !== this.sr) {
      this.sr = ctx.sampleRate
      this.atk = smoothCoeff(this.attackMs, this.sr)
      this.rel = smoothCoeff(this.releaseMs, this.sr)
      this.avg = smoothCoeff(RMS_WINDOW_MS, this.sr)
    }
    const rms = this.mode === 'rms'
    let env = this.env
    let ms = this.ms
    for (let i = 0; i < n; i++) {
      /* TWO STAGES in rms mode, and the order matters. Feeding x² straight
       * into the asymmetric smoother does NOT measure rms: a fast attack
       * yanks it up to each peak of x² and a slow release holds it there, so
       * a sine reads its AMPLITUDE (0.59 measured, against a true 0.42).
       *
       * Power has to be averaged symmetrically first — that is what makes it
       * a mean — and only then does attack/release shape the resulting level.
       * The consequence is honest rather than a limitation: you cannot
       * measure power faster than the window it is averaged over. */
      let level: number
      if (rms) {
        ms += (detect(input[i]!, 'rms') - ms) * this.avg
        level = Math.sqrt(ms < 0 ? 0 : ms)
      } else {
        level = detect(input[i]!, 'peak')
      }
      // rising uses attack, falling uses release: the asymmetry IS the node
      env += (level - env) * (level > env ? this.atk : this.rel)
      out[i] = env < 0 ? 0 : env
    }
    this.env = Number.isFinite(env) ? env : 0
    this.ms = Number.isFinite(ms) ? ms : 0
  }

  reset(): void {
    this.env = 0
    this.ms = 0
  }
}
