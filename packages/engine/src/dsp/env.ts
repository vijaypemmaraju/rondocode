import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface AdsrConfig {
  /** Attack time in seconds (linear ramp to 1). Default 0.01. */
  a?: number
  /** Decay time constant in seconds (one-pole toward sustain). Default 0.1. */
  d?: number
  /** Sustain level, 0..1. Default 0.7. */
  s?: number
  /** Release time constant in seconds (one-pole toward 0). Default 0.2. */
  r?: number
}

const IDLE = 0
const ATTACK = 1
const DECAY = 2
const SUSTAIN = 3
const RELEASE = 4

/** ADSR envelope. Input 'gate' (audio-rate; > 0.5 = on); output 0..1.
 *  Attack is a LINEAR ramp to 1 over `a` seconds, always starting from the
 *  current level (so a retrigger mid-release resumes upward with no click).
 *  Decay and release are one-pole exponentials — `d`/`r` are time constants
 *  (~63% of the remaining distance per constant), not reach-times. Gate-off in
 *  ANY stage releases from the current level; below 1e-4 the release snaps to
 *  exactly 0 and goes idle. Times are clamped to [0.0005, 30] s and the
 *  sustain level to [0, 1] at construction. */
export class AdsrKernel implements Kernel {
  private readonly a: number
  private readonly d: number
  private readonly s: number
  private readonly r: number
  private level = 0
  private stage = IDLE

  constructor(config: AdsrConfig = {}) {
    this.a = clamp(config.a ?? 0.01, 0.0005, 30)
    this.d = clamp(config.d ?? 0.1, 0.0005, 30)
    this.s = clamp(config.s ?? 0.7, 0, 1)
    this.r = clamp(config.r ?? 0.2, 0.0005, 30)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const gate = inputs['gate']!
    const sr = ctx.sampleRate
    const s = this.s
    const aStep = 1 / (this.a * sr) // linear attack increment per sample
    const gD = 1 - Math.exp(-1 / (this.d * sr))
    const gR = 1 - Math.exp(-1 / (this.r * sr))
    let level = this.level
    let stage = this.stage
    for (let i = 0; i < n; i++) {
      if (gate[i]! > 0.5) {
        if (stage === IDLE || stage === RELEASE) stage = ATTACK
      } else if (stage !== IDLE && stage !== RELEASE) {
        stage = RELEASE
      }
      if (stage === ATTACK) {
        level += aStep
        if (level >= 1) {
          level = 1
          stage = DECAY
        }
      } else if (stage === DECAY) {
        level += gD * (s - level)
        if (Math.abs(level - s) < 1e-4) {
          level = s
          stage = SUSTAIN
        }
      } else if (stage === RELEASE) {
        level -= gR * level
        if (level < 1e-4) {
          level = 0
          stage = IDLE
        }
      }
      // SUSTAIN holds s (level already there); IDLE holds 0.
      out[i] = level
    }
    this.level = level
    this.stage = stage
  }

  reset(): void {
    this.level = 0
    this.stage = IDLE
  }
}
