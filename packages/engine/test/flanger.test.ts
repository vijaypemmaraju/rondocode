import { describe, it, expect } from 'vitest'
import { FlangerKernel } from '../src/dsp/flanger'
import { ChorusKernel } from '../src/dsp/chorus'
import type { DspContext, Kernel } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

/* ------------------------------------------------------------------------- *
 * FlangerKernel — a short modulated delay WITH feedback. The claims are that
 * the notch MOVES, that feedback builds resonance, and that this is a
 * different animal from chorus. The last one is measured, not asserted: an
 * unfed multi-tap chorus can never push its transfer magnitude above unity,
 * and a fed-back single tap can and does.
 *
 * Everything spectral here is measured from an IMPULSE RESPONSE rather than
 * from noise. A single Goertzel bin of white noise is chi-square with 2 dof —
 * ±100% swings — so a ratio of two such bins cannot distinguish a 3 dB notch
 * from luck. Against an impulse the same Goertzel reads |H(f)| exactly (a
 * bare delta measures 1.0000 at every probe frequency, pinned below).
 * ------------------------------------------------------------------------- */

const SR = 48000
const ctx: DspContext = { sampleRate: SR }
const ctxR: DspContext = { sampleRate: SR, spread: 23 }

const run = (k: Kernel, input: Float32Array, block = 128, c: DspContext = ctx): Float32Array => {
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += block) {
    const m = Math.min(block, input.length - i)
    k.process(m, { in: input.subarray(i, i + m) }, out.subarray(i, i + m), c)
  }
  return out
}

/** Impulse response captured `atSec` into the run, so the LFO has swept to a
 *  known phase before the impulse lands. */
const ir = (k: Kernel, atSec = 0, lenSec = 0.35, c: DspContext = ctx, sr = SR): Float32Array => {
  const pre = Math.round(atSec * sr)
  const x = new Float32Array(pre + Math.round(lenSec * sr))
  x[pre] = 1
  return run(k, x, 128, c).subarray(pre)
}

/** |H(f)| from an impulse response (goertzel returns power/N). */
const H = (h: Float32Array, f: number, sr = SR): number => Math.sqrt(goertzel(h, f, sr) * h.length)

const sweepH = (h: Float32Array, from = 100, to = 10000, step = 25, sr = SR): { min: number; max: number; fmin: number } => {
  let min = Infinity
  let max = -Infinity
  let fmin = 0
  for (let f = from; f <= to; f += step) {
    const m = H(h, f, sr)
    if (m < min) {
      min = m
      fmin = f
    }
    if (m > max) max = m
  }
  return { min, max, fmin }
}

/** Largest |H| ratio between two responses anywhere in the band. */
const biggestDiff = (a: Float32Array, b: Float32Array, sr = SR): number => {
  let worst = 1
  for (let f = 200; f <= 8000; f += 25) {
    const ha = H(a, f, sr)
    const hb = H(b, f, sr)
    const r = Math.max(ha, hb) / Math.min(ha, hb)
    if (r > worst) worst = r
  }
  return worst
}

const sine = (n: number, freq: number, amp = 0.5): Float32Array => {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR)
  return x
}

const noise = (n: number, seed = 4242): Float32Array => {
  const x = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    x[i] = ((s / 4294967296) * 2 - 1) * 0.5
  }
  return x
}

describe('the measurement itself', () => {
  it('reads |H| = 1 for a bare delta (so the numbers below are real)', () => {
    const h = new Float32Array(4096)
    h[0] = 1
    for (const f of [200, 1000, 5000]) expect(H(h, f)).toBeCloseTo(1, 6)
  })
})

describe('FlangerKernel: mix 0 is untouched', () => {
  it('passes the dry signal through BIT-exactly at mix 0', () => {
    const src = sine(SR, 300)
    const out = run(new FlangerKernel({ mix: 0, feedback: 0.9 }, ctx), src)
    for (let i = 0; i < src.length; i++) expect(out[i]!).toBe(src[i]!)
  })
})

