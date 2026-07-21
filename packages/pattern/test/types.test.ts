import { describe, it, expect } from 'vitest'
import { F } from '../src/fraction'
import { TimeSpan, Hap, hap, hasOnset } from '../src/types'

const span = (bn: number, bd: number, en: number, ed: number) =>
  new TimeSpan(F(bn, bd), F(en, ed))

describe('TimeSpan construction', () => {
  it('holds begin and end', () => {
    const s = new TimeSpan(F(1, 2), F(3, 2))
    expect(s.begin.eq(F(1, 2))).toBe(true)
    expect(s.end.eq(F(3, 2))).toBe(true)
  })

  it('allows zero-width spans', () => {
    expect(() => new TimeSpan(F(1), F(1))).not.toThrow()
  })

  it('throws when begin > end', () => {
    expect(() => new TimeSpan(F(1), F(0))).toThrow(RangeError)
  })
})

describe('TimeSpan.length', () => {
  it('is end - begin', () => {
    expect(span(1, 2, 3, 2).length.eq(F(1))).toBe(true)
    expect(span(1, 4, 1, 2).length.eq(F(1, 4))).toBe(true)
    expect(new TimeSpan(F(1), F(1)).length.eq(F(0))).toBe(true)
  })
})

describe('TimeSpan.withTime', () => {
  it('maps both endpoints with one function', () => {
    const s = span(1, 2, 3, 2).withTime((t) => t.mul(2))
    expect(s.equals(new TimeSpan(F(1), F(3)))).toBe(true)
  })

  it('maps begin and end with separate functions', () => {
    const s = span(1, 2, 3, 2).withTime(
      (t) => t.sub(F(1, 2)),
      (t) => t.add(F(1, 2)),
    )
    expect(s.equals(new TimeSpan(F(0), F(2)))).toBe(true)
  })

  it('does not mutate the original span', () => {
    const s = span(1, 2, 3, 2)
    s.withTime((t) => t.mul(2))
    expect(s.equals(span(1, 2, 3, 2))).toBe(true)
  })
})

describe('TimeSpan.intersection', () => {
  it('returns the overlap of overlapping spans', () => {
    const i = span(0, 1, 1, 1).intersection(span(1, 2, 3, 2))
    expect(i).toBeDefined()
    expect(i!.equals(new TimeSpan(F(1, 2), F(1)))).toBe(true)
  })

  it('returns the smaller span when one contains the other', () => {
    const i = span(0, 1, 2, 1).intersection(span(1, 2, 3, 4))
    expect(i!.equals(span(1, 2, 3, 4))).toBe(true)
  })

  it('is symmetric', () => {
    const a = span(0, 1, 1, 1)
    const b = span(1, 2, 3, 2)
    expect(a.intersection(b)!.equals(b.intersection(a)!)).toBe(true)
  })

  it('returns undefined for disjoint spans', () => {
    expect(span(0, 1, 1, 1).intersection(span(2, 1, 3, 1))).toBeUndefined()
  })

  it('returns undefined for spans touching only at an edge', () => {
    expect(span(0, 1, 1, 1).intersection(span(1, 1, 2, 1))).toBeUndefined()
  })

  it('returns the zero-width span for a zero-width query inside a span', () => {
    const point = new TimeSpan(F(1, 2), F(1, 2))
    const i = span(0, 1, 1, 1).intersection(point)
    expect(i).toBeDefined()
    expect(i!.equals(point)).toBe(true)
    // symmetric direction too
    expect(point.intersection(span(0, 1, 1, 1))!.equals(point)).toBe(true)
  })

  it('includes a zero-width span at the BEGIN edge of the other span', () => {
    // Half-open (Tidal subArc): [0,1) contains its begin instant
    const atStart = new TimeSpan(F(0), F(0))
    expect(span(0, 1, 1, 1).intersection(atStart)!.equals(atStart)).toBe(true)
  })

  it('excludes a zero-width span at the END edge of the other span', () => {
    // Half-open (Tidal subArc): [0,1) does not contain the instant 1 —
    // subArc returns Nothing when the zero-width result equals the end of
    // a positive-width operand.
    const atEnd = new TimeSpan(F(1), F(1))
    expect(span(0, 1, 1, 1).intersection(atEnd)).toBeUndefined()
    expect(atEnd.intersection(span(0, 1, 1, 1))).toBeUndefined()
  })

  it('excludes point queries against events ending at that instant (phantom-hap regression)', () => {
    // Span-level root cause of the appLeft phantom: querying the point
    // [1/2,1/2] against a hap part [0,1/2) must be empty — otherwise
    // pure(1).appLeft(fastcat(pure(10), pure(20)), add) at [1/2,1/2]
    // yields a phantom 11 alongside the correct 21. See pattern.test.ts.
    const point = new TimeSpan(F(1, 2), F(1, 2))
    expect(span(0, 1, 1, 2).intersection(point)).toBeUndefined()
    expect(span(1, 2, 1, 1).intersection(point)!.equals(point)).toBe(true)
  })

  it('intersects two identical zero-width spans', () => {
    const p = new TimeSpan(F(1), F(1))
    expect(p.intersection(new TimeSpan(F(1), F(1)))!.equals(p)).toBe(true)
  })

  it('returns undefined for two different zero-width spans', () => {
    const p = new TimeSpan(F(1), F(1))
    expect(p.intersection(new TimeSpan(F(2), F(2)))).toBeUndefined()
  })
})

