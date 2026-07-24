import { javascriptLanguage } from '@codemirror/lang-javascript'

/* ------------------------------------------------------------------------- *
 * Widget + scrubbable-literal detection — PURE: (docText, tree?) → data.
 *
 * PARSER CHOICE: Lezer (the editor's own @codemirror/lang-javascript
 * grammar), not acorn. Two reasons: the caller can hand us the editor's
 * incremental syntaxTree so no second parse happens on the hot path, and —
 * decisive — Lezer is error-tolerant: while the user types elsewhere in a
 * momentarily-unparseable doc, widgets in the intact parts survive instead
 * of all vanishing (acorn throws on the first syntax error). When no tree
 * is supplied (tests, cold paths) we do a full parse; at this app's doc
 * sizes (<10 KB) that costs well under a millisecond.
 *
 * A call becomes a widget ONLY when its callee is a bare identifier named
 * slider/toggle/pick/xy and every argument is a literal (number, possibly
 * negated; escape-free string; true/false) matching the kind's arity —
 * anything else (variables, expressions, spreads, escaped strings) leaves
 * the call as plain text, and the code still runs because the scope
 * placeholders in session/scope.ts give the calls identity semantics.
 *
 * Numbers reported for scrubbing are every plain decimal Number literal
 * (with a directly-attached unary minus folded in) that is NOT inside a
 * detected widget call — those are hidden behind the widget's UI. Hex /
 * binary / octal / bigint literals are skipped: a scrub rewrite would
 * silently change their radix.
 * ------------------------------------------------------------------------- */

type Tree = ReturnType<typeof javascriptLanguage.parser.parse>
type SyntaxNode = Tree['topNode']

export type WidgetKind = 'slider' | 'toggle' | 'pick' | 'xy'

/** One literal argument of a widget call. `raw` is the exact source slice
 *  (quotes and sign included) — pick cycling re-inserts option raws, which
 *  trivially preserves quote style. */
export interface LiteralArg {
  value: number | string | boolean
  raw: string
  from: number
  to: number
}

/** A widget call: [from, to) spans the whole `kind(...)` expression. */
export interface WidgetDesc {
  kind: WidgetKind
  from: number
  to: number
  args: LiteralArg[]
}

/** A scrubbable numeric literal. `isInt` — the source had no decimal point
 *  or exponent, so scrubbing must keep it an integer. */
export interface ScrubLit {
  from: number
  to: number
  value: number
  isInt: boolean
}

/** Language-agnostic numeric-literal scan (plain decimals, folded unary minus).
 *  scrub falls back to this when the syntax tree yields no numbers — e.g. rondo
 *  mode, where the tree is the StreamLanguage grammar, not JS, so the tree walk
 *  finds nothing. Skips numbers glued to identifiers and the second operand of a
 *  `..` range (its leading dot). */
export function scanNumbersText(text: string): ScrubLit[] {
  const out: ScrubLit[] = []
  const re = /-?(?:\d+\.\d+|\.\d+|\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const prev = text[m.index - 1]
    const next = text[m.index + raw.length]
    if (prev !== undefined && /[\w.]/.test(prev)) continue // part of an ident / after a dot
    if (next !== undefined && /\w/.test(next)) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    out.push({ from: m.index, to: m.index + raw.length, value, isInt: !/[.eE]/.test(raw) })
  }
  return out
}

export interface DetectResult {
  widgets: WidgetDesc[]
  numbers: ScrubLit[]
}

const WIDGET_KINDS = new Set<string>(['slider', 'toggle', 'pick', 'xy'])
const PUNCT = new Set(['(', ')', ',', 'LineComment', 'BlockComment'])

/** A plain decimal number literal (scrub would change the radix of 0x/0b/0o
 *  and the meaning of 1n). */
const isPlainDecimal = (raw: string): boolean => /^\d/.test(raw) && !/^0[xbo]/i.test(raw) && !/n$/.test(raw)

