import { describe, expect, it } from 'vitest'
import { Fraction as F, TimeSpan, hasOnset, n, note, s } from '../src/index'

/* ------------------------------------------------------------------------- *
 * MULTI-LANE NOTE EXPRESSION: `0'2'gain:.8'chance:.5`.
 *
 * `'2` gave a note one number. Named lanes give it as many as it needs, and
 * that one generalisation covers most of what a modern DAW calls note
 * expression: per-note velocity, per-note length, and per-note probability —
 * each of which otherwise wants its own parallel control pattern, and each of
 * which would then lose track of which note it meant the moment the notation
 * grew a rest or a subgroup.
 *
 * THREE NAMES ARE STRUCTURAL (vel, len, chance) because the pattern engine
 * consumes them. Everything else is an ordinary param and reaches the synth
 * untouched, which is the point: the language should not own a vocabulary of
 * musical properties when the synth already has one.
 * ------------------------------------------------------------------------- */

const cyc = (p: unknown, c = 0): Record<string, unknown>[] =>
  (p as { query: (t: TimeSpan) => { value: Record<string, unknown> }[] })
    .query(new TimeSpan(new F(c), new F(c + 1)))
    .filter(hasOnset as never)
    .map((h) => { const v = { ...h.value }; delete v['loc']; return v })

describe('named lanes', () => {
  it('a bare value still means `expr`', () => {
    expect(cyc(n("0'2 3"))).toEqual([{ n: 0, expr: 2 }, { n: 3 }])
  })

  it('`gain` is the note’s own gain', () => {
    expect(cyc(n("0'gain:.8 3'gain:.3"))).toEqual([{ n: 0, gain: 0.8 }, { n: 3, gain: 0.3 }])
  })

  it('`dur` is the note’s own duration', () => {
    expect(cyc(n("0'dur:.25 3"))).toEqual([{ n: 0, dur: 0.25 }, { n: 3 }])
  })

  it('lanes chain, in any order', () => {
    expect(cyc(n("0'2'gain:.8'dur:.5"))).toEqual([{ n: 0, expr: 2, gain: 0.8, dur: 0.5 }])
    expect(cyc(n("0'gain:.8'2"))).toEqual([{ n: 0, gain: 0.8, expr: 2 }])
  })

  it('an unknown name is an ordinary param for that note alone', () => {
    // the synth already has a vocabulary; the notation does not need one
    expect(cyc(n("0'cut:.7 3"))).toEqual([{ n: 0, cut: 0.7 }, { n: 3 }])
  })

  it('works on absolute pitches and drum words too', () => {
    expect(cyc(note("c4'gain:.5"))).toEqual([{ note: 60, gain: 0.5 }])
    expect(cyc(s("kick'gain:.6 hat"))).toEqual([
      { sound: 'kick', note: 60, gain: 0.6 },
      { sound: 'hat', note: 60 },
    ])
  })

  it('survives a rest and a subgroup, like the single lane did', () => {
    expect(cyc(n("0'gain:.9 ~ [3'gain:.2 5'gain:.5] 7"))).toEqual([
      { n: 0, gain: 0.9 }, { n: 3, gain: 0.2 }, { n: 5, gain: 0.5 }, { n: 7 },
    ])
  })
})

describe('`chance` — per-note probability', () => {
  const line = "0'chance:.5 3'chance:.5 5'chance:.5 7'chance:.5"

  it('1 always sounds, 0 never does', () => {
    expect(cyc(n("0'chance:1 3'chance:1")).length).toBe(2)
    expect(cyc(n("0'chance:0 3'chance:0"))).toEqual([])
  })

  it('is REPRODUCIBLE — the same cycle gives the same notes, always', () => {
    /* The property that separates a probabilistic line you can put in a piece
     * from one that is merely random. It draws from the same time-locked
     * stream degradeBy uses, so a note that fires on cycle 3 fires on cycle 3
     * every time the loop comes round. */
    for (const c of [0, 1, 2, 7]) {
      expect(cyc(n(line), c), `cycle ${c}`).toEqual(cyc(n(line), c))
    }
  })

  it('differs BETWEEN cycles, or it would not be probability', () => {
    const shapes = [0, 1, 2, 3, 4, 5].map((c) => JSON.stringify(cyc(n(line), c)))
    expect(new Set(shapes).size, 'every cycle came out identical').toBeGreaterThan(1)
  })

  it('never leaks `chance` to the synth', () => {
    // structural: the engine consumes it, and a synth could not use it
    for (const v of cyc(n("0'chance:1 3'chance:1"))) {
      expect(Object.keys(v), 'chance reached the control map').not.toContain('chance')
    }
  })

  it('leaves the other lanes on the notes that survive', () => {
    const got = cyc(n("0'chance:1'gain:.4 3'chance:1'2"))
    expect(got).toEqual([{ n: 0, gain: 0.4 }, { n: 3, expr: 2 }])
  })
})

describe('notation that must keep working', () => {
  it('a lane with no value is not a lane', () => {
    expect(() => n("0'gain: 3")).toThrow()
    expect(() => n("0' 3")).toThrow()
  })

  it('leaves ordinary notation completely alone', () => {
    expect(cyc(n('0 3 5 7'))).toEqual([{ n: 0 }, { n: 3 }, { n: 5 }, { n: 7 }])
  })

  it('still reads an accidental beside the lanes', () => {
    expect(cyc(n("2#'gain:.5"))).toEqual([{ n: 2, nAcc: 1, gain: 0.5 }])
  })
})
