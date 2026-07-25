import { describe, it, expect } from 'vitest'
import { F, Fraction } from '../src/fraction'
import { TimeSpan, hap } from '../src/types'
import { Pattern, reify } from '../src/pattern'
import { checkInvariants, q, qw, span } from './helpers'

const { pure, fastcat, cat, stack, timecat, steady } = Pattern

// helpers (q/qw/span/checkInvariants) are the shared ones in test/helpers.ts —
// this file used to carry a drifted private copy (its sortHaps lacked the
// whole-begin tie-break); keep exactly one implementation.

/** A pattern whose value is its own cycle number — pins timeline-shift semantics. */
const cyclenum = new Pattern<number>((s) =>
  s.cycleSpans().map((cs) => {
    const sam = cs.begin.sam()
    return hap(new TimeSpan(sam, sam.add(Fraction.ONE)), cs, sam.valueOf())
  }),
)

const abc = fastcat(pure('a'), pure('b'), pure('c'))
const ab = fastcat(pure('a'), pure('b'))

// ---------------------------------------------------------------- golden

describe('pure', () => {
  it('yields one event per cycle with whole [sam, sam+1)', () => {
    expect(q(pure('a'), 0, 2)).toEqual([
      [0, 1, 'a'],
      [1, 2, 'a'],
    ])
  })

  it('clips part on partial queries but keeps the full whole', () => {
    expect(qw(pure('a'), 0.25, 0.75)).toEqual([
      { whole: [0, 1], part: [0.25, 0.75], value: 'a' },
    ])
  })

  it('works before cycle zero', () => {
    expect(qw(pure('a'), -0.5, 0)).toEqual([
      { whole: [-1, 0], part: [-0.5, 0], value: 'a' },
    ])
  })
})

describe('silence and steady', () => {
  it('silence returns no haps', () => {
    expect(q(Pattern.silence, 0, 4)).toEqual([])
  })

  it('steady is continuous: whole undefined, part = query span', () => {
    expect(qw(steady(7), 0.25, 1.5)).toEqual([
      { whole: null, part: [0.25, 1.5], value: 7 },
    ])
  })
})

describe('fastcat', () => {
  it('splits the cycle equally', () => {
    expect(q(ab, 0, 1)).toEqual([
      [0, 0.5, 'a'],
      [0.5, 1, 'b'],
    ])
  })

  it('handles exact thirds', () => {
    expect(q(abc, 0, 1)).toEqual([
      [0, 1 / 3, 'a'],
      [1 / 3, 2 / 3, 'b'],
      [2 / 3, 1, 'c'],
    ])
  })
})

describe('fast / slow', () => {
  it('fast(2) doubles pure', () => {
    expect(q(pure('a').fast(2), 0, 1)).toEqual([
      [0, 0.5, 'a'],
      [0.5, 1, 'a'],
    ])
  })

  it('fast(2) scales wholes rather than clipping them', () => {
    expect(qw(pure('a').fast(2), 0, 1)).toEqual([
      { whole: [0, 0.5], part: [0, 0.5], value: 'a' },
      { whole: [0.5, 1], part: [0.5, 1], value: 'a' },
    ])
  })

  it('slow(2) stretches fastcat over two cycles', () => {
    expect(q(ab.slow(2), 0, 2)).toEqual([
      [0, 1, 'a'],
      [1, 2, 'b'],
    ])
  })

  it('fast(0) and negative factors are silence', () => {
    expect(q(pure('a').fast(0), 0, 4)).toEqual([])
    expect(q(pure('a').fast(-2), 0, 4)).toEqual([])
    expect(q(pure('a').slow(0), 0, 4)).toEqual([])
    expect(q(pure('a').slow(-1), 0, 4)).toEqual([])
  })

  it('fast(3).slow(3) round-trips exactly (Fraction exactness end-to-end)', () => {
    expect(qw(abc.fast(3).slow(3), 0, 1)).toEqual(qw(abc, 0, 1))
    expect(qw(abc.fast(3).slow(3), 1 / 3, 5 / 3)).toEqual(qw(abc, 1 / 3, 5 / 3))
  })
})

describe('early / late', () => {
  it('early(0.25) shifts events sooner; later material slides in (no rotation)', () => {
    expect(qw(ab.early(0.25), 0, 1)).toEqual([
      { whole: [-0.25, 0.25], part: [0, 0.25], value: 'a' },
      { whole: [0.25, 0.75], part: [0.25, 0.75], value: 'b' },
      { whole: [0.75, 1.25], part: [0.75, 1], value: 'a' },
    ])
  })

  it('late is the inverse of early', () => {
    expect(qw(ab.early(0.25).late(0.25), 0, 1)).toEqual(qw(ab, 0, 1))
  })
})

