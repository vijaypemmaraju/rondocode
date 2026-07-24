import { describe, expect, it } from 'vitest'
import { paletteChips } from '../src/editor/rondo/palette'

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
