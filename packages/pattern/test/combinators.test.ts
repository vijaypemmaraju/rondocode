import { describe, it, expect } from 'vitest'
import { F, Pattern, saw, note, n, hasOnset, TimeSpan } from '../src/index'
import type { Hap } from '../src/index'
import { q, qw, sortHaps, span } from './helpers'

const { pure, fastcat, cat } = Pattern

const ab = fastcat(pure('a'), pure('b'))
const abc = fastcat(pure('a'), pure('b'), pure('c'))
const abcd = fastcat(pure('a'), pure('b'), pure('c'), pure('d'))

/** part.begin values of the onsets in [b, e). */
const onsets = <T>(p: Pattern<T>, b: number, e: number): number[] =>
  sortHaps(p.onsetsOnly().query(span(b, e))).map((h) => h.part.begin.valueOf())

describe('every / whenCycle', () => {
  it('every(2, fast(2)): cycle 0 transformed (cycle mod n == 0), cycle 1 not', () => {
    const p = ab.every(2, (x) => x.fast(2))
    expect(q(p, 0, 2)).toEqual([
      [0, 0.25, 'a'],
      [0.25, 0.5, 'b'],
      [0.5, 0.75, 'a'],
      [0.75, 1, 'b'],
      [1, 1.5, 'a'],
      [1.5, 2, 'b'],
    ])
  })

  it('every(3, rev) hits cycles 0, 3, ... only', () => {
    const p = abc.every(3, (x) => x.rev())
    expect(q(p, 0, 1)).toEqual(q(abc.rev(), 0, 1))
    expect(q(p, 1, 2)).toEqual(q(abc, 1, 2))
    expect(q(p, 2, 3)).toEqual(q(abc, 2, 3))
    expect(q(p, 3, 4)).toEqual(q(abc.rev(), 3, 4))
  })

  it('uses Euclidean cycle indexing before cycle zero', () => {
    const p = ab.every(2, (x) => x.fast(2))
    expect(q(p, -2, -1)).toEqual([
      [-2, -1.75, 'a'],
      [-1.75, -1.5, 'b'],
      [-1.5, -1.25, 'a'],
      [-1.25, -1, 'b'],
    ])
    expect(q(p, -1, 0)).toEqual(q(ab, -1, 0))
  })

  it('every(1, f) applies always; every(0, f) and negative n are identity', () => {
    expect(q(ab.every(1, (x) => x.rev()), 0, 2)).toEqual(q(ab.rev(), 0, 2))
    expect(q(ab.every(0, (x) => x.rev()), 0, 2)).toEqual(q(ab, 0, 2))
    expect(q(ab.every(-3, (x) => x.rev()), 0, 2)).toEqual(q(ab, 0, 2))
    expect(() => ab.every(1.5, (x) => x)).toThrow(TypeError)
  })

  it('whenCycle generalizes: apply on cycles where test(cycle) holds', () => {
    const p = ab.whenCycle((c) => c % 3 === 1, (x) => x.rev())
    expect(q(p, 0, 1)).toEqual(q(ab, 0, 1))
    expect(q(p, 1, 2)).toEqual(q(ab.rev(), 1, 2))
    expect(q(p, 2, 3)).toEqual(q(ab, 2, 3))
  })
})

