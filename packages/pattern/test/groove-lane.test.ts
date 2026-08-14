import { describe, expect, it } from 'vitest'
import { Fraction, TimeSpan, miniParse } from '../src/index'

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
