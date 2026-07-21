import { describe, expect, it } from 'vitest'
import { Pattern, arrange, rise, fall } from '../src/index'
import { q, at } from './helpers'

const { pure, cat, fastcat } = Pattern

/* ------------------------------------------------------------------------- *
 * The song-arrangement layer: arrange() sequences whole sections over cycle
 * ranges and loops; rise/fall are named transition ramps. Values are pinned
 * cycle by cycle; the q helper enforces the part ⊆ whole / part ⊆ query
 * invariants on every hap it returns.
 * ------------------------------------------------------------------------- */

describe('arrange', () => {
  it('plays each section for its cycleCount, then loops over the total', () => {
    // total = 2 + 1 = 3, so the arrangement repeats every 3 cycles.
    const a = arrange<string>([2, pure('a')], [1, pure('b')])
    expect(q(a, 0, 1)).toEqual([[0, 1, 'a']])
    expect(q(a, 1, 2)).toEqual([[1, 2, 'a']])
    expect(q(a, 2, 3)).toEqual([[2, 3, 'b']])
    // loop: cycle 3 == cycle 0
    expect(q(a, 3, 4)).toEqual([[3, 4, 'a']])
  })

  it('restarts a section at its own cycle 0 each loop, advancing inner structure within the window', () => {
    // Section 0 is a 2-cycle cat; over its 2-cycle window it plays x then y,
    // and it restarts (x again) every time the loop comes back to it.
    const a = arrange<string>([2, cat(pure('x'), pure('y'))], [1, pure('z')])
    const values = [0, 1, 2, 3, 4, 5].map((c) => q(a, c, c + 1)[0]![2])
    expect(values).toEqual(['x', 'y', 'z', 'x', 'y', 'z'])
  })

  it("preserves a section pattern's within-cycle structure", () => {
    const a = arrange<string>([1, fastcat(pure('a'), pure('b'))], [1, pure('c')])
    expect(q(a, 0, 1)).toEqual([
      [0, 0.5, 'a'],
      [0.5, 1, 'b'],
    ])
    expect(q(a, 1, 2)).toEqual([[1, 2, 'c']])
  })

  it('reifies bare section values', () => {
    const a = arrange<string>([1, 'a'], [1, 'b'])
    expect(q(a, 0, 1)).toEqual([[0, 1, 'a']])
    expect(q(a, 1, 2)).toEqual([[1, 2, 'b']])
  })

  it('holds the invariants when queried across many cycles at once', () => {
    // A multi-cycle query exercises splitQueries; q asserts the invariants.
    const a = arrange<string>([2, cat(pure('x'), pure('y'))], [1, pure('z')])
    expect(q(a, 0, 6).map((h) => h[2])).toEqual(['x', 'y', 'z', 'x', 'y', 'z'])
    // and a fractional / offset span still holds together
    expect(() => q(a, 0.5, 3.5)).not.toThrow()
  })

  it('rejects an empty arrangement', () => {
    expect(() => arrange()).toThrow(/at least one section/i)
  })

  it('rejects a non-integer, zero, or negative cycleCount', () => {
    expect(() => arrange<string>([1.5, pure('a')])).toThrow(/positive integer/i)
    expect(() => arrange<string>([0, pure('a')])).toThrow(/positive integer/i)
    expect(() => arrange<string>([-2, pure('a')])).toThrow(/positive integer/i)
  })
})

describe('rise / fall', () => {
  it('rise ramps 0→1 over its cycle count (saw.slow midpoints)', () => {
    // rise(4) === saw.slow(4): cycle midpoints are 1/8, 3/8, 5/8, 7/8.
    expect(at(rise(4), 0.5)).toBeCloseTo(0.125, 10)
    expect(at(rise(4), 1.5)).toBeCloseTo(0.375, 10)
    expect(at(rise(4), 2.5)).toBeCloseTo(0.625, 10)
    expect(at(rise(4), 3.5)).toBeCloseTo(0.875, 10)
  })

  it('rise stays within [0, 1) and defaults to 8 cycles', () => {
    expect(at(rise(), 0)).toBeCloseTo(0, 10)
    // just before completing the 8-cycle ramp
    expect(at(rise(), 7.99)).toBeLessThan(1)
    expect(at(rise(), 7.99)).toBeGreaterThan(0.99)
  })

  it('fall is 1 − rise', () => {
    for (const t of [0.5, 1.5, 2.5, 3.5]) {
      expect(at(fall(4), t)).toBeCloseTo(1 - at(rise(4), t), 10)
    }
  })
})