describe('FlangerKernel: the notch MOVES', () => {
  const cfg = { rate: 0.5, depth: 1, feedback: 0.7, mix: 0.5 }

  it('the response a second later is a DIFFERENT curve (the sweep moved)', () => {
    // 0.5 Hz sweep, so t=1 s and t=2 s are half a cycle apart.
    const a = ir(new FlangerKernel(cfg, ctx), 1)
    const b = ir(new FlangerKernel(cfg, ctx), 2)
    // measured: the deepest notch sits at 6550 Hz (|H| 0.098) at t=1 s and at
    // 1675 Hz (|H| 0.207) at t=2 s; the biggest per-frequency ratio is 16.6x
    expect(biggestDiff(a, b)).toBeGreaterThan(6)
    expect(Math.abs(sweepH(a).fmin - sweepH(b).fmin)).toBeGreaterThan(1000)
    // and at a fixed probe frequency, exactly the Goertzel-at-two-times check
    // measured: |H(2000)| = 1.794 at t=1 s, 0.241 at t=2 s
    expect(H(a, 2000) / H(b, 2000)).toBeGreaterThan(4)
  })

  it('a sweep parked at its rate floor holds the SAME response', () => {
    const still = { ...cfg, rate: 0.001 }
    const a = ir(new FlangerKernel(still, ctx), 1)
    const b = ir(new FlangerKernel(still, ctx), 2)
    // measured: notch at 1675 Hz in both; worst per-frequency drift 0.5%
    expect(sweepH(a).fmin).toBe(sweepH(b).fmin)
    for (const f of [500, 1000, 2000, 4000]) {
      expect(Math.abs(H(b, f) - H(a, f)) / H(a, f)).toBeLessThan(0.05)
    }
  })
})

describe('FlangerKernel: feedback raises the resonance', () => {
  const at = (feedback: number): { min: number; max: number; fmin: number } =>
    sweepH(ir(new FlangerKernel({ rate: 0.001, depth: 0.5, feedback, mix: 0.5 }, ctx)))

  it('a fed-back comb PEAKS above unity; an unfed one cannot', () => {
    // measured max |H|: fb 0 → 0.996, fb 0.4 → 1.302, fb 0.8 → 2.735
    const a = at(0)
    const b = at(0.4)
    const c = at(0.8)
    expect(a.max).toBeLessThanOrEqual(1.001)
    expect(b.max).toBeGreaterThan(1.2)
    expect(c.max).toBeGreaterThan(2.5)
    expect(c.max).toBeGreaterThan(b.max * 1.8)
  })

  it('negative feedback also resonates, and moves the notch', () => {
    // measured: fb -0.8 peaks at 1.926, and its notch lands at 1675 Hz — where
    // fb +0.8 has its notch too, but the peak/notch roles are swapped there
    const c = at(-0.8)
    expect(c.max).toBeGreaterThan(1.8)
    expect(c.min).toBeLessThan(0.8)
  })
})

