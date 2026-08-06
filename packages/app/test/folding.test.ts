import { describe, expect, it } from 'vitest'
import { indentFoldRange } from '../src/editor/folding'
import type { FoldLine } from '../src/editor/folding'

/* Rondo is a StreamLanguage — a tokenizer, not a parser — so there is no
 * syntax tree to hang fold ranges on and the tree-based folder finds nothing.
 * Its structure IS its indentation, so that is what the folder reads.
 *
 * The failure mode is a range that swallows a line the header does not own,
 * which hides someone's code with no error, so the rule is pure and pinned
 * here rather than only exercised through an editor. */

/** Split a document the way the fold service does. */
const lines = (doc: string): FoldLine[] => {
  const out: FoldLine[] = []
  let at = 0
  for (const text of doc.split('\n')) {
    out.push({ text, from: at, to: at + text.length })
    at += text.length + 1
  }
  return out
}
/** The text a fold at `index` would hide. */
const hidden = (doc: string, index: number): string | null => {
  const r = indentFoldRange(lines(doc), index)
  return r === null ? null : doc.slice(r.from, r.to)
}

const SYNTH = ['synth pad', '  saw note', '  * env', '  env = adsr .01 .2 .5 .2', '', 'play pad', '  c3 e3'].join('\n')

describe('rondo folding, by indentation', () => {
  it('folds a block, and keeps its header readable', () => {
    const r = indentFoldRange(lines(SYNTH), 0)!
    expect(r.from, 'the range starts at the END of the header').toBe('synth pad'.length)
    expect(hidden(SYNTH, 0)).toBe('\n  saw note\n  * env\n  env = adsr .01 .2 .5 .2')
  })

  it('stops at the next line of equal or shallower indent', () => {
    // the blank line and `play pad` after it belong to nobody but the document
    expect(hidden(SYNTH, 0)).not.toContain('play pad')
  })

  it('does not eat the blank line that separates two blocks', () => {
    // folding through it closes the two blocks up into each other on screen
    expect(hidden(SYNTH, 0)!.endsWith('.2')).toBe(true)
  })

  it('keeps a blank line INSIDE a block, which does not end it', () => {
    const doc = ['synth pad', '  saw note', '', '  * env', 'play pad', '  c3'].join('\n')
    expect(hidden(doc, 0)).toBe('\n  saw note\n\n  * env')
  })

  it('folds a nested block on its own — post, and a sum inside a synth', () => {
    const doc = ['synth pad', '  sum k 1..4', '    sine note * k', '    * amp', '  post', '    reverb room:.9'].join('\n')
    expect(hidden(doc, 1), 'the sum block').toBe('\n    sine note * k\n    * amp')
    expect(hidden(doc, 4), 'the post block').toBe('\n    reverb room:.9')
    expect(hidden(doc, 0), 'the synth owns all of it').toContain('reverb room:.9')
  })

  it('offers nothing on a line that heads nothing', () => {
    expect(indentFoldRange(lines(SYNTH), 1), 'a body line').toBeNull()
    expect(indentFoldRange(lines(SYNTH), 4), 'a blank line').toBeNull()
    expect(indentFoldRange(lines(SYNTH), 6), 'the last line').toBeNull()
    expect(indentFoldRange(lines('one line only'), 0)).toBeNull()
  })

  it('handles a deeper-then-shallower body without running past the block', () => {
    const doc = ['section intro 8', '  play pad', '    c3', '  play sub', '    c1', 'song intro'].join('\n')
    const h = hidden(doc, 0)!
    expect(h).toContain('play sub')
    expect(h).not.toContain('song intro')
  })
})
