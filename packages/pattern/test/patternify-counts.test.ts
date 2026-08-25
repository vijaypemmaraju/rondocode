import { describe, expect, it } from 'vitest'
import { n, s, note } from '../src/index'
import { q } from './helpers'

/* PATTERNIFIED COUNTS (patternify.ts): a combinator's numeric arg may itself be
 * a pattern, so the count changes over time — the Strudel move. Two things must
 * hold for every wrapped method: a plain number takes the original path
 * unchanged, and a mini string / pattern drives the count per its own spans. */

const count = (p: ReturnType<typeof s>, a: number, b: number): number => q(p, a, b).length

describe('patterned counts drive the transform per cycle', () => {
  it('fast <1 2>: cycle 0 unchanged, cycle 1 doubled', () => {
    expect(count(s('a b').fast('<1 2>'), 0, 1)).toBe(2)
    expect(count(s('a b').fast('<1 2>'), 1, 2)).toBe(4)
  })
  it('slow <1 2>: cycle 1 stretches', () => {
    expect(count(s('a b c d').slow('<1 2>'), 0, 1)).toBe(4)
    expect(count(s('a b c d').slow('<1 2>'), 1, 2)).toBe(2)
  })
  it('ply <1 3>', () => {
    expect(count(note(60).ply('<1 3>'), 0, 1)).toBe(1)
    expect(count(note(60).ply('<1 3>'), 1, 2)).toBe(3)
  })
  it('segment <2 4>', () => {
    expect(count(s('x').segment('<2 4>'), 0, 1)).toBe(2)
    expect(count(s('x').segment('<2 4>'), 1, 2)).toBe(4)
  })
  it('euclid with a patterned pulse count', () => {
    expect(count(s('x').euclid('<3 5>', 8), 0, 1)).toBe(3)
    expect(count(s('x').euclid('<3 5>', 8), 1, 2)).toBe(5)
  })
  it('euclid with a patterned STEP count (second arg)', () => {
    expect(count(s('x').euclid(3, '<8 16>'), 0, 1)).toBe(3) // 3 pulses either way
    // the rhythm differs, but the pulse count is 3 in both; assert it parses+runs
    expect(count(s('x').euclid(3, '<8 16>'), 1, 2)).toBe(3)
  })
  it('degradeBy <0 1>: keep all, then drop all', () => {
    expect(count(note(60).fast(4).degradeBy('<0 1>'), 0, 1)).toBe(4)
    expect(count(note(60).fast(4).degradeBy('<0 1>'), 1, 2)).toBe(0)
  })
  it('every with a patterned period applies rev on the right cycles', () => {
    const p = n('0 1').every('<1 2>', (x) => x.rev())
    // period 1 on cycle 0 → always reversed; period 2 on cycle 1 → cycle%2===0 test
    expect(q(p, 0, 1).map(([, , v]) => v.n)).toEqual([1, 0])
  })
})

describe('a plain number is unchanged (the fast path)', () => {
  it('fast/slow/ply/segment/euclid with numbers match the pre-feature result', () => {
    expect(count(s('a b').fast(2), 0, 1)).toBe(4)
    expect(count(s('a b c d').slow(2), 0, 1)).toBe(2)
    expect(count(note(60).ply(3), 0, 1)).toBe(3)
    expect(count(s('x').segment(4), 0, 1)).toBe(4)
    expect(count(s('x').euclid(3, 8), 0, 1)).toBe(3)
  })
  it('roll takes a patterned count too (two-arg)', () => {
    expect(count(note(60).roll('<2 4>'), 0, 1)).toBe(2)
    expect(count(note(60).roll('<2 4>'), 1, 2)).toBe(4)
  })
})

/* Count locs: a patterned count is mini-notation the reader wrote and watches,
 * so the events its transform shaped carry the count atom's source range in
 * `locs` for the editor's note-flash. The scalar path stays byte-identical. */
describe('patterned counts carry their atom loc (editor flash)', () => {
  it("fast('<1 2>') stamps events with the sounding count atom's range", () => {
    const c0 = q(s('a').fast('<1 2>'), 0, 1).map(([, , v]) => v)
    expect(c0.length).toBeGreaterThan(0)
    for (const v of c0) expect(v.locs).toEqual([{ start: 1, end: 2, src: '<1 2>' }])
    const c1 = q(s('a').fast('<1 2>'), 1, 2).map(([, , v]) => v)
    for (const v of c1) expect(v.locs).toEqual([{ start: 3, end: 4, src: '<1 2>' }])
    // scalar counts take the original core: no locs key appears
    for (const [, , v] of q(s('a b').fast(2), 0, 1)) expect(v.locs).toBeUndefined()
  })

  it('every patterned count of a multi-count combinator stamps its range', () => {
    const vals = q(s('x').euclid('<3>', '<8>'), 0, 1).map(([, , v]) => v)
    expect(vals).toHaveLength(3)
    for (const v of vals) {
      expect(new Set(v.locs?.map((l) => l.src))).toEqual(new Set(['<3>', '<8>']))
    }
  })
})
