import { describe, expect, it } from 'vitest'
import { note, s } from '../src/index'
import { q } from './helpers'

/* .chop and .striate: slicing a sample across events by writing begin/end.
 * chop walks ONE event through its own slices in place; striate sweeps the
 * SAME slice across every event, then moves to the next slice. */

describe('chop', () => {
  it('splits one event into n consecutive slices filling its span', () => {
    const haps = q(note(60).sound('break').chop(4), 0, 1)
    expect(haps.map(([b, e]) => [b, e])).toEqual([[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1]])
    expect(haps.map(([, , v]) => [v.begin, v.end])).toEqual([
      [0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1],
    ])
    // rhythm/route preserved
    for (const [, , v] of haps) { expect(v.note).toBe(60); expect(v.sound).toBe('break') }
  })

  it('slices each event of a multi-step pattern within its own step', () => {
    const haps = q(s('a b').chop(2), 0, 1)
    expect(haps.map(([b, e, v]) => [b, e, v.sound, v.begin, v.end])).toEqual([
      [0, 0.25, 'a', 0, 0.5],
      [0.25, 0.5, 'a', 0.5, 1],
      [0.5, 0.75, 'b', 0, 0.5],
      [0.75, 1, 'b', 0.5, 1],
    ])
  })

  it('n=1 is identity; non-positive throws', () => {
    expect(q(s('a').chop(1), 0, 1)).toEqual(q(s('a'), 0, 1))
    expect(() => s('a').chop(0)).toThrow(/positive integer/)
  })

  it('nests: chop within a chop narrows rather than resets the window', () => {
    const haps = q(note(60).sound('x').chop(2).chop(2), 0, 1)
    expect(haps.map(([, , v]) => [v.begin, v.end])).toEqual([
      [0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1],
    ])
  })
})

describe('striate', () => {
  it('sweeps the same slice across all events, pass by pass', () => {
    // two events, 2 slices: pass 0 = slice 0 of a then b; pass 1 = slice 1
    const haps = q(s('a b').striate(2), 0, 1)
    expect(haps.map(([b, e, v]) => [b, e, v.sound, v.begin, v.end])).toEqual([
      [0, 0.25, 'a', 0, 0.5],
      [0.25, 0.5, 'b', 0, 0.5],
      [0.5, 0.75, 'a', 0.5, 1],
      [0.75, 1, 'b', 0.5, 1],
    ])
  })

  it('n=1 is identity; non-positive throws', () => {
    expect(q(s('a b').striate(1), 0, 1)).toEqual(q(s('a b'), 0, 1))
    expect(() => s('a').striate(-2)).toThrow(/positive integer/)
  })
})

describe('patterned counts', () => {
  it('chop takes a mini-string count that changes per cycle', () => {
    const p = s('break').chop('<2 4>')
    expect(q(p, 0, 1).map(([, , v]) => [v.begin, v.end])).toEqual([[0, 0.5], [0.5, 1]])
    expect(q(p, 1, 2).map(([, , v]) => [v.begin, v.end])).toEqual([
      [0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1],
    ])
  })

  it('striate takes a patterned count too', () => {
    // cycle 0: 2 passes over 2 events = 4 haps
    expect(q(s('a b').striate('<2 3>'), 0, 1).length).toBe(4)
    // cycle 1: 3 passes over 2 events = 6 haps
    expect(q(s('a b').striate('<2 3>'), 1, 2).length).toBe(6)
  })

  it('a patterned value below 1 slices by 1 (no slicing) rather than throwing', () => {
    expect(q(s('a').chop('<1 0>'), 1, 2).map(([, , v]) => v.sound)).toEqual(['a'])
  })
})
