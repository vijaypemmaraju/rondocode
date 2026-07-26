import { afterEach, describe, expect, it } from 'vitest'
import {
  SCALES,
  clearCustomScales,
  defineScale,
  noteNameToMidi,
  parseScaleName,
  restoreCustomScales,
  scaleDegree,
  snapshotCustomScales,
} from '../src/scales'

describe('SCALES table', () => {
  it('has the v1 mode set with correct interval spellings', () => {
    expect(SCALES['major']).toEqual([0, 2, 4, 5, 7, 9, 11])
    expect(SCALES['minor']).toEqual([0, 2, 3, 5, 7, 8, 10])
    expect(SCALES['dorian']).toEqual([0, 2, 3, 5, 7, 9, 10])
    expect(SCALES['phrygian']).toEqual([0, 1, 3, 5, 7, 8, 10])
    expect(SCALES['lydian']).toEqual([0, 2, 4, 6, 7, 9, 11])
    expect(SCALES['mixolydian']).toEqual([0, 2, 4, 5, 7, 9, 10])
    expect(SCALES['aeolian']).toEqual(SCALES['minor'])
    expect(SCALES['locrian']).toEqual([0, 1, 3, 5, 6, 8, 10])
    expect(SCALES['pentatonic']).toEqual([0, 2, 4, 7, 9])
    expect(SCALES['minorPentatonic']).toEqual([0, 3, 5, 7, 10])
    expect(SCALES['chromatic']).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
})

describe('parseScaleName', () => {
  it('parses root + mode; the root sits in the octave nearest middle C', () => {
    // pitch classes 0..6 (c..f#) map up from 60; 7..11 (g..b) map just below
    expect(parseScaleName('c major')).toEqual({ root: 60, intervals: SCALES['major'], period: 12 })
    expect(parseScaleName('e minor').root).toBe(64)
    expect(parseScaleName('a dorian').root).toBe(57)
    expect(parseScaleName('f# mixolydian').root).toBe(66)
    expect(parseScaleName('g pentatonic').root).toBe(55)
    expect(parseScaleName('b locrian').root).toBe(59)
    expect(parseScaleName('bb lydian').root).toBe(58)
    expect(parseScaleName('c chromatic').root).toBe(60)
  })

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(parseScaleName('C Major').root).toBe(60)
    expect(parseScaleName('  a  minorpentatonic ').intervals).toEqual(
      SCALES['minorPentatonic'],
    )
  })

  it('throws on an unknown mode, naming the available ones', () => {
    expect(() => parseScaleName('c blorian')).toThrowError(/blorian/)
    expect(() => parseScaleName('c blorian')).toThrowError(/major/)
  })

  it('throws on a malformed root or missing mode', () => {
    expect(() => parseScaleName('h major')).toThrow()
    expect(() => parseScaleName('major')).toThrow()
    expect(() => parseScaleName('')).toThrow()
  })
})

describe('scaleDegree', () => {
  const major = SCALES['major']!
  const pent = SCALES['pentatonic']!

  it('reads degrees straight from the table within one octave', () => {
    expect(scaleDegree(major, 0)).toBe(0)
    expect(scaleDegree(major, 2)).toBe(4)
    expect(scaleDegree(major, 6)).toBe(11)
  })

  it('wraps past the scale length with an octave shift', () => {
    expect(scaleDegree(major, 7)).toBe(12)
    expect(scaleDegree(major, 9)).toBe(16)
    expect(scaleDegree(major, 14)).toBe(24)
    expect(scaleDegree(pent, 5)).toBe(12)
    expect(scaleDegree(pent, 6)).toBe(14)
  })

  it('mirrors negative degrees down through the octave below', () => {
    expect(scaleDegree(major, -1)).toBe(-1) // leading tone below the root
    expect(scaleDegree(major, -2)).toBe(-3)
    expect(scaleDegree(major, -7)).toBe(-12)
    expect(scaleDegree(pent, -1)).toBe(-3)
  })

  it('reads FLOAT interval tables verbatim (microtones)', () => {
    const bell = [0, 1.4, 3.8, 6.1, 9.2]
    expect(scaleDegree(bell, 1)).toBe(1.4)
    expect(scaleDegree(bell, 4)).toBe(9.2)
    expect(scaleDegree(bell, 5)).toBe(12) // wrap: 0 + default period
    expect(scaleDegree(bell, 6)).toBeCloseTo(13.4, 10)
    expect(scaleDegree(bell, -1)).toBeCloseTo(-2.8, 10) // 9.2 - 12
  })

  it('wraps by a CUSTOM period instead of 12 when given one', () => {
    // Bohlen-Pierce-style tritave: period 12*log2(3)
    const tritave = 12 * Math.log2(3)
    const steps = [0, 3, 6, 9]
    expect(scaleDegree(steps, 4, tritave)).toBeCloseTo(tritave, 10)
    expect(scaleDegree(steps, 5, tritave)).toBeCloseTo(3 + tritave, 10)
    expect(scaleDegree(steps, -1, tritave)).toBeCloseTo(9 - tritave, 10)
  })
})

