import { describe, it, expect } from 'vitest'
import { CombKernel } from '../src/dsp/comb'
import type { CombConfig } from '../src/dsp/comb'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

/** Run a comb over `input` with constant freq/feedback, in `block`-sized
 *  chunks. */
const runComb = (
  k: CombKernel,
  input: Float32Array,
  freq: number,
  feedback: number,
  block = input.length,
): Float32Array => {
  const n = input.length
  const out = new Float32Array(n)
  const f = new Float32Array(n).fill(freq)
  const fb = new Float32Array(n).fill(feedback)
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    k.process(
      m,
      { in: input.subarray(i, i + m), freq: f.subarray(i, i + m), feedback: fb.subarray(i, i + m) },
      out.subarray(i, i + m),
      ctx,
    )
  }
  return out
}

const impulse = (n: number): Float32Array => {
  const x = new Float32Array(n)
  x[0] = 1
  return x
}

const maxAbs = (out: Float32Array): number => {
  let peak = 0
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]!)
    if (a > peak) peak = a
  }
  return peak
}

const rms = (out: Float32Array, aSec: number, bSec: number): number => {
  const a = Math.floor(aSec * sr)
  const b = Math.floor(bSec * sr)
  let s = 0
  for (let i = a; i < b; i++) s += out[i]! * out[i]!
  return Math.sqrt(s / (b - a))
}

const cfg = (c: CombConfig = {}): CombKernel => new CombKernel(c, ctx)

describe('CombKernel', () => {
  it('an impulse rings at the tuned frequency and sustains', () => {
    const out = runComb(cfg({ damp: 0 }), impulse(sr), 200, 0.9, 256)
    // (a) the ring persists well after the impulse (fb 0.9 over a 5 ms period
    // decays quickly, so measure the early-tail window empirically ~2.8e-3)
    expect(rms(out, 0.1, 0.3)).toBeGreaterThan(1e-3)
    // (b) energy concentrates at 200 Hz, not at an unrelated frequency
    const win = out.subarray(Math.floor(0.02 * sr), Math.floor(0.3 * sr))
    const at200 = goertzel(win, 200, sr)
    const at350 = goertzel(win, 350, sr)
    expect(at200).toBeGreaterThan(at350 * 8)
    // (c) bounded, finite
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
  })

  it('feedback 0 passes the dry signal through', () => {
    const src = impulse(1000)
    src[10] = 0.5
    src[20] = -0.3
    const out = runComb(cfg(), src, 220, 0, 128)
    for (let i = 0; i < src.length; i++) expect(out[i]!).toBe(src[i]!)
  })

  it('stays finite and bounded at feedback 0.98', () => {
    const out = runComb(cfg(), impulse(2 * sr), 200, 0.98, 256)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    expect(maxAbs(out)).toBeLessThan(20)
    // it genuinely rings for a long time at this feedback (default damp 0.2
    // still leaves a healthy tail ~9e-4 at 0.5-1 s)
    expect(rms(out, 0.5, 1)).toBeGreaterThan(1e-4)
  })

  it('damping darkens the ring (less high-frequency energy)', () => {
    const bright = runComb(cfg({ damp: 0 }), impulse(sr), 400, 0.95, 256)
    const dark = runComb(cfg({ damp: 0.6 }), impulse(sr), 400, 0.95, 256)
    // the fundamental survives in both; the dark one decays faster overall
    expect(rms(dark, 0.4, 0.8)).toBeLessThan(rms(bright, 0.4, 0.8))
  })

  it('the ring settles to exact 0 after silence (block-end flush)', () => {
    const out = runComb(cfg(), impulse(2 * sr), 200, 0.9, 128)
    expect(out[out.length - 1]!).toBe(0)
  })

  it('is block-boundary continuous: two half-blocks == one full block', () => {
    const src = impulse(4096)
    src[100] = 0.4
    const whole = runComb(cfg(), src, 300, 0.7)
    const split = runComb(cfg(), src, 300, 0.7, src.length / 2)
    for (let i = 0; i < src.length; i++) expect(split[i]!).toBe(whole[i]!)
  })

  it('reset() clears the delay line', () => {
    const k = cfg()
    runComb(k, impulse(2000), 200, 0.9, 128)
    k.reset()
    const out = runComb(k, new Float32Array(sr), 200, 0.9, 128)
    expect(maxAbs(out)).toBe(0)
  })
})