describe('TimeSpan.sect', () => {
  it('returns the raw overlap of overlapping spans', () => {
    const s = span(0, 1, 1, 1).sect(span(1, 2, 3, 2))
    expect(s.equals(new TimeSpan(F(1, 2), F(1)))).toBe(true)
  })

  it('returns a zero-width span at edge-touch (unlike intersection)', () => {
    // Whole-combination in app* combinators must keep edge-touching wholes
    const s = span(0, 1, 1, 1).sect(span(1, 1, 2, 1))
    expect(s.equals(new TimeSpan(F(1), F(1)))).toBe(true)
    // ...where the checked variant reports no overlap
    expect(span(0, 1, 1, 1).intersection(span(1, 1, 2, 1))).toBeUndefined()
  })

  it('throws RangeError when spans do not overlap (caller contract)', () => {
    expect(() => span(0, 1, 1, 1).sect(span(2, 1, 3, 1))).toThrow(RangeError)
  })
})

describe('TimeSpan.cycleSpans', () => {
  it('splits at integer cycle boundaries', () => {
    const parts = new TimeSpan(F(1, 2), F(5, 2)).cycleSpans()
    expect(parts.length).toBe(3)
    expect(parts[0]!.equals(new TimeSpan(F(1, 2), F(1)))).toBe(true)
    expect(parts[1]!.equals(new TimeSpan(F(1), F(2)))).toBe(true)
    expect(parts[2]!.equals(new TimeSpan(F(2), F(5, 2)))).toBe(true)
  })

  it('handles exact-integer bounds: [1,3] -> [[1,2],[2,3]]', () => {
    const parts = new TimeSpan(F(1), F(3)).cycleSpans()
    expect(parts.length).toBe(2)
    expect(parts[0]!.equals(new TimeSpan(F(1), F(2)))).toBe(true)
    expect(parts[1]!.equals(new TimeSpan(F(2), F(3)))).toBe(true)
  })

  it('returns a span within one cycle unchanged', () => {
    const parts = new TimeSpan(F(1, 4), F(3, 4)).cycleSpans()
    expect(parts.length).toBe(1)
    expect(parts[0]!.equals(new TimeSpan(F(1, 4), F(3, 4)))).toBe(true)
  })

  it('splits spans over negative time', () => {
    const parts = new TimeSpan(F(-1, 2), F(1, 2)).cycleSpans()
    expect(parts.length).toBe(2)
    expect(parts[0]!.equals(new TimeSpan(F(-1, 2), F(0)))).toBe(true)
    expect(parts[1]!.equals(new TimeSpan(F(0), F(1, 2)))).toBe(true)
  })

  it('returns a zero-width span as [itself]', () => {
    const p = new TimeSpan(F(1), F(1))
    const parts = p.cycleSpans()
    expect(parts.length).toBe(1)
    expect(parts[0]!.equals(p)).toBe(true)
  })
})

describe('TimeSpan.equals / toString', () => {
  it('equals compares endpoints exactly', () => {
    expect(span(1, 2, 1, 1).equals(span(2, 4, 3, 3))).toBe(true)
    expect(span(1, 2, 1, 1).equals(span(1, 2, 3, 2))).toBe(false)
  })

  it('toString renders both endpoints', () => {
    const s = span(1, 2, 3, 2).toString()
    expect(s).toContain('1/2')
    expect(s).toContain('3/2')
  })
})

describe('Hap', () => {
  const whole = new TimeSpan(F(0), F(1))

  it('hap builds a plain object', () => {
    const h = hap(whole, whole, 'bd')
    expect(h.whole).toBe(whole)
    expect(h.part).toBe(whole)
    expect(h.value).toBe('bd')
  })

  it('hasOnset is true when the whole begins with the part', () => {
    const h: Hap<string> = hap(whole, new TimeSpan(F(0), F(1, 2)), 'bd')
    expect(hasOnset(h)).toBe(true)
  })

  it('hasOnset is false when the part is clipped (starts after the whole)', () => {
    const h = hap(whole, new TimeSpan(F(1, 2), F(1)), 'bd')
    expect(hasOnset(h)).toBe(false)
  })

  it('hasOnset is false for continuous signals (no whole)', () => {
    const h = hap(undefined, new TimeSpan(F(0), F(1, 2)), 0.5)
    expect(hasOnset(h)).toBe(false)
  })
})