const numberLit = (raw: string, from: number, to: number): LiteralArg | null => {
  if (!isPlainDecimal(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? { value, raw, from, to } : null
}

/** Literal for one ArgList expression node, or null when it isn't one. */
const literalArg = (node: SyntaxNode, doc: string): LiteralArg | null => {
  const raw = doc.slice(node.from, node.to)
  switch (node.name) {
    case 'Number':
      return numberLit(raw, node.from, node.to)
    case 'String':
      // escape-free only: the cooked value then equals the raw slice minus
      // quotes (same exactness trick as flash.ts)
      if (raw.includes('\\')) return null
      return { value: raw.slice(1, -1), raw, from: node.from, to: node.to }
    case 'BooleanLiteral':
      return { value: raw === 'true', raw, from: node.from, to: node.to }
    case 'UnaryExpression': {
      // exactly `-<number>`: fold the sign into the literal
      const op = node.firstChild
      const num = op?.nextSibling
      if (op?.name !== 'ArithOp' || doc.slice(op.from, op.to) !== '-') return null
      if (num?.name !== 'Number' || num.nextSibling !== null) return null
      const inner = numberLit(doc.slice(num.from, num.to), num.from, num.to)
      if (inner === null) return null
      return { value: -(inner.value as number), raw, from: node.from, to: node.to }
    }
    default:
      return null
  }
}

const allNumbers = (args: LiteralArg[]): boolean => args.every((a) => typeof a.value === 'number')

/** Kind-specific arity/type check — mirrors the scope.ts signatures. */
const validArgs = (kind: WidgetKind, args: LiteralArg[]): boolean => {
  switch (kind) {
    case 'slider':
      return args.length >= 1 && args.length <= 4 && allNumbers(args)
    case 'xy':
      return args.length === 2 && allNumbers(args)
    case 'toggle':
      return args.length === 1 && typeof args[0]!.value === 'boolean'
    case 'pick':
      // value + at least one option; a chip with nothing to cycle to is
      // not a widget
      return args.length >= 2
  }
}

/** Scan `doc` for widget calls and scrubbable numbers. Pass the editor's
 *  incremental `syntaxTree(state)` as `tree` to avoid a second parse. */
export function detect(doc: string, tree?: Tree): DetectResult {
  const t = tree ?? javascriptLanguage.parser.parse(doc)
  const widgets: WidgetDesc[] = []
  const numbers: ScrubLit[] = []

  t.iterate({
    enter(ref) {
      if (ref.name === 'Number') {
        const raw = doc.slice(ref.from, ref.to)
        if (!isPlainDecimal(raw)) return
        const value = Number(raw)
        if (!Number.isFinite(value)) return
        // fold a directly-attached unary minus into the literal
        const parent = ref.node.parent
        let from = ref.from
        let v = value
        if (parent?.name === 'UnaryExpression') {
          const op = parent.firstChild
          if (op?.name === 'ArithOp' && doc.slice(op.from, op.to) === '-' && op.nextSibling?.from === ref.from) {
            from = parent.from
            v = -value
          }
        }
        numbers.push({ from, to: ref.to, value: v, isInt: !/[.eE]/.test(raw) })
        return
      }
      if (ref.name !== 'CallExpression') return
      const call = ref.node
      const callee = call.firstChild
      if (callee?.name !== 'VariableName') return
      const kind = doc.slice(callee.from, callee.to)
      if (!WIDGET_KINDS.has(kind)) return
      const argList = call.getChild('ArgList')
      if (argList === null) return
      const args: LiteralArg[] = []
      let ok = true
      for (let ch = argList.firstChild; ch !== null; ch = ch.nextSibling) {
        if (PUNCT.has(ch.name)) continue
        const lit = literalArg(ch, doc)
        if (lit === null) {
          ok = false
          break
        }
        args.push(lit)
      }
      if (!ok || !validArgs(kind as WidgetKind, args)) return
      widgets.push({ kind: kind as WidgetKind, from: call.from, to: call.to, args })
    },
  })

  // numbers hidden behind a widget's UI are not scrubbable
  const visible = numbers.filter((n) => !widgets.some((w) => n.from >= w.from && n.to <= w.to))
  return { widgets, numbers: visible }
}
