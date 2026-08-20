import { describe, expect, it } from 'vitest'
import { Fraction, TimeSpan, miniParse, timeHash } from '../src/index'

/* ------------------------------------------------------------------------- *
 * `[hh*8]'swing:.6` -- groove on a subgroup.
 *
 * Swing existed only as a whole-pattern combinator, so a shuffled hat over a
 * straight kick meant two patterns. This puts it on the group, reusing the `'`
 * lane suffix that already carries per-step controls (`0'gain:.8`).
 *
 * GRID IS EXPLICIT. It cannot be inferred from the written structure: `[hh*8]`
 * is one term that makes eight events, `[a b c d]` is four terms that make
 * four, and any rule reading the source gets one of them wrong.
 * ------------------------------------------------------------------------- */

/** Onsets in cycle 0, in eighths, dropping anything wrapped in from before. */
const onsets = (src: string): number[] => {
  const { pattern } = miniParse(src)
  return pattern.query(new TimeSpan(new Fraction(0), new Fraction(1)))
    .map((h) => h.whole!.begin.valueOf() * 8)
    .filter((x) => x >= 0)
    .sort((a, b) => a - b)
    .map((x) => Math.round(x * 100) / 100)
}

describe('swing on a group', () => {
  it('leaves the on-beats and pushes the off-beats late', () => {
    expect(onsets('hh*8')).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(onsets("[hh*8]'swing:.33")).toEqual([0, 1.33, 2, 3.33, 4, 5.33, 6, 7.33])
  })

  it('swings harder with a bigger amount', () => {
    const soft = onsets("[hh*8]'swing:.2")
    const hard = onsets("[hh*8]'swing:.5")
    expect(hard[1]).toBeGreaterThan(soft[1]!)
    expect(hard[0], 'the downbeat never moves').toBe(0)
  })

  it('takes the grid, and 4 is the default', () => {
    expect(onsets("[hh*8]'swing:.33'grid:4")).toEqual(onsets("[hh*8]'swing:.33"))
    // grid 2 swings quarters: only the halfway hat moves
    expect(onsets("[a b c d]'swing:.33'grid:2")).toEqual([0, 2.66, 4, 6.66])
  })

  it('a grid finer than the events is a no-op, not a mangling', () => {
    // at grid 8 each subdivision holds one event, so there is no second half
    expect(onsets("[hh*8]'swing:.33'grid:8")).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('leaves a neighbouring group alone, which is the whole point', () => {
    const both = onsets("[hh*8]'swing:.33")
    expect(both).not.toEqual(onsets('hh*8'))
    expect(onsets('bd ~ bd ~'), 'the straight part stays straight').toEqual([0, 4])
  })

  it('REFUSES an unknown timing lane rather than ignoring it', () => {
    /* The failure this language keeps finding: a suffix that parses and does
     * nothing. On an atom any lane name may be a control, but on a group the
     * only meanings are the ones the parser knows. */
    expect(() => miniParse("[hh*8]'swng:.3")).toThrow(/not a timing lane/)
  })

  it('refuses a grid with no swing to apply', () => {
    expect(() => miniParse("[hh*8]'grid:4")).toThrow(/needs a 'swing:'/)
  })

  it('refuses a grid that is not a whole subdivision', () => {
    expect(() => miniParse("[hh*8]'swing:.3'grid:0")).toThrow(/whole number/)
    expect(() => miniParse("[hh*8]'swing:.3'grid:1.5")).toThrow(/whole number/)
  })

  it('composes with the suffixes that commute with a nudge', () => {
    for (const src of ["[a b]'swing:.33*2", "[hh*4]'swing:.33!2", "[hh*4]'swing:.33/2"]) {
      expect(onsets(src).length, src).toBeGreaterThan(0)
    }
  })

  it('REFUSES a euclid after a groove, which silently doubles onsets', () => {
    /* Measured: `[hh*8]'swing:.33(3,8)` gives five onsets, two of them
     * doubled, where `(3,8)` alone gives three. Euclid takes its structure
     * from the pattern underneath, and sampling one whose events have been
     * nudged off the grid picks some of them up twice. Nothing in the notation
     * says which order was meant, so it says so instead of choosing. */
    expect(() => miniParse("[hh*8]'swing:.33(3,8)")).toThrow(/euclid cannot follow a groove/)
  })

  it('and the other order works, which is what the error tells you to write', () => {
    expect(onsets("[hh*8](3,8)'swing:.33")).toEqual([0, 3.33, 6])
  })
})

/* ------------------------------------------------------------------------- *
 * `[hh*8]'humanize:.2` -- deterministic jitter, on swing's ruler.
 *
 * Every onset moves LATE by a random amount below amount/(2*grid) cycles, so
 * at full amount a hit lands at most where 'swing: puts the off-beats. The
 * draw is timeHash of the exact onset: re-querying reproduces the identical
 * offsets, which is what keeps re-renders bit-identical.
 * ------------------------------------------------------------------------- */

/** Raw cycle-0 onsets in cycles (not eighths), unrounded. */
const raw = (src: string): number[] => {
  const { pattern } = miniParse(src)
  return pattern.query(new TimeSpan(new Fraction(0), new Fraction(1)))
    .map((h) => h.whole!.begin.valueOf())
    .filter((x) => x >= 0)
    .sort((a, b) => a - b)
}

describe('humanize on a group', () => {
  it('moves every hit late, each below the swing ruler amount/(2*grid)', () => {
    const grid = raw('hh*8')
    const loose = raw("[hh*8]'humanize:.33")
    const ceiling = 0.33 / (2 * 4)
    expect(loose).toHaveLength(8)
    for (let i = 0; i < 8; i++) {
      expect(loose[i]! - grid[i]!, `hit ${i} moves late`).toBeGreaterThanOrEqual(0)
      expect(loose[i]! - grid[i]!, `hit ${i} stays below the ruler`).toBeLessThan(ceiling)
    }
    expect(new Set(loose.map((x, i) => x - grid[i]!)).size, 'a jitter, not a shift')
      .toBeGreaterThan(1)
  })

  it('is deterministic: the same line lands the same way every parse and query', () => {
    expect(raw("[hh*8]'humanize:.2")).toEqual(raw("[hh*8]'humanize:.2"))
    const { pattern } = miniParse("[hh*8]'humanize:.2")
    const span = new TimeSpan(new Fraction(0), new Fraction(1))
    expect(pattern.query(span).map((h) => h.whole!.begin.valueOf()))
      .toEqual(pattern.query(span).map((h) => h.whole!.begin.valueOf()))
  })

  it('takes the grid, and 4 is the default', () => {
    expect(raw("[hh*8]'humanize:.2")).toEqual(raw("[hh*8]'humanize:.2'grid:4"))
    const fine = raw("[hh*8]'humanize:.2'grid:8")
    const coarse = raw("[hh*8]'humanize:.2'grid:4")
    expect(fine).not.toEqual(coarse)
  })

  it('does NOT draw from the shared seed-0 stream chance/degrade use', () => {
    /* Same coin -> the notes that survive a 'chance: are the ones that drag.
     * Pin the streams apart: for these eight onsets, the seed-0 draw and the
     * humanize draw disagree somewhere. */
    const grid = raw('hh*8')
    const loose = raw("[hh*8]'humanize:.33")
    const ceiling = new Fraction(33, 100).div(8)
    const seedZeroPrediction = grid.map((t, i) => {
      const q = Math.floor(timeHash(new Fraction(i, 8), 0) * 64)
      return t + ceiling.mul(new Fraction(q, 64)).valueOf()
    })
    expect(loose).not.toEqual(seedZeroPrediction)
  })

  it('never loses or doubles a hit across query windows', () => {
    const whole = raw("[hh*8]'humanize:.33")
    const halves = [
      ...miniParse("[hh*8]'humanize:.33").pattern
        .query(new TimeSpan(new Fraction(0), new Fraction(1, 2))),
      ...miniParse("[hh*8]'humanize:.33").pattern
        .query(new TimeSpan(new Fraction(1, 2), new Fraction(1))),
    ]
      .filter((h) => h.whole!.begin.eq(h.part.begin))
      .map((h) => h.whole!.begin.valueOf())
      .filter((x) => x >= 0)
      .sort((a, b) => a - b)
    expect(halves).toEqual(whole)
  })

  it('composes with swing: shuffle first, breathe on the shuffled grid', () => {
    const swung = raw("[hh*8]'swing:.33")
    const both = raw("[hh*8]'swing:.33'humanize:.2")
    expect(both).toHaveLength(8)
    for (let i = 0; i < 8; i++) {
      expect(both[i]! - swung[i]!).toBeGreaterThanOrEqual(0)
      expect(both[i]! - swung[i]!).toBeLessThan(0.2 / 8)
    }
  })

  it('a grid alone still refuses, naming both lanes that would want it', () => {
    expect(() => miniParse("[hh*8]'grid:4")).toThrow(/'swing:' or 'humanize:'/)
  })

  it('refuses a euclid after it, like any groove', () => {
    expect(() => miniParse("[hh*8]'humanize:.2(3,8)")).toThrow(/euclid cannot follow a groove/)
  })
})
