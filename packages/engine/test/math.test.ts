import { describe, it, expect } from 'vitest'
import {
  MulKernel,
  AddKernel,
  SubKernel,
  DivKernel,
  PowKernel,
  ClipKernel,
  FoldKernel,
  TanhKernel,
  MixKernel,
} from '../src/dsp/math'
import type { DspContext, Kernel } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }

/** Process a single sample with scalar inputs; returns the single output. */
const one = (k: Kernel, inputs: Record<string, number>): number => {
  const bufs: Record<string, Float32Array> = {}
  for (const key of Object.keys(inputs)) bufs[key] = new Float32Array([inputs[key]!])
  const out = new Float32Array(1)
  k.process(1, bufs, out, ctx)
  return out[0]!
}

// [description, kernel factory, scalar inputs, expected output]
// Expectations are exact in float32 unless noted; compared at ±1e-6.
const cases: [string, () => Kernel, Record<string, number>, number][] = [
  ['mul 3*4 = 12', () => new MulKernel(), { a: 3, b: 4 }, 12],
  ['mul -0.5*0.5 = -0.25', () => new MulKernel(), { a: -0.5, b: 0.5 }, -0.25],
  ['add 3+4 = 7', () => new AddKernel(), { a: 3, b: 4 }, 7],
  ['sub 3-4 = -1', () => new SubKernel(), { a: 3, b: 4 }, -1],
  ['div 1/4 = 0.25', () => new DivKernel(), { a: 1, b: 4 }, 0.25],
  ['div by 0 guards to 0', () => new DivKernel(), { a: 1, b: 0 }, 0],
  ['div by 1e-7 (< guard) is 0', () => new DivKernel(), { a: 1, b: 1e-7 }, 0],
  ['pow 2^3 = 8', () => new PowKernel(), { a: 2, b: 3 }, 8],
  ['pow preserves sign: (-0.5)^2 = -0.25', () => new PowKernel(), { a: -0.5, b: 2 }, -0.25],
  ['pow 0.25^0.5 = 0.5', () => new PowKernel(), { a: 0.25, b: 0.5 }, 0.5],
  // 0^-1 would be 0 * Infinity = NaN without the zero-base guard
  ['pow 0^-1 guards to 0', () => new PowKernel(), { a: 0, b: -1 }, 0],
  ['clip passes in-range', () => new ClipKernel(), { in: 0.3, lo: -1, hi: 1 }, 0.3],
  ['clip clamps high', () => new ClipKernel(), { in: 1.7, lo: -1, hi: 1 }, 1],
  ['clip clamps low', () => new ClipKernel(), { in: -1.7, lo: -1, hi: 1 }, -1],
  ['fold passes in-range', () => new FoldKernel(), { in: 0.3 }, 0.3],
  ['fold at boundary 1 stays 1', () => new FoldKernel(), { in: 1 }, 1],
  // 1.5 exceeds 1 by 0.5 -> reflects down to 0.5
  ['fold 1.5 = 0.5', () => new FoldKernel(), { in: 1.5 }, 0.5],
  // -2.7 exceeds -1 by 1.7 -> reflects up to -1 + 1.7 = 0.7
  ['fold -2.7 = 0.7', () => new FoldKernel(), { in: -2.7 }, 0.7],
  ['mix t=0 is all a', () => new MixKernel(), { a: 1, b: 3, t: 0 }, 1],
  ['mix t=1 is all b', () => new MixKernel(), { a: 1, b: 3, t: 1 }, 3],
  ['mix t=0.5 is midpoint', () => new MixKernel(), { a: 1, b: 3, t: 0.5 }, 2],
  ['mix t=0.25 leans toward a', () => new MixKernel(), { a: 1, b: 3, t: 0.25 }, 1.5],
  ['mix of bipolar signals', () => new MixKernel(), { a: -1, b: 1, t: 0.75 }, 0.5],
  ['tanh 0 = 0', () => new TanhKernel(), { in: 0 }, 0],
  ['tanh 10 ~ 1', () => new TanhKernel(), { in: 10 }, Math.tanh(10)],
  ['tanh -1 = -tanh 1', () => new TanhKernel(), { in: -1 }, Math.tanh(-1)],
]

describe('math kernels', () => {
  it.each(cases)('%s', (_desc, make, inputs, expected) => {
    expect(one(make(), inputs)).toBeCloseTo(expected, 6)
  })

  it('fold keeps large sweeps inside [-1, 1]', () => {
    const n = 1000
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = -10 + (20 * i) / (n - 1)
    const out = new Float32Array(n)
    new FoldKernel().process(n, { in: input }, out, ctx)
    for (let i = 0; i < n; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(-1)
      expect(out[i]!).toBeLessThanOrEqual(1)
    }
  })
})