describe('FlangerKernel vs ChorusKernel: a MEASURED difference', () => {
  const fl = ir(new FlangerKernel({ rate: 0.001, depth: 0.5, feedback: 0.8, mix: 0.5 }, ctx))
  const ch = ir(new ChorusKernel({ rate: 0.01, depth: 0.003, mix: 0.5 }, ctx))
  const f = sweepH(fl)
  const c = sweepH(ch)

  it('the flanger peaks WELL above unity; chorus cannot, by construction', () => {
    // Chorus averages three UNFED taps, so |wet| <= |x| and the dry/wet blend
    // has |H| <= 1 everywhere. The flanger's loop gain is 1/(1-fb) = 5.
    // measured: flanger max 2.735 (+8.7 dB), chorus max 1.000 (0.0 dB)
    expect(c.max).toBeLessThan(1.01)
    expect(f.max).toBeGreaterThan(2.5)
    expect(f.max / c.max).toBeGreaterThan(2.5)
  })

  it('the flanger notch is ONE harmonic series; chorus averages its taps away', () => {
    // The structural claim, pinned two ways. First: at depth 0 the flanger
    // parks at its 0.3 ms floor, whose first notch must sit at
    // 1/(2*0.0003) = 1667 Hz with full nulls at the odd multiples.
    const floor = ir(new FlangerKernel({ rate: 0.001, depth: 0, feedback: 0, mix: 0.5 }, ctx))
    // measured: |H| = 0.003 at 1667 Hz, 0.707 at 833 Hz, 0.989 at 3334 Hz
    expect(H(floor, 1667)).toBeLessThan(0.05)
    expect(H(floor, 833)).toBeGreaterThan(0.6)
    expect(H(floor, 3334)).toBeGreaterThan(0.9)
    expect(sweepH(floor, 500, 3000, 5).fmin).toBeGreaterThan(1600)
    expect(sweepH(floor, 500, 3000, 5).fmin).toBeLessThan(1730)
    // Second: chorus's ~11 ms base delay puts its first notch at ~45 Hz — far
    // below the flanger's whole sweep range — so at 1667 Hz it is unremarkable.
    expect(H(ch, 1667)).toBeGreaterThan(0.15)
  })
})

describe('FlangerKernel: stereo', () => {
  const cfg = { rate: 0.5, depth: 1, feedback: 0.7 }

  it('the right instance sweeps a quarter cycle ahead of the left', () => {
    const l = ir(new FlangerKernel(cfg, ctx), 1)
    const r = ir(new FlangerKernel(cfg, ctxR), 1, 0.35, ctxR)
    // measured: the L notch sits at 6550 Hz, the R notch at 9875 Hz, and the
    // two responses differ by up to 9.6x at one instant
    expect(biggestDiff(l, r)).toBeGreaterThan(4)
    expect(sweepH(l).fmin).not.toBe(sweepH(r).fmin)
  })

  it('reset() restores the RIGHT instance to its quadrature phase, not 0', () => {
    const src = noise(SR)
    const k = new FlangerKernel(cfg, ctxR)
    const first = run(k, src, 128, ctxR)
    k.reset()
    const second = run(k, src, 128, ctxR)
    for (let i = 0; i < src.length; i++) expect(second[i]!).toBe(first[i]!)
  })
})