describe('EDO scales', () => {
  it("parses '<n>edo' generically: n equal divisions of the octave", () => {
    const { root, intervals, period } = parseScaleName('c 19edo')
    expect(root).toBe(60)
    expect(period).toBe(12)
    expect(intervals.length).toBe(19)
    expect(intervals[0]).toBe(0)
    expect(intervals[1]).toBeCloseTo(12 / 19, 12)
    // degree 19 in 19edo = exactly one octave up
    expect(scaleDegree(intervals, 19, period)).toBe(12)
    expect(parseScaleName('a 31edo').intervals.length).toBe(31)
    expect(parseScaleName('f# 5edo').root).toBe(66)
    // 12edo degree k = k semitones (chromatic, computed not tabled)
    expect(scaleDegree(parseScaleName('c 12edo').intervals, 7, 12)).toBeCloseTo(7, 12)
  })

  it('rejects out-of-range divisions with the unknown-scale error style', () => {
    expect(() => parseScaleName('c 0edo')).toThrowError(/0edo/)
    expect(() => parseScaleName('c 97edo')).toThrowError(/97edo/)
    expect(() => parseScaleName('c 19edo ')).not.toThrow()
  })
})

describe('defineScale (custom tunings)', () => {
  afterEach(() => clearCustomScales())

  it('registers a plain offsets array (floats welcome), period 12', () => {
    defineScale('bell', [0, 1.4, 3.8, 6.1, 9.2])
    const { root, intervals, period } = parseScaleName('c bell')
    expect(root).toBe(60)
    expect(intervals).toEqual([0, 1.4, 3.8, 6.1, 9.2])
    expect(period).toBe(12)
  })

  it('registers a cents spec: cents/100 = semitones, periodCents optional', () => {
    defineScale('pelog', { cents: [0, 120, 270, 540, 670] })
    const a = parseScaleName('c pelog')
    expect(a.intervals).toEqual([0, 1.2, 2.7, 5.4, 6.7])
    expect(a.period).toBe(12)
    defineScale('stretch', { cents: [0, 600], periodCents: 1250 })
    expect(parseScaleName('c stretch').period).toBe(12.5)
  })

  it('registers a ratios spec: 12*log2(ratio), periodRatio defaults to 2', () => {
    defineScale('just', { ratios: [1, 5 / 4, 3 / 2] })
    const a = parseScaleName('c just')
    expect(a.intervals[0]).toBe(0)
    expect(a.intervals[1]).toBeCloseTo(3.863, 3) // just major third
    expect(a.intervals[2]).toBeCloseTo(7.02, 2) // just fifth
    expect(a.period).toBe(12)
    defineScale('bp', { ratios: [1, 25 / 21, 9 / 7], periodRatio: 3 })
    expect(parseScaleName('c bp').period).toBeCloseTo(12 * Math.log2(3), 10)
  })

  it('resolves case-insensitively and by any root', () => {
    defineScale('myBell', [0, 2.5, 7])
    expect(parseScaleName('a MYBELL').root).toBe(57)
    expect(parseScaleName('f# mybell').intervals).toEqual([0, 2.5, 7])
  })

  it('may NOT shadow a built-in scale', () => {
    expect(() => defineScale('major', [0, 1])).toThrowError(/shadow/)
    expect(() => defineScale('MinorPentatonic', [0, 1])).toThrowError(/shadow/)
  })

  it('redefines the same name silently (evals re-run whole programs)', () => {
    defineScale('bell', [0, 1])
    defineScale('bell', [0, 2])
    expect(parseScaleName('c bell').intervals).toEqual([0, 2])
  })

  it('rejects malformed names and specs', () => {
    expect(() => defineScale('', [0, 1])).toThrow(TypeError)
    expect(() => defineScale('19edo', [0, 1])).toThrow(TypeError) // digit start
    expect(() => defineScale('my scale', [0, 1])).toThrow(TypeError)
    expect(() => defineScale('ok', [])).toThrow(TypeError)
    expect(() => defineScale('ok', [0, NaN])).toThrow(TypeError)
    expect(() => defineScale('ok', { cents: [0, Infinity] })).toThrow(TypeError)
    expect(() => defineScale('ok', { cents: [0, 100], periodCents: -1 })).toThrow(TypeError)
    expect(() => defineScale('ok', { ratios: [1, 0] })).toThrow(TypeError)
    expect(() => defineScale('ok', { ratios: [1, 1.5], periodRatio: 1 })).toThrow(TypeError)
    expect(() => defineScale('ok', 42 as never)).toThrow(TypeError)
  })

  it('unknown-scale errors list the registered custom names', () => {
    defineScale('bell', [0, 1])
    expect(() => parseScaleName('c blorian')).toThrowError(/custom: bell/)
  })

  it('clear/snapshot/restore drive the eval-boundary lifecycle', () => {
    defineScale('bell', [0, 1.5])
    const snap = snapshotCustomScales()
    clearCustomScales()
    expect(() => parseScaleName('c bell')).toThrow()
    restoreCustomScales(snap)
    expect(parseScaleName('c bell').intervals).toEqual([0, 1.5])
  })
})

