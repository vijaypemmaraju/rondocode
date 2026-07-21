import { describe, it, expect } from 'vitest'
import { LfoKernel, type LfoShape } from '../src/dsp/lfo'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

const run = (k: LfoKernel, freq: number, n: number): Float32Array => {
  const out = new Float32Array(n)
  k.process(n, { freq: new Float32Array(n).fill(freq) }, out, ctx)
  return out
}

const minMax = (out: Float32Array): [number, number] => {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < out.length; i++) {
    if (out[i]! < min) min = out[i]!
    if (out[i]! > max) max = out[i]!
  }
  return [min, max]
}

describe('LfoKernel', () => {
  const shapes: LfoShape[] = ['sine', 'tri', 'square', 'saw']

  it.each(shapes)('%s output stays in [0, 1]', (shape) => {
    // 2Hz over 1s = two full cycles, so every phase region is visited.
    const [min, max] = minMax(run(new LfoKernel(shape), 2, sr))
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(1)
  })

  it('sine at 2Hz peaks near 1 and troughs near 0', () => {
    const [min, max] = minMax(run(new LfoKernel('sine'), 2, sr))
    expect(max).toBeGreaterThan(0.999)
    expect(min).toBeLessThan(0.001)
  })

  it('tri mean is ~0.5 over whole cycles', () => {
    const out = run(new LfoKernel('tri'), 2, sr) // exactly 2 cycles
    let sum = 0
    for (let i = 0; i < out.length; i++) sum += out[i]!
    expect(sum / out.length).toBeGreaterThan(0.49)
    expect(sum / out.length).toBeLessThan(0.51)
  })

  it('square has 50% duty cycle', () => {
    const out = run(new LfoKernel('square'), 2, sr) // exactly 2 cycles
    let high = 0
    for (let i = 0; i < out.length; i++) if (out[i]! === 1) high++
    expect(high / out.length).toBeGreaterThan(0.49)
    expect(high / out.length).toBeLessThan(0.51)
  })

  it('square edge spacing matches the requested frequency', () => {
    const out = run(new LfoKernel('square'), 2, 2 * sr) // 4 cycles
    const edges: number[] = []
    for (let i = 1; i < out.length; i++) {
      if (out[i - 1]! === 0 && out[i]! === 1) edges.push(i) // rising = phase wrap
    }
    expect(edges.length).toBe(3) // wraps at 0.5s, 1.0s, 1.5s (starts high at t=0)
    for (let i = 1; i < edges.length; i++) {
      expect(Math.abs(edges[i]! - edges[i - 1]! - sr / 2)).toBeLessThanOrEqual(1)
    }
  })

  it('recovers from NaN freq within a block', () => {
    const k = new LfoKernel('sine')
    run(k, NaN, 512) // poison the phase for one block
    const out = run(k, 2, 512) // clean input: sane again from the next block
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true)
      expect(out[i]!).toBeGreaterThanOrEqual(0)
      expect(out[i]!).toBeLessThanOrEqual(1)
    }
  })

  it('reset() restarts the phase', () => {
    const k = new LfoKernel('saw')
    const a = run(k, 3, 1000)
    k.reset()
    const b = run(k, 3, 1000)
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})

describe('LfoKernel sample-and-hold (rand)', () => {
  /** Distinct held levels and the sample indices where the value changes. */
  const steps = (out: Float32Array): { levels: number[]; changes: number[] } => {
    const levels: number[] = [out[0]!]
    const changes: number[] = []
    for (let i = 1; i < out.length; i++) {
      if (out[i]! !== out[i - 1]!) {
        levels.push(out[i]!)
        changes.push(i)
      }
    }
    return { levels, changes }
  }

  it('stays in [0, 1]', () => {
    const [min, max] = minMax(run(new LfoKernel('rand'), 4, sr))
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(1)
  })

  it('holds ~4 distinct stepped levels over 1s at 4Hz, changing at wraps', () => {
    const out = run(new LfoKernel('rand'), 4, sr) // 4 cycles => 4 wraps in 1s
    const { levels, changes } = steps(out)
    // one initial level plus a new one at each of the (up to) 4 wraps
    expect(levels.length).toBeGreaterThanOrEqual(4)
    expect(levels.length).toBeLessThanOrEqual(5)
    // changes land on the cycle wraps at t = k/4 s (± a sample of phase drift)
    for (let c = 0; c < changes.length; c++) {
      const expected = ((c + 1) * sr) / 4
      expect(Math.abs(changes[c]! - expected)).toBeLessThanOrEqual(1)
    }
  })

  it('is constant within each step', () => {
    const out = run(new LfoKernel('rand'), 4, sr)
    // between consecutive wraps the value must not move at all
    const wraps = [0, sr / 4, sr / 2, (3 * sr) / 4]
    for (let w = 0; w < wraps.length; w++) {
      const lo = wraps[w]! + 2 // skip the exact boundary sample
      const hi = (wraps[w + 1] ?? sr) - 2
      for (let i = lo + 1; i < hi; i++) expect(out[i]).toBe(out[lo]!)
    }
  })

  it('is deterministic across two fresh kernels of the same seed', () => {
    const a = run(new LfoKernel('rand', 999), sr, sr)
    const b = run(new LfoKernel('rand', 999), sr, sr)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('reset() replays the same stepped sequence', () => {
    const k = new LfoKernel('rand', 4242)
    const a = run(k, 4, sr)
    k.reset()
    const b = run(k, 4, sr)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('differs from a saw ramp of the same frequency', () => {
    const r = run(new LfoKernel('rand'), 4, sr)
    const s = run(new LfoKernel('saw'), 4, sr)
    expect(Array.from(r)).not.toEqual(Array.from(s))
  })
})