describe('FlangerKernel: hygiene', () => {
  it('stays finite and bounded at maximum feedback on a full-scale tone', () => {
    const out = run(new FlangerKernel({ feedback: 0.95, depth: 1, mix: 1 }, ctx), sine(2 * SR, 220, 1))
    // Scan in a plain loop and assert ONCE. Two expect() calls per sample over
    // 2s of audio is ~192k assertions, which is slow enough to time out under
    // a loaded suite — and it reports only the FIRST bad sample. This reports
    // the worst one, which is what you want when a bound is exceeded.
    let worst = 0
    let firstBad = -1
    for (let i = 0; i < out.length; i++) {
      const v = out[i]!
      if (!Number.isFinite(v)) { firstBad = i; break }
      if (Math.abs(v) > worst) worst = Math.abs(v)
    }
    expect(firstBad, `non-finite sample at ${firstBad}`).toBe(-1)
    // the soft knee bounds every write to |v| < 2, and out = read
    expect(worst).toBeLessThan(2.1)
  })

  it('keeps audio still IN FLIGHT inside the line instead of draining it early', () => {
    // Regression: with mix < 1 the output is silent for the whole pre-delay
    // gap, so a settle check that fires on one quiet block erases the delayed
    // signal before it is ever heard.
    // At t = 1 s a 0.5 Hz sweep parks the tap at its 8 ms ceiling — three full
    // 128-sample blocks of silence before the impulse re-emerges.
    const h = ir(new FlangerKernel({ rate: 0.5, depth: 1, feedback: 0, mix: 1 }, ctx), 1)
    let energyAfterGap = 0
    for (let i = 256; i < h.length; i++) energyAfterGap += Math.abs(h[i]!)
    // measured: 1.00 (the whole impulse), and 0.00 before this fix
    expect(energyAfterGap).toBeGreaterThan(0.5)
  })

  it('drains a resonant tail to exact 0 after the signal stops', () => {
    const n = 2 * SR
    const src = new Float32Array(n)
    for (let i = 0; i < 0.2 * SR; i++) src[i] = Math.sin((2 * Math.PI * 300 * i) / SR)
    const out = run(new FlangerKernel({ feedback: 0.95, mix: 1 }, ctx), src)
    expect(out[n - 1]!).toBe(0)
  })

  it('recovers within a round trip from a NaN on the input', () => {
    const k = new FlangerKernel({ feedback: 0.9, mix: 1 }, ctx)
    k.process(128, { in: new Float32Array(128).fill(NaN) }, new Float32Array(128), ctx)
    const zeros = new Float32Array(128)
    let clean = false
    for (let b = 0; b < 20 && !clean; b++) {
      const out = new Float32Array(128)
      k.process(128, { in: zeros }, out, ctx)
      clean = out.every((v) => Number.isFinite(v))
    }
    expect(clean).toBe(true)
  })

  it('is block-boundary continuous: one full block == many small blocks', () => {
    const src = noise(4096)
    const whole = run(new FlangerKernel({ feedback: 0.8 }, ctx), src, 4096)
    const split = run(new FlangerKernel({ feedback: 0.8 }, ctx), src, 37)
    for (let i = 0; i < src.length; i++) expect(split[i]!).toBe(whole[i]!)
  })

  it('reset() clears the delay line', () => {
    const k = new FlangerKernel({ feedback: 0.9, mix: 1 }, ctx)
    run(k, noise(4096), 128)
    k.reset()
    expect(run(k, new Float32Array(SR), 128).every((v) => v === 0)).toBe(true)
  })
})

describe('FlangerKernel at 44.1 kHz', () => {
  const SR44 = 44100
  const c44: DspContext = { sampleRate: SR44 }

  it('the 0.3 ms delay floor is in SECONDS: the notch stays at 1667 Hz', () => {
    // A 48k bake-in would delay 14 samples instead of 13 and move the notch to
    // ~1575 Hz.
    const h = ir(new FlangerKernel({ rate: 0.001, depth: 0, feedback: 0, mix: 0.5 }, c44), 0, 0.35, c44, SR44)
    // measured: notch at 1665 Hz, |H| = 0.003; |H| = 0.707 at 833 Hz
    expect(sweepH(h, 500, 3000, 5, SR44).fmin).toBeGreaterThan(1600)
    expect(sweepH(h, 500, 3000, 5, SR44).fmin).toBeLessThan(1730)
    expect(H(h, 833, SR44)).toBeGreaterThan(0.6)
  })

  it('the sweep rate is in Hz and the feedback resonance holds', () => {
    const cfg = { rate: 0.5, depth: 1, feedback: 0.7, mix: 0.5 }
    const a = ir(new FlangerKernel(cfg, c44), 1, 0.35, c44, SR44)
    const b = ir(new FlangerKernel(cfg, c44), 2, 0.35, c44, SR44)
    // measured: biggest per-frequency ratio 13.8x (16.6x at 48k)
    expect(biggestDiff(a, b, SR44)).toBeGreaterThan(6)
    const res = ir(new FlangerKernel({ rate: 0.001, depth: 0.5, feedback: 0.8, mix: 0.5 }, c44), 0, 0.35, c44, SR44)
    // measured: max |H| 2.765 (2.735 at 48k)
    expect(sweepH(res, 100, 10000, 25, SR44).max).toBeGreaterThan(2.5)
  })
})
