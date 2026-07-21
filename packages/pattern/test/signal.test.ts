import { describe, it, expect } from 'vitest'
import {
  F,
  Pattern,
  cosine,
  cosine2,
  irand,
  isaw,
  isaw2,
  perlin,
  rand,
  saw,
  saw2,
  signal,
  sine,
  sine2,
  square,
  square2,
  timeHash,
  tri,
  tri2,
} from '../src/index'
import { at, q, qw, span } from './helpers'

describe('signal plumbing', () => {
  it('is continuous: one hap per query, whole undefined, part = query span', () => {
    expect(qw(saw, 0.25, 1.5)).toEqual([{ whole: null, part: [0.25, 1.5], value: expect.any(Number) }])
  })

  it('samples at the MIDPOINT of the query part (Strudel convention)', () => {
    expect(at(saw, F(1, 2))).toBe(0.5) // zero-width: midpoint = the point
    expect(q(saw, 0, F(1, 2))).toEqual([[0, 0.5, 0.25]])
    expect(q(saw, F(1, 2), 1)).toEqual([[0.5, 1, 0.75]])
  })

  it('is queryable at zero-width spans', () => {
    const haps = sine.query(span(F(1, 4), F(1, 4)))
    expect(haps.length).toBe(1)
    expect(haps[0]!.whole).toBeUndefined()
    expect(haps[0]!.part.length.valueOf()).toBe(0)
    expect(haps[0]!.value).toBe(1)
  })

  it('signal() exposes the raw constructor', () => {
    const p = signal((t) => t.valueOf() * 2)
    expect(at(p, F(1, 4))).toBe(0.5)
  })
})

describe('waveforms', () => {
  it('saw ramps 0→1 each cycle; isaw is its mirror', () => {
    expect(at(saw, 0)).toBe(0)
    expect(at(saw, F(3, 4))).toBe(0.75)
    expect(at(saw, F(7, 4))).toBe(0.75) // periodic
    expect(at(isaw, F(1, 4))).toBe(0.75)
  })

  it('saw handles negative time via cycle position', () => {
    expect(at(saw, F(-3, 4))).toBe(0.25)
  })

  it('sine is unipolar [0,1] with peak at cycle position 1/4', () => {
    expect(at(sine, 0)).toBeCloseTo(0.5, 12)
    expect(at(sine, F(1, 4))).toBe(1)
    expect(at(sine, F(1, 2))).toBeCloseTo(0.5, 12)
    expect(at(sine, F(3, 4))).toBeCloseTo(0, 12)
  })

  it('cosine is sine shifted a quarter cycle', () => {
    expect(at(cosine, 0)).toBe(1)
    expect(at(cosine, F(1, 4))).toBeCloseTo(0.5, 12)
    expect(at(cosine, F(1, 2))).toBeCloseTo(0, 12)
  })

  it('tri rises 0→1 over the first half, falls 1→0 over the second', () => {
    expect(at(tri, 0)).toBe(0)
    expect(at(tri, F(1, 4))).toBe(0.5)
    expect(at(tri, F(1, 2))).toBe(1)
    expect(at(tri, F(3, 4))).toBe(0.5)
  })

  it('square is 0 for the first half of the cycle, 1 for the second (Strudel)', () => {
    expect(at(square, 0)).toBe(0)
    expect(at(square, F(1, 4))).toBe(0)
    expect(at(square, F(1, 2))).toBe(1)
    expect(at(square, F(3, 4))).toBe(1)
    // sampled over each half: midpoints 1/4 and 3/4
    expect(q(square, 0, F(1, 2))).toEqual([[0, 0.5, 0]])
    expect(q(square, F(1, 2), 1)).toEqual([[0.5, 1, 1]])
  })

  it('bipolar variants are 2v-1 of the unipolar ones', () => {
    expect(at(sine2, F(1, 4))).toBe(1)
    expect(at(sine2, F(3, 4))).toBeCloseTo(-1, 12)
    expect(at(cosine2, F(1, 2))).toBeCloseTo(-1, 12)
    expect(at(saw2, F(3, 4))).toBe(0.5)
    expect(at(isaw2, F(3, 4))).toBe(-0.5)
    expect(at(tri2, 0)).toBe(-1)
    expect(at(tri2, F(1, 2))).toBe(1)
    expect(at(square2, 0)).toBe(-1)
    expect(at(square2, F(3, 4))).toBe(1)
  })
})

