/* ------------------------------------------------------------------------- *
 * JavaScript scanners for the shared widget layer.
 *
 * Every widget in editor/rondo/widgets.ts is language-agnostic already: it is
 * handed absolute source offsets plus values, and the editable ones write back
 * through LiveWriter at those offsets. Only the SCAN was rondo-specific. These
 * produce the same descriptors from JavaScript, so the same widgets — the same
 * gesture machinery, the same write-verify discipline — serve both languages.
 *
 * Two things make this different from a port of the rondo regexes:
 *
 *   1. There is a real syntax tree, so locating a call is exact rather than a
 *      line pattern. `param('cut', 1200, { min: 100 })` is found wherever it
 *      sits, across line breaks, inside any nesting.
 *   2. JavaScript spells the same thing more ways. rondo's `knob 1200 100..6000
 *      log` is four literals in fixed positions; the JS form has an options
 *      OBJECT whose keys may be reordered, omitted, or computed. A widget can
 *      only exist where the values are literals — a `param('cut', baseFreq)`
 *      has no number to drag — which is the rule detect.ts already applies to
 *      slider()/toggle()/pick()/xy(). Non-literal code keeps plain text and
 *      still runs.
 * ------------------------------------------------------------------------- */

import { javascriptLanguage } from '@codemirror/lang-javascript'
import type { EnvMatch, KnobMatch, WidgetScan } from '../rondo/widgets'
import type { WavetableCallScan, WavedefScan } from '../rondo/wavetable'
import type { UnisonScan } from '../rondo/unison'

type Tree = ReturnType<typeof javascriptLanguage.parser.parse>
type SyntaxNode = Tree['topNode']

/** Parse once per scan pass. Docs here are small (<10 KB); the whole-file
 *  parse is well under a millisecond and keeps every scanner pure over text. */
const parse = (text: string): SyntaxNode => javascriptLanguage.parser.parse(text).topNode

const slice = (doc: string, n: SyntaxNode): string => doc.slice(n.from, n.to)

/** Children of a node, skipping punctuation and comments. */
function* kids(n: SyntaxNode): Generator<SyntaxNode> {
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c.name === 'LineComment' || c.name === 'BlockComment') continue
    yield c
  }
}

/** A plain decimal literal's numeric value + exact source range, or null.
 *  Folds a directly-attached unary minus so `-0.5` reads as one token. */
export interface NumTok {
  value: number
  from: number
  to: number
}
function numTok(doc: string, n: SyntaxNode): NumTok | null {
  if (n.name === 'Number') {
    const raw = slice(doc, n)
    // hex/binary/octal/bigint would change meaning if a scrub rewrote them
    if (!/^\d/.test(raw) || /^0[xbo]/i.test(raw) || /n$/.test(raw)) return null
    const value = Number(raw)
    return Number.isFinite(value) ? { value, from: n.from, to: n.to } : null
  }
  if (n.name === 'UnaryExpression') {
    const op = n.firstChild
    const num = op?.nextSibling
    if (op === null || op === undefined || slice(doc, op) !== '-') return null
    if (num === null || num === undefined || num.name !== 'Number') return null
    const inner = numTok(doc, num)
    return inner === null ? null : { value: -inner.value, from: n.from, to: n.to }
  }
  return null
}

/** An escape-free string literal's cooked value, or null. */
function strVal(doc: string, n: SyntaxNode): string | null {
  if (n.name !== 'String') return null
  const raw = slice(doc, n)
  return raw.includes('\\') ? null : raw.slice(1, -1)
}

/** The name a CallExpression calls, when the callee is a bare identifier. */
function calleeName(doc: string, call: SyntaxNode): string | null {
  if (call.name !== 'CallExpression') return null
  const callee = call.firstChild
  return callee !== null && callee.name === 'VariableName' ? slice(doc, callee) : null
}

