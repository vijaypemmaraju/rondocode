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
 * THREE NAMES ARE STRUCTURAL (gain, dur, chance) because the pattern engine
 * consumes them. Everything else is an ordinary param and reaches the synth
 * untouched, which is the point: the language should not own a vocabulary of
 * musical properties when the synth already has one.
 * ------------------------------------------------------------------------- */

const cyc = (p: unknown, c = 0): Record<string, unknown>[] =>
  (p as { query: (t: TimeSpan) => { value: Record<string, unknown> }[] })
    .query(new TimeSpan(new F(c), new F(c + 1)))
    .filter(hasOnset as never)
    /* Strip the METADATA that rides along with every event: `loc` for the
     * editor's note flash, `laneKeys` for lane provenance (see ControlMap).
     * Neither is a control, and asserting them here would make every test in
     * this file about bookkeeping rather than about what a lane does. */
    .map((h) => { const v = { ...h.value }; delete v['loc']; delete v['laneKeys']; return v })

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

/* ------------------------------------------------------------------------- *
 * A LANE BEATS A BLOCK MODIFIER.
 *
 * `cutoff: 17100` on the block and `0'cutoff:500` on a note used to resolve to
 * 17100 — not by any decision, but because `.ctrl()` was applied after the
 * notation was built and overwrote whatever was there. So a lane looked broken
 * on exactly the blocks where it is most useful: the ones that also set a
 * baseline for every other note.
 *
 * The value written ON the note is the more specific of the two, and
 * specificity is what every other layered system resolves by.
 * ------------------------------------------------------------------------- */

describe('a per-note lane overrides a block modifier', () => {
  it('an ordinary param: the lane wins, other notes take the block value', () => {
    const got = cyc((n("0'cutoff:500 3") as never as { ctrl: (k: string, v: number) => unknown })
      .ctrl('cutoff', 17100))
    expect(got[0]!['cutoff'], 'the block overwrote the note').toBe(500)
    expect(got[1]!['cutoff'], 'a note with no lane should take the block value').toBe(17100)
  })

  it('the structural ones too — gain and dur', () => {
    const p = n("0'gain:.1'dur:.1 3") as never as
      { gain: (v: number) => { dur: (v: number) => unknown } }
    const got = cyc(p.gain(0.9).dur(0.7))
    expect(got[0]!['gain']).toBe(0.1)
    expect(got[0]!['dur']).toBe(0.1)
    expect(got[1]!['gain']).toBe(0.9)
    expect(got[1]!['dur']).toBe(0.7)
  })

  it('a lane only defends ITS OWN control', () => {
    // `0'gain:.1` must not stop the block from setting cutoff on that note
    const got = cyc((n("0'gain:.1") as never as
      { gain: (v: number) => { ctrl: (k: string, v: number) => unknown } })
      .gain(0.9).ctrl('cutoff', 900))
    expect(got[0]!['gain']).toBe(0.1)
    expect(got[0]!['cutoff'], 'an unrelated control was blocked').toBe(900)
  })

  it('chained ctrl calls still override each other', () => {
    /* Only a LANE is protected. Two block modifiers for the same control are
     * both block-level, so the later one wins as it always did. */
    const got = cyc((n('0') as never as { gain: (v: number) => { gain: (v: number) => unknown } })
      .gain(0.5).gain(0.9))
    expect(got[0]!['gain']).toBe(0.9)
  })

  it('a block modifier still reaches every note when none carries a lane', () => {
    const got = cyc((n('0 3 5') as never as { gain: (v: number) => unknown }).gain(0.42))
    expect(got.map((g) => g['gain'])).toEqual([0.42, 0.42, 0.42])
  })

  it('the provenance never reaches a synth', () => {
    /* `laneKeys` is bookkeeping. It is in RESERVED_PARAM_NAMES so it can never
     * be mistaken for a param, and it is not a number so every dispatcher
     * skips it anyway — belt and braces, because a stray control key becomes a
     * silent `unknown param` at the engine. */
    const raw = (n("0'cutoff:500") as never as { query: (t: TimeSpan) => { value: Record<string, unknown> }[] })
      .query(new TimeSpan(new F(0), new F(1)))[0]!.value
    expect(raw['laneKeys']).toEqual(['cutoff'])
    expect(typeof raw['laneKeys']).not.toBe('number')
  })
})
