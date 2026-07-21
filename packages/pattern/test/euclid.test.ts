import { describe, it, expect } from 'vitest'
import { bjorklund } from '../src/index'

/** "x.x." → [true, false, true, false] */
const bits = (s: string): boolean[] => [...s].map((c) => c === 'x')

describe('bjorklund', () => {
  // Pinned to Strudel/Tidal's _bjorklund output (the parity bar: patterns
  // ported from Strudel must hear the same rhythm). This matches Toussaint's
  // paper for every (pulses, steps) <= 16 EXCEPT the E(n-1, n) family, where
  // the algorithm stops before any pairing: E(2,3) = xx. (Toussaint: x.x).
  const table: [number, number, string][] = [
    [2, 3, 'xx.'],
    [3, 4, 'xxx.'],
    [2, 5, 'x.x..'],
    [3, 8, 'x..x..x.'],
    [4, 9, 'x.x.x.x..'],
    [5, 8, 'x.xx.xx.'],
    [7, 12, 'x.xx.x.xx.x.'],
    [1, 4, 'x...'],
    [4, 12, 'x..x..x..x..'],
  ]

  for (const [pulses, steps, expected] of table) {
    it(`E(${pulses},${steps}) = [${expected}]`, () => {
      expect(bjorklund(pulses, steps)).toEqual(bits(expected))
    })
  }

  it('E(0,n) is all rests, E(n,n) all onsets, pulses > steps saturates', () => {
    expect(bjorklund(0, 4)).toEqual(bits('....'))
    expect(bjorklund(4, 4)).toEqual(bits('xxxx'))
    expect(bjorklund(5, 4)).toEqual(bits('xxxx'))
    expect(bjorklund(-1, 3)).toEqual(bits('...'))
  })

  it('always returns `steps` slots with `min(max(pulses,0),steps)` onsets', () => {
    for (let steps = 1; steps <= 16; steps++) {
      for (let pulses = 0; pulses <= steps; pulses++) {
        const r = bjorklund(pulses, steps)
        expect(r.length).toBe(steps)
        expect(r.filter(Boolean).length).toBe(pulses)
        expect(r[0]).toBe(pulses > 0)
      }
    }
  })

  it('rejects non-integers and non-positive step counts', () => {
    expect(() => bjorklund(2.5, 8)).toThrow(TypeError)
    expect(() => bjorklund(2, 8.5)).toThrow(TypeError)
    expect(() => bjorklund(2, 0)).toThrow(RangeError)
    expect(() => bjorklund(2, -8)).toThrow(RangeError)
  })
})
