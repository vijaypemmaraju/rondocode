import { Decoration, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import { Prec, RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { highlightTree } from '@lezer/highlight'
import { scanBalanced, stripComment } from '@rondocode/rondo'
import { editorHighlightStyle } from './theme'
import { rondoMode } from './langflag'
import { visualHeaderIndent, inVisualBody } from './wgsl'

/* ------------------------------------------------------------------------- *
 * JavaScript highlighting inside rondo's escape hatches: the body of a lone
 * `js` block, of a `mask N` painter block, and the inside of an inline
 * `js{ … }` span are raw JavaScript,
 * but the rondo tokenizer painted them by rondo's rules. That is worse than
 * colourless — `sample`, `gain`, `note` and `mix` are rondo vocabulary too, so
 * escaped JS came out coloured as though it were music (the same bug wgsl.ts
 * fixed for `visual` bodies).
 *
 * Same cure, better tokenizer: the rondo StreamLanguage stands down inside the
 * regions (rondo/index.ts), and this overlay runs the REAL lezer JavaScript
 * parser over each one, painting with the editor's own HighlightStyle — so an
 * escaped statement and the same statement in a JS document cannot colour
 * differently.
 * ------------------------------------------------------------------------- */

// ---- where the JavaScript is ---------------------------------------------

/** The indent of a header that opens a raw-JavaScript body, or null for any
 *  other line: a lone `js` (the parser opens the block form on exactly that;
 *  `js{ … }` on the same line is the inline form, handled separately below),
 *  or `mask N`, whose body is the LED mask painter for slot N. */
export const jsHeaderIndent = (line: string): number | null =>
  /^[ \t]*(?:js|mask[ \t]+\d+)[ \t]*$/.test(line) ? /^[ \t]*/.exec(line)![0].length : null

/** Whether `line` is still inside a `js` block opened at `headerIndent`.
 *  A blank line does NOT close it, matching the parser's bodyLines. */
export const inJsBody = (headerIndent: number, line: string): boolean =>
  line.trim() === '' || /^[ \t]*/.exec(line)![0].length > headerIndent

/** An inline span starts where the lexer's rule fires: `js` at a token
 *  boundary, then optional space, then `{`. */
const INLINE_JS = /(?:^|[^\w])js\s*\{/g

/**
 * Every JavaScript region in a rondo document: `js` block bodies (one range
 * each, verbatim like the parser lifts them) and the content of every inline
 * `js{ … }` span. Mirrors the parser's block rule and the lexer's inline rule
 * — via the lexer's own `stripComment`/`scanBalanced`, so a `#` or a brace
 * inside a string cannot make the two disagree. `visual` bodies are skipped:
 * a `js{` inside a shader is WGSL punctuation, not an escape hatch.
 */
export function jsRegionRanges(text: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let js: number | null = null // open `js` block header indent
  let wgsl: number | null = null // open `visual` block header indent
  let from = 0
  let to = 0
  let at = 0
  for (const line of text.split('\n')) {
    const end = at + line.length
    if (js !== null) {
      if (inJsBody(js, line)) {
        if (line.trim() !== '') to = end
        at = end + 1
        continue
      }
      out.push({ from, to })
      js = null
    }
    if (wgsl !== null) {
      if (inVisualBody(wgsl, line)) {
        at = end + 1
        continue
      }
      wgsl = null
    }
    const jh = jsHeaderIndent(line)
    if (jh !== null) {
      js = jh
      from = Math.min(end + 1, text.length)
      to = from
      at = end + 1
      continue
    }
    const vh = visualHeaderIndent(line)
    if (vh !== null) {
      wgsl = vh
      at = end + 1
      continue
    }
    // inline js{ … } spans on an ordinary line (there may be several)
    const stripped = stripComment(line)
    INLINE_JS.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = INLINE_JS.exec(stripped)) !== null) {
      const open = m.index + m[0].length - 1
      const close = scanBalanced(stripped, open)
      if (close < 0) {
        // unterminated: the lexer errors, the highlighter still paints what is
        // there — this is the state every span passes through while typed
        if (stripped.length > open + 1) out.push({ from: at + open + 1, to: at + stripped.length })
        break
      }
      if (close > open + 1) out.push({ from: at + open + 1, to: at + close })
      INLINE_JS.lastIndex = close + 1
    }
    at = end + 1
  }
  if (js !== null && to > from) out.push({ from, to })
  return out
}

// ---- highlight ViewPlugin ------------------------------------------------

const decoCache = new Map<string, Decoration>()
const tokenDeco = (cls: string): Decoration => {
  let d = decoCache.get(cls)
  if (!d) {
    d = Decoration.mark({ class: cls })
    decoCache.set(cls, d)
  }
  return d
}

const jsHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>()
      // rondo documents only: in a JS document the grammar itself is JS
      if (!view.state.facet(rondoMode)) return builder.finish()
      const ranges = jsRegionRanges(view.state.doc.toString())
      const { from: vpFrom, to: vpTo } = view.viewport
      for (const r of ranges) {
        if (r.to <= vpFrom || r.from >= vpTo) continue
        // parse the WHOLE region even when only part is visible — clipping a
        // parse mid-string or mid-comment mis-lexes everything after it.
        // Regions are escape hatches, not documents; they stay small.
        const text = view.state.sliceDoc(r.from, r.to)
        const tree = javascriptLanguage.parser.parse(text)
        highlightTree(tree, editorHighlightStyle, (from, to, classes) => {
          builder.add(r.from + from, r.from + to, tokenDeco(classes))
        })
      }
      return builder.finish()
    }
  },
  { decorations: (v) => v.decorations },
)

/** JavaScript highlighting overlaid on rondo `js` blocks and `js{ … }` spans.
 *  Highest precedence, same as the WGSL overlay, so its marks nest innermost. */
export function rondoJsHighlight(): Extension {
  return Prec.highest(jsHighlighter)
}
