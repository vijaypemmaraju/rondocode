import { describe, expect, it } from 'vitest'
import { Fraction, MiniError, TimeSpan, hasOnset, miniParse, n } from '../src/index'

/* ------------------------------------------------------------------------- *
 * `sn'push:.25` -- one hit off the grid, on purpose.
 *
 * The grid has swing (a whole-parity rule) and gain-shaping, but no way to
 * move ONE note: laying back a snare meant re-bracketing the bar. `'push:x`
 * moves that hit by x of its own step, positive late, negative early.
 *
 * The push rides in the VALUE and is applied once, to the fully assembled
 * pattern (pushPass). Two measured failures pinned that design, and both are
 * pinned again here: an atom-level time warp WRAPS (late(-.1) is late(.9)),
 * and euclid sampled the structure from under it (the push vanished, no
 * error).
 * ------------------------------------------------------------------------- */

const span01 = new TimeSpan(new Fraction(0), new Fraction(1))

/** [onset in cycle 0, value] pairs, onsets in cycle fractions. */
const heard = (src: string, span = span01): [number, string | number][] => {
  const { pattern } = miniParse(src)
  return pattern.query(span)
    .filter(hasOnset)
    .map((h): [number, string | number] => [h.whole!.begin.valueOf(), h.value.value])
    .sort((a, b) => a[0] - b[0])
}

