import { describe, expect, it } from 'vitest'
import { deleteTokenRange, notationCtxAt, paletteChips } from '../src/editor/rondo/palette'

/* The tap palette's brain: (doc, cursor) → the grammar's legal next moves.
 * Pure and pinned — a wrong context means the bar offers illegal tokens. */

const labels = (doc: string, pos: number): string[] => paletteChips(doc, pos).map((c) => c.label)

describe('paletteChips', () => {
  it('offers block starters at the top level (and on an empty doc)', () => {
    expect(labels('', 0)).toContain('＋ synth')
    const doc = 'synth a\n  saw\n\n'
    expect(labels(doc, doc.length)).toContain('＋ play')
  })

  it('generates a fresh synth name and targets the LAST synth for play', () => {
    const doc = 'synth s1\n  saw\n\nsynth bass\n  sine\n\n'
    const chips = paletteChips(doc, doc.length)
    const synthChip = chips.find((c) => c.label === '＋ synth')!
    const playChip = chips.find((c) => c.label === '＋ play')!
    expect(synthChip.insert).toContain('synth s2')
    expect(playChip.insert).toContain('play bass')
  })

  it('offers SOURCES on a synth body first line, TRANSFORMS after', () => {
    const doc = 'synth a\n  '
    expect(labels(doc, doc.length)).toContain('supersaw')
    const doc2 = 'synth a\n  saw\n  '
    const l2 = labels(doc2, doc2.length)
    expect(l2).toContain('* env')
    expect(l2).toContain('ladder')
    expect(l2).toContain('post')
  })

  it('drops the post chip inside a post sub-block', () => {
    const doc = 'synth a\n  saw\n  post\n    '
    expect(labels(doc, doc.length)).not.toContain('post')
  })

  it('offers degree/rest chips on a play first line, modifiers after', () => {
    const doc = 'synth a\n  saw\n\nplay a\n  '
    const l = labels(doc, doc.length)
    expect(l).toContain('0')
    expect(l).toContain('~')
    const doc2 = 'synth a\n  saw\n\nplay a\n  0 3 5\n  '
    const l2 = labels(doc2, doc2.length)
    expect(l2).toContain('gain:')
    expect(l2).toContain('every')
  })

  it('offers bus chips inside a bus block', () => {
    const doc = 'bus space\n  '
    expect(labels(doc, doc.length)).toContain('send')
  })
})

describe('notationCtxAt (play-to-write preview context)', () => {
  const doc = [
    'synth acid',
    '  saw',
    '',
    'play acid',
    '  0 3 5',
    '  scale: a-min',
    '',
    'play ch2 synth:acid',
    '  0 2 4  scale:c-maj',
    '',
    'section drop 4',
    '  play acid',
    '    0 5',
    '    scale: e-dor',
    '',
  ].join('\n')
  const at = (needle: string): number => doc.indexOf(needle) + needle.length

  it('resolves the enclosing play synth + modifier-line scale', () => {
    expect(notationCtxAt(doc, at('0 3 5'))).toEqual({ synth: 'acid', scale: 'a-min' })
  })
  it('play chan synth:NAME routes to NAME; inline scale wins', () => {
    expect(notationCtxAt(doc, at('0 2 4'))).toEqual({ synth: 'acid', scale: 'c-maj' })
  })
  it('a play nested in a section resolves too', () => {
    expect(notationCtxAt(doc, at('    0 5'))).toEqual({ synth: 'acid', scale: 'e-dor' })
  })
  it('no scale in the block: synth only (preview stays silent)', () => {
    const d = 'play acid\n  0 3\n'
    expect(notationCtxAt(d, d.indexOf('0 3') + 3)).toEqual({ synth: 'acid' })
  })
  it('outside any play: empty', () => {
    expect(notationCtxAt(doc, doc.indexOf('saw') + 3)).toEqual({})
  })
  it('the scale scan stops at the end of the block', () => {
    // the NEXT play's inline scale must not leak into the first block
    const d = 'play a\n  0 3\n\nplay b\n  0  scale:c-maj\n'
    expect(notationCtxAt(d, d.indexOf('0 3') + 3)).toEqual({ synth: 'a' })
  })
})

describe('deleteTokenRange (the ⌫ chip)', () => {
  it('erases the token before the caret, trailing space included', () => {
    const d = 'play s\n  0 3 5 '
    // deletes '5 ' (token + its trailing separator), leaving '  0 3 '
    expect(deleteTokenRange(d, d.length)).toEqual({ from: d.length - 2, to: d.length })
  })
  it('erases up to the caret mid-token', () => {
    const d = '  kick ~ ki'
    expect(deleteTokenRange(d, d.length)).toEqual({ from: 9, to: 11 })
  })
  it('null at the start of a line (nothing to erase)', () => {
    expect(deleteTokenRange('0 3\n  ', 6)).toBeNull()
  })
  it('never crosses the line boundary', () => {
    const d = '0 3\n5'
    expect(deleteTokenRange(d, 5)).toEqual({ from: 4, to: 5 })
    expect(deleteTokenRange(d, 4)).toBeNull()
  })
})

describe('degree chips carry their preview degree', () => {
  it('digits 0..7 preview, rest/brackets do not, ⌫ is an action', () => {
    const chips = paletteChips('play s\n  ', 9)
    const digits = chips.filter((c) => c.previewDegree !== undefined)
    expect(digits.map((c) => c.previewDegree)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(chips.find((c) => c.label === '⌫')?.action).toBe('del-token')
    expect(chips.find((c) => c.label === '~')?.previewDegree).toBeUndefined()
  })
})
