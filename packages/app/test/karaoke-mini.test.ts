import { describe, expect, it } from 'vitest'
import { parseSingCalls, parseSingBlocksRondo } from '../src/editor/karaoke'

/* Karaoke alignment reads the melody with the REAL mini parser (brackets,
 * rests, alternations, @weights all change which tokens sound and for how
 * long), in BOTH languages. A whitespace split silently mis-aligned or
 * dropped the highlight entirely; these pin the contract. */

const at = (src: string, needle: string, n = 0): number => {
  let i = -1
  for (let k = 0; k <= n; k++) i = src.indexOf(needle, i + 1)
  return i
}

describe('parseSingCalls (JavaScript)', () => {
  it('aligns a plain melody and maps ranges to the document', () => {
    const src = `p('v', sing('la la la', 'c4 e4 g4'))`
    const [c] = parseSingCalls(src)
    expect(c).toBeDefined()
    expect(c!.lyr).toHaveLength(3)
    expect(src.slice(c!.notes[1]!.from, c!.notes[1]!.to)).toBe('e4')
    expect(src.slice(c!.lyr[1]!.from, c!.lyr[1]!.to)).toBe('la')
  })

  it('@weights set the phase spans (a dotted note holds longer)', () => {
    const src = `p('v', sing('a b c', 'c4@6 e4@2 g4@2'))`
    const [c] = parseSingCalls(src)!
    expect(c!.spans[0]!.end).toBeCloseTo(0.6, 6)
    expect(c!.spans[1]!.end).toBeCloseTo(0.8, 6)
    expect(c!.spans[2]!.end).toBeCloseTo(1, 6)
  })

  it('RESTS are not syllables: a melody with ~ still aligns', () => {
    // 3 sounding notes, 3 syllables - the old whitespace split counted 4
    const src = `p('v', sing('la la la', '~ c4 e4 g4'))`
    const [c] = parseSingCalls(src)
    expect(c).toBeDefined()
    expect(c!.notes).toHaveLength(3)
    expect(src.slice(c!.notes[0]!.from, c!.notes[0]!.to)).toBe('c4')
    // nothing is highlighted during the leading rest
    expect(c!.spans[0]!.start).toBeCloseTo(0.25, 6)
  })

  it('BRACKETS and cycles: a multi-bar phrase aligns across cycles', () => {
    const src = `p('v', sing('oh dan ny boy', '<[e4 f4] [g4@3 a4]>', { name: 'v', cycles: 2 }))`
    const [c] = parseSingCalls(src)
    expect(c).toBeDefined()
    expect(c!.notes).toHaveLength(4)
    expect(src.slice(c!.notes[3]!.from, c!.notes[3]!.to)).toBe('a4')
    // cycle 2 occupies the second half of the phrase
    expect(c!.spans[2]!.start).toBeCloseTo(0.5, 6)
    expect(c!.spans[3]!.start).toBeCloseTo(0.875, 6)
  })

  it('the 2-string form (no voice) works too', () => {
    const src = `p('v', sing('la la', 'c4 e4'))`
    expect(parseSingCalls(src)[0]!.notes).toHaveLength(2)
  })

  it('a syllable/note mismatch yields no call (never a wrong highlight)', () => {
    expect(parseSingCalls(`p('v', sing('la la', 'c4 e4 g4'))`)).toHaveLength(0)
  })
})

describe('parseSingBlocksRondo', () => {
  const doc = [
    'synth pad',
    '  saw',
    '',
    'sing danny voice:barbara',
    '  oh dan-ny boy',
    '  <[e4@2 f4@2 g4@2] [a4@6]>',
    '  cycles: 2',
    '  gain: .95',
    '',
    'cps .4',
  ].join('\n')

  it('finds the block and aligns syllables to sounding notes', () => {
    const [c] = parseSingBlocksRondo(doc)
    expect(c).toBeDefined()
    expect(c!.lyr).toHaveLength(4)
    expect(c!.notes).toHaveLength(4)
    expect(doc.slice(c!.lyr[1]!.from, c!.lyr[1]!.to)).toBe('dan')
    expect(doc.slice(c!.lyr[2]!.from, c!.lyr[2]!.to)).toBe('ny')
    // the loc covers the note ATOM; its @weight is not part of the highlight
    expect(doc.slice(c!.notes[3]!.from, c!.notes[3]!.to)).toBe('a4')
  })

  it('cycles: N stretches the phase map over N cycles', () => {
    const [c] = parseSingBlocksRondo(doc)
    expect(c!.spans[3]!.start).toBeCloseTo(0.5, 6) // bar 2 starts at half
    expect(c!.spans[3]!.end).toBeCloseTo(1, 6)
  })

  it('multiple lyric/melody PAIRS join like the compiler joins them', () => {
    const d = [
      'sing v',
      '  la la',
      '  c4 e4',
      '  da da',
      '  g4 a4',
    ].join('\n')
    const [c] = parseSingBlocksRondo(d)
    expect(c!.lyr).toHaveLength(4)
    expect(d.slice(c!.notes[2]!.from, c!.notes[2]!.to)).toBe('g4')
    expect(d.slice(c!.lyr[3]!.from, c!.lyr[3]!.to)).toBe('da')
  })

  it('modifier and comment lines are not mistaken for lyrics', () => {
    const d = ['sing v', '  la la', '  c4 e4', '  # a note', '  dur: .9'].join('\n')
    expect(parseSingBlocksRondo(d)[0]!.lyr).toHaveLength(2)
  })

  it('a JS document yields nothing here (and vice versa)', () => {
    expect(parseSingBlocksRondo(`p('v', sing('la', 'c4'))`)).toHaveLength(0)
    expect(parseSingCalls(doc)).toHaveLength(0)
  })
})

describe('sharps are notes, not comments (regression)', () => {
  it('a melody containing a#4 keeps every note', () => {
    // a naive `#` strip ate the rest of the line and silently killed the
    // whole highlight for any melody with a sharp in it
    const d = ['sing v', '  la la la la', '  g4 a#4 a4 a#4', '  gain: .9'].join('\n')
    const [c] = parseSingBlocksRondo(d)
    expect(c).toBeDefined()
    expect(c!.notes).toHaveLength(4)
    expect(d.slice(c!.notes[1]!.from, c!.notes[1]!.to)).toBe('a#4')
  })

  it('a REAL trailing comment is still stripped', () => {
    const d = ['sing v', '  la la', '  c4 e4  # the hook', '  gain: .9'].join('\n')
    expect(parseSingBlocksRondo(d)[0]!.notes).toHaveLength(2)
  })
})
