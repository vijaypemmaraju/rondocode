import { describe, it, expect } from 'vitest'
import { TransientKernel } from '../src/dsp/transient'
import type { TransientConfig } from '../src/dsp/transient'
import type { DspContext } from '../src/dsp/types'

/* ------------------------------------------------------------------------- *
 * TransientKernel — envelope-ratio transient designer. The claims that matter
 * are (a) attack shapes the ONSET relative to the body, (b) sustain shortens
 * or lengthens the TAIL, and (c) it is LEVEL-INDEPENDENT, which is the whole
 * difference from a compressor.
 * ------------------------------------------------------------------------- */

const SR = 48000
const ctx: DspContext = { sampleRate: SR }

const run = (cfg: TransientConfig, input: Float32Array, block = 128): Float32Array => {
  const k = new TransientKernel(cfg)
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += block) {
    const m = Math.min(block, input.length - i)
    k.process(m, { in: input.subarray(i, i + m) }, out.subarray(i, i + m), ctx)
  }
  return out
}

/** A drum-shaped hit: an instant onset decaying exponentially over `decay`
 *  seconds, carrying a 220 Hz tone so it has real spectral content. */
const hit = (n: number, amp = 0.5, decay = 0.15, start = 0): Float32Array => {
  const x = new Float32Array(n)
  for (let i = start; i < n; i++) {
    const t = (i - start) / SR
    x[i] = amp * Math.exp(-t / decay) * Math.sin(2 * Math.PI * 220 * t)
  }
  return x
}

const peak = (x: Float32Array, from = 0, to = x.length): number => {
  let p = 0
  for (let i = from; i < to; i++) {
    const a = Math.abs(x[i]!)
    if (a > p) p = a
  }
  return p
}

const rms = (x: Float32Array, from: number, to: number): number => {
  let s = 0
  for (let i = from; i < to; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / (to - from))
}

const ms = (t: number): number => Math.round((t / 1000) * SR)

describe('TransientKernel: neutral settings', () => {
  it('attack 0 + sustain 0 is a BIT-exact passthrough', () => {
    const src = hit(SR)
    const out = run({}, src)
    for (let i = 0; i < src.length; i++) expect(out[i]!).toBe(src[i]!)
  })

  it('an explicit { attack: 0, sustain: 0 } is the same passthrough', () => {
    const src = hit(SR)
    const out = run({ attack: 0, sustain: 0 }, src)
    for (let i = 0; i < src.length; i++) expect(out[i]!).toBe(src[i]!)
  })
})

describe('TransientKernel: attack shapes the ONSET', () => {
  const src = hit(SR)
  // "peak-to-body": the loudest sample in the first 8 ms against the RMS of
  // the settled body 50..150 ms in. Attack boost must raise this ratio.
  const ptb = (x: Float32Array): number => peak(x, 0, ms(8)) / rms(x, ms(50), ms(150))
  const dry = ptb(src)

  it('attack +1 RAISES the onset peak-to-body ratio', () => {
    // measured: dry 2.64, attack +1 → 5.50 (2.09x)
    const boosted = ptb(run({ attack: 1 }, src))
    expect(boosted).toBeGreaterThan(dry * 1.8)
  })

  it('attack -1 LOWERS it (a softened onset)', () => {
    // measured: attack -1 → 1.04 (0.39x)
    const softened = ptb(run({ attack: -1 }, src))
    expect(softened).toBeLessThan(dry * 0.7)
  })

  it('rises monotonically with attack (until the ±12 dB clamp saturates)', () => {
    // measured: 1.04, 1.20, 2.64, 5.52 — and 5.50 at attack 1, i.e. flat once
    // the gain clamp is reached, which is why the sweep stops at 0.5.
    const seq = [-1, -0.5, 0, 0.5].map((a) => ptb(run({ attack: a }, src)))
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThan(seq[i - 1]!)
  })
})

describe('TransientKernel: LEVEL INDEPENDENCE (this is not a compressor)', () => {
  it('shapes a -26 dB hit and a -6 dB hit identically (same gain curve)', () => {
    // A compressor with a threshold would gate at one level and not the other.
    const quiet = hit(SR, 0.05)
    const loud = hit(SR, 0.5)
    const cfg: TransientConfig = { attack: 0.8, sustain: -0.6 }
    const oq = run(cfg, quiet)
    const ol = run(cfg, loud)
    let worst = 0
    for (let i = 0; i < SR; i++) {
      // recover the applied GAIN at each sample and compare the two runs
      if (Math.abs(quiet[i]!) < 1e-4) continue
      const gq = oq[i]! / quiet[i]!
      const gl = ol[i]! / loud[i]!
      const rel = Math.abs(gq - gl) / Math.max(Math.abs(gq), 1e-9)
      if (rel > worst) worst = rel
    }
    // measured worst relative gain difference: 1.1e-7 (float32 rounding)
    expect(worst).toBeLessThan(1e-4)
  })

  it('a 10x level change scales the OUTPUT by 10x, nothing else', () => {
    const cfg: TransientConfig = { attack: 1, sustain: 1 }
    const oq = run(cfg, hit(SR, 0.05))
    const ol = run(cfg, hit(SR, 0.5))
    for (let i = 0; i < SR; i += 97) {
      expect(Math.abs(ol[i]! - oq[i]! * 10)).toBeLessThan(1e-4)
    }
  })
})

