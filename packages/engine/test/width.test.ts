import { describe, it, expect } from 'vitest'
import { WidthKernel } from '../src/dsp/width'
import type { WidthConfig } from '../src/dsp/width'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

/* ------------------------------------------------------------------------- *
 * WidthKernel — Lauridsen pseudo-stereo. The kernel is MONO; the stereo pair
 * is two instances of it, and the RIGHT one is marked by a nonzero ctx.spread
 * (exactly how post.ts compiles a post chain). Everything measured here runs
 * the pair the way PostChain would.
 * ------------------------------------------------------------------------- */

const SR = 48000
const ctxL: DspContext = { sampleRate: SR }
const ctxR: DspContext = { sampleRate: SR, spread: 23 }

const run = (k: WidthKernel, input: Float32Array, amount: number, ctx: DspContext, block = 128): Float32Array => {
  const n = input.length
  const out = new Float32Array(n)
  const amt = new Float32Array(block).fill(amount)
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    k.process(m, { in: input.subarray(i, i + m), amount: amt.subarray(0, m) }, out.subarray(i, i + m), ctx)
  }
  return out
}

/** Run the L/R pair the way PostChain does: same graph, two instances, the
 *  right one carrying the stereo-spread marker. */
const pair = (input: Float32Array, amount: number, cfg: WidthConfig = {}): [Float32Array, Float32Array] => [
  run(new WidthKernel(cfg, ctxL), input, amount, ctxL),
  run(new WidthKernel(cfg, ctxR), input, amount, ctxR),
]

/** Pearson correlation of two equal-length signals (both are zero-mean here). */
const correlation = (a: Float32Array, b: Float32Array, from = 0): number => {
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = from; i < a.length; i++) {
    sab += a[i]! * b[i]!
    saa += a[i]! * a[i]!
    sbb += b[i]! * b[i]!
  }
  return sab / Math.sqrt(saa * sbb)
}

const rms = (x: Float32Array, from = 0): number => {
  let s = 0
  for (let i = from; i < x.length; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / (x.length - from))
}

/** Deterministic white noise (a plain LCG — no engine dependency). */
const noise = (n: number, seed = 12345): Float32Array => {
  const x = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    x[i] = (s / 4294967296) * 2 - 1
  }
  return x
}

const sine = (n: number, freq: number, amp = 0.5): Float32Array => {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR)
  return x
}

describe('WidthKernel: amount 0 is untouched', () => {
  it('passes the signal through BIT-exactly on both sides at amount 0', () => {
    const src = noise(SR)
    const [l, r] = pair(src, 0)
    for (let i = 0; i < src.length; i++) {
      expect(l[i]!).toBe(src[i]!)
      expect(r[i]!).toBe(src[i]!)
    }
  })
})

describe('WidthKernel: L/R correlation falls as amount rises', () => {
  // The prediction is exact for a source decorrelated from its own delayed
  // copy: corr = (1 - a^2) / (1 + a^2).
  const src = noise(4 * SR)
  const skip = SR // ignore the buffer fill-in
  const measured = new Map<number, number>()
  for (const a of [0, 0.25, 0.5, 0.75, 1]) {
    const [l, r] = pair(src, a)
    measured.set(a, correlation(l, r, skip))
  }

  it('is 1.0 at amount 0 and falls monotonically to ~0 at amount 1', () => {
    // measured on white noise, 'wide' mode: 1.000, 0.882, 0.600, 0.280, 0.000
    expect(measured.get(0)!).toBeCloseTo(1, 5)
    expect(measured.get(1)!).toBeCloseTo(0, 2)
    const seq = [0, 0.25, 0.5, 0.75, 1].map((a) => measured.get(a)!)
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeLessThan(seq[i - 1]! - 0.1)
  })

  it('matches the (1-a^2)/(1+a^2) prediction within 0.02', () => {
    for (const [a, c] of measured) {
      expect(Math.abs(c - (1 - a * a) / (1 + a * a)), `amount ${a}: ${c}`).toBeLessThan(0.02)
    }
  })

  it("'tight' mode also widens, and correlates the same way", () => {
    const [l, r] = pair(src, 1, { mode: 'tight' })
    expect(Math.abs(correlation(l, r, skip))).toBeLessThan(0.02)
  })
})

