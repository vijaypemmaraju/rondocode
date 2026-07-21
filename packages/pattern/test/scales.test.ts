import { describe, expect, it } from 'vitest'
import {
  SCALES,
  noteNameToMidi,
  parseScaleName,
  scaleDegree,
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
    expect(parseScaleName('c major')).toEqual({ root: 60, intervals: SCALES['major'] })
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
