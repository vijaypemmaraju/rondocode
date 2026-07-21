import { describe, it, expect } from 'vitest'
import { ReverbKernel } from '../src/dsp/reverb'
import { NoiseKernel } from '../src/dsp/osc'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

/** Run a reverb over `input` in `block`-sized chunks (chunking matters for the
 *  block-end denormal/NaN flush tests). Reverb takes only the 'in' port —
 *  roomSize/damp are construction config, not per-sample inputs (v1). */
const runReverb = (
  k: ReverbKernel,
  input: Float32Array,
  block = input.length,
): Float32Array => {
  const n = input.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    k.process(m, { in: input.subarray(i, i + m) }, out.subarray(i, i + m), ctx)
  }
  return out
}

const impulse = (n: number): Float32Array => {
  const x = new Float32Array(n)
  x[0] = 1
  return x
}

const noise = (n: number, seed = 1234): Float32Array => {
  const out = new Float32Array(n)
  new NoiseKernel(seed).process(n, {}, out, ctx)
  return out
}

const maxAbs = (out: Float32Array): number => {
  let peak = 0
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]!)
    if (a > peak) peak = a
  }
  return peak
}

/** RMS over the sample window [aSec, bSec). */
const rms = (out: Float32Array, aSec: number, bSec: number): number => {
  const a = Math.floor(aSec * sr)
  const b = Math.floor(bSec * sr)
  let s = 0
  for (let i = a; i < b; i++) s += out[i]! * out[i]!
  return Math.sqrt(s / (b - a))
}

describe('ReverbKernel', () => {
  it('an impulse builds a tail that persists, then decays, and stays bounded', () => {
    const out = runReverb(new ReverbKernel(), impulse(2 * sr))
    // (a) a real tail exists well after the impulse
    expect(rms(out, 0.5, 1)).toBeGreaterThan(1e-4)
    // (b) it decays: the late window is quieter than the early tail
    expect(rms(out, 1.5, 2)).toBeLessThan(rms(out, 0.2, 0.5))
    // (c) bounded, no NaN
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    expect(maxAbs(out)).toBeLessThan(2)
  })

  it('a larger roomSize gives a longer tail', () => {
    const big = runReverb(new ReverbKernel({ roomSize: 0.9 }), impulse(2 * sr))
    const small = runReverb(new ReverbKernel({ roomSize: 0.4 }), impulse(2 * sr))
    // late-window energy is higher when the room is bigger
    expect(rms(big, 1.2, 1.8)).toBeGreaterThan(rms(small, 1.2, 1.8))
  })

  it('higher damp removes high-frequency energy from the tail', () => {
    // Feed broadband noise so every band is excited, then compare 8 kHz energy
    // in the tail. damp lowpasses the comb feedback, so the bright reverb
    // (damp 0.1) must retain more 8 kHz than the dark one (damp 0.9).
    const src = noise(sr)
    const bright = runReverb(new ReverbKernel({ damp: 0.1 }), src)
    const dark = runReverb(new ReverbKernel({ damp: 0.9 }), src)
    const win = (o: Float32Array): Float32Array =>
      o.subarray(Math.floor(0.3 * sr), Math.floor(0.9 * sr))
    const hfBright = goertzel(win(bright), 8000, sr)
    const hfDark = goertzel(win(dark), 8000, sr)
    // Empirically hfBright is many times hfDark; a 2x margin is comfortable.
    expect(hfBright).toBeGreaterThan(hfDark * 2)
  })

  it('the tail settles to exact 0 after the impulse (block-end flush)', () => {
    // 1 impulse then long silence: flush() must scrub the sub-denormal tail to
    // exact zero, not leave it decaying forever.
    const out = runReverb(new ReverbKernel(), impulse(2 * sr), 128)
    // well after 1 s of silence the output is bit-exactly 0
    expect(out[out.length - 1]!).toBe(0)
  })

  it('is block-boundary continuous: two half-blocks == one full block', () => {
    const src = noise(4096)
    const whole = runReverb(new ReverbKernel(), src)
    const split = runReverb(new ReverbKernel(), src, src.length / 2)
    for (let i = 0; i < src.length; i++) expect(split[i]!).toBe(whole[i]!)
  })

  it('stays finite and bounded under 1 s of full-scale noise at roomSize 0.98', () => {
    const src = noise(sr, 7)
    const out = runReverb(new ReverbKernel({ roomSize: 0.98 }), src, 256)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    expect(maxAbs(out)).toBeLessThan(4)
  })

  it('reset() clears all buffers', () => {
    const k = new ReverbKernel()
    runReverb(k, impulse(sr), 128)
    k.reset()
    const out = runReverb(k, new Float32Array(sr), 128)
    expect(maxAbs(out)).toBe(0)
  })
})
