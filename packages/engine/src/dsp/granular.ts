import type { DspContext, Kernel, SampleBankRO } from './types'
import { clamp } from './util'

export interface GranularConfig {
  /** Grain length in seconds. Default 0.08. Clamped to [0.002, 0.5]. */
  size?: number
  /** Grains spawned per second (density of the cloud). Default 25.
   *  Clamped to [1, 400]. size*density is the average overlap. */
  density?: number
  /** Random jitter added to each grain's start position, in seconds — the
   *  "spray" that thickens the texture. Default 0.01. Clamped to [0, 0.5]. */
  spray?: number
  /** Wrap the read position at the buffer ends (default true). */
  loop?: boolean
  /** Seed for the deterministic jitter RNG. Default 1. */
  seed?: number
}

/** Max simultaneously-active grains. Overlap beyond this steals the grain
 *  nearest to finishing — audible only at extreme density. */
const MAX_GRAINS = 48

/** Shared Hann (raised-cosine) window table — click-free grain envelope. */
const WIN_SIZE = 1024
const HANN = (() => {
  const w = new Float32Array(WIN_SIZE + 1)
  for (let i = 0; i <= WIN_SIZE; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / WIN_SIZE))
  return w
})()

/** Granular synthesis over a loaded sample. Sprays short, Hann-windowed grains
 *  read from the buffer around a scannable position, at a playback rate (pitch),
 *  with per-grain position jitter (spray). Inputs:
 *   - 'gate'  : grains spawn while > 0.5 (hold = a sustained cloud).
 *   - 'pos'   : read centre, 0..1 of the buffer (scannable — freeze or scrub).
 *   - 'rate'  : playback-rate multiplier (1 = natural pitch; grains are pitched
 *               independently of the scan position — the whole point of granular).
 *  Config (construction): grain `size`, `density`, `spray`, `loop`, `seed`.
 *
 *  Like SampleKernel it resolves `name` against the shared bank each block, so a
 *  sample loaded after compile just works; a missing name is silence. Output is
 *  loudness-normalised by ~1/sqrt(overlap) so density changes don't blow up. */
export class GranularKernel implements Kernel {
  private readonly size: number
  private readonly density: number
  private readonly spray: number
  private readonly loop: boolean
  // grain pool (parallel arrays — no per-grain allocation on the audio path)
  private readonly gPos = new Float64Array(MAX_GRAINS) // read head in source frames
  private readonly gWin = new Float64Array(MAX_GRAINS) // window phase 0..1
  private readonly gInc = new Float64Array(MAX_GRAINS) // window phase increment
  private readonly gRate = new Float64Array(MAX_GRAINS) // frames advanced per sample
  private readonly gOn = new Uint8Array(MAX_GRAINS)
  private spawnAcc = 0 // samples until the next grain
  private rng: number

  constructor(
    private readonly name: string,
    cfg: GranularConfig,
    private readonly bank: SampleBankRO | undefined,
  ) {
    this.size = clamp(cfg.size ?? 0.08, 0.002, 0.5)
    this.density = clamp(cfg.density ?? 25, 1, 400)
    this.spray = clamp(cfg.spray ?? 0.01, 0, 0.5)
    this.loop = cfg.loop !== false
    this.rng = (cfg.seed ?? 1) >>> 0 || 1
  }

  /** Deterministic uniform in [0, 1). */
  private rand(): number {
    // xorshift32
    let x = this.rng
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.rng = x >>> 0
    return this.rng / 4294967296
  }

  private spawn(centreFrame: number, rate: number, len: number, spraySamp: number): void {
    // find a free slot, else steal the grain nearest done (highest window phase)
    let slot = -1
    for (let g = 0; g < MAX_GRAINS; g++) {
      if (!this.gOn[g]) {
        slot = g
        break
      }
    }
    if (slot < 0) {
      let maxWin = -1
      for (let g = 0; g < MAX_GRAINS; g++) {
        if (this.gWin[g]! > maxWin) {
          maxWin = this.gWin[g]!
          slot = g
        }
      }
    }
    let start = centreFrame + (this.rand() * 2 - 1) * spraySamp
    // keep the start inside the buffer (wrap or clamp per loop)
    if (this.loop) {
      start -= Math.floor(start / len) * len
    } else {
      if (start < 0) start = 0
      else if (start > len - 1) start = len - 1
    }
    this.gPos[slot] = start
    this.gWin[slot] = 0
    this.gRate[slot] = rate
    this.gOn[slot] = 1
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const gate = inputs['gate']!
    const posIn = inputs['pos'] // 0..1 or undefined -> 0
    const rateIn = inputs['rate'] // pitch or undefined -> 1
    const s = this.bank?.get(this.name)
    if (s === undefined || s.data.length === 0) {
      out.fill(0, 0, n)
      return
    }
    const data = s.data
    const len = data.length
    const srRatio = s.sampleRate / ctx.sampleRate
    const grainSamples = Math.max(1, this.size * ctx.sampleRate)
    const winInc = WIN_SIZE / grainSamples // per-sample step through the window table
    const spawnInterval = ctx.sampleRate / this.density
    const spraySamp = this.spray * s.sampleRate
    // loudness compensation for overlap (size*density grains sounding at once)
    const norm = 1 / Math.sqrt(Math.max(1, this.size * this.density))

    for (let i = 0; i < n; i++) {
      // spawn grains while gated
      if (gate[i]! > 0.5) {
        this.spawnAcc -= 1
        while (this.spawnAcc <= 0) {
          this.spawnAcc += spawnInterval
          const pos = posIn !== undefined ? clamp(posIn[i]!, 0, 1) : 0
          const rate = (rateIn !== undefined ? rateIn[i]! : 1) * srRatio
          this.spawn(pos * (len - 1), rate, len, spraySamp)
        }
      }

      // sum the active grains
      let acc = 0
      for (let g = 0; g < MAX_GRAINS; g++) {
        if (!this.gOn[g]) continue
        const wph = this.gWin[g]!
        if (wph >= WIN_SIZE) {
          this.gOn[g] = 0
          continue
        }
        // Hann window (integer index into the table — cheap, click-free)
        const w = HANN[wph | 0]!
        // linear-interp read from the source
        let p = this.gPos[g]!
        if (this.loop) p -= Math.floor(p / len) * len
        const i0 = p | 0
        const frac = p - i0
        const a = data[i0]!
        const b = i0 + 1 < len ? data[i0 + 1]! : this.loop ? data[0]! : 0
        acc += w * (a + frac * (b - a))
        this.gPos[g] = this.gPos[g]! + this.gRate[g]!
        this.gWin[g] = wph + winInc
      }
      out[i] = acc * norm
    }
  }

  reset(): void {
    this.gOn.fill(0)
    this.spawnAcc = 0
  }
}