describe('noteNameToMidi', () => {
  it('parses letter + accidental + octave with c4 = 60', () => {
    expect(noteNameToMidi('c4')).toBe(60)
    expect(noteNameToMidi('a4')).toBe(69)
    expect(noteNameToMidi('f#3')).toBe(54)
    expect(noteNameToMidi('eb2')).toBe(39)
    expect(noteNameToMidi('g5')).toBe(79)
    expect(noteNameToMidi('c0')).toBe(12)
    expect(noteNameToMidi('c-1')).toBe(0)
  })

  it('defaults a missing octave to 4', () => {
    expect(noteNameToMidi('c')).toBe(60)
    expect(noteNameToMidi('a')).toBe(69)
    expect(noteNameToMidi('bb')).toBe(70)
  })

  it('is case-insensitive on the letter', () => {
    expect(noteNameToMidi('C4')).toBe(60)
    expect(noteNameToMidi('F#3')).toBe(54)
  })

  it('carries enharmonics across the octave boundary (b# up, cb down)', () => {
    expect(noteNameToMidi('b#4')).toBe(72) // enharmonic c5, NOT c4
    expect(noteNameToMidi('cb4')).toBe(59) // enharmonic b3, NOT b4
    expect(noteNameToMidi('b#')).toBe(72)
    expect(noteNameToMidi('cb')).toBe(59)
  })

  it('returns raw midi math outside 0..127 (documented, not clamped)', () => {
    expect(noteNameToMidi('c10')).toBe(132)
    expect(noteNameToMidi('c-2')).toBe(-12)
  })

  it('returns undefined for anything that is not a note name', () => {
    expect(noteNameToMidi('xyz')).toBeUndefined()
    expect(noteNameToMidi('c##4')).toBeUndefined()
    expect(noteNameToMidi('4')).toBeUndefined()
    expect(noteNameToMidi('')).toBeUndefined()
  })
})