describe('push on a note', () => {
  it('moves that hit late by a fraction of its OWN step, and nothing else', () => {
    expect(heard("bd sn'push:.25 hh sn")).toEqual([
      [0, 'bd'],
      // slot 1/4, step 1/4: pushed a quarter of it, 1/4 + 1/16
      [0.3125, 'sn'],
      [0.5, 'hh'],
      [0.75, 'sn'],
    ])
  })

  it('negative is genuinely EARLY, not the wrap the naive warp gave', () => {
    /* Measured before pushPass: pure(sn).late(-.5) inside the sequence put
     * the sn at 0.375 -- late by half a step, because an atom's own timeline
     * is cyclic and the early shift wrapped. The whole reason push is a
     * value. */
    expect(heard("bd sn'push:-.5 hh sn")).toEqual([
      [0, 'bd'],
      [0.125, 'sn'],
      [0.5, 'hh'],
      [0.75, 'sn'],
    ])
  })

  it('an early first-of-cycle hit slides to the cycle BEFORE its gridpoint', () => {
    /* bd'push:-.25 in four slots: each cycle's bd sounds a sixteenth before
     * the barline -- which is inside the PREVIOUS cycle. Cycle 0 therefore
     * shows the bd belonging to cycle 1, and the very first bd of a
     * performance (before the transport) never sounds. */
    expect(heard("bd'push:-.25 sn hh sn")).toEqual([
      [0.25, 'sn'],
      [0.5, 'hh'],
      [0.75, 'sn'],
      [0.9375, 'bd'],
    ])
  })

  it('composes with euclid: each chosen hit moves by a fraction of ITS step', () => {
    /* Measured before pushPass: the push vanished under (3,8) -- identical
     * onsets to unpushed, no error. The repo's dominant bug shape. */
    expect(heard("bd'push:.25(3,8)")).toEqual([
      [0.03125, 'bd'],
      [0.40625, 'bd'],
      [0.78125, 'bd'],
    ])
    // and it follows the NOTE through the euclid, not the slots: only the
    // pushed sn moves, the sn euclid picked at 0.75 stays put
    expect(heard("[bd sn'push:.25 hh sn](3,8)")).toEqual([
      [0, 'bd'],
      [0.40625, 'sn'],
      [0.75, 'sn'],
    ])
  })

  it('scales with the mods that re-time the note', () => {
    // *2: two copies, each pushed a quarter of its (halved) step
    expect(heard("sn'push:.25*2 hh")).toEqual([
      [0.0625, 'sn'],
      [0.3125, 'sn'],
      [0.5, 'hh'],
    ])
    // an alternation slot is a full cycle, so its step is a full cycle
    expect(heard("<bd sn'push:.5>", new TimeSpan(new Fraction(1), new Fraction(2))))
      .toEqual([[1.5, 'sn']])
  })

  it('a step longer than a cycle counts as one cycle', () => {
    /* bd/4 has a four-cycle whole; uncapped, push:.5 would move it two whole
     * cycles and the padded query could no longer find it. */
    expect(heard("bd'push:.5/4", new TimeSpan(new Fraction(0), new Fraction(4))))
      .toEqual([[0.5, 'bd']])
  })

  it('keeps its neighbours on the lane: push is consumed, gain still flows', () => {
    const { pattern } = miniParse("sn'push:.25'gain:.8")
    const [h] = pattern.query(span01).filter(hasOnset)
    expect(h!.whole!.begin.valueOf()).toBe(0.25)
    expect(h!.value.lanes).toEqual({ gain: 0.8 })
    expect(h!.value.push, 'consumed into the times, not forwarded').toBe(0.25)
  })

  it('never loses or doubles an event across query windows', () => {
    /* The pushPass over-queries by a cycle and clips back to the span; the
     * law that makes that safe is that any tiling of a window hears exactly
     * the onsets the whole window hears. */
    const whole = heard("bd'push:-.25 sn'push:.5 hh sn'push:.1")
    const parts = [
      ...heard("bd'push:-.25 sn'push:.5 hh sn'push:.1", new TimeSpan(new Fraction(0), new Fraction(3, 10))),
      ...heard("bd'push:-.25 sn'push:.5 hh sn'push:.1", new TimeSpan(new Fraction(3, 10), new Fraction(1))),
    ].sort((a, b) => a[0] - b[0])
    expect(parts).toEqual(whole)
  })

  it('works through the numeric entry points too', () => {
    const hs = n("0 3'push:.5 7").query(span01).filter(hasOnset)
    expect(hs.map((h) => [h.whole!.begin.valueOf(), h.value.n])).toEqual([
      [0, 0],
      [0.5, 3],
      [2 / 3, 7],
    ])
    expect(hs[1]!.value['push'], 'no phantom synth param').toBeUndefined()
  })

  it('refuses a push past a full step, at the note that carries it', () => {
    const err = ((): MiniError => {
      try {
        miniParse("bd sn'push:1.5")
      } catch (e) {
        return e as MiniError
      }
      throw new Error('did not throw')
    })()
    expect(err.message).toMatch(/fraction of its own step/)
    expect(err.pos, 'points at the sn, not the line').toBe(3)
  })

  it("push exactly +-1 is legal: a full step either way", () => {
    expect(heard("bd sn'push:1 hh ~")).toEqual([
      [0, 'bd'],
      [0.5, 'sn'],
      [0.5, 'hh'],
    ])
  })
})

describe('push on a group', () => {
  it('moves the whole figure late by a fraction of its slot', () => {
    expect(heard("[bd sn](3,8)'push:.1")).toEqual([
      [0.1, 'bd'],
      [0.475, 'bd'],
      [0.85, 'sn'],
    ])
  })

  it('is late-only, because an early group shift wraps', () => {
    expect(() => miniParse("[bd sn]'push:-.1")).toThrow(/late-only/)
  })

  it('still refuses a euclid after it, like any groove', () => {
    expect(() => miniParse("[bd sn]'push:.1(3,8)")).toThrow(/euclid cannot follow a groove/)
  })
})

describe('the group-only lanes on a bare note', () => {
  it('are errors, not silent params', () => {
    /* A lane the engine does not know forwards to the synth as a param, so
     * hh'swing:.3 would become param('swing') -- a shuffle that never
     * arrives. Same guard RENAMED_LANES gives the controls. */
    for (const src of ["hh'swing:.3", "hh'grid:8", "hh'humanize:.2"]) {
      expect(() => miniParse(src), src).toThrow(/timing lane for a GROUP/)
    }
  })
})
