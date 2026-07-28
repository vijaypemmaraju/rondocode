import type { DspContext, Kernel } from './types'
import { clamp } from './util'

/* util.ts's clamp PROPAGATES NaN (`v < lo` and `v > hi` are both false for it),
 * which is fine for a value read once at construction and fatal for one read per
 * sample: a single NaN would poison `level` for the life of the voice, which is
 * exactly how a knob wired into a stage used to silence a synth. These test
 * `>= lo` first, so NaN falls to the floor instead of spreading. */
const clampTime = (v: number): number => (v >= 0.0005 ? (v <= 30 ? v : 30) : 0.0005)
const clampLevel = (v: number): number => (v >= 0 ? (v <= 1 ? v : 1) : 0)

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
 *  sustain level to [0, 1].
 *
 *  a/d/s/r are INPUT PORTS, not config, so each one can be a knob, an LFO or
 *  another envelope and is read per sample: turning the attack knob mid-attack
 *  changes the current ramp rate immediately, exactly like an analog envelope.
 *  A plain number costs nothing extra — compile resolves it to a shared
 *  constant buffer rather than a kernel step (see compile.ts). The one-pole
 *  coefficients need an exp() per distinct value, so they are cached and only
 *  recomputed when their input actually moves: a fixed (or held) time pays one
 *  exp per block, and only a moving knob pays per sample. */
export class AdsrKernel implements Kernel {
  private level = 0
  private stage = IDLE
  // cached one-pole coefficients + the input value each was computed from
  private lastD = NaN
  private gD = 0
  private lastR = NaN
  private gR = 0

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const gate = inputs['gate']!
    const aIn = inputs['a']!
    const dIn = inputs['d']!
    const sIn = inputs['s']!
    const rIn = inputs['r']!
    const sr = ctx.sampleRate
    let level = this.level
    let stage = this.stage
    let lastD = this.lastD
    let gD = this.gD
    let lastR = this.lastR
    let gR = this.gR
    for (let i = 0; i < n; i++) {
      if (gate[i]! > 0.5) {
        if (stage === IDLE || stage === RELEASE) stage = ATTACK
      } else if (stage !== IDLE && stage !== RELEASE) {
        stage = RELEASE
      }
      if (stage === ATTACK) {
        level += 1 / (clampTime(aIn[i]!) * sr)
        if (level >= 1) {
          level = 1
          stage = DECAY
        }
      } else if (stage === DECAY) {
        const d = clampTime(dIn[i]!)
        if (d !== lastD) {
          lastD = d
          gD = 1 - Math.exp(-1 / (d * sr))
        }
        const s = clampLevel(sIn[i]!)
        level += gD * (s - level)
        if (Math.abs(level - s) < 1e-4) {
          level = s
          stage = SUSTAIN
        }
      } else if (stage === RELEASE) {
        const r = clampTime(rIn[i]!)
        if (r !== lastR) {
          lastR = r
          gR = 1 - Math.exp(-1 / (r * sr))
        }
        level -= gR * level
        if (level < 1e-4) {
          level = 0
          stage = IDLE
        }
      } else if (stage === SUSTAIN) {
        // A moving sustain must actually move: glide to it at the decay rate
        // rather than freezing at whatever level the decay stage handed over.
        const s = clampLevel(sIn[i]!)
        if (s !== level) level += gD * (s - level)
      }
      // IDLE holds 0.
      out[i] = level
    }
    this.level = level
    this.stage = stage
    this.lastD = lastD
    this.gD = gD
    this.lastR = lastR
    this.gR = gR
  }

  reset(): void {
    this.level = 0
    this.stage = IDLE
  }
}

export interface EnvConfig {
  /** Breakpoints as [timeSec, level] pairs: segment k ramps from the previous
   *  level (0 at start) to level_k over time_k seconds. Required, non-empty. */
  points: [number, number][]
  /** Gate-off ramp time to 0, seconds. Default 0.1. */
  release?: number
  /** Segment shape: 0 = linear; > 0 = fast-then-slow (exponential-decay feel);
   *  < 0 = slow-then-fast. Applied to every segment and the release. Default 0. */
  curve?: number
  /** Loop the breakpoints while the gate is held (a function generator) instead
   *  of holding the last level. Default false. */
  loop?: boolean
}