describe('WidthKernel: MONO COMPATIBILITY — the sum is the dry signal', () => {
  const src = noise(2 * SR)
  const skip = SR

  it('sums to the dry signal with a FLAT trim: 0 dB at amount 0, -3.01 dB at 1', () => {
    // (L+R)/2 = x / sqrt(1+a^2): the delayed copy cancels exactly.
    for (const a of [0, 0.25, 0.5, 0.75, 1]) {
      const [l, r] = pair(src, a)
      const sum = new Float32Array(src.length)
      for (let i = 0; i < src.length; i++) sum[i] = (l[i]! + r[i]!) / 2
      const g = 1 / Math.sqrt(1 + a * a)
      // level: measured -0.00, -0.26, -0.97, -1.94, -3.01 dB
      const db = 20 * Math.log10(rms(sum, skip) / rms(src, skip))
      expect(db, `amount ${a}`).toBeCloseTo(20 * Math.log10(g), 2)
      // shape: the sum is the dry signal SCALED, sample for sample
      for (let i = skip; i < src.length; i++) {
        expect(Math.abs(sum[i]! - src[i]! * g), `amount ${a} @ ${i}`).toBeLessThan(2e-6)
      }
    }
  })

  it('has NO comb notches in the mono sum: every band is trimmed equally', () => {
    // The honest failure mode of a Haas widener is periodic nulls in mono.
    // Sweep the band and show the response is flat to within 0.1 dB.
    const [l, r] = pair(src, 1)
    const sum = new Float32Array(src.length)
    for (let i = 0; i < src.length; i++) sum[i] = (l[i]! + r[i]!) / 2
    const a = sum.subarray(skip)
    const b = src.subarray(skip)
    let lo = Infinity
    let hi = -Infinity
    for (let f = 60; f <= 12000; f += 37) {
      const db = 10 * Math.log10(goertzel(a, f, SR) / goertzel(b, f, SR))
      if (db < lo) lo = db
      if (db > hi) hi = db
    }
    // measured: -3.06 .. -2.96 dB across 60 Hz .. 12 kHz (spread 0.10 dB)
    expect(hi - lo, `spread ${hi - lo} dB`).toBeLessThan(0.5)
    expect(lo).toBeGreaterThan(-3.5)
    expect(hi).toBeLessThan(-2.5)
  })

  it('the price: each channel ALONE is comb filtered (documented, not a bug)', () => {
    const [l] = pair(src, 1)
    const a = l.subarray(skip)
    const b = src.subarray(skip)
    // 'wide' = 12 ms = 576 samples at 48k, so L peaks at multiples of
    // SR/576 = 83.33 Hz and notches halfway between. Measure one of each.
    const spacing = SR / Math.round(0.012 * SR)
    const peakDb = 10 * Math.log10(goertzel(a, spacing * 6, SR) / goertzel(b, spacing * 6, SR))
    const notchDb = 10 * Math.log10(goertzel(a, spacing * 6.5, SR) / goertzel(b, spacing * 6.5, SR))
    // measured: peak +2.7 dB (theoretical ceiling +3.01), notch -33 dB
    expect(peakDb).toBeGreaterThan(2)
    expect(notchDb).toBeLessThan(-20)
  })
})

