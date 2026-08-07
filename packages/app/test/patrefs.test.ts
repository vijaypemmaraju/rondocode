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
