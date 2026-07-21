import { describe, it, expect } from 'vitest'
import { BitcrushKernel } from '../src/dsp/bitcrush'
import type { BitcrushConfig } from '../src/dsp/bitcrush'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }

const runCrush = (k: BitcrushKernel, input: Float32Array, block = input.length): Float32Array => {
  const n = input.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    k.process(m, { in: input.subarray(i, i + m) }, out.subarray(i, i + m), ctx)
  }
  return out
}

/** A ramp from -1 to +1 over n samples. */
const ramp = (n: number): Float32Array => {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = -1 + (2 * i) / (n - 1)
  return x
}

const cfg = (c: BitcrushConfig): BitcrushKernel => new BitcrushKernel(c, ctx)

describe('BitcrushKernel', () => {
  it('bits=2 quantizes a ramp to a handful of distinct levels', () => {
    const out = runCrush(cfg({ bits: 2 }), ramp(2000))
    const distinct = new Set(Array.from(out))
    // 2 bits -> round(x*2)/2 gives {-1,-0.5,0,0.5,1} over [-1,1]: <= 5 levels.
    expect(distinct.size).toBeLessThanOrEqual(5)
    expect(distinct.size).toBeGreaterThan(1)
  })

  it('downsample=4 holds each grabbed sample for 4-sample runs', () => {
    const out = runCrush(cfg({ bits: 16, downsample: 4 }), ramp(400), 400)
    // samples come in runs of 4 identical values starting at index 0
    for (let i = 0; i < 40; i++) {
      const base = i * 4
      expect(out[base + 1]!).toBe(out[base]!)
      expect(out[base + 2]!).toBe(out[base]!)
      expect(out[base + 3]!).toBe(out[base]!)
    }
    // and it actually moves between runs (not a constant)
    expect(out[4]!).not.toBe(out[0]!)
  })

  it('bits=16, downsample=1 is ~identity', () => {
    const src = ramp(1000)
    const out = runCrush(cfg({ bits: 16, downsample: 1 }), src)
    for (let i = 0; i < src.length; i++) {
      expect(Math.abs(out[i]! - src[i]!)).toBeLessThan(1e-4)
    }
  })

  it('is block-boundary continuous: two half-blocks == one full block', () => {
    const src = ramp(4096)
    const whole = runCrush(cfg({ bits: 5, downsample: 3 }), src)
    const split = runCrush(cfg({ bits: 5, downsample: 3 }), src, src.length / 2)
    for (let i = 0; i < src.length; i++) expect(split[i]!).toBe(whole[i]!)
  })

  it('reset() clears the hold state', () => {
    const k = cfg({ bits: 4, downsample: 8 })
    runCrush(k, ramp(1000), 128)
    k.reset()
    const out = runCrush(k, new Float32Array(64), 128)
    // silence in -> quantized 0 -> exactly 0 out
    for (let i = 0; i < out.length; i++) expect(out[i]!).toBe(0)
  })
})
