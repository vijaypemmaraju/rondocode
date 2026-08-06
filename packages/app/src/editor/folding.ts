import { codeFolding, foldGutter, foldKeymap, foldService } from '@codemirror/language'
import { keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { rondoMode } from './langflag'

/* ------------------------------------------------------------------------- *
 * CODE FOLDING, for both languages.
 *
 * JavaScript folds off its syntax tree — @codemirror/lang-javascript already
 * marks what is foldable, so the JS half is only ever a matter of turning the
 * feature on.
 *
 * RONDO HAS NO TREE. It is a StreamLanguage (a tokenizer, not a parser), so
 * there are no nodes to hang fold ranges on and the tree-based folder finds
 * nothing at all. But rondo's structure is entirely its INDENTATION: a header
 * line owns every deeper line under it, which is exactly what a fold range is.
 * So the rule below reads the document rather than a tree, and it covers every
 * block the language has — synth, play, beat, section, bus, post, sum — without
 * naming any of them.
 *
 * The rule is pure and exported: the failure mode of a fold range is that it
 * swallows a line it does not own, which is silent and hides someone's code.
 * ------------------------------------------------------------------------- */

/** One line of the document, reduced to what the fold rule needs. */
export interface FoldLine {
  /** text of the line, indentation included */
  text: string
  from: number
  to: number
}

/** Indentation width, counting a tab as one. Blank lines have none — they are
 *  skipped rather than treated as column 0, or a blank line inside a synth
 *  would end its fold halfway through. */
const indentOf = (text: string): number => text.length - text.trimStart().length

const isBlank = (text: string): boolean => text.trim() === ''

/**
 * The fold range for the block headed by `line`, or null when that line heads
 * nothing.
 *
 * The range starts at the END of the header (so the header itself stays
 * readable when folded) and runs to the end of the last line the header owns.
 * Trailing blank lines are NOT included: a fold that eats the gap between two
 * synths closes them up into each other when collapsed.
 */
export function indentFoldRange(lines: readonly FoldLine[], index: number): { from: number; to: number } | null {
  const head = lines[index]
  if (head === undefined || isBlank(head.text)) return null
  const headIndent = indentOf(head.text)
  let last = -1
  for (let i = index + 1; i < lines.length; i++) {
    const ln = lines[i]!
    if (isBlank(ln.text)) continue // a gap inside a block does not end it
    if (indentOf(ln.text) <= headIndent) break
    last = i
  }
  if (last === -1) return null // nothing is indented under this line
  return { from: head.to, to: lines[last]!.to }
}

/** Rondo's folder: indentation, because that IS rondo's structure. Stands
 *  down in JavaScript, where the syntax tree knows better. */
const rondoIndentFolding = foldService.of((state, lineStart) => {
  if (!state.facet(rondoMode)) return null
  const doc = state.doc
  const lines: FoldLine[] = []
  let index = -1
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n)
    if (l.from === lineStart) index = lines.length
    lines.push({ text: l.text, from: l.from, to: l.to })
  }
  return index === -1 ? null : indentFoldRange(lines, index)
})

/**
 * Folding for both languages. `gutter` is false for the read-only docs
 * snippets, which have no gutter to put a marker in — the keyboard binding
 * still works, so a long snippet is not stuck open.
 */
export function foldingExtension(gutter: boolean): Extension {
  return [
    codeFolding({
      placeholderText: '⋯',
    }),
    rondoIndentFolding,
    ...(gutter ? [foldGutter({ openText: '⌄', closedText: '›' })] : []),
    keymap.of(foldKeymap),
  ]
}