/** A call's argument nodes (the ArgList's expression children). */
function callArgs(call: SyntaxNode): SyntaxNode[] {
  for (const c of kids(call)) {
    if (c.name !== 'ArgList') continue
    const out: SyntaxNode[] = []
    for (let a = c.firstChild; a !== null; a = a.nextSibling) {
      if (a.name === '(' || a.name === ')' || a.name === ',') continue
      if (a.name === 'LineComment' || a.name === 'BlockComment') continue
      out.push(a)
    }
    return out
  }
  return []
}

/** Read an ObjectExpression's literal properties: key → value node. Computed
 *  keys, spreads and methods are skipped, so a partially-dynamic options
 *  object still yields the literal parts. */
function objProps(doc: string, obj: SyntaxNode): Map<string, SyntaxNode> {
  const out = new Map<string, SyntaxNode>()
  if (obj.name !== 'ObjectExpression') return out
  for (const prop of kids(obj)) {
    if (prop.name !== 'Property') continue
    const key = prop.firstChild
    if (key === null) continue
    const name = key.name === 'PropertyDefinition' || key.name === 'PropertyName' || key.name === 'VariableName'
      ? slice(doc, key)
      : key.name === 'String'
        ? strVal(doc, key)
        : null
    if (name === null) continue
    // the value is the last child (key : value)
    let value: SyntaxNode | null = null
    for (const c of kids(prop)) value = c
    if (value !== null && value !== key) out.set(name, value)
  }
  return out
}

/** Walk every node, depth first. */
function* walk(n: SyntaxNode): Generator<SyntaxNode> {
  yield n
  for (const c of kids(n)) yield* walk(c)
}

/** The `const NAME = synth(…)` a node sits inside, which is how a widget
 *  routes live values to the right voice. Synths register under that binding
 *  name (see evalCode's auto-defineSynth transform), so the enclosing
 *  VariableDeclaration IS the synth name. */
function enclosingSynth(doc: string, root: SyntaxNode, pos: number): string | undefined {
  let best: { name: string; span: number } | undefined
  for (const n of walk(root)) {
    if (n.name !== 'VariableDeclaration') continue
    if (pos < n.from || pos > n.to) continue
    let name: string | undefined
    let isSynth = false
    for (const c of kids(n)) {
      if (c.name === 'VariableDefinition') name = slice(doc, c)
      if (c.name === 'CallExpression' && calleeName(doc, c) === 'synth') isSynth = true
    }
    if (!isSynth || name === undefined) continue
    const span = n.to - n.from
    // innermost wins (nested synths are legal, if unusual)
    if (best === undefined || span < best.span) best = { name, span }
  }
  return best?.name
}

/* ---- knob: param('name', def, { min, max, curve }) ----------------------- */

/** Find every `param(name, def, opts)` whose def is a literal number.
 *
 *  min/max default to the engine's own (0..1) when the options object omits
 *  them, exactly as `param()` does — a knob still beats a bare number even
 *  without an explicit range. A non-literal def (a variable, an expression)
 *  yields no knob: there would be nothing to write back to. */
export function scanKnobsJs(text: string): KnobMatch[] {
  const root = parse(text)
  const out: KnobMatch[] = []
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'param') continue
    const args = callArgs(n)
    const name = args[0] !== undefined ? strVal(text, args[0]) : null
    const def = args[1] !== undefined ? numTok(text, args[1]) : null
    if (name === null || def === null) continue
    const props = args[2] !== undefined ? objProps(text, args[2]) : new Map<string, SyntaxNode>()
    const minN = props.get('min') !== undefined ? numTok(text, props.get('min')!) : null
    const maxN = props.get('max') !== undefined ? numTok(text, props.get('max')!) : null
    const curveNode = props.get('curve')
    const curve = curveNode !== undefined ? strVal(text, curveNode) : null
    const lo = minN?.value ?? 0
    const hi = maxN?.value ?? 1
    if (!(hi > lo)) continue // a degenerate range has no dial to turn
    const synth = enclosingSynth(text, root, n.from)
    out.push({
      defFrom: def.from,
      defTo: def.to,
      value: def.value,
      lo,
      hi,
      log: curve === 'log',
      name,
      ...(synth !== undefined ? { synth } : {}),
    })
  }
  return out
}

