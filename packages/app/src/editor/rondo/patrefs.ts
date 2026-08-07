import { RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { isComposablePatDefName } from '@rondocode/rondo'
import { rondoMode } from '../langflag'

/* ------------------------------------------------------------------------- *
 * `patdef` REFERENCES, made visible.
 *
 * The keyword highlights on its own — it is in BLOCK_KEYWORDS, so the
 * tokenizer paints it. The USE site does not:
 *
 *   patdef riff <[0 ~ 3] [5 ~ 7]>     <- keyword + notation, both coloured
 *   play lead
 *     riff                            <- plain: a word, like any other
 *
 * A tokenizer cannot fix that. It sees one line at a time and has no idea
 * which names a document defines, and `riff` there is shaped exactly like a
 * note name or a synth name. So this is a decoration, which CAN read the
 * document — the same reason mini-notation highlighting is one.
 *
 * It matters more than it looks: that line stands where a pattern normally
 * is, and a pattern is the thing you read a play block to find. Leaving it
 * plain means the one line that is NOT literal notation is the one line that
 * looks most like it.
 * ------------------------------------------------------------------------- */

/** Names a document defines with `patdef`, in source order. */
export function patDefNames(doc: string): string[] {
  const out: string[] = []
  for (const m of doc.matchAll(/^[ \t]*patdef[ \t]+([A-Za-z][\w]*)/gm)) out.push(m[1]!)
  return out
}

/** The spans of every USE of one of `names`. Two shapes, because there are
 *  two ways to refer to a figure:
 *
 *    play lead
 *      riff              <- a body line that IS the name (whole-line
 *                           substitution, see codegen's applyPatDefs)
 *
 *    patdef riffB <openB tail openA tail>
 *                  ^^^^^ ^^^^ ^^^^^ ^^^^  <- INSIDE another figure
 *
 *  The second only became possible when patdefs learned to compose, and
 *  leaving it plain is worse than it was for the first: those words sit in the
 *  middle of notation, so unhighlighted they read as NOTES, which is exactly
 *  what they would be if the name were spelled a little differently.
 *
 *  Which names can appear inside a figure is the compiler's rule, imported
 *  rather than restated — a note-like name is not expanded there, so marking
 *  it would promise a substitution that never happens.
 *
 *  Pure, so both rules are testable without an editor. */
export function patRefSpans(doc: string, names: readonly string[]): { from: number; to: number }[] {
  if (names.length === 0) return []
  const defined = new Set(names)
  const composable = new Set(names.filter(isComposablePatDefName))
  const out: { from: number; to: number }[] = []
  let at = 0
  for (const line of doc.split('\n')) {
    const text = line.trim()
    const indent = line.length - line.trimStart().length
    const def = /^patdef[ \t]+([A-Za-z]\w*)[ \t]+(.*)$/.exec(text)
    if (def !== null) {
      // references INSIDE this figure. The name being defined is skipped: a
      // self-reference is an error, not a link worth dressing up.
      const self = def[1]!
      const bodyAt = at + indent + text.length - def[2]!.length
      for (const m of def[2]!.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
        if (m[0] === self || !composable.has(m[0])) continue
        out.push({ from: bodyAt + m.index, to: bodyAt + m.index + m[0].length })
      }
      at += line.length + 1
      continue
    }
    // the DEFINITION is not a reference to itself
    if (text !== '' && defined.has(text)) {
      const from = at + indent
      out.push({ from, to: from + text.length })
    }
    at += line.length + 1
  }
  return out
}

const refMark = Decoration.mark({ class: 'cm-patref' })

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  if (!view.state.facet(rondoMode)) return b.finish()
  const doc = view.state.doc.toString()
  // The whole document, not the visible ranges: a definition scrolled off the
  // top still defines the name used here, and a builder needs its ranges in
  // order anyway.
  for (const s of patRefSpans(doc, patDefNames(doc))) b.add(s.from, s.to, refMark)
  return b.finish()
}

/** Mark `patdef` references so a named pattern does not read as a bare word. */
export const patRefHighlight: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private wasRondo: boolean
    constructor(view: EditorView) {
      this.decorations = build(view)
      this.wasRondo = view.state.facet(rondoMode)
    }
    update(u: ViewUpdate): void {
      const isRondo = u.state.facet(rondoMode)
      if (u.docChanged || isRondo !== this.wasRondo) {
        this.decorations = build(u.view)
        this.wasRondo = isRondo
      }
    }
  },
  { decorations: (v) => v.decorations },
)
