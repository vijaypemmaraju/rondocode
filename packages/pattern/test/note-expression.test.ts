import { describe, expect, it } from 'vitest'
import { Fraction as F, TimeSpan, hasOnset, n, note, s } from '../src/index'

/* ------------------------------------------------------------------------- *
 * PER-NOTE EXPRESSION: `0'2`.
 *
 * Values already reached a synth per event — a modifier line (`amt: 2 0 1 3`)
 * is an ordinary control pattern and the delivery path was never the problem.
 * ALIGNMENT was. A control pattern lines up by TIME, so it only corresponds to
 * notes while the notation is a flat, even row:
 *
 *     0 3 5 7      + amt: 2 0 1 3   ->  2 0 1 3   correct, by luck of shape
 *     0 3 5 7      + amt: 2 0       ->  2 2 0 0   stretched, not per note
 *     0 ~ [3 5] 7  + amt: 2 0 1 3   ->  2 1 1 3   both subgroup notes get 1,
 *                                                 and the REST consumed the 0
 *
 * A value written ON the note cannot drift, because it never leaves the note.
 * That is the whole feature; these pin it.
 * ------------------------------------------------------------------------- */

const cycle = (p: { query: (t: TimeSpan) => { value: Record<string, unknown> }[] }): Record<string, unknown>[] =>
  p.query(new TimeSpan(new F(0), new F(1))).filter(hasOnset as never).map((h) => h.value)

const exprs = (p: Parameters<typeof cycle>[0]): unknown[] => cycle(p).map((v) => v['expr'])

describe('the `\'value` suffix attaches to the note', () => {
  it('gives each note its own value on a flat row', () => {
    expect(exprs(n("0'2 3'0 5'1 7'3"))).toEqual([2, 0, 1, 3])
  })

  it('SURVIVES a rest and a subgroup — the case a control pattern gets wrong', () => {
    const got = cycle(n("0'2 ~ [3'1 5'3] 7'-1"))
    expect(got.map((v) => [v['n'], v['expr']])).toEqual([[0, 2], [3, 1], [5, 3], [7, -1]])
  })

  it('survives an alternation, which changes which note sounds per cycle', () => {
    const p = n("<0'2 9'-3> 3'1")
    expect(exprs(p)).toEqual([2, 1])
    const next = p.query(new TimeSpan(new F(1), new F(2))).filter(hasOnset).map((h) => (h.value as Record<string, unknown>)['expr'])
    expect(next, 'the second cycle takes the other arm and ITS value').toEqual([-3, 1])
  })

  it('rides through a subgroup that is squeezed into one step', () => {
    // the values must not be re-timed along with the notes
    expect(exprs(n("[0'1 3'2 5'3] 7'4"))).toEqual([1, 2, 3, 4])
  })

  it('is absent — not zero — on a note that carries none', () => {
    // undefined lets a synth's own default stand; 0 would silently override it
    expect(exprs(n("0 3'2 5"))).toEqual([undefined, 2, undefined])
  })
})

describe('what a value may be', () => {
  it('takes negatives and decimals', () => {
    expect(exprs(n("0'-2 3'0.5 5'-0.25"))).toEqual([-2, 0.5, -0.25])
  })

  it('rides on an accidental without eating it', () => {
    const got = cycle(n("2#'3 4b'-1"))
    expect(got.map((v) => [v['n'], v['nAcc'], v['expr']])).toEqual([[2, 1, 3], [4, -1, -1]])
  })

  it('does not disturb the other modifiers', () => {
    // `!` `@` `*` all still apply to a note that carries a value
    expect(exprs(n("0'2!2 3'1@2"))).toEqual([2, 2, 1])
  })
})

describe('every entry path carries it', () => {
  it('n() — scale degrees', () => {
    expect(exprs(n("0'2 3'0"))).toEqual([2, 0])
  })

  it('note() — absolute pitches', () => {
    const got = cycle(note("c4'2 e4'0"))
    expect(got.map((v) => [v['note'], v['expr']])).toEqual([[60, 2], [64, 0]])
  })

  it('s() — drum words', () => {
    const got = cycle(s("kick'2 hat'1"))
    expect(got.map((v) => [v['sound'], v['expr']])).toEqual([['kick', 2], ['hat', 1]])
  })
})

describe('notation that must keep working', () => {
  it('a bare quote is not an expression, and does not silently vanish', () => {
    // it has to FAIL rather than parse as something else
    expect(() => n("0' 3")).toThrow()
  })

  it('leaves ordinary notation completely alone', () => {
    expect(cycle(n('0 3 5 7')).map((v) => v['expr'])).toEqual([undefined, undefined, undefined, undefined])
    expect(cycle(n('0 ~ [3 5] 7')).map((v) => v['n'])).toEqual([0, 3, 5, 7])
  })

  it('a word containing digits still lexes (c4, bd:3)', () => {
    expect(cycle(s('bd:3 hat')).map((v) => v['sound'])).toEqual(['bd:3', 'hat'])
  })
})