/* ---- the envelope: adsr(gate, { a, d, s, r }) ---------------------------- */

/** ADSR curves on `adsr(gate, { a: 0.004, d: 0.18, s: 0.25, r: 0.12 })`.
 *
 *  All four stages must be plain literals: the widget drags a CURVE, and a
 *  stage driven by a knob or an expression has no number to write back to
 *  (`adsr(gate, { r: relKnob })` is a real and useful thing to write — it just
 *  cannot also be a handle). Partial coverage would be worse than none: three
 *  draggable corners and one that silently ignores you.
 *
 *  The four spans go out in a/d/s/r order regardless of how the object was
 *  written, so `{ r: 0.1, a: 0.003, ... }` drags correctly too. */
export function scanEnvsJs(text: string): EnvMatch[] {
  const root = parse(text)
  const out: EnvMatch[] = []
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'adsr') continue
    const args = callArgs(n)
    if (args[1] === undefined) continue
    const props = objProps(text, args[1])
    const toks = (['a', 'd', 's', 'r'] as const).map((k) => {
      const node = props.get(k)
      return node !== undefined ? numTok(text, node) : null
    })
    if (toks.some((t) => t === null)) continue
    const [a, d, sus, r] = toks as [NumTok, NumTok, NumTok, NumTok]
    const synth = enclosingSynth(text, root, n.from)
    out.push({
      // the region is the whole call: eq() uses it to notice a respelled
      // literal, and the widget anchors after it
      from: n.from,
      to: n.to,
      a: a.value, d: d.value, s: sus.value, r: r.value,
      ranges: [a, d, sus, r].map((t) => ({ from: t.from, to: t.to })),
      ...(synth !== undefined ? { synth } : {}),
    })
  }
  return out
}

/* ---- unison fan: synth(fn, opts) / synth(fn, post, opts) ----------------- */

/** Voice-spread glyphs on a `synth(…, { unison, detune, spread })`. Display
 *  only, so it needs nothing but the numbers and an anchor. */
export function scanUnisonHeadersJs(text: string): UnisonScan[] {
  const root = parse(text)
  const out: UnisonScan[] = []
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'synth') continue
    const args = callArgs(n)
    // the options object is the LAST argument when it is an object literal
    const last = args[args.length - 1]
    if (last === undefined || last.name !== 'ObjectExpression') continue
    const props = objProps(text, last)
    const voices = props.get('unison') !== undefined ? numTok(text, props.get('unison')!) : null
    if (voices === null || voices.value < 2) continue
    // defaults mirror the engine's DEFAULT_VOICE_OPTS, same as the rondo scan
    const num = (k: string, dflt: number): number => {
      const node = props.get(k)
      const t = node !== undefined ? numTok(text, node) : null
      return t?.value ?? dflt
    }
    out.push({
      at: n.to,
      synth: enclosingSynth(text, root, n.from) ?? '',
      unison: voices.value,
      detune: num('detune', 15),
      curve: num('curve', 1),
      blend: num('blend', 1),
      octaves: num('octaves', 0),
    })
  }
  return out
}

/* ---- wavetable ribbon: wavetable(freq, pos, { table, warp, warpAmt }) ---- */

const WARPS = new Set(['sync', 'bend', 'mirror'])

/** Ribbon previews under `wavetable(…)` calls. `pos` is read only when it is a
 *  literal — a signal-driven scan renders the morph across the whole ribbon,
 *  which is the same honesty rule the rondo scanner applies. */