describe('timeHash', () => {
  it('is pure and stable across calls', () => {
    expect(timeHash(F(1, 4), 0)).toBe(timeHash(F(1, 4), 0))
    expect(timeHash(F(17, 3), 42)).toBe(timeHash(F(17, 3), 42))
  })

  it('varies per position, per cycle, and per seed', () => {
    expect(timeHash(F(1, 4), 0)).not.toBe(timeHash(F(3, 4), 0))
    expect(timeHash(F(1, 4), 0)).not.toBe(timeHash(F(5, 4), 0))
    expect(timeHash(F(1, 4), 0)).not.toBe(timeHash(F(1, 4), 1))
  })

  it('stays in [0,1) with a roughly centered mean', () => {
    let sum = 0
    const n = 1000
    for (let i = 0; i < n; i++) {
      const v = timeHash(F(i, 16), 0)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      sum += v
    }
    expect(sum / n).toBeGreaterThan(0.4)
    expect(sum / n).toBeLessThan(0.6)
  })
})

describe('rand / irand / perlin', () => {
  it('rand is deterministic: identical queries give identical values', () => {
    expect(qw(rand, 0, 4)).toEqual(qw(rand, 0, 4))
    expect(at(rand, F(1, 3))).toBe(at(rand, F(1, 3)))
  })

  it('rand varies over time and stays in [0,1)', () => {
    const vals = Array.from({ length: 64 }, (_, i) => at(rand, F(i, 16)))
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(new Set(vals).size).toBeGreaterThan(48)
  })

  it('irand(n) yields integers in [0, n)', () => {
    const vals = Array.from({ length: 100 }, (_, i) => at(irand(8), F(i, 7)))
    for (const v of vals) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(8)
    }
    expect(new Set(vals).size).toBeGreaterThan(4)
  })

  it('irand rejects non-positive or fractional n', () => {
    expect(() => irand(0)).toThrow(RangeError)
    expect(() => irand(2.5)).toThrow(RangeError)
  })

  it('perlin is continuous: adjacent samples stay close', () => {
    let prev = at(perlin, 0)
    for (let k = 1; k <= 300; k++) {
      const v = at(perlin, F(k, 100))
      expect(Math.abs(v - prev)).toBeLessThan(0.05)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      prev = v
    }
  })

  it('perlin interpolates between integer-lattice values and is not constant', () => {
    // At integers the smoothstep weight is 0: value = the lattice hash.
    const v0 = at(perlin, 0)
    const v1 = at(perlin, 1)
    expect(v0).not.toBe(v1)
    // Halfway, the value is the average of the two lattice values.
    expect(at(perlin, F(1, 2))).toBeCloseTo((v0 + v1) / 2, 12)
  })
})

describe('signals compose with combinators (via package index wiring)', () => {
  it('saw.segment(4) is the 1/8 3/8 5/8 7/8 staircase', () => {
    expect(qw(saw.segment(4), 0, 1)).toEqual([
      { whole: [0, 0.25], part: [0, 0.25], value: 1 / 8 },
      { whole: [0.25, 0.5], part: [0.25, 0.5], value: 3 / 8 },
      { whole: [0.5, 0.75], part: [0.5, 0.75], value: 5 / 8 },
      { whole: [0.75, 1], part: [0.75, 1], value: 7 / 8 },
    ])
  })

  it('sine.segment(8).range(200, 2000) is an 8-step staircase of scaled midpoints', () => {
    const haps = qw(sine.segment(8).range(200, 2000), 0, 1)
    expect(haps.length).toBe(8)
    haps.forEach((h, k) => {
      expect(h.whole).toEqual([k / 8, (k + 1) / 8])
      const mid = (2 * k + 1) / 16
      const expected = 200 + 1800 * (0.5 + 0.5 * Math.sin(2 * Math.PI * mid))
      expect(h.value).toBeCloseTo(expected, 9)
    })
  })
})
