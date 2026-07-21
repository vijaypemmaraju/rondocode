import { describe, it, expect } from 'vitest'
import { ShapeKernel } from '../src/dsp/shape'
import type { ShapeType } from '../src/dsp/shape'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

const runShape = (
  k: ShapeKernel,
  input: Float32Array,
  drive: number,
  block = input.length,
): Float32Array => {
  const n = input.length
  const out = new Float32Array(n)
  const d = new Float32Array(n).fill(drive)
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    k.process(m, { in: input.subarray(i, i + m), drive: d.subarray(i, i + m) }, out.subarray(i, i + m), ctx)
  }
  return out
}

const sine = (n: number, freq: number, amp = 0.7): Float32Array => {
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

const TYPES: ShapeType[] = ['soft', 'hard', 'sine', 'tube']

describe('ShapeKernel', () => {
  it.each(TYPES)('type %s: more drive adds high-frequency harmonics', (type) => {
    const f0 = 200
    const src = sine(sr, f0)
    const low = runShape(new ShapeKernel(type), src, 1, 256)
    const high = runShape(new ShapeKernel(type), src, 8, 256)
    // the 3rd harmonic (present for every curve on a sine) grows with drive
    const h3low = goertzel(low, 3 * f0, sr)
    const h3high = goertzel(high, 3 * f0, sr)
    expect(h3high).toBeGreaterThan(h3low * 2)
  })

  it.each(TYPES)('type %s: output stays bounded ~[-1, 1.1]', (type) => {
    const src = sine(sr, 200, 1)
    const out = runShape(new ShapeKernel(type), src, 40, 256)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    expect(maxAbs(out)).toBeLessThanOrEqual(1.1)
  })

  it("type 'hard' clips to [-1, 1]", () => {
    const src = sine(sr, 200, 1)
    const out = runShape(new ShapeKernel('hard'), src, 10, 256)
    expect(maxAbs(out)).toBeLessThanOrEqual(1)
    // and it really is clipping: lots of samples pinned at the rails
    let pinned = 0
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]!) > 0.999) pinned++
    expect(pinned).toBeGreaterThan(out.length / 4)
  })

  it("type 'tube' is asymmetric (even harmonics: DC/2nd differ from a symmetric curve)", () => {
    const f0 = 200
    const src = sine(sr, f0)
    const tube = runShape(new ShapeKernel('tube'), src, 6, 256)
    const soft = runShape(new ShapeKernel('soft'), src, 6, 256)
    // an asymmetric curve produces 2nd-harmonic energy a symmetric one lacks
    expect(goertzel(tube, 2 * f0, sr)).toBeGreaterThan(goertzel(soft, 2 * f0, sr) * 4)
  })

  it('drive is clamped to >= 1 (drive 0 behaves as drive 1)', () => {
    const src = sine(1000, 200)
    const a = runShape(new ShapeKernel('soft'), src, 0, 256)
    const b = runShape(new ShapeKernel('soft'), src, 1, 256)
    for (let i = 0; i < src.length; i++) expect(a[i]!).toBe(b[i]!)
  })

  it('reset() is a no-op (stateless)', () => {
    const k = new ShapeKernel('soft')
    const src = sine(1000, 200)
    const before = runShape(k, src, 5, 256)
    k.reset()
    const after = runShape(k, src, 5, 256)
    for (let i = 0; i < src.length; i++) expect(after[i]!).toBe(before[i]!)
  })
})