describe('rev', () => {
  it('reverses within the cycle', () => {
    expect(q(abc.rev(), 0, 1)).toEqual([
      [0, 1 / 3, 'c'],
      [1 / 3, 2 / 3, 'b'],
      [2 / 3, 1, 'a'],
    ])
  })

  it('is cycle-local: cycle 1 has the same shape shifted by 1', () => {
    expect(q(abc.rev(), 1, 2)).toEqual([
      [1, 4 / 3, 'c'],
      [4 / 3, 5 / 3, 'b'],
      [5 / 3, 2, 'a'],
    ])
  })

  it('reflects wholes too', () => {
    expect(qw(ab.rev(), 0, 0.5)).toEqual([
      { whole: [0, 0.5], part: [0, 0.5], value: 'b' },
    ])
  })

  it('rev . rev = identity', () => {
    expect(qw(abc.rev().rev(), 0, 2)).toEqual(qw(abc, 0, 2))
  })
})

describe('cat (slowcat)', () => {
  it('plays one pattern per cycle', () => {
    const p = cat(pure('a'), pure('b'))
    expect(q(p, 0, 2)).toEqual([
      [0, 1, 'a'],
      [1, 2, 'b'],
    ])
    expect(q(p, 2, 4)).toEqual([
      [2, 3, 'a'],
      [3, 4, 'b'],
    ])
  })

  it('selects by cycle index mod length, structure intact', () => {
    const p = cat(ab, pure('c'))
    expect(q(p, 0, 4)).toEqual([
      [0, 0.5, 'a'],
      [0.5, 1, 'b'],
      [1, 2, 'c'],
      [2, 2.5, 'a'],
      [2.5, 3, 'b'],
      [3, 4, 'c'],
    ])
  })

  it('each pattern continues its OWN timeline (the slowcat shift)', () => {
    const p = cat<number | string>(cyclenum, pure('x'))
    // Outer cycle 2 is cyclenum's SECOND visit → its own cycle 1, not 2.
    expect(q(p, 2, 3)).toEqual([[2, 3, 1]])
    expect(q(p, 0, 1)).toEqual([[0, 1, 0]])
    expect(q(p, 4, 5)).toEqual([[4, 5, 2]])
    expect(q(p, 1, 2)).toEqual([[1, 2, 'x']])
  })

  it('handles negative cycles with Euclidean indexing', () => {
    const p = cat(pure('a'), pure('b'))
    expect(q(p, -1, 0)).toEqual([[-1, 0, 'b']])
  })

  it('cat of nothing is silence', () => {
    expect(q(cat(), 0, 1)).toEqual([])
  })
})

describe('timecat', () => {
  it('weights slices proportionally', () => {
    expect(q(timecat([[3, pure('a')], [1, pure('b')]]), 0, 1)).toEqual([
      [0, 0.75, 'a'],
      [0.75, 1, 'b'],
    ])
  })

  it('equal weights match fastcat', () => {
    const t = timecat([[1, pure('a')], [1, pure('b')], [1, pure('c')]])
    expect(qw(t, 0, 2)).toEqual(qw(abc, 0, 2))
  })

  it('compresses inner structure into the slice', () => {
    expect(q(timecat([[1, ab], [1, pure('c')]]), 0, 1)).toEqual([
      [0, 0.25, 'a'],
      [0.25, 0.5, 'b'],
      [0.5, 1, 'c'],
    ])
  })

  it('skips non-positive weights', () => {
    expect(q(timecat([[0, pure('x')], [1, pure('a')]]), 0, 1)).toEqual([[0, 1, 'a']])
  })

  it('all-nonpositive weights yield silence (no division by a zero total)', () => {
    expect(q(timecat([[0, pure('a')], [-1, pure('b')]]), 0, 1)).toEqual([])
    expect(q(timecat([[0, pure('a')]]), 0, 1)).toEqual([])
  })
})

describe('stack', () => {
  it('plays all patterns at once (deterministic order via sort)', () => {
    expect(q(stack(pure('b'), pure('a')), 0, 1)).toEqual([
      [0, 1, 'a'],
      [0, 1, 'b'],
    ])
  })
})

