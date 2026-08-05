import { RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { rondoMode } from './langflag'

/* ------------------------------------------------------------------------- *
 * MINI-NOTATION INSIDE A JAVASCRIPT STRING.
 *
 * The same pattern reads differently in the two languages, and it should not:
 *
 *   rondo       c2 ~ g2 ~           the ~ is amber, and the rest jumps out
 *   rondocode   note('c2 ~ g2 ~')   one cyan string, rests invisible
 *
 * A rest is the thing you scan a pattern for — where the holes are IS the
 * rhythm — and in the JS DSL it had exactly the same colour as the notes
 * around it, because JavaScript's tokenizer sees one string literal and stops.
 *
 * So the structural characters get marked inside the string, using the SAME
 * tags rondo's own tokenizer emits (see editor/rondo/index.ts): the grouping
 * and repeat characters are atoms, the arithmetic ones are operators. Mirroring
 * that list rather than inventing a palette is the point — one notation should
 * not have two appearances.
 *
 * WHICH STRINGS. Not "arguments of a known pattern function": that list is
 * long (note/n/s/sound/mini/chord, plus .gain/.dur/.pan/.ctrl/.arp/… and any
 * control added later), and a missed entry is a silently unhighlighted pattern.
 * The rule is the CONTENT: a string containing a mini-notation structural
 * character. Ordinary strings in this DSL are names — 'grand', 'a-min',
 * 'take1' — and contain none of them. Template literals are excluded outright
 * because visual(`…`) holds WGSL, which is full of < > [ ] *.
 * ------------------------------------------------------------------------- */

/** Grouping, alternation, rest, repeat, euclid — rondo tags these `note`,
 *  which the theme paints as an atom. */
const ATOM_CHARS = '<>[]~@!'
/** Speed and weight — rondo tags these as operators. */
const OP_CHARS = '*/%,?'

/** True when this string looks like mini-notation rather than a name. One
 *  structural character is enough: names never contain them. */
export const looksLikeMini = (text: string): boolean =>
  [...text].some((c) => ATOM_CHARS.includes(c) || OP_CHARS.includes(c))

export interface MiniMark {
  from: number
  to: number
  kind: 'atom' | 'op'
}

/**
 * The structural characters of one string literal, as document offsets.
 *
 * `text` is the literal INCLUDING its quotes and `from` is where it starts in
 * the document, so the quotes are skipped and every offset returned is a real
 * document position. Pure, so the rule is testable without an editor.
 */
export function miniMarks(text: string, from: number): MiniMark[] {
  const out: MiniMark[] = []
  if (text.length < 2) return out
  const quote = text[0]
  if (quote !== "'" && quote !== '"') return out // template literals: not ours
  const body = text.slice(1, -1)
  if (!looksLikeMini(body)) return out
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    const kind = ATOM_CHARS.includes(c) ? 'atom' : OP_CHARS.includes(c) ? 'op' : null
    if (kind === null) continue
    const at = from + 1 + i
    // merge runs of the same kind (`!!`, `*/`) into one mark
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.kind === kind && prev.to === at) prev.to = at + 1
    else out.push({ from: at, to: at + 1, kind })
  }
  return out
}

const atomMark = Decoration.mark({ class: 'cm-mini-atom' })
const opMark = Decoration.mark({ class: 'cm-mini-op' })

/** Decorate the visible ranges. Only the visible ones: a long document should
 *  not pay for patterns nobody is looking at. */
function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  // rondo already colours its own notation; this is the JS DSL's catch-up.
  if (view.state.facet(rondoMode)) return builder.finish()
  const tree = syntaxTree(view.state)
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'String') return
        const text = view.state.doc.sliceString(node.from, node.to)
        for (const m of miniMarks(text, node.from)) {
          builder.add(m.from, m.to, m.kind === 'atom' ? atomMark : opMark)
        }
      },
    })
  }
  return builder.finish()
}

/** Mini-notation structure, coloured inside JS strings. */
export const miniNotationHighlight: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    /** The language this was last built for. A rondo/rondocode switch may not
     *  touch the document, and stale marks would then survive the change. */
    private wasRondo: boolean
    constructor(view: EditorView) {
      this.decorations = build(view)
      this.wasRondo = view.state.facet(rondoMode)
    }
    update(u: ViewUpdate): void {
      // viewportChanged too: the tree is only parsed for what is on screen
      const isRondo = u.state.facet(rondoMode)
      if (u.docChanged || u.viewportChanged || isRondo !== this.wasRondo) {
        this.decorations = build(u.view)
        this.wasRondo = isRondo
      }
    }
  },
  { decorations: (v) => v.decorations },
)
