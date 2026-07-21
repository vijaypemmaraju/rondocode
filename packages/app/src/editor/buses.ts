import { javascriptLanguage } from '@codemirror/lang-javascript'

/* ------------------------------------------------------------------------- *
 * bus() literal detection — PURE: (docText, tree?) → the send/gain numbers in
 * every bus(name, fx, sends?, opts?) call, WITH their exact source ranges.
 *
 * The mixer's bus faders are a remote control for these literals: drag a fader
 * and the editor rewrites the number in place (see editor.rewrite), so the
 * TEXT stays the single source of truth exactly like the inline widgets. Same
 * Lezer choice as widgets/detect.ts — error-tolerant, and it can reuse the
 * editor's incremental syntaxTree so the hot path never re-parses.
 *
 * Only PLAIN numeric literals become faders: a send whose amount is a variable
 * or expression is left alone (nothing safe to rewrite), and the bus still
 * works — it just has no fader.
 * ------------------------------------------------------------------------- */

type Tree = ReturnType<typeof javascriptLanguage.parser.parse>
type SyntaxNode = NonNullable<ReturnType<Tree['topNode']['getChild']>>

/** One send into a bus: `synth` feeds it by `amount`, and [from, to) is the
 *  amount literal's range in the source. */
export interface BusSend {
  synth: string
  amount: number
  from: number
  to: number
}

/** A bus output-gain literal (opts.gain) and its source range. */
export interface BusGain {
  value: number
  from: number
  to: number
}

export interface BusDesc {
  name: string
  sends: BusSend[]
  gain?: BusGain
}

const PUNCT = new Set(['(', ')', ',', 'LineComment', 'BlockComment'])

/** A plain decimal number (0x/0b/0o and 1n would change meaning if scrubbed). */
const isPlainDecimal = (raw: string): boolean => /^\d/.test(raw) && !/^0[xbo]/i.test(raw) && !/n$/.test(raw)

/** Property key text, or null when it isn't a plain/quoted name. */
const keyName = (node: SyntaxNode | null, doc: string): string | null => {
  if (node === null) return null
  if (node.name === 'PropertyDefinition' || node.name === 'PropertyName' || node.name === 'VariableName') {
    return doc.slice(node.from, node.to)
  }
  if (node.name === 'String') {
    const raw = doc.slice(node.from, node.to)
    return raw.includes('\\') ? null : raw.slice(1, -1)
  }
  return null
}

/** Number-valued properties of an ObjectExpression node (key → value + range). */
const numberProps = (obj: SyntaxNode, doc: string): { key: string; value: number; from: number; to: number }[] => {
  const out: { key: string; value: number; from: number; to: number }[] = []
  for (let p = obj.firstChild; p !== null; p = p.nextSibling) {
    if (p.name !== 'Property') continue
    const key = keyName(p.firstChild, doc)
    const val = p.lastChild
    if (key === null || val === null || val.name !== 'Number') continue
    const raw = doc.slice(val.from, val.to)
    if (!isPlainDecimal(raw)) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    out.push({ key, value, from: val.from, to: val.to })
  }
  return out
}

/** Scan `doc` for bus() calls and their editable send/gain literals. Pass the
 *  editor's `syntaxTree(state)` as `tree` to avoid a second parse. */
export function detectBuses(doc: string, tree?: Tree): BusDesc[] {
  const t = tree ?? javascriptLanguage.parser.parse(doc)
  const buses: BusDesc[] = []
  t.iterate({
    enter(ref) {
      if (ref.name !== 'CallExpression') return
      const call = ref.node
      const callee = call.firstChild
      if (callee === null || callee.name !== 'VariableName' || doc.slice(callee.from, callee.to) !== 'bus') return
      const argList = call.getChild('ArgList')
      if (argList === null) return
      // Top-level argument nodes, in order: [name, fx, sends?, opts?].
      const args: SyntaxNode[] = []
      for (let ch = argList.firstChild; ch !== null; ch = ch.nextSibling) {
        if (PUNCT.has(ch.name)) continue
        args.push(ch)
      }
      const nameNode = args[0]
      if (nameNode === undefined || nameNode.name !== 'String') return
      const rawName = doc.slice(nameNode.from, nameNode.to)
      if (rawName.includes('\\')) return
      const name = rawName.slice(1, -1)

      const sends: BusSend[] = []
      const sendObj = args[2]
      if (sendObj !== undefined && sendObj.name === 'ObjectExpression') {
        for (const p of numberProps(sendObj, doc)) sends.push({ synth: p.key, amount: p.value, from: p.from, to: p.to })
      }
      let gain: BusGain | undefined
      const optObj = args[3]
      if (optObj !== undefined && optObj.name === 'ObjectExpression') {
        const g = numberProps(optObj, doc).find((p) => p.key === 'gain')
        if (g !== undefined) gain = { value: g.value, from: g.from, to: g.to }
      }
      buses.push({ name, sends, gain })
    },
  })
  return buses
}