const E_IDLE = 0
const E_SEG = 1
const E_HOLD = 2
const E_REL = 3

/** Multi-segment (breakpoint) envelope — the flexible cousin of ADSR. Input
 *  'gate' (audio-rate; > 0.5 = on); output follows the breakpoints (levels are
 *  NOT clamped, so it drives amplitude, pitch or any modulation).
 *
 *  While the gate is high it ramps through `points` in order (each from the
 *  previous level to that point's level over its time), then HOLDS the last
 *  level (the sustain) — or, with `loop`, jumps back to the first point and
 *  repeats. Gate-off from any stage releases from the CURRENT level to 0 over
 *  `release` (so it never clicks), and a retrigger restarts the segments from
 *  the current level. `curve` warps every segment/the release the same way.
 *  Times are clamped to [0, 30] s, release to [0.0002, 30] s. */
export class EnvKernel implements Kernel {
  private readonly times: number[]
  private readonly levels: number[]
  private readonly release: number
  private readonly curve: number
  private readonly denom: number // 1 - e^-curve, precomputed for the warp
  private readonly loop: boolean

  private level = 0
  private stage = E_IDLE
  private seg = 0
  private t = 0 // seconds elapsed in the current segment/release
  private segStart = 0 // level at the start of the current segment/release

  constructor(config: EnvConfig) {
    const pts = Array.isArray(config.points) ? config.points : []
    if (pts.length === 0) throw new Error('env: points must be a non-empty [time, level][] array')
    this.times = pts.map((p) => clamp(Number(p[0]) || 0, 0, 30))
    this.levels = pts.map((p) => Number(p[1]) || 0)
    this.release = clamp(config.release ?? 0.1, 0.0002, 30)
    this.curve = Number.isFinite(config.curve) ? (config.curve as number) : 0
    this.denom = this.curve !== 0 ? 1 - Math.exp(-this.curve) : 0
    this.loop = config.loop === true
  }

  /** Warp a 0..1 fraction by the curve (0 = linear). */
  private warp(f: number): number {
    if (this.curve === 0) return f
    return (1 - Math.exp(-this.curve * f)) / this.denom
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const gate = inputs['gate']!
    const dt = 1 / ctx.sampleRate
    const times = this.times
    const levels = this.levels
    const last = levels.length - 1
    let level = this.level
    let stage = this.stage
    let seg = this.seg
    let t = this.t
    let segStart = this.segStart
    for (let i = 0; i < n; i++) {
      const on = gate[i]! > 0.5
      if (on) {
        if (stage === E_IDLE || stage === E_REL) {
          stage = E_SEG
          seg = 0
          t = 0
          segStart = level
        }
      } else if (stage === E_SEG || stage === E_HOLD) {
        stage = E_REL
        t = 0
        segStart = level
      }

      if (stage === E_SEG) {
        const dur = times[seg]!
        const target = levels[seg]!
        if (dur <= dt) {
          level = target // instant segment
        } else {
          const f = t / dur
          level = f >= 1 ? target : segStart + (target - segStart) * this.warp(f)
        }
        t += dt
        if (t >= dur) {
          level = target
          if (seg >= last) {
            if (this.loop) {
              seg = 0
              t = 0
              segStart = level
            } else {
              stage = E_HOLD
            }
          } else {
            seg++
            t = 0
            segStart = level
          }
        }
      } else if (stage === E_HOLD) {
        level = levels[last]!
      } else if (stage === E_REL) {
        const f = t / this.release
        level = f >= 1 ? 0 : segStart * (1 - this.warp(f))
        t += dt
        if (t >= this.release) {
          level = 0
          stage = E_IDLE
        }
      } else {
        level = 0 // IDLE
      }
      out[i] = level
    }
    this.level = level
    this.stage = stage
    this.seg = seg
    this.t = t
    this.segStart = segStart
  }

  reset(): void {
    this.level = 0
    this.stage = E_IDLE
    this.seg = 0
    this.t = 0
    this.segStart = 0
  }
}
