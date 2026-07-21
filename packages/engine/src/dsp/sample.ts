import type { DspContext, Kernel, SampleBankRO } from './types'

/** Sample playback voice. Inputs: 'gate' (a rising edge >0.5 retriggers from
 *  the start) and optional 'speed' (playback-rate multiplier; 1 = the sample's
 *  natural pitch, 2 = an octave up). Config: the sample `name` and whether to
 *  `loop`. Output is mono; shape the amplitude with an ADSR like any oscillator.
 *
 *  Pitch/quality:
 *  - Advances the read head by `speed * (sampleRate / engineRate)` per output
 *    sample, so a 44.1k sample plays at natural pitch through a 48k engine.
 *  - Linear interpolation between adjacent frames (v1 — cheap, slight HF loss
 *    when pitched up; good enough for drums, chops, risers).
 *
 *  Lifecycle:
 *  - Resolves `name` against the shared bank EACH BLOCK, so a sample loaded
 *    after this synth was compiled starts sounding with no recompile. Missing
 *    name -> silence.
 *  - One-shot (loop=false): plays start->end once per gate edge, then silence
 *    until the next edge (drums don't need a held gate).
 *  - loop=true: wraps at the end and keeps going while gated-or-triggered. */
export class SampleKernel implements Kernel {
  /** Fractional read position in source frames. */
  private pos = 0
  private playing = false
  private prevGate = 0

  constructor(
    private readonly name: string,
    private readonly loop: boolean,
    private readonly bank: SampleBankRO | undefined,
  ) {}

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const gate = inputs['gate']!
    const speed = inputs['speed'] // may be absent -> natural rate (1)
    const s = this.bank?.get(this.name)
    if (s === undefined || s.data.length === 0) {
      // Not loaded (yet) — silence, but still track gate edges so a sample that
      // arrives between blocks starts on the NEXT edge, not retroactively.
      for (let i = 0; i < n; i++) {
        this.prevGate = gate[i]!
      }
      out.fill(0, 0, n)
      return
    }
    const data = s.data
    const len = data.length
    const rate = s.sampleRate / ctx.sampleRate

    for (let i = 0; i < n; i++) {
      const g = gate[i]!
      if (g > 0.5 && this.prevGate <= 0.5) {
        this.pos = 0
        this.playing = true
      }
      this.prevGate = g

      if (!this.playing) {
        out[i] = 0
        continue
      }

      let p = this.pos
      if (p >= len) {
        if (this.loop) {
          p -= Math.floor(p / len) * len
          this.pos = p
        } else {
          this.playing = false
          out[i] = 0
          continue
        }
      }

      const i0 = p | 0
      const frac = p - i0
      const a = data[i0]!
      // Next frame: wrap for loop, else read the tail (0 past the very end).
      const bNext = i0 + 1 < len ? data[i0 + 1]! : this.loop ? data[0]! : 0
      out[i] = a + frac * (bNext - a)

      const sp = speed !== undefined ? speed[i]! : 1
      this.pos = p + sp * rate
    }
  }

  reset(): void {
    this.pos = 0
    this.playing = false
    this.prevGate = 0
  }
}