describe('appLeft / appRight / appBoth', () => {
  const add = (a: number, b: number) => a + b

  it('appLeft takes structure from the left', () => {
    expect(qw(fastcat(pure(1), pure(2)).appLeft(pure(10), add), 0, 1)).toEqual([
      { whole: [0, 0.5], part: [0, 0.5], value: 11 },
      { whole: [0.5, 1], part: [0.5, 1], value: 12 },
    ])
  })

  it('appLeft across boundary: left whole kept, right subdivides into two haps', () => {
    expect(qw(pure(1).appLeft(fastcat(pure(10), pure(20)), add), 0, 1)).toEqual([
      { whole: [0, 1], part: [0, 0.5], value: 11 },
      { whole: [0, 1], part: [0.5, 1], value: 21 },
    ])
  })

  it('appLeft point query yields no phantom hap from an event ending at that instant', () => {
    // Regression (Tidal subArc end-edge exclusion in TimeSpan.intersection):
    // at the instant 1/2, fastcat's first half [0,1/2) is already over —
    // only the second half applies. The old inclusive end-edge semantics
    // produced a phantom 11 here alongside the correct 21.
    const p = pure(1).appLeft(fastcat(pure(10), pure(20)), add)
    expect(qw(p, F(1, 2), F(1, 2))).toEqual([
      { whole: [0, 1], part: [0.5, 0.5], value: 21 },
    ])
  })

  it('appLeft samples a continuous right over the left whole', () => {
    expect(qw(fastcat(pure(1), pure(2)).appLeft(steady(10), add), 0, 1)).toEqual([
      { whole: [0, 0.5], part: [0, 0.5], value: 11 },
      { whole: [0.5, 1], part: [0.5, 1], value: 12 },
    ])
  })

  it('appLeft samples continuous values over the WHOLE, not the clipped part', () => {
    // A continuous pattern whose value reveals the span it was queried with:
    // proto-signal; the signals task depends on sampling over wholeOrPart.
    const spanBegin = new Pattern<number>((s) => [hap(undefined, s, s.begin.valueOf())])
    // Partial query [0.5, 1]: the left hap's whole is still [0, 1], so the
    // continuous side must be sampled from 0, not from the clipped 0.5.
    expect(qw(pure(1).appLeft(spanBegin, add), 0.5, 1)).toEqual([
      { whole: [0, 1], part: [0.5, 1], value: 1 },
    ])
  })

  it('appRight takes structure from the right', () => {
    expect(qw(fastcat(pure(1), pure(2)).appRight(pure(10), add), 0, 1)).toEqual([
      { whole: [0, 1], part: [0, 0.5], value: 11 },
      { whole: [0, 1], part: [0.5, 1], value: 12 },
    ])
  })

  it('appBoth intersects parts and wholes', () => {
    const l = fastcat(pure(1), pure(2))
    const r = fastcat(pure(10), pure(20))
    expect(q(l.appBoth(r, add), 0, 1)).toEqual([
      [0, 0.5, 11],
      [0.5, 1, 22],
    ])
  })

  it('appBoth with misaligned structure: wholes are the sect of both', () => {
    expect(qw(pure(1).appBoth(fastcat(pure(10), pure(20)), add), 0, 1)).toEqual([
      { whole: [0, 0.5], part: [0, 0.5], value: 11 },
      { whole: [0.5, 1], part: [0.5, 1], value: 21 },
    ])
  })

  it('appBoth with a continuous side has undefined wholes', () => {
    expect(qw(pure(1).appBoth(steady(10), add), 0, 1)).toEqual([
      { whole: null, part: [0, 1], value: 11 },
    ])
  })
})

describe('innerBind / outerBind', () => {
  const split = (v: number) => fastcat(pure(v), pure(v * 2))

  it('innerBind takes structure from the inner pattern', () => {
    expect(qw(pure(2).innerBind(split), 0, 1)).toEqual([
      { whole: [0, 0.5], part: [0, 0.5], value: 2 },
      { whole: [0.5, 1], part: [0.5, 1], value: 4 },
    ])
  })

  it('outerBind takes structure from the outer pattern', () => {
    expect(qw(pure(2).outerBind(split), 0, 1)).toEqual([
      { whole: [0, 1], part: [0, 0.5], value: 2 },
      { whole: [0, 1], part: [0.5, 1], value: 4 },
    ])
  })
})

