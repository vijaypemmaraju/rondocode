import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset, note } from '../src/index'
import type { ControlMap, Hap } from '../src/index'

const span = new TimeSpan(F(0), F(1))
const onsets = (haps: Hap<ControlMap>[]): Hap<ControlMap>[] =>
  haps.filter(hasOnset).sort((a, b) => Number(a.whole!.begin.valueOf()) - Number(b.whole!.begin.valueOf()))

describe('slur: content-aware bowing', () => {
  it('ties contiguous different pitches, never ties a repeated pitch', () => {
    const haps = onsets(note('a4 a4 b4 c5 ~').slur(1).query(span))
    // a4 -> a4 is the invisible boundary: MUST re-articulate. b4 -> c5 ties.
    // The trailing rest ends the phrase, so c5 does not tie.
    expect(haps.map((h) => h.value.slide ?? 0)).toEqual([0, 1, 1, 0])
  })

  it('patterns loop: with no trailing rest the last note ties into the next cycle', () => {
    const haps = onsets(note('a4 b4').slur(1).query(span))
    expect(haps.map((h) => h.value.slide ?? 0)).toEqual([1, 1]) // b4 -> a4 of cycle 1
  })

  it('a rest breaks the phrase even between different pitches', () => {
    const haps = onsets(note('a4 ~ b4 c5 ~').slur(1).query(span))
    expect(haps.map((h) => h.value.slide ?? 0)).toEqual([0, 1, 0])
  })

  it('prob 0 never ties; the draw is deterministic across re-queries', () => {
    expect(onsets(note('a4 b4 c5 d5').slur(0).query(span)).every((h) => h.value.slide === undefined)).toBe(true)
    const a = onsets(note('d4 e4 f#4 g4 a4 b4 c#5 ~').slur(0.5).query(span)).map((h) => h.value.slide ?? 0)
    const b = onsets(note('d4 e4 f#4 g4 a4 b4 c#5 ~').slur(0.5).query(span)).map((h) => h.value.slide ?? 0)
    expect(a).toEqual(b)
    expect(a[a.length - 1]).toBe(0) // rest-ended phrase: last note never ties
  })

  it('explicit slide wins over the helper', () => {
    const haps = onsets(note('a4 b4').slide(0).slur(1).query(span))
    expect(haps.map((h) => h.value.slide)).toEqual([0, 0])
  })

  it('ties across the bar line of an alternation', () => {
    // bar 1 ends g4, bar 2 begins a4: contiguous different pitches -> tie
    const two = new TimeSpan(F(0), F(2))
    const haps = onsets(note('<[e4 f4 g4 g4] [a4 b4 c5 d5 ~]>').slur(1).query(two))
    expect(haps.map((h) => h.value.slide ?? 0)).toEqual([1, 1, 0, 1, 1, 1, 1, 0])
  })

  it('leaves non-note events untouched', () => {
    const haps = onsets(note('a4 b4').sound('vln').slur(1).query(span))
    expect(haps[0]!.value.sound).toBe('vln')
    expect(haps[0]!.value.slide).toBe(1)
  })
})
