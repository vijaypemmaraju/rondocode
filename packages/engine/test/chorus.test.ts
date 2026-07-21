import { describe, it, expect } from 'vitest'
import { ChorusKernel } from '../src/dsp/chorus'
import type { ChorusConfig } from '../src/dsp/chorus'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

/** Run a chorus over `input` in `block`-sized chunks (chunking exercises the
 *  block-boundary state). Chorus takes only the 'in' port — rate/depth/mix are
 *  construction config, not per-sample inputs. */
const runChorus = (k: ChorusKernel, input: Float32Array, block = input.length): Float32Array => {
  const n = input.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    k.process(m, { in: input.subarray(i, i + m) }, out.subarray(i, i + m), ctx)
  }
  return out
}

const sine = (n: number, freq: number, amp = 0.5): Float32Array => {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
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

/** Coefficient of variation (std/mean) of the RMS measured over `win`-sample
 *  windows — a proxy for amplitude modulation. A steady tone is ~0; a chorused
 *  tone beats as the three detuned voices drift in and out of phase. */
const rmsCov = (out: Float32Array, win: number): number => {
  const rmss: number[] = []
  for (let i = 0; i + win <= out.length; i += win) {
    let s = 0
    for (let j = 0; j < win; j++) s += out[i + j]! * out[i + j]!
    rmss.push(Math.sqrt(s / win))
  }
  const mean = rmss.reduce((a, b) => a + b, 0) / rmss.length
  const varc = rmss.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rmss.length
  return Math.sqrt(varc) / mean
}

const cfg = (c: ChorusConfig): ChorusKernel => new ChorusKernel(c, ctx)

describe('ChorusKernel', () => {
  it('mix 0 passes the dry signal through bit-exactly', () => {
    const src = sine(sr, 300)
    const out = runChorus(cfg({ mix: 0 }), src, 128)
    for (let i = 0; i < src.length; i++) expect(out[i]!).toBe(src[i]!)
  })

  it('mix 1 on a steady tone thickens it (amplitude modulation appears)', () => {
    const src = sine(2 * sr, 300)
    const dry = rmsCov(src, Math.floor(0.02 * sr))
    const wet = runChorus(cfg({ mix: 1, rate: 0.8, depth: 0.004 }), src, 256)
    const wetCov = rmsCov(wet, Math.floor(0.02 * sr))
    // The dry tone has essentially constant windowed RMS; the chorus beats.
    expect(dry).toBeLessThan(0.01)
    expect(wetCov).toBeGreaterThan(0.05)
  })

  it('stays bounded and finite under a full-scale tone', () => {
    const src = sine(sr, 220, 1)
    const out = runChorus(cfg({ mix: 0.5 }), src, 256)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    // dry*(0.5) + wet*(0.5), wet is an average of bounded delayed taps => <= 1.
    expect(maxAbs(out)).toBeLessThan(1.1)
  })

  it('is block-boundary continuous: two half-blocks == one full block', () => {
    const src = sine(4096, 330, 0.7)
    const whole = runChorus(cfg({ mix: 0.5 }), src)
    const split = runChorus(cfg({ mix: 0.5 }), src, src.length / 2)
    for (let i = 0; i < src.length; i++) expect(split[i]!).toBe(whole[i]!)
  })

  it('output settles to exact 0 after the signal stops (no denormals)', () => {
    const n = 2 * sr
    const src = new Float32Array(n)
    // 0.1 s of tone then silence: no feedback path, so the delay line drains.
    for (let i = 0; i < 0.1 * sr; i++) src[i] = Math.sin((2 * Math.PI * 300 * i) / sr)
    const out = runChorus(cfg({ mix: 0.5 }), src, 128)
    expect(out[out.length - 1]!).toBe(0)
  })

  it('reset() clears the delay line and LFO phases', () => {
    const k = cfg({ mix: 1 })
    runChorus(k, sine(2000, 300), 128)
    k.reset()
    const out = runChorus(k, new Float32Array(sr), 128)
    expect(maxAbs(out)).toBe(0)
  })
})