describe('iter / iterBack', () => {
  it('iter(4) rotates one step earlier each cycle: cycle 1 starts at b', () => {
    const p = abcd.iter(4)
    expect(q(p, 0, 1).map((h) => h[2])).toEqual(['a', 'b', 'c', 'd'])
    expect(q(p, 1, 2).map((h) => h[2])).toEqual(['b', 'c', 'd', 'a'])
    expect(q(p, 2, 3).map((h) => h[2])).toEqual(['c', 'd', 'a', 'b'])
    expect(q(p, 3, 4).map((h) => h[2])).toEqual(['d', 'a', 'b', 'c'])
    expect(q(p, 4, 5).map((h) => h[2])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('iterBack(4) rotates the other way: cycle 1 starts at d', () => {
    const p = abcd.iterBack(4)
    expect(q(p, 0, 1).map((h) => h[2])).toEqual(['a', 'b', 'c', 'd'])
    expect(q(p, 1, 2).map((h) => h[2])).toEqual(['d', 'a', 'b', 'c'])
    expect(q(p, 2, 3).map((h) => h[2])).toEqual(['c', 'd', 'a', 'b'])
  })

  it('iter keeps event spans on the grid', () => {
    expect(q(abcd.iter(4), 1, 2)).toEqual([
      [1, 1.25, 'b'],
      [1.25, 1.5, 'c'],
      [1.5, 1.75, 'd'],
      [1.75, 2, 'a'],
    ])
  })

  it('iter(1) and iter(0) are identity; non-integers throw', () => {
    expect(q(abcd.iter(1), 0, 2)).toEqual(q(abcd, 0, 2))
    expect(q(abcd.iter(0), 0, 2)).toEqual(q(abcd, 0, 2))
    expect(() => abcd.iter(2.5)).toThrow(TypeError)
  })
})

describe('off / superimpose / palindrome', () => {
  it('off(t, f) stacks the original with a shifted, transformed copy', () => {
    const p = pure(7).off(F(1, 4), (x) => x.add(5))
    expect(qw(p, 0, 1)).toEqual([
      { whole: [-0.75, 0.25], part: [0, 0.25], value: 12 },
      { whole: [0, 1], part: [0, 1], value: 7 },
      { whole: [0.25, 1.25], part: [0.25, 1], value: 12 },
    ])
  })

  it('superimpose stacks the original with f applied in place', () => {
    expect(q(ab.superimpose((x) => x.rev()), 0, 1)).toEqual([
      [0, 0.5, 'a'],
      [0, 0.5, 'b'],
      [0.5, 1, 'a'],
      [0.5, 1, 'b'],
    ])
  })

  it('palindrome alternates forward and reversed cycles', () => {
    const p = abc.palindrome()
    expect(q(p, 0, 1).map((h) => h[2])).toEqual(['a', 'b', 'c'])
    expect(q(p, 1, 2).map((h) => h[2])).toEqual(['c', 'b', 'a'])
    expect(q(p, 2, 3).map((h) => h[2])).toEqual(['a', 'b', 'c'])
  })
})

describe('arithmetic (Pattern<number>)', () => {
  it('add/sub/mul/div with bare numbers', () => {
    expect(q(pure(3).add(2), 0, 1)).toEqual([[0, 1, 5]])
    expect(q(pure(10).sub(4), 0, 1)).toEqual([[0, 1, 6]])
    expect(q(pure(3).mul(4), 0, 1)).toEqual([[0, 1, 12]])
    expect(q(pure(8).div(2), 0, 1)).toEqual([[0, 1, 4]])
  })

  it('pattern operands combine via appLeft: structure from the left', () => {
    expect(qw(pure(10).add(fastcat(1, 2)), 0, 1)).toEqual([
      { whole: [0, 1], part: [0, 0.5], value: 11 },
      { whole: [0, 1], part: [0.5, 1], value: 12 },
    ])
    expect(q(fastcat(3, 5).mul(pure(2)), 0, 1)).toEqual([
      [0, 0.5, 6],
      [0.5, 1, 10],
    ])
  })

  it('transposes note()/n() control patterns on the pitch field, keeping loc + controls', () => {
    // note('c e g') = [60,64,67]; .add(-2) shifts every note down 2 semitones,
    // leaves the loc intact (so editor flashing still resolves), and touches
    // nothing else on the control map.
    const shifted = note('c e g').add(-2).query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(shifted.map((h) => (h.value as { note: number }).note)).toEqual([58, 62, 65])
    expect((shifted[0]!.value as { loc?: unknown }).loc).toBeDefined()
    // n() degrees shift too
    const deg = n('0 3 5').add(2).query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(deg.map((h) => (h.value as { n: number }).n)).toEqual([2, 5, 7])
    // sub transposes down; sub(12) is an octave
    const oct = note('c e g').sub(12).query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(oct.map((h) => (h.value as { note: number }).note)).toEqual([48, 52, 55])
  })

  it('add/sub RESPECT THE SCALE: after .scale(), they move in scale steps', () => {
    // a major degrees 0,3,5 = A3,D4,F#4 = [57,62,66]. .add(2) moves TWO SCALE
    // STEPS (not 2 semitones): degrees 2,5,7 = C#4,F#4,A4 = [61,66,69].
    const up = n('0 3 5').scale('a major').add(2).query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(up.map((h) => (h.value as { note: number }).note)).toEqual([61, 66, 69])
    expect(up.map((h) => (h.value as { n: number }).n)).toEqual([2, 5, 7]) // degree tracked too
    // down a scale step stays in key: degree 2 (C#4=61) → degree 1 (B3=59)
    const down = n('2').scale('a major').sub(1).query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect((down[0]!.value as { note: number }).note).toBe(59)
  })

  it('add/sub after .scale() PRESERVE a prior .octave()/.invert()/.voicing()', () => {
    // regression: the scale re-resolution used to recompute note from the degree
    // alone, silently discarding octave/invert/voicing. The note OFFSET must ride.
    const notes = (p: Pattern<unknown>) =>
      p.query(new TimeSpan(F(0), F(1))).filter(hasOnset).map((h) => (h.value as { note: number }).note)
    // c major 0,1,2 = 60,62,64; .octave(1) = 72,74,76; then .add(1) scale-step up
    // must keep the octave: degrees 1,2,3 = 62,64,65, +12 = 74,76,77.
    expect(notes(n('0 1 2').scale('c major').octave(1).add(1))).toEqual([74, 76, 77])
    // .add(0) must be a no-op, not a reset of the octave
    expect(notes(n('0 1 2').scale('c major').octave(1).add(0))).toEqual([72, 74, 76])
    // invert offset preserved too
    expect(notes(n('0 2 4').scale('c major').invert(1).add(0))).toEqual([72, 76, 79])
  })

  it('octave/invert on an UNSCALED n() is a no-op, not a degree collapse', () => {
    // regression: revoice read only .note (absent on unscaled degrees) so every
    // degree sorted as 0 and became pitch 12. Now such events pass through.
    const hs = n('0 3 5').octave(1).query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(hs.map((h) => (h.value as { n: number }).n)).toEqual([0, 3, 5]) // degrees intact
    expect(hs.every((h) => (h.value as { note?: number }).note === undefined)).toBe(true) // no bogus note
    // scaling afterwards still resolves correctly (c major 0,3,5 = 60,65,69)
    const scaled = n('0 3 5').octave(1).scale('c major').query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(scaled.map((h) => (h.value as { note: number }).note)).toEqual([60, 65, 69])
  })

  it('range/rangex do NOT destroy control-map patterns (no NaN, loc kept)', () => {
    // regression: range used `v*(hi-lo)+lo` on the raw value → object*number = NaN,
    // wiping note + loc. It must map the pitch field and keep loc for highlighting.
    const hs = note('c e g').range(0, 12).query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    for (const h of hs) {
      expect(Number.isNaN((h.value as { note: number }).note)).toBe(false)
      expect((h.value as { loc?: unknown }).loc).toBeDefined()
    }
    // and it stays a pass-through / correct mapping on plain numeric signals
    expect(saw.range(0, 10).segment(2).query(new TimeSpan(F(0), F(1))).filter(hasOnset).length).toBeGreaterThan(0)
  })

  it('range maps unipolar [0,1] to [lo,hi]; rangex is exponential', () => {
    expect(q(pure(0.5).range(0, 10), 0, 1)).toEqual([[0, 1, 5]])
    expect(q(pure(0).range(200, 2000), 0, 1)).toEqual([[0, 1, 200]])
    expect(q(pure(1).range(200, 2000), 0, 1)).toEqual([[0, 1, 2000]])
    const [[, , v]] = q(pure(0.5).rangex(20, 20000), 0, 1) as [[number, number, number]]
    expect(v).toBeCloseTo(Math.sqrt(20 * 20000), 9) // geometric midpoint
  })

  it('rangex rejects non-positive bounds', () => {
    expect(() => pure(0.5).rangex(0, 100)).toThrow(RangeError)
    expect(() => pure(0.5).rangex(-1, 100)).toThrow(RangeError)
    expect(() => pure(0.5).rangex(100, 0)).toThrow(RangeError)
  })
})

describe('struct / euclid', () => {
  it('struct takes structure from the boolean pattern, values from this', () => {
    const p = pure('x').struct(fastcat(true, false, true, true))
    expect(qw(p, 0, 1)).toEqual([
      { whole: [0, 0.25], part: [0, 0.25], value: 'x' },
      { whole: [0.5, 0.75], part: [0.5, 0.75], value: 'x' },
      { whole: [0.75, 1], part: [0.75, 1], value: 'x' },
    ])
  })

  it('euclid(3,8): onsets at 0, 3/8, 6/8', () => {
    expect(onsets(pure('x').euclid(3, 8), 0, 1)).toEqual([0, 3 / 8, 6 / 8])
  })

  it('euclid(5,8): x.xx.xx.', () => {
    expect(onsets(pure('x').euclid(5, 8), 0, 1)).toEqual(
      [0, 2, 3, 5, 6].map((k) => k / 8),
    )
  })

  it('euclid(3,8,2): rotated left by two steps', () => {
    expect(onsets(pure('x').euclid(3, 8, 2), 0, 1)).toEqual([1 / 8, 4 / 8, 6 / 8])
  })

  it('euclid(7,12): x.xx.x.xx.x.', () => {
    expect(onsets(pure('x').euclid(7, 12), 0, 1)).toEqual(
      [0, 2, 3, 5, 7, 8, 10].map((k) => k / 12),
    )
  })

  it('euclidInv plays the offbeats', () => {
    expect(onsets(pure('x').euclidInv(3, 8), 0, 1)).toEqual(
      [1, 2, 4, 5, 7].map((k) => k / 8),
    )
  })

  it('euclid events carry step-sized wholes', () => {
    expect(qw(pure('x').euclid(3, 8), 0, F(1, 4))).toEqual([
      { whole: [0, 1 / 8], part: [0, 1 / 8], value: 'x' },
    ])
  })
})

describe('degradeBy / undegradeBy', () => {
  const p400 = pure('x').fast(4) // 400 events over 100 cycles

  it('is deterministic: identical queries across runs', () => {
    const a = qw(p400.degradeBy(0.5), 0, 100)
    const b = qw(p400.degradeBy(0.5), 0, 100)
    expect(a).toEqual(b)
  })

  it('different seeds keep different subsets', () => {
    const a = qw(p400.degradeBy(0.5, 0), 0, 100)
    const b = qw(p400.degradeBy(0.5, 1), 0, 100)
    expect(a).not.toEqual(b)
  })

  it('degradeBy(0) keeps everything, degradeBy(1) nothing', () => {
    expect(p400.degradeBy(0).query(span(0, 100)).length).toBe(400)
    expect(p400.degradeBy(1).query(span(0, 100)).length).toBe(0)
    expect(p400.undegradeBy(1).query(span(0, 100)).length).toBe(400)
    expect(p400.undegradeBy(0).query(span(0, 100)).length).toBe(0)
  })

  it('degradeBy(0.5) drops roughly half (40-60% over 400 events)', () => {
    const kept = p400.degradeBy(0.5).query(span(0, 100)).length
    expect(kept).toBeGreaterThanOrEqual(160) // actual: 195
    expect(kept).toBeLessThanOrEqual(240)
  })

  it('degradeBy and undegradeBy partition exactly (same seed)', () => {
    const kept = p400.degradeBy(0.3, 7).query(span(0, 100))
    const dropped = p400.undegradeBy(0.3, 7).query(span(0, 100))
    expect(kept.length + dropped.length).toBe(400)
    const begins = (hs: Hap<string>[]) => hs.map((h) => h.part.begin.toString())
    const union = new Set([...begins(kept), ...begins(dropped)])
    expect(union.size).toBe(400)
  })

  it('degrade() is degradeBy(0.5)', () => {
    expect(qw(p400.degrade(), 0, 20)).toEqual(qw(p400.degradeBy(0.5), 0, 20))
  })
})

describe('sometimesBy family', () => {
  it('sometimes(id) ≡ original: exact partition, no double or missing events', () => {
    const p = abcd.fast(3)
    expect(qw(p.sometimes((x) => x), 0, 10)).toEqual(qw(p, 0, 10))
  })

  it('sometimesBy(0.3, add(12)): same hap count, values partition 7|19', () => {
    const p = pure(7).fast(4)
    const haps = p.sometimesBy(0.3, (x) => x.add(12)).query(span(0, 25))
    expect(haps.length).toBe(100)
    const transformed = haps.filter((h) => h.value === 19).length
    const untouched = haps.filter((h) => h.value === 7).length
    expect(transformed + untouched).toBe(100)
    expect(transformed).toBeGreaterThanOrEqual(15) // ~30 of 100
    expect(transformed).toBeLessThanOrEqual(45)
    // union of times is exactly the original grid
    const times = new Set(haps.map((h) => h.part.begin.toString()))
    expect(times.size).toBe(100)
  })

  it('always applies f everywhere, never nowhere', () => {
    expect(q(ab.always((x) => x.rev()), 0, 1)).toEqual(q(ab.rev(), 0, 1))
    expect(q(ab.never((x) => x.rev()), 0, 1)).toEqual(q(ab, 0, 1))
  })

  it('often/rarely lean towards/away from f', () => {
    const p = pure(7).fast(4)
    const count = (pat: Pattern<number>) =>
      pat.query(span(0, 50)).filter((h) => h.value === 19).length
    const o = count(p.often((x) => x.add(12)))
    const r = count(p.rarely((x) => x.add(12)))
    expect(o).toBeGreaterThan(100) // ~150 of 200
    expect(r).toBeLessThan(100) // ~50 of 200
  })
})

describe('ply / segment', () => {
  it('ply(2) on fastcat(a,b): 4 events, each event repeated within its span', () => {
    expect(qw(ab.ply(2), 0, 1)).toEqual([
      { whole: [0, 0.25], part: [0, 0.25], value: 'a' },
      { whole: [0.25, 0.5], part: [0.25, 0.5], value: 'a' },
      { whole: [0.5, 0.75], part: [0.5, 0.75], value: 'b' },
      { whole: [0.75, 1], part: [0.75, 1], value: 'b' },
    ])
  })

  it('ply(3) on pure subdivides the cycle in three', () => {
    expect(q(pure('x').ply(3), 0, 1)).toEqual([
      [0, 1 / 3, 'x'],
      [1 / 3, 2 / 3, 'x'],
      [2 / 3, 1, 'x'],
    ])
  })

  it('ply clips parts on partial queries and keeps sub-wholes', () => {
    expect(qw(ab.ply(2), F(1, 8), F(3, 8))).toEqual([
      { whole: [0, 0.25], part: [1 / 8, 1 / 4], value: 'a' },
      { whole: [0.25, 0.5], part: [1 / 4, 3 / 8], value: 'a' },
    ])
  })

  it('ply point query lands in exactly one subdivision', () => {
    expect(qw(pure('x').ply(2), F(1, 2), F(1, 2))).toEqual([
      { whole: [0.5, 1], part: [0.5, 0.5], value: 'x' },
    ])
  })

  it('ply(1) is identity; invalid counts throw', () => {
    expect(qw(ab.ply(1), 0, 1)).toEqual(qw(ab, 0, 1))
    expect(() => ab.ply(0)).toThrow(RangeError)
    expect(() => ab.ply(-2)).toThrow(RangeError)
    expect(() => ab.ply(1.5)).toThrow(RangeError)
  })

  it('segment(4) on saw samples the step midpoints (see signal tests too)', () => {
    expect(q(saw.segment(4), 0, 1)).toEqual([
      [0, 0.25, 1 / 8],
      [0.25, 0.5, 3 / 8],
      [0.5, 0.75, 5 / 8],
      [0.75, 1, 7 / 8],
    ])
  })

  it('segment rejects non-positive counts', () => {
    expect(() => saw.segment(0)).toThrow(RangeError)
  })
})

describe('chunk', () => {
  it('chunk(4, fast(2)) applies f to a moving quarter-window each cycle', () => {
    const p = abcd.chunk(4, (x) => x.fast(2))
    // cycle 0: window [0,1/4) doubled — a,b eighths; b,c,d untouched
    expect(q(p, 0, 1)).toEqual([
      [0, 1 / 8, 'a'],
      [1 / 8, 1 / 4, 'b'],
      [1 / 4, 1 / 2, 'b'],
      [1 / 2, 3 / 4, 'c'],
      [3 / 4, 1, 'd'],
    ])
    // cycle 1: window [1/4,1/2) doubled — c,d eighths there; a,c,d untouched
    expect(q(p, 1, 2)).toEqual([
      [1, 5 / 4, 'a'],
      [5 / 4, 11 / 8, 'c'],
      [11 / 8, 3 / 2, 'd'],
      [3 / 2, 7 / 4, 'c'],
      [7 / 4, 2, 'd'],
    ])
    // cycle 2: window [1/2,3/4)
    expect(q(p, 2, 3)).toEqual([
      [2, 9 / 4, 'a'],
      [9 / 4, 5 / 2, 'b'],
      [5 / 2, 21 / 8, 'a'],
      [21 / 8, 11 / 4, 'b'],
      [11 / 4, 3, 'd'],
    ])
    // cycle 4 wraps back to window [0,1/4)
    expect(q(p, 4, 5)).toEqual(q(p, 0, 1).map((h) => [h[0] + 4, h[1] + 4, h[2]]))
  })

  it('chunk validates n', () => {
    expect(() => abcd.chunk(0, (x) => x)).toThrow(RangeError)
    expect(() => abcd.chunk(2.5, (x) => x)).toThrow(RangeError)
  })
})

describe('linger', () => {
  it('linger(1/4) repeats the first quarter for the whole cycle', () => {
    expect(qw(abcd.linger(F(1, 4)), 0, 1)).toEqual([
      { whole: [0, 0.25], part: [0, 0.25], value: 'a' },
      { whole: [0.25, 0.5], part: [0.25, 0.5], value: 'a' },
      { whole: [0.5, 0.75], part: [0.5, 0.75], value: 'a' },
      { whole: [0.75, 1], part: [0.75, 1], value: 'a' },
    ])
  })

  it('linger(1/2) repeats the first half', () => {
    expect(q(abcd.linger(F(1, 2)), 0, 1)).toEqual([
      [0, 0.25, 'a'],
      [0.25, 0.5, 'b'],
      [0.5, 0.75, 'a'],
      [0.75, 1, 'b'],
    ])
  })

  it('is cycle-local: cycle 1 lingers cycle 1 material', () => {
    const p = cat(ab, fastcat('c', 'd')).linger(F(1, 2))
    expect(q(p, 1, 2).map((h) => h[2])).toEqual(['c', 'c'])
  })

  it('linger(1) is identity; linger(0) is silence', () => {
    expect(qw(abcd.linger(1), 0, 2)).toEqual(qw(abcd, 0, 2))
    expect(q(abcd.linger(0), 0, 2)).toEqual([])
  })
})

describe('swingBy / swing', () => {
  const grid8 = abcd.fast(2) // 8 even events per cycle, "hh*8"-shaped

  it('swingBy(1/3, 4) on an 8-event grid shifts the 2nd/4th/6th/8th eighths by 1/24 (Strudel)', () => {
    expect(onsets(grid8.swingBy(F(1, 3), 4), 0, 1)).toEqual([
      0,
      1 / 8 + 1 / 24, // = 1/6
      1 / 4,
      3 / 8 + 1 / 24, // = 5/12
      1 / 2,
      5 / 8 + 1 / 24, // = 2/3
      3 / 4,
      7 / 8 + 1 / 24, // = 11/12
    ])
  })

  it('events sitting only on the n grid do not move: swingBy(1/3, 4) on quarters is identity', () => {
    // Strudel swings the second HALF of each 1/n slice; four quarter-notes
    // all begin on even 2n-grid positions, so nothing shifts.
    expect(qw(abcd.swingBy(F(1, 3), 4), 0, 1)).toEqual(qw(abcd, 0, 1))
  })

  it('swung events keep their (shifted) wholes', () => {
    // n=2: quarters b and d sit on the odd 4-grid positions, shift 1/12.
    const haps = qw(abcd.swingBy(F(1, 3), 2).onsetsOnly(), 0, 1)
    expect(haps).toEqual([
      { whole: [0, 0.25], part: [0, 0.25], value: 'a' },
      { whole: [1 / 3, 7 / 12], part: [1 / 3, 7 / 12], value: 'b' },
      { whole: [0.5, 0.75], part: [0.5, 0.75], value: 'c' },
      { whole: [5 / 6, 13 / 12], part: [5 / 6, 1], value: 'd' },
    ])
  })

  it('swing(n) is swingBy(1/3, n)', () => {
    expect(qw(grid8.swing(4), 0, 2)).toEqual(qw(grid8.swingBy(F(1, 3), 4), 0, 2))
  })

  it('swingBy(0, n) is identity on the grid', () => {
    expect(qw(grid8.swingBy(0, 4), 0, 1)).toEqual(qw(grid8, 0, 1))
  })
})

describe('prototype augmentation wiring', () => {
  it('methods are available on patterns built from the package index', () => {
    // This file imports ONLY from ../src/index — every combinator used above
    // proves the side-effect import. Belt and braces:
    expect(typeof Pattern.pure('x').every).toBe('function')
    expect(typeof Pattern.pure(1).add).toBe('function')
    expect(typeof saw.segment).toBe('function')
  })
})
