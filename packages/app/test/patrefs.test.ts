import { describe, expect, it } from 'vitest'
import { patDefNames, patRefSpans } from '../src/editor/rondo/patrefs'

/* The `patdef` KEYWORD highlights on its own — it is in BLOCK_KEYWORDS. The
 * use site does not, and a tokenizer cannot fix that: it sees one line at a
 * time and has no idea which names a document defines, while `riff` on a body
 * line is shaped exactly like a note name or a synth name.
 *
 * That line stands where a pattern normally is, so leaving it plain made the
 * one line that is NOT literal notation look most like it. */

const spans = (doc: string) => patRefSpans(doc, patDefNames(doc)).map((s) => doc.slice(s.from, s.to))

describe('patdef references', () => {
  it('finds the names a document defines', () => {
    expect(patDefNames('patdef riff <[0]>\npatdef  bass  <[3]>\n')).toEqual(['riff', 'bass'])
  })

  it('marks a body line that IS the name', () => {
    expect(spans('patdef riff <[0 ~ 3]>\n\nplay lead\n  riff\n')).toEqual(['riff'])
  })

  it('does not mark the definition as a use of itself', () => {
    const doc = 'patdef riff <[0 ~ 3]>\n'
    expect(patRefSpans(doc, ['riff'])).toEqual([])
  })

  it('leaves a name that merely APPEARS in a line alone', () => {
    // substitution is whole-line (see codegen applyPatDefs), so anything else
    // is an ordinary word and must not be dressed up as a reference
    expect(spans('patdef riff <[0]>\n\nbeat\n  riff ~ riff ~\n')).toEqual([])
    expect(spans('patdef riff <[0]>\n\nplay lead\n  riffy\n')).toEqual([])
  })

  it('marks every use, in several blocks', () => {
    const doc = 'patdef riff <[0]>\n\nplay a\n  riff\n\nplay b\n  riff\n  add 7\n'
    expect(spans(doc)).toEqual(['riff', 'riff'])
  })

  it('points at the name, not at the indentation', () => {
    const doc = 'patdef riff <[0]>\n\nsection s 2\n    play lead\n      riff\n'
    const [s] = patRefSpans(doc, patDefNames(doc))
    expect(doc.slice(s!.from, s!.to)).toBe('riff')
    expect(doc[s!.from - 1]).toBe(' ') // the indent is not included
  })

  it('marks nothing when the document defines nothing', () => {
    expect(spans('play lead\n  riff\n')).toEqual([])
  })
})

/* COMPOSED figures refer to other figures INSIDE the notation, which only
 * became possible when patdefs learned to compose. Leaving those plain is
 * worse than leaving a whole-line reference plain: they sit in the middle of
 * notation, so unhighlighted they read as NOTES — which is exactly what they
 * would be if the name were spelled a little differently. */
describe('references inside a composed figure', () => {
  it('marks every name used inside another figure', () => {
    const doc = 'patdef tail [1 2]\npatdef openA [0]\npatdef riff <openA tail openA tail>\n'
    expect(spans(doc)).toEqual(['openA', 'tail', 'openA', 'tail'])
  })

  it('points at the names, not at the notation around them', () => {
    const doc = 'patdef tail [1 2]\npatdef riff <[0 0] tail>\n'
    const [s] = patRefSpans(doc, patDefNames(doc))
    expect(doc.slice(s!.from, s!.to)).toBe('tail')
    expect(doc[s!.from - 1], 'the space before it is not included').toBe(' ')
  })

  it('does not mark the name being DEFINED as a use of itself', () => {
    // a self-reference is an error, not a link worth dressing up
    expect(spans('patdef loop <[0] loop>\n')).toEqual([])
  })

  it('leaves a NOTE that merely matches a name alone', () => {
    // the compiler does not expand a note-like name inside a figure, so
    // marking it would promise a substitution that never happens
    const doc = 'patdef e [9]\npatdef tune <c3 e4 e g4>\n'
    expect(spans(doc), 'e / e4 are notes here').toEqual([])
  })

  it('still marks a whole-line reference in a play block', () => {
    const doc = 'patdef tail [1 2]\npatdef riff <[0] tail>\n\nplay lead\n  riff\n'
    expect(spans(doc)).toEqual(['tail', 'riff'])
  })

  it('marks nothing inside a figure that references nothing', () => {
    expect(spans('patdef riff <[0 1] [2 3]>\n')).toEqual([])
  })
})