describe('WidthKernel: hygiene', () => {
  it('stays finite and bounded on a full-scale tone', () => {
    const [l, r] = pair(sine(SR, 220, 1), 1)
    for (let i = 0; i < l.length; i++) {
      expect(Number.isFinite(l[i]!)).toBe(true)
      expect(Number.isFinite(r[i]!)).toBe(true)
      // |x ± a*y| / sqrt(1+a^2) <= (1+a)/sqrt(1+a^2) = sqrt(2) at a = 1
      expect(Math.abs(l[i]!)).toBeLessThan(1.42)
      expect(Math.abs(r[i]!)).toBeLessThan(1.42)
    }
  })

  it('settles to exact 0 after the signal stops (no denormals, no feedback)', () => {
    const n = SR
    const src = new Float32Array(n)
    for (let i = 0; i < 0.1 * SR; i++) src[i] = Math.sin((2 * Math.PI * 300 * i) / SR)
    const [l, r] = pair(src, 0.8)
    expect(l[n - 1]!).toBe(0)
    expect(r[n - 1]!).toBe(0)
  })

  it('recovers within one block from a NaN on the input', () => {
    const k = new WidthKernel({}, ctxL)
    const bad = new Float32Array(128).fill(NaN)
    const amt = new Float32Array(128).fill(0.8)
    k.process(128, { in: bad, amount: amt }, new Float32Array(128), ctxL)
    // the poisoned line is zeroed at block end, so the next silent block is 0
    const out = new Float32Array(128)
    k.process(128, { in: new Float32Array(128), amount: amt }, out, ctxL)
    expect(out.every((v) => v === 0)).toBe(true)
  })

  it('is block-boundary continuous: one full block == many small blocks', () => {
    const src = noise(4096)
    const whole = run(new WidthKernel({}, ctxL), src, 0.7, ctxL, 4096)
    const split = run(new WidthKernel({}, ctxL), src, 0.7, ctxL, 37)
    for (let i = 0; i < src.length; i++) expect(split[i]!).toBe(whole[i]!)
  })

  it('reset() clears the delay line', () => {
    const k = new WidthKernel({}, ctxL)
    run(k, noise(4096), 1, ctxL)
    k.reset()
    const out = run(k, new Float32Array(SR), 1, ctxL)
    expect(out.every((v) => v === 0)).toBe(true)
  })
})

describe('WidthKernel at 44.1 kHz', () => {
  const SR44 = 44100
  const c44L: DspContext = { sampleRate: SR44 }
  const c44R: DspContext = { sampleRate: SR44, spread: 23 }

  it("keeps the 12 ms 'wide' delay in SECONDS (comb peak at 1/0.012 = 83.3 Hz)", () => {
    const src = noise(4 * SR44)
    const out = new Float32Array(src.length)
    const k = new WidthKernel({}, c44L)
    const amt = new Float32Array(128).fill(1)
    for (let i = 0; i < src.length; i += 128) {
      const m = Math.min(128, src.length - i)
      k.process(m, { in: src.subarray(i, i + m), amount: amt.subarray(0, m) }, out.subarray(i, i + m), c44L)
    }
    const a = out.subarray(SR44)
    const b = src.subarray(SR44)
    const at = (f: number): number => 10 * Math.log10(goertzel(a, f, SR44) / goertzel(b, f, SR44))
    // comb spacing = SR/round(0.012*SR) = 83.4 Hz. A 48k bake-in would delay
    // 576 samples instead of 529, spacing the comb at 76.6 Hz — which puts a
    // NOTCH where this reads a peak.
    const spacing = SR44 / Math.round(0.012 * SR44)
    // measured: peak +2.7 dB, notch -15.2 dB (the floor is Goertzel leakage on
    // noise, not the comb — the contract is the peak/notch SPACING)
    expect(at(spacing * 6)).toBeGreaterThan(2)
    expect(at(spacing * 6) - at(spacing * 6.5)).toBeGreaterThan(15)
  })

  it('still sums to the dry signal at -3.01 dB', () => {
    const src = noise(2 * SR44)
    const l = new Float32Array(src.length)
    const r = new Float32Array(src.length)
    const kl = new WidthKernel({}, c44L)
    const kr = new WidthKernel({}, c44R)
    const amt = new Float32Array(128).fill(1)
    for (let i = 0; i < src.length; i += 128) {
      const m = Math.min(128, src.length - i)
      kl.process(m, { in: src.subarray(i, i + m), amount: amt.subarray(0, m) }, l.subarray(i, i + m), c44L)
      kr.process(m, { in: src.subarray(i, i + m), amount: amt.subarray(0, m) }, r.subarray(i, i + m), c44R)
    }
    const sum = new Float32Array(src.length)
    for (let i = 0; i < src.length; i++) sum[i] = (l[i]! + r[i]!) / 2
    expect(20 * Math.log10(rms(sum, SR44) / rms(src, SR44))).toBeCloseTo(-3.01, 1)
  })
})
