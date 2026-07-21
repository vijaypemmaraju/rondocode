import { describe, it, expect } from 'vitest'
import { Pattern, note } from '../src/index'
import { q, qw, sortHaps, span } from './helpers'

const { pure, fastcat } = Pattern

/** part.begin values of the onsets in [b, e). */
const onsets = <T>(p: Pattern<T>, b: number, e: number): number[] =>
  sortHaps(p.onsetsOnly().query(span(b, e))).map((h) => h.part.begin.valueOf())

describe('roll', () => {
  it('roll(4) — even spacing (accel default 1): hits at 0, 1/4, 1/2, 3/4', () => {
    expect(qw(pure('x').roll(4), 0, 1)).toEqual([
      { whole: [0, 0.25], part: [0, 0.25], value: 'x' },
      { whole: [0.25, 0.5], part: [0.25, 0.5], value: 'x' },
      { whole: [0.5, 0.75], part: [0.5, 0.75], value: 'x' },
      { whole: [0.75, 1], part: [0.75, 1], value: 'x' },
    ])
  })

  it('every hit carries the original value and has an onset', () => {
    const haps = pure('x').roll(4).query(span(0, 1))
    expect(haps.length).toBe(4)
    for (const h of haps) {
      expect(h.value).toBe('x')
      // onset: whole begins where part begins
      expect(h.whole!.begin.eq(h.part.begin)).toBe(true)
    }
  })

  it('roll(4, 2) — accelerating: hits at 0, 7/16, 3/4, 15/16 (gaps 7/16,5/16,3/16,1/16)', () => {
    expect(qw(pure('x').roll(4, 2), 0, 1)).toEqual([
      { whole: [0, 7 / 16], part: [0, 7 / 16], value: 'x' },
      { whole: [7 / 16, 0.75], part: [7 / 16, 0.75], value: 'x' },
      { whole: [0.75, 15 / 16], part: [0.75, 15 / 16], value: 'x' },
      { whole: [15 / 16, 1], part: [15 / 16, 1], value: 'x' },
    ])
    // gaps strictly decreasing → accelerating into the downbeat
    const on = onsets(pure('x').roll(4, 2), 0, 1).concat(1)
    const gaps = on.slice(1).map((t, i) => t - on[i]!)
    expect(gaps).toEqual([7 / 16, 5 / 16, 3 / 16, 1 / 16])
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeLessThan(gaps[i - 1]!)
  })

  it('accel < 1 decelerates: gaps strictly increasing', () => {
    const on = onsets(pure('x').roll(4, 0.5), 0, 1).concat(1)
    const gaps = on.slice(1).map((t, i) => t - on[i]!)
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!)
  })

  it('inside a sequence: fastcat(a,b).roll(2) subdivides each half', () => {
    expect(qw(fastcat(pure('a'), pure('b')).roll(2), 0, 1)).toEqual([
      { whole: [0, 0.25], part: [0, 0.25], value: 'a' },
      { whole: [0.25, 0.5], part: [0.25, 0.5], value: 'a' },
      { whole: [0.5, 0.75], part: [0.5, 0.75], value: 'b' },
      { whole: [0.75, 1], part: [0.75, 1], value: 'b' },
    ])
  })

  it("note('c2').roll(8, 3) — 8 accelerating onsets, monotonic times, decreasing gaps", () => {
    const on = onsets(note('c2').roll(8, 3), 0, 1)
    expect(on.length).toBe(8)
    for (let i = 1; i < on.length; i++) expect(on[i]!).toBeGreaterThan(on[i - 1]!)
    const bounded = on.concat(1)
    const gaps = bounded.slice(1).map((t, i) => t - bounded[i]!)
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeLessThan(gaps[i - 1]!)
  })

  it('continuous (whole-less) haps pass through unchanged', () => {
    // saw is a continuous signal; roll leaves it as a single sample
    const haps = Pattern.steady(5).roll(4).query(span(0, 1))
    expect(haps.length).toBe(1)
    expect(haps[0]!.whole).toBeUndefined()
    expect(haps[0]!.value).toBe(5)
  })

  it('validates: roll(0), roll(3,0), roll(2.5) throw', () => {
    expect(() => pure('x').roll(0)).toThrow()
    expect(() => pure('x').roll(3, 0)).toThrow()
    expect(() => pure('x').roll(-1)).toThrow()
    expect(() => pure('x').roll(2.5)).toThrow()
    expect(() => pure('x').roll(4, -2)).toThrow()
  })

  it('invariants hold under a partial / cross-boundary query', () => {
    // q() asserts part ⊆ whole and part ⊆ query span
    q(pure('x').roll(4, 2), 0.3, 1.7)
    q(fastcat(pure('a'), pure('b')).roll(3), -0.5, 2.5)
  })

  it("composes as a fill: note('c2').roll(16, 2).sound('sn') yields 16 sounding events", () => {
    const haps = note('c2').roll(16, 2).sound('sn').onsetsOnly().query(span(0, 1))
    expect(haps.length).toBe(16)
    for (const h of haps) {
      expect(h.value.note).toBe(36) // c2 midi (c4 = 60)
      expect(h.value.sound).toBe('sn')
    }
  })
})