describe('withValue / filters / onsetsOnly', () => {
  it('withValue maps values, structure untouched', () => {
    expect(qw(ab.withValue((v) => v.toUpperCase()), 0, 1)).toEqual([
      { whole: [0, 0.5], part: [0, 0.5], value: 'A' },
      { whole: [0.5, 1], part: [0.5, 1], value: 'B' },
    ])
  })

  it('filterValues keeps matching values', () => {
    const p = fastcat(pure(1), pure(2), pure(3)).filterValues((v) => v % 2 === 1)
    expect(q(p, 0, 1)).toEqual([
      [0, 1 / 3, 1],
      [2 / 3, 1, 3],
    ])
  })

  it('onsetsOnly drops clipped tails and continuous samples', () => {
    expect(qw(pure('a').onsetsOnly(), 0.5, 1.5)).toEqual([
      { whole: [1, 2], part: [1, 1.5], value: 'a' },
    ])
    expect(q(steady(1).onsetsOnly(), 0, 1)).toEqual([])
  })
})

describe('reify / auto-reify', () => {
  it('passes Patterns through untouched', () => {
    const p = pure('a')
    expect(reify(p)).toBe(p)
  })

  it('lifts bare values to pure', () => {
    expect(qw(reify(5), 0, 1)).toEqual(qw(pure(5), 0, 1))
  })

  it('cat accepts bare values (Strudel parity)', () => {
    expect(q(cat('a', 'b'), 0, 2)).toEqual([
      [0, 1, 'a'],
      [1, 2, 'b'],
    ])
  })

  it('fastcat and stack accept mixed bare values and patterns', () => {
    expect(q(fastcat('a', pure('b')), 0, 1)).toEqual([
      [0, 0.5, 'a'],
      [0.5, 1, 'b'],
    ])
    expect(q(stack('b', pure('a')), 0, 1)).toEqual([
      [0, 1, 'a'],
      [0, 1, 'b'],
    ])
  })

  it('timecat accepts bare values in pairs', () => {
    expect(q(timecat([[3, 'a'], [1, pure('b')]]), 0, 1)).toEqual([
      [0, 0.75, 'a'],
      [0.75, 1, 'b'],
    ])
  })
})

describe('error paths', () => {
  it('fast(NaN) throws a RangeError naming the offending value', () => {
    expect(() => pure('a').fast(NaN)).toThrow(RangeError)
    expect(() => pure('a').fast(NaN)).toThrow(/finite number, got NaN/)
  })

  it('early(Infinity) throws a RangeError', () => {
    expect(() => pure('a').early(Infinity)).toThrow(RangeError)
    expect(() => pure('a').early(Infinity)).toThrow(/finite number, got Infinity/)
  })
})

describe('rev at cycle boundaries', () => {
  it('point query at 0 sees the reflection of cycle -1, as a non-onset', () => {
    // rev reflects cycle 0 about t -> 1 - t, so the instant 0 is the image
    // of the instant 1 — the END of pure's cycle-0 event, i.e. the start of
    // the reflected cycle -1 event's tail. Whole [-1, 0], part [0, 0], no
    // onset. This matches Tidal's cycle-local reflect; do not "fix" it.
    const haps = pure('a').rev().query(span(0, 0))
    expect(qw(pure('a').rev(), 0, 0)).toEqual([
      { whole: [-1, 0], part: [0, 0], value: 'a' },
    ])
    expect(haps.some((h) => h.whole !== undefined && h.whole.begin.eq(h.part.begin))).toBe(false)
  })
})

describe('invariants over random spans', () => {
  // Deterministic LCG so failures are reproducible.
  let seed = 0x2f2f
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }

  const patterns: [string, Pattern<unknown>][] = [
    ['pure', pure('x')],
    ['fastcat.fast.early', abc.fast(3).early(F(1, 3))],
    ['cat.rev', cat(ab, pure('c')).rev()],
    ['timecat.slow', timecat([[3, pure('a')], [2, ab]]).slow(F(3, 2))],
    ['appLeft steady', ab.appLeft(steady(1), (a, b) => `${a}${b}`)],
  ]

  for (const [name, p] of patterns) {
    it(`part ⊆ whole and part ⊆ span for ${name}`, () => {
      for (let i = 0; i < 200; i++) {
        const b = F(rand(64) - 32, rand(12) + 1)
        const e = b.add(F(rand(48), rand(12) + 1))
        const s = new TimeSpan(b, e)
        checkInvariants(p.query(s), s)
      }
    })
  }
})
