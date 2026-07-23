import type { DspContext, Kernel } from './types'
import { clamp, flush } from './util'
import { smoothCoeff } from './compress'

export interface OttConfig {
  /** Dry→fully-processed blend, 0..1. Default 0.5. OTT is aggressive; this is
   *  the main "how much" knob. */
  depth?: number
  /** Low/mid crossover Hz. Default 240. */
  low?: number
  /** Mid/high crossover Hz. Default 2500. */
  high?: number
  /** Output makeup gain in dB. Default 0. */
  makeup?: number
}

interface BQ { b0: number; b1: number; b2: number; a1: number; a2: number; x1: number; x2: number; y1: number; y2: number }
const mkBQ = (): BQ => ({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 })

/** 2nd-order Butterworth (Q≈0.707) LP or HP coefficients (RBJ). */
const setLpHp = (f: BQ, freq: number, sr: number, hp: boolean): void => {
  const w0 = (2 * Math.PI * clamp(freq, 20, sr * 0.49)) / sr
  const c = Math.cos(w0)
  const s = Math.sin(w0)
  const al = s / (2 * 0.707)
  const a0 = 1 + al
  let b0: number, b1: number, b2: number
  if (hp) { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2 } else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2 }
  f.b0 = b0 / a0; f.b1 = b1 / a0; f.b2 = b2 / a0; f.a1 = (-2 * c) / a0; f.a2 = (1 - al) / a0
}
const runBQ = (f: BQ, x: number): number => {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y
  return y
}

// OTT-flavoured band dynamics: compress DOWN above -20 dB, expand UP below
// -30 dB, both ~4:1. Gains are clamped so quiet bands can't run away into noise.
const DOWN_THRESH = -20
const UP_THRESH = -30
const SLOPE = 1 - 1 / 4 // 4:1
const UP_FLOOR = -55 // below this, don't upward-boost (it's noise/silence)
const MAX_UP = 24
const MAX_DOWN = 40

/** Multiband (3-band) upward+downward compressor — the "OTT" glue/brightener.
 *  Splits the signal at `low`/`high`, applies OTT-style dynamics per band, and
 *  recombines, blended with the dry by `depth`. Mono. Squashes dynamics and
 *  pulls up detail, which reads as louder, fuller, brighter. */
export class OttKernel implements Kernel {
  private readonly depth: number
  private readonly lowF: number
  private readonly highF: number
  private readonly makeupLin: number
  private sr = 0
  private readonly lpLow = mkBQ()
  private readonly hpMid = mkBQ()
  private readonly lpMid = mkBQ()
  private readonly hpHigh = mkBQ()
  private readonly env = [0, 0, 0]
  private readonly gDb = [0, 0, 0]
  private atk = 0
  private rel = 0

  constructor(cfg: OttConfig = {}) {
    this.depth = clamp(cfg.depth ?? 0.5, 0, 1)
    this.lowF = clamp(cfg.low ?? 240, 60, 1200)
    this.highF = clamp(cfg.high ?? 2500, 800, 14000)
    this.makeupLin = Math.pow(10, (cfg.makeup ?? 0) / 20)
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    if (ctx.sampleRate !== this.sr) {
      this.sr = ctx.sampleRate
      setLpHp(this.lpLow, this.lowF, this.sr, false)
      setLpHp(this.hpMid, this.lowF, this.sr, true)
      setLpHp(this.lpMid, this.highF, this.sr, false)
      setLpHp(this.hpHigh, this.highF, this.sr, true)
      this.atk = smoothCoeff(5, this.sr)
      this.rel = smoothCoeff(60, this.sr)
    }
    const { depth, makeupLin: makeup, env, gDb, atk, rel } = this
    for (let i = 0; i < n; i++) {
      const dry = input[i]!
      const low = runBQ(this.lpLow, dry)
      const high = runBQ(this.hpHigh, dry)
      const mid = runBQ(this.lpMid, runBQ(this.hpMid, dry))
      const bands = [low, mid, high]
      let wet = 0
      for (let bnd = 0; bnd < 3; bnd++) {
        const x = bands[bnd]!
        const lin = Math.abs(x)
        // envelope follower (per-band)
        const ec = lin > env[bnd]! ? atk : rel
        env[bnd] = env[bnd]! + (lin - env[bnd]!) * ec
        const e = env[bnd]!
        const db = e > 1e-6 ? 20 * Math.log10(e) : -120
        const down = db > DOWN_THRESH ? clamp((db - DOWN_THRESH) * SLOPE, 0, MAX_DOWN) : 0
        const up = db < UP_THRESH && db > UP_FLOOR ? clamp((UP_THRESH - db) * SLOPE, 0, MAX_UP) : 0
        const target = up - down
        const gc = target < gDb[bnd]! ? atk : rel
        gDb[bnd] = gDb[bnd]! + (target - gDb[bnd]!) * gc
        wet += x * Math.pow(10, gDb[bnd]! / 20)
      }
      const y = (dry * (1 - depth) + wet * depth) * makeup
      out[i] = Number.isFinite(y) ? y : 0
    }
    // Scrub state so a transient NaN/denormal can't latch the bands into
    // permanent silence (crossover biquads + per-band envelope + gain).
    for (const f of [this.lpLow, this.hpMid, this.lpMid, this.hpHigh]) {
      f.x1 = flush(f.x1); f.x2 = flush(f.x2); f.y1 = flush(f.y1); f.y2 = flush(f.y2)
    }
    for (let bnd = 0; bnd < 3; bnd++) {
      env[bnd] = flush(env[bnd]!); gDb[bnd] = flush(gDb[bnd]!)
    }
  }

  reset(): void {
    this.env[0] = this.env[1] = this.env[2] = 0
    this.gDb[0] = this.gDb[1] = this.gDb[2] = 0
    for (const f of [this.lpLow, this.hpMid, this.lpMid, this.hpHigh]) { f.x1 = f.x2 = f.y1 = f.y2 = 0 }
  }
}
