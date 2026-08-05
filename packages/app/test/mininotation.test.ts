import { describe, expect, it } from 'vitest'
import { looksLikeMini, miniMarks } from '../src/editor/mininotation'

/* Reported as "rests don't get highlighted in rondocode". Measured in the real
 * editor first: rondo paints `~` amber (rgb(242,177,85)) while rondocode gave
 * the whole literal one cyan token, so a rest looked exactly like a note. The
 * rule is the string's CONTENT, because the alternative — a list of which
 * arguments take mini-notation — is long and silently wrong when it misses. */

const marked = (literal: string, from = 0) =>
  miniMarks(literal, from).map((m) => ({ text: literal.slice(m.from - from, m.to - from), kind: m.kind }))

describe('mini-notation inside a JS string', () => {
  it('marks the rest, which is what the report was about', () => {
    expect(marked("'c2 ~ g2 ~'")).toEqual([
      { text: '~', kind: 'atom' },
      { text: '~', kind: 'atom' },
    ])
  })

  it('returns real DOCUMENT offsets, skipping the quote', () => {
    //          0123456789
    const doc = "note('a ~')"
    const [m] = miniMarks("'a ~'", 5)
    expect(doc.slice(m!.from, m!.to)).toBe('~')
  })

  it('marks grouping and alternation as atoms, speed as an operator', () => {
    // `<[` come out as one mark: they are adjacent and the same kind, and
    // one span of two characters renders identically to two of one.
    expect(marked("'<[c2 e2]!2 g2*4>'")).toEqual([
      { text: '<[', kind: 'atom' },
      { text: ']!', kind: 'atom' },
      { text: '*', kind: 'op' },
      { text: '>', kind: 'atom' },
    ])
  })

  it('merges a run of the same kind into one mark', () => {
    // two decorations butted together render as two spans for one gesture
    expect(marked("'a!!2'")).toEqual([{ text: '!!', kind: 'atom' }])
  })

  it('leaves ordinary names alone — they are not patterns', () => {
    for (const name of ["'grand'", "'a-min'", "'take1'", "'updown'", "'c4 e4 g4'"]) {
      expect(miniMarks(name, 0), name).toEqual([])
    }
  })

  it('ignores a template literal, because visual(`…`) is WGSL', () => {
    // WGSL is full of < > [ ] * and would light up like a Christmas tree
    expect(miniMarks('`fn main() { let x = a[0] * 2.0; }`', 0)).toEqual([])
  })

  it('survives a degenerate literal instead of reading past the end', () => {
    expect(miniMarks("'", 0)).toEqual([])
    expect(miniMarks('', 0)).toEqual([])
    expect(miniMarks("''", 0)).toEqual([])
  })

  describe('looksLikeMini', () => {
    it('is true for anything with structure, false for a bare name', () => {
      expect(looksLikeMini('c2 ~ g2')).toBe(true)
      expect(looksLikeMini('bd*4')).toBe(true)
      expect(looksLikeMini('grand')).toBe(false)
      // a plain run of notes has nothing to distinguish, so nothing to mark
      expect(looksLikeMini('c4 e4 g4')).toBe(false)
    })
  })
})