describe('TransientKernel: sustain shapes the TAIL', () => {
  const src = hit(SR)
  /** Time (in samples) for the signal to fall below `frac` of its own peak. */
  const tailTo = (x: Float32Array, frac: number): number => {
    const p = peak(x)
    for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]!) > p * frac) return i
    return 0
  }

  it('sustain -1 SHORTENS the tail measurably', () => {
    // measured: the dry hit reaches -30 dB of its peak at 519 ms, sustain -1
    // at 385 ms — 26% shorter
    const dryT = tailTo(src, 0.0316)
    const cutT = tailTo(run({ sustain: -1 }, src), 0.0316)
    expect(cutT).toBeLessThan(dryT * 0.85)
  })

  it('sustain -1 pulls the tail DOWN, +1 lifts it, symmetrically', () => {
    // measured over 300..600 ms: -7.10 dB at sustain -1, +7.39 dB at +1
    const dryBody = rms(src, ms(300), ms(600))
    const cut = rms(run({ sustain: -1 }, src), ms(300), ms(600))
    const lift = rms(run({ sustain: 1 }, src), ms(300), ms(600))
    expect(20 * Math.log10(cut / dryBody)).toBeLessThan(-5)
    expect(20 * Math.log10(lift / dryBody)).toBeGreaterThan(5)
    expect(tailTo(run({ sustain: 1 }, src), 0.0316)).toBeGreaterThan(tailTo(src, 0.0316))
  })

  it('leaves the ONSET peak untouched (it only acts on the tail)', () => {
    const dryPeak = peak(src, 0, ms(8))
    const cutPeak = peak(run({ sustain: -1 }, src), 0, ms(8))
    // measured: 0.4962 → 0.4962
    expect(Math.abs(cutPeak - dryPeak) / dryPeak).toBeLessThan(0.01)
  })
})

describe('TransientKernel: hygiene', () => {
  const cfg: TransientConfig = { attack: 1, sustain: 1 }

  it('is bounded by the ±12 dB gain clamp and stays finite', () => {
    const src = hit(SR, 1)
    const out = run(cfg, src)
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true)
      expect(Math.abs(out[i]!)).toBeLessThanOrEqual(Math.abs(src[i]!) * 4 + 1e-6)
    }
  })

  it('outputs exact 0 on silence, and settles to exact 0 after the signal stops', () => {
    const n = SR
    const src = new Float32Array(n)
    for (let i = 0; i < ms(100); i++) src[i] = Math.sin((2 * Math.PI * 300 * i) / SR)
    const out = run(cfg, src)
    expect(out[n - 1]!).toBe(0)
    expect(run(cfg, new Float32Array(n)).every((v) => v === 0)).toBe(true)
  })

  it('recovers within one block from a NaN on the input', () => {
    const k = new TransientKernel(cfg)
    k.process(128, { in: new Float32Array(128).fill(NaN) }, new Float32Array(128), ctx)
    const out = new Float32Array(128)
    k.process(128, { in: new Float32Array(128).fill(0.5) }, out, ctx)
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('is block-boundary continuous: one full block == many small blocks', () => {
    const src = hit(8192)
    const whole = run(cfg, src, 8192)
    const split = run(cfg, src, 37)
    for (let i = 0; i < src.length; i++) expect(split[i]!).toBe(whole[i]!)
  })

  it('reset() clears the followers', () => {
    const k = new TransientKernel(cfg)
    k.process(4096, { in: hit(4096, 1) }, new Float32Array(4096), ctx)
    k.reset()
    const a = new Float32Array(4096)
    k.process(4096, { in: hit(4096, 1) }, a, ctx)
    const b = run(cfg, hit(4096, 1), 4096)
    for (let i = 0; i < 4096; i++) expect(a[i]!).toBe(b[i]!)
  })
})

describe('TransientKernel at 44.1 kHz', () => {
  const SR44 = 44100
  const c44: DspContext = { sampleRate: SR44 }
  const hit44 = (n: number, amp = 0.5): Float32Array => {
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / SR44
      x[i] = amp * Math.exp(-t / 0.15) * Math.sin(2 * Math.PI * 220 * t)
    }
    return x
  }
  const run44 = (cfg: TransientConfig, input: Float32Array): Float32Array => {
    const k = new TransientKernel(cfg)
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i += 128) {
      const m = Math.min(128, input.length - i)
      k.process(m, { in: input.subarray(i, i + m) }, out.subarray(i, i + m), c44)
    }
    return out
  }

  it('follower times are in MILLISECONDS: the same shaping at 44.1k', () => {
    // A 48k bake-in would run the followers ~9% fast and change the ratio.
    const src = hit44(SR44)
    const body = (x: Float32Array): number => rms(x, Math.round(0.05 * SR44), Math.round(0.15 * SR44))
    const on = (x: Float32Array): number => peak(x, 0, Math.round(0.008 * SR44))
    const dry = on(src) / body(src)
    const up = run44({ attack: 1 }, src)
    // measured: dry 2.64 → 5.50 at 44.1k (2.64 → 5.50 at 48k)
    expect(on(up) / body(up)).toBeGreaterThan(dry * 1.8)
  })

  it('is still level-independent at 44.1k', () => {
    const cfg: TransientConfig = { attack: 0.8, sustain: -0.6 }
    const oq = run44(cfg, hit44(SR44, 0.05))
    const ol = run44(cfg, hit44(SR44, 0.5))
    for (let i = 0; i < SR44; i += 101) {
      expect(Math.abs(ol[i]! - oq[i]! * 10)).toBeLessThan(1e-4)
    }
  })
})
