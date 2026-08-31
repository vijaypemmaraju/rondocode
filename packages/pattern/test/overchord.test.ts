import { describe, expect, it } from 'vitest'
import { chord, chordDegree, mini, n } from '../src/index'
import { q } from './helpers'

/* Arpeggiating over a chord PATTERN: the degree pattern is the rhythm and the
 * chord pattern is the harmony. The property that matters is that one degree
 * figure re-voices itself as the chords move under it — that is what makes an
 * arp pattern reusable instead of a transcription. */

const notes = (p: ReturnType<typeof n>, a: number, b: number): number[] =>
  q(p, a, b).map((t) => (typeof t[2] === 'number' ? t[2] : (t[2] as { note: number }).note))

describe('chordDegree', () => {
  it('wraps up an octave past the top, not clamping', () => {
    expect([0, 1, 2, 3, 4].map((d) => chordDegree([60, 64, 67], d))).toEqual([60, 64, 67, 72, 76])
  })
  it('wraps downward for negatives', () => {
    expect([-1, -2].map((d) => chordDegree([60, 64, 67], d))).toEqual([55, 52])
  })
  it('is null with no chord', () => {
    expect(chordDegree([], 0)).toBeNull()
  })
})

describe('one figure, moving harmony', () => {
  it('re-voices the SAME degrees onto each chord', () => {
    // Am(a c e) then F(f a c), one chord per cycle
    const p = n('0 1 2 3').overChord(chord('<Am F>'))
    expect(notes(p, 0, 1)).toEqual([57, 60, 64, 69]) // a c e a'
    expect(notes(p, 1, 2)).toEqual([53, 57, 60, 65]) // f a c f'  — same shape
  })

  it('keeps the degree pattern’s own rhythm', () => {
    const p = n('0 ~ 2 ~').overChord(chord('Am'))
    expect(q(p, 0, 1).map((t) => t[0])).toEqual([0, 0.5]) // rests preserved
  })

  it('follows a chord that changes WITHIN the cycle', () => {
    const p = n('0 0 0 0').overChord(chord('Am F'))
    // first half over Am (root 57), second half over F (root 53)
    expect(notes(p, 0, 1)).toEqual([57, 57, 53, 53])
  })

  it('handles a chord with more notes than the figure reaches', () => {
    const p = n('0 3').overChord(chord('Cmaj7')) // c e g b, rooted at C3
    expect(notes(p, 0, 1)).toEqual([48, 59])
  })
})

describe('the chord atom lights up (locs for the editor flash)', () => {
  it('threads the sounding chord atom loc into each mapped event', () => {
    // an `overchord:` line is mini-notation the reader wrote and watches;
    // without this it stayed dark while the degrees beside it flashed
    const p = n('0 1').overChord(chord('<Am F>'))
    const vals = q(p, 0, 1).map(
      (t) => t[2] as { note: number; loc?: { start: number }; locs?: { start: number; end: number }[] },
    )
    expect(vals.length).toBeGreaterThan(0)
    for (const v of vals) {
      // the degree atom keeps its own primary loc…
      expect(v.loc).toBeDefined()
      // …and the chord atom rides along in locs:
      // cycle 0 sounds Am, the atom at offset 1..3 of '<Am F>'
      const last = v.locs![v.locs!.length - 1]!
      expect(last.start).toBe(1)
      expect(last.end).toBe(3)
    }
    // cycle 1 sounds F: the loc moves to its atom
    const c1 = q(p, 1, 2).map((t) => t[2] as { locs?: { start: number }[] })
    expect(c1[0]!.locs![c1[0]!.locs!.length - 1]!.start).toBe(4)
  })
})

describe('honest failure', () => {
  it('drops events with no chord under them rather than inventing a pitch', () => {
    // a rest in the chord pattern means no harmony for the second half
    const p = n('0 0').overChord(mini('<c4> ~'))
    expect(notes(p, 0, 1).length).toBeLessThan(2)
  })

  it('passes non-numeric values through untouched', () => {
    const p = mini('bd sn').overChord(chord('Am'))
    expect(q(p, 0, 1)).toHaveLength(2) // words are not degrees
  })
})

describe('composes with the rest of the notation', () => {
  it('works under a stack (a degree chord)', () => {
    const p = n('[0,2]').overChord(chord('Am'))
    expect(notes(p, 0, 1).sort((a, b) => a - b)).toEqual([57, 64])
  })

  it('works with alternation on the degrees', () => {
    const p = n('<0 2>').overChord(chord('Am'))
    expect(notes(p, 0, 1)).toEqual([57])
    expect(notes(p, 1, 2)).toEqual([64])
  })

  it('survives a euclid rhythm', () => {
    const p = n('0(3,8)').overChord(chord('Am'))
    expect(notes(p, 0, 1)).toEqual([57, 57, 57])
  })
})