export function scanWavetableCallsJs(text: string): WavetableCallScan[] {
  const root = parse(text)
  const out: WavetableCallScan[] = []
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'wavetable') continue
    const args = callArgs(n)
    const opts = args.find((a) => a.name === 'ObjectExpression')
    const props = opts !== undefined ? objProps(text, opts) : new Map<string, SyntaxNode>()
    const tableNode = props.get('table')
    const table = tableNode !== undefined ? strVal(text, tableNode) : null
    // pos is the 2nd positional when it is a plain number
    const posNode = args[1]
    const pos = posNode !== undefined && posNode.name !== 'ObjectExpression' ? numTok(text, posNode) : null
    const warpNode = props.get('warp')
    const warpRaw = warpNode !== undefined ? strVal(text, warpNode) : null
    const warp = warpRaw !== null && WARPS.has(warpRaw) ? (warpRaw as WavetableCallScan['warp']) : undefined
    const amtNode = props.get('warpAmt')
    const amt = amtNode !== undefined ? numTok(text, amtNode) : null
    out.push({
      table: table ?? 'basic',
      ...(pos !== null ? { posLiteral: pos.value } : {}),
      ...(warp !== undefined ? { warp } : {}),
      ...(warp !== undefined ? { warpAmt: amt?.value ?? 0.5 } : {}),
      ...(enclosingSynth(text, root, n.from) !== undefined
        ? { synth: enclosingSynth(text, root, n.from)! }
        : {}),
      at: n.to,
    })
  }
  return out
}

/* ---- wavedef editor: defineWavetable('name', [[…], […]]) ----------------- */

/** The bar editor's source model: frames of partial amplitudes, each with the
 *  exact range of its number token so a drag rewrites that number and nothing
 *  else. Only fully-literal tables qualify — a computed frame cannot be
 *  dragged without destroying the expression that built it. */
export function scanWavedefsJs(text: string): WavedefScan[] {
  const root = parse(text)
  const out: WavedefScan[] = []
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'defineWavetable') continue
    const args = callArgs(n)
    const name = args[0] !== undefined ? strVal(text, args[0]) : null
    const table = args[1]
    if (name === null || table === undefined || table.name !== 'ArrayExpression') continue
    const frames: number[][] = []
    const ranges: { from: number; to: number }[][] = []
    let ok = true
    for (const frame of kids(table)) {
      if (frame.name === '[' || frame.name === ']' || frame.name === ',') continue
      if (frame.name !== 'ArrayExpression') { ok = false; break }
      const vals: number[] = []
      const rs: { from: number; to: number }[] = []
      for (const num of kids(frame)) {
        if (num.name === '[' || num.name === ']' || num.name === ',') continue
        const t = numTok(text, num)
        if (t === null) { ok = false; break }
        vals.push(t.value)
        rs.push({ from: t.from, to: t.to })
      }
      if (!ok || vals.length === 0) { ok = false; break }
      frames.push(vals)
      ranges.push(rs)
    }
    if (!ok || frames.length === 0) continue
    out.push({ name, frames, ranges, at: n.to })
  }
  return out
}

/* ---- the scanner set ----------------------------------------------------- */

/** JavaScript's widget scanners.
 *
 * The roll family is the one still on rondo-only: its write-back rewrites
 * mini-notation, which rondo carries unquoted and JS carries inside a string
 * literal. It is reachable — `n('0 3 5')` is right there — it just needs the
 * writer taught to stay inside the quotes. Until then it returns nothing here
 * rather than half-working, so a JS doc simply shows the widgets that fully
 * function. (The envelope came across once its writer stopped rebuilding a
 * space-joined region and started writing the four VALUES in place: that is
 * the only part the two languages share.) */
export const JS_SCAN: WidgetScan = {
  knobs: scanKnobsJs,
  envs: scanEnvsJs,
  plays: () => [],
  richPlays: () => [],
  beats: () => [],
  wavedefs: scanWavedefsJs,
  // array elements, not space-joined: `[1, 0.5]` gains `, 0`
  wavedefDialect: { sep: ', ', scan: scanWavedefsJs },
  wavetableCalls: scanWavetableCallsJs,
  unisonHeaders: scanUnisonHeadersJs,
  filters: () => [],
  enumSpans: () => [],
}
