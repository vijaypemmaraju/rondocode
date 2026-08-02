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
import type { BeatBlock, BeatRow, EnvMatch, KnobMatch, PlayRoll, RichPlay, WidgetScan } from '../rondo/widgets'
import { STEP_RE, accValue } from '../rondo/widgets'
import type { EnvPointsScan } from '../rondo/envpoints'
import type { WavetableCallScan, WavedefScan } from '../rondo/wavetable'
import { ENUM_VALUE_TABLE, EQ_TYPE_CYCLES, SVF_MODES as EDITOR_SVF_MODES, WT_TABLES } from '../rondo/enums'
import type { EnumSpan } from '../rondo/enums'
import type { UnisonScan } from '../rondo/unison'
import type { SwitchMatch, SwitchWrite } from '../rondo/switches'
import type { EqBandTypeName, FilterScan, StaticArg, SvfModeName } from '../rondo/filtercurve'

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
    // a SWITCH is a param too, and min/max default to 0..1 here — so without
    // this it would grow a dial reading 0..1 as well as its toggle, two
    // controls fighting over one value. scanSwitchesJs owns these.
    if (props.get('values') !== undefined) continue
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

/* ---- the breakpoint editor: env(gate, [[t, l], …]) ----------------------- */

/** Elements of an ArrayExpression, punctuation skipped. */
function arrayItems(arr: SyntaxNode): SyntaxNode[] {
  if (arr.name !== 'ArrayExpression') return []
  const out: SyntaxNode[] = []
  for (const c of kids(arr)) {
    if (c.name === '[' || c.name === ']' || c.name === ',') continue
    out.push(c)
  }
  return out
}

/** `env(gate, [[t, l], [t, l, curve], …], opts?)` as the same descriptor the
 *  rondo scan produces, so the SAME widget serves both.
 *
 *  Nothing about the writer had to change: it edits character ranges, and a
 *  number inside a JS array literal is a character range like any other. The
 *  reason this was rondo-only was only ever that nobody had read the spans out
 *  of the tree.
 *
 *  Every breakpoint must be plain literals. One computed point and the shape
 *  drawn would not be the shape playing, so the widget declines rather than
 *  draw a handle it cannot move. */
export function scanEnvPointsJs(text: string): EnvPointsScan[] {
  const root = parse(text)
  const out: EnvPointsScan[] = []
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'env') continue
    const args = callArgs(n)
    if (args[1] === undefined || args[1].name !== 'ArrayExpression') continue
    const points: EnvPointsScan['points'] = []
    let ok = true
    for (const el of arrayItems(args[1])) {
      const nums = arrayItems(el).map((q) => numTok(text, q))
      if (el.name !== 'ArrayExpression' || nums.length < 2 || nums.length > 3 || nums.some((q) => q === null)) {
        ok = false
        break
      }
      const [t, l, c] = nums as [NumTok, NumTok, NumTok | undefined]
      const p: EnvPointsScan['points'][number] = {
        time: t.value,
        level: l.value,
        timeSpan: { from: t.from, to: t.to },
        levelSpan: { from: l.from, to: l.to },
      }
      if (c !== undefined) { p.curve = c.value; p.curveSpan = { from: c.from, to: c.to } }
      else p.curveInsert = { at: l.to, prefix: ', ' }
      points.push(p)
    }
    if (!ok || points.length === 0) continue
    const synth = enclosingSynth(text, root, n.from)
    const scan: EnvPointsScan = { points, at: n.to }
    if (synth !== undefined) scan.synth = synth
    const wide = args[2] !== undefined ? objProps(text, args[2]).get('curve') : undefined
    const wideNum = wide !== undefined ? numTok(text, wide) : null
    if (wideNum !== null) scan.curve = wideNum.value
    out.push(scan)
  }
  return out
}

/* ---- the roll family: n('0 3 5') inside p(…) ----------------------------- */

/** A string literal's INTERIOR span. That is the whole trick for this family:
 *  hand the widget a range between the quotes and its existing writer cannot
 *  leave them — no writer change, exactly as with the two envelope editors. */
function strTok(doc: string, n: SyntaxNode): { value: string; from: number; to: number } | null {
  if (n.name !== 'String') return null
  const raw = slice(doc, n)
  const q = raw[0]
  if (q !== "'" && q !== '"') return null
  const body = raw.slice(1, -1)
  // an escape would make the interior offsets lie about the text
  if (body.includes('\\')) return null
  return { value: body, from: n.from + 1, to: n.to - 1 }
}

/** The METHOD a `x.foo(…)` call invokes. calleeName only answers for a bare
 *  identifier, which is right for `n('…')` and useless for the `.sound()` and
 *  `.scale()` that carry the rest of what a roll needs. */
function methodName(doc: string, call: SyntaxNode): string | null {
  if (call.name !== 'CallExpression') return null
  const callee = call.firstChild
  if (callee === null || callee.name !== 'MemberExpression') return null
  let last: SyntaxNode | null = null
  for (const c of kids(callee)) last = c
  return last !== null && last.name === 'PropertyName' ? slice(doc, last) : null
}

/** Walk a `n('…').scale(…).sound(…)` chain, collecting every call by the name
 *  it invokes — bare or method. */
function chainCalls(doc: string, root: SyntaxNode): Map<string, SyntaxNode[]> {
  const out = new Map<string, SyntaxNode[]>()
  for (const n of walk(root)) {
    const name = calleeName(doc, n) ?? methodName(doc, n)
    if (name === null) continue
    const list = out.get(name)
    if (list === undefined) out.set(name, [n])
    else list.push(n)
  }
  return out
}

/** rondo hands the widget its own short scale spelling (`a-min`), which
 *  rollPreviewMidi expands. JS writes `.scale('a minor')`, and expandScale
 *  reads a dashless string as "root + major" — so it has to be dashed here or
 *  every preview note would come out of the wrong scale. */
const dashScale = (s: string): string => s.trim().replace(/\s+/g, '-')

/** Everything the roll family needs from one `p(name, chain)` call. */
function playChain(doc: string, call: SyntaxNode): {
  entry: SyntaxNode
  text: { value: string; from: number; to: number }
  synth?: string
  scale?: string
} | null {
  const args = callArgs(call)
  if (args.length < 2 || args[1] === undefined) return null
  const calls = chainCalls(doc, args[1])
  // the note source: n('…') for degrees. note()/s() are other families.
  const entry = calls.get('n')?.[0]
  if (entry === undefined) return null
  const eArgs = callArgs(entry)
  if (eArgs.length !== 1 || eArgs[0] === undefined) return null
  const text = strTok(doc, eArgs[0])
  if (text === null) return null
  const out: ReturnType<typeof playChain> = { entry, text }
  const sound = calls.get('sound')?.[0]
  if (sound !== undefined) {
    const sa = callArgs(sound)
    const sv = sa[0] !== undefined ? strVal(doc, sa[0]) : null
    if (sv !== null) out.synth = sv
  }
  const scale = calls.get('scale')?.[0]
  if (scale !== undefined) {
    const sa = callArgs(scale)
    const sv = sa[0] !== undefined ? strVal(doc, sa[0]) : null
    if (sv !== null) out.scale = dashScale(sv)
  }
  return out
}

/** `p('bass', n('0 3 5 7')…)` → the editable step grid, when the notation is
 *  nothing but degrees and rests. Same rule as rondo, including negatives. */
export function scanPlaysJs(text: string): PlayRoll[] {
  const root = parse(text)
  const out: PlayRoll[] = []
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'p') continue
    const c = playChain(text, n)
    if (c === null) continue
    const toks = c.text.value.trim().split(/\s+/).filter(Boolean)
    if (toks.length === 0) continue
    // degrees may carry an accidental (`2#`, `3b`) — the notation is the same
    // string in both languages, so this is the same STEP_RE the rondo scan uses
    if (!toks.every((tk) => tk === '~' || STEP_RE.test(tk))) continue
    const roll: PlayRoll = {
      from: c.text.from,
      to: c.text.to,
      content: c.text.value,
      steps: toks.map((tk) => (tk === '~' ? null : Number(STEP_RE.exec(tk)![1]))),
      accs: toks.map((tk) => (tk === '~' ? undefined : accValue(STEP_RE.exec(tk)![2]))),
    }
    if (c.synth !== undefined) roll.synth = c.synth
    if (c.scale !== undefined) roll.scale = c.scale
    out.push(roll)
  }
  return out
}

/** Notation too rich for the grid but still pure degree-mini — the read-only
 *  overview. The predicate mirrors the rondo scan exactly: structure required,
 *  letters excluded, and the editable polymeter form left to scanPlaysJs. */
export function scanRichPlaysJs(text: string): RichPlay[] {
  const root = parse(text)
  const out: RichPlay[] = []
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'p') continue
    const c = playChain(text, n)
    if (c === null) continue
    const notation = c.text.value
    if (notation.length === 0) continue
    if (!/^[0-9~\s<>[\]{}%*/!@?,.()-]+$/.test(notation)) continue
    if (!/[<>[\]{}%*/!@?,()]/.test(notation)) continue
    if (/^\{[0-9~ \t]+\}%\d+$/.test(notation)) continue
    const rich: RichPlay = { content: notation, from: c.text.from, to: c.text.to }
    if (c.synth !== undefined) rich.synth = c.synth
    out.push(rich)
  }
  return out
}

/* ---- beat blocks: p(name, stack(s('…'), s('…'))) ------------------------ */

/** A drum row: `s('kick ~ kick ~')`, optionally `.gain('1 ~ 0.6 ~')`.
 *
 *  What a rondo `beat` block COMPILES TO is the answer to what the JS
 *  equivalent is — `p(name, stack(s(…), s(…)))` — so this is not a guess about
 *  mapping, it is the same program written the other way round. A lone
 *  `p(name, s(…))` is a one-row block, which is what a single rondo row
 *  compiles to as well.
 *
 *  The one real difference: rondo puts velocity inline (`kick:0.6`) and JS
 *  keeps it in a parallel pattern, so the row reports where its gains live and
 *  the widget writes both strings (see BeatRow.gainSpan). */
function beatRowFrom(doc: string, call: SyntaxNode, gain: SyntaxNode | undefined): BeatRow | null {
  const args = callArgs(call)
  if (args.length !== 1 || args[0] === undefined) return null
  const text = strTok(doc, args[0])
  if (text === null) return null
  const toks = text.value.trim().split(/\s+/).filter(Boolean)
  if (toks.length < 2) return null // a 1-step row is not a sequencer
  // a JS row carries no `:v` suffixes — the words are bare
  if (!toks.every((tk) => tk === '~' || /^[a-zA-Z_]\w*$/.test(tk))) return null
  const words = new Set(toks.filter((tk) => tk !== '~'))
  if (words.size !== 1) return null // no single instrument to label the row
  const word = [...words][0]!

  // velocities, when a sibling .gain('…') supplies them, aligned by position
  let gains: number[] | null = null
  let gainSpan: { from: number; to: number } | undefined
  if (gain !== undefined) {
    const ga = callArgs(gain)
    const gt = ga.length === 1 && ga[0] !== undefined ? strTok(doc, ga[0]) : null
    if (gt !== null) {
      const gtoks = gt.value.trim().split(/\s+/).filter(Boolean)
      // a gain pattern that does not line up step-for-step is NOT this row's
      // velocities — writing into it would silently retime the whole line
      if (gtoks.length === toks.length && gtoks.every((g) => g === '~' || /^\d*\.?\d+$/.test(g))) {
        gains = gtoks.map((g) => (g === '~' ? 1 : Number(g)))
        gainSpan = { from: gt.from, to: gt.to }
      }
    }
  }
  const row: BeatRow = {
    from: text.from,
    to: text.to,
    content: text.value,
    word,
    steps: toks.map((tk, i) => (tk === '~' ? null : gains !== null ? gains[i]! : 1)),
    hadComment: false,
  }
  if (gainSpan !== undefined) row.gainSpan = gainSpan
  return row
}

export function scanBeatsJs(text: string): BeatBlock[] {
  const root = parse(text)
  const out: BeatBlock[] = []
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'p') continue
    const args = callArgs(n)
    if (args.length < 2 || args[1] === undefined) continue
    const body = args[1]
    // a stack() is a multi-row block; a bare chain is a single row
    const heads = calleeName(text, body) === 'stack' ? callArgs(body) : [body]
    const rows: BeatRow[] = []
    for (const head of heads) {
      const calls = chainCalls(text, head)
      const src = calls.get('s')?.[0]
      if (src === undefined) continue
      const row = beatRowFrom(text, src, calls.get('gain')?.[0])
      if (row !== null) rows.push(row)
    }
    if (rows.length > 0) out.push({ rows })
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

/* ---- switches: param(name, a, { values: [a, b] }) ------------------------ */

/** Every switch in a JS document, from both scopes.
 *
 *  Three spans rather than rondo's two: JavaScript spells the resting value
 *  TWICE — once as the default and once as the first array element — so a
 *  toggle has to move both or the two would disagree about which value the
 *  control is on. That is the whole reason SwitchMatch reports writes instead
 *  of a value; see switches.ts.
 *
 *  A default that is not one of the pair yields no widget. The engine rejects
 *  it too, but a widget would be worse than the error: it would offer a tap
 *  that writes a state the source cannot spell. */
export function scanSwitchesJs(text: string): SwitchMatch[] {
  const root = parse(text)
  const out: SwitchMatch[] = []
  for (const n of walk(root)) {
    const fn = calleeName(text, n)
    if (fn !== 'param' && fn !== 'macro') continue
    const args = callArgs(n)
    const name = args[0] !== undefined ? strVal(text, args[0]) : null
    const def = args[1] !== undefined ? numTok(text, args[1]) : null
    if (name === null || def === null || args[2] === undefined) continue
    const props = objProps(text, args[2])
    const arr = props.get('values')
    if (arr === undefined || arr.name !== 'ArrayExpression') continue
    const els: NumTok[] = []
    let ok = true
    for (const el of kids(arr)) {
      if (el.name === '[' || el.name === ']' || el.name === ',') continue
      const t = numTok(text, el)
      if (t === null) { ok = false; break }
      els.push(t)
    }
    if (!ok || els.length !== 2) continue
    const [a, b] = els as [NumTok, NumTok]
    if (a.value === b.value) continue
    // which element the default is resting on decides the pair's ORDER, so
    // that `values` written the other way round still reads correctly
    const restsOnFirst = def.value === a.value
    if (!restsOnFirst && def.value !== b.value) continue
    const values: [number, number] = restsOnFirst ? [a.value, b.value] : [b.value, a.value]
    // ONE write. In JavaScript the default is what says where the switch is
    // resting and `values` is just the set it may hold, so a toggle only moves
    // the default -- reordering the array as well would be a diff that changes
    // nothing. rondo has no separate default, which is why it swaps instead.
    const writes: SwitchWrite[] = [{ from: def.from, to: def.to, holds: 0 }]
    const synth = enclosingSynth(text, root, n.from)
    out.push({
      values,
      writes,
      at: n.to,
      name,
      ...(fn === 'macro' ? { macro: true as const } : synth !== undefined ? { synth } : {}),
    })
  }
  return out
}

/* ---- filter response curves: svf / ladder / dualsvf / eq ----------------- */

/** rondo's `ladder 900` and JS's `ladder(x, 900)` do NOT resonate the same.
 *
 *  The engine's own default is res 0 for all three (compile.ts's port table),
 *  but rondo's builtin registry emits `res: 0.5` whenever a ladder line omits
 *  it. So the same written line means two different filters depending on the
 *  language, and a curve drawn at 0.5 over a JS ladder would show a peak that
 *  is not there. The scanner reports what THIS language actually does. */
const JS_RES_DEFAULT = 0

/** Where a mid-line call's curve hangs: the end of the line it ends on.
 *
 *  rondo's `at` is "end of the line's code part" because a rondo filter IS a
 *  whole spine line. In JS the call is an expression with `.mul(env)` often
 *  still to come, and anchoring at the closing paren would drop a 420px block
 *  into the middle of the source. Same contract, computed rather than given. */
const lineEndFrom = (text: string, pos: number): number => {
  const nl = text.indexOf('\n', pos)
  const end = nl === -1 ? text.length : nl
  let i = end
  while (i > pos && (text[i - 1] === ' ' || text[i - 1] === '\t')) i--
  return i
}

/** Binding name → literal `param()` default, scoped to the enclosing synth.
 *
 *  The rondo scanner keys knob DEFs by the param's NAME because rondo's `cutoff
 *  = knob 800 …` makes the two the same word. JS can spell them apart — `const
 *  fc = param('cutoff', 800)` — and the call site says `fc`, so the binding is
 *  what has to be resolvable. */
function paramBindings(doc: string, root: SyntaxNode): Map<string, number> {
  const out = new Map<string, number>()
  for (const n of walk(root)) {
    if (n.name !== 'VariableDeclaration') continue
    let name: string | undefined
    let def: NumTok | null = null
    for (const c of kids(n)) {
      if (c.name === 'VariableDefinition') name = slice(doc, c)
      if (c.name === 'CallExpression' && calleeName(doc, c) === 'param') {
        const args = callArgs(c)
        def = args[1] !== undefined ? numTok(doc, args[1]) : null
      }
    }
    if (name === undefined || def === null) continue
    out.set(`${enclosingSynth(doc, root, n.from) ?? ''} ${name}`, def.value)
  }
  return out
}

/** One numeric argument's static story, by the same three rules the rondo
 *  scanner applies: a literal is a value you may drag; a bare identifier that
 *  names a knob is a value you may not (the signal owns it); anything else has
 *  no honest value at all. */
function staticArgJs(
  doc: string,
  node: SyntaxNode | undefined,
  bindings: Map<string, number>,
  synth: string | undefined,
): StaticArg | null {
  if (node === undefined) return null
  const num = numTok(doc, node)
  if (num !== null) return { value: num.value, range: { from: num.from, to: num.to } }
  if (node.name !== 'VariableName') return null // a rich expression: no read
  const def = bindings.get(`${synth ?? ''} ${slice(doc, node)}`)
    ?? bindings.get(` ${slice(doc, node)}`)
  return def !== undefined ? { value: def } : null
}

const isSvfMode = (s: string | null): s is SvfModeName => s !== null && SVF_MODES.has(s)

const SVF_MODES: ReadonlySet<string> = new Set(EDITOR_SVF_MODES)
const EQ_TYPES: ReadonlySet<string> = new Set(EQ_TYPE_CYCLES.flat())

/** Filter response curves under `svf(…)`, `ladder(…)`, `dualsvf(…)`, `eq(…)`.
 *
 *  The last rondo-only widget family. Nothing about the curve maths or the
 *  drag handles is language-specific — a handle writes a number into a
 *  character range — so this is a scan and only a scan.
 *
 *  Positions differ from rondo in exactly one way that matters: rondo's spine
 *  passes the input implicitly, so `svf 900` puts the cutoff first, while JS
 *  spells the input out and the cutoff is the SECOND argument. Everything
 *  after that is the same values under different punctuation. */
export function scanFiltersJs(text: string): FilterScan[] {
  const root = parse(text)
  const bindings = paramBindings(text, root)
  // Ordered by each call's CLOSING position, not its start. A rondo spine
  // reads in signal-flow order (input first, every line feeding the next), and
  // the JS form of that same spine is nested inside-out —
  // `eq(dualsvf(svf(ladder(saw(note)))))`. The innermost call is the earliest
  // stage and it is also the first to close, so the closing paren is where the
  // two languages agree about what "first" means.
  const out: (FilterScan & { readonly to: number })[] = []
  for (const n of walk(root)) {
    const kind = calleeName(text, n)
    if (kind !== 'svf' && kind !== 'ladder' && kind !== 'dualsvf' && kind !== 'eq') continue
    const args = callArgs(n)
    const synth = enclosingSynth(text, root, n.from)
    const scan: FilterScan & { to: number } = {
      kind, at: lineEndFrom(text, n.to), to: n.to, cutoffs: [], res: { value: JS_RES_DEFAULT },
      mode: 'lp', routing: 'serial', a: 'lp', b: 'lp', bands: [],
    }
    if (synth !== undefined) scan.synth = synth

    if (kind === 'eq') {
      // eq(inp, [{ type, freq, gain, q }, …]) — every band fully literal or
      // the line stays curve-less, the same rule the rondo scanner applies to
      // its bare `eq peak 800 6 1.2` groups
      const list = args[1]
      if (list === undefined || list.name !== 'ArrayExpression') continue
      let ok = true
      for (const b of kids(list)) {
        if (b.name === '[' || b.name === ']' || b.name === ',') continue
        if (b.name !== 'ObjectExpression') { ok = false; break }
        const props = objProps(text, b)
        const typeNode = props.get('type')
        const type = typeNode !== undefined ? strVal(text, typeNode) : 'peak' // engine default
        if (type === null || !EQ_TYPES.has(type)) { ok = false; break }
        const lit = (k: string): StaticArg | null => {
          const node = props.get(k)
          if (node === undefined) return null
          const t = numTok(text, node)
          return t === null ? null : { value: t.value, range: { from: t.from, to: t.to } }
        }
        const freq = lit('freq')
        if (freq === null) { ok = false; break } // freq is required, as in rondo
        const band: FilterScan['bands'][number] = { type: type as EqBandTypeName, freq }
        const gain = lit('gain')
        const q = lit('q')
        if (gain !== null) band.gain = gain
        if (q !== null) band.q = q
        scan.bands.push(band)
      }
      if (!ok || scan.bands.length === 0) continue
      out.push(scan)
      continue
    }

    // svf/ladder/dualsvf: input, cutoff(s), then one options object
    const need = kind === 'dualsvf' ? 2 : 1
    let bad = false
    for (let i = 0; i < need; i++) {
      const sa = staticArgJs(text, args[1 + i], bindings, synth)
      if (sa === null) { bad = true; break }
      scan.cutoffs.push(sa)
    }
    if (bad) continue
    const opts = args[1 + need]
    if (opts !== undefined && opts.name === 'ObjectExpression') {
      const props = objProps(text, opts)
      const resNode = props.get('res')
      if (resNode !== undefined) {
        // a signal-driven res falls back to the default silently — the curve is
        // still honest at the written cutoffs, just drawn at rest
        const sa = staticArgJs(text, resNode, bindings, synth)
        if (sa !== null) scan.res = sa
      }
      const modeNode = props.get('mode')
      const mode = modeNode !== undefined ? strVal(text, modeNode) : null
      if (kind === 'svf' && isSvfMode(mode)) scan.mode = mode
      if (kind === 'dualsvf' && (mode === 'serial' || mode === 'parallel')) scan.routing = mode
      if (kind === 'dualsvf') {
        const aNode = props.get('a')
        const bNode = props.get('b')
        const av = aNode !== undefined ? strVal(text, aNode) : null
        const bv = bNode !== undefined ? strVal(text, bNode) : null
        if (isSvfMode(av)) scan.a = av
        if (isSvfMode(bv)) scan.b = bv
      }
    }
    out.push(scan)
  }
  return out.sort((x, y) => x.to - y.to).map(({ to: _to, ...rest }) => rest)
}

/* ---- enum words: the tap-cycler ------------------------------------------ */

/** Enum arguments in a JS call: `{ mode: 'lp' }` and the positional word slots.
 *
 *  rondo writes these bare (`svf 900 mode:lp`) and JS quotes them, which is
 *  the only difference that matters — the span is the string's INTERIOR, so
 *  the cycler rewrites `lp` and leaves the quotes alone. Same trick as the
 *  roll family.
 *
 *  The value LISTS come from ENUM_VALUE_TABLE, which is the engine's accepted
 *  values, so both languages cycle through exactly the same set. */
export function scanEnumSpansJs(text: string): EnumSpan[] {
  const root = parse(text)
  const out: EnumSpan[] = []
  const tables: readonly string[] = (() => {
    const custom = scanWavedefsJs(text).map((w) => w.name)
    return custom.length > 0 ? [...WT_TABLES, ...custom] : WT_TABLES
  })()
  for (const n of walk(root)) {
    const name = calleeName(text, n) ?? methodName(text, n)
    if (name === null) continue
    const spec = ENUM_VALUE_TABLE[name]
    if (spec === undefined) continue
    const args = callArgs(n)
    // positional enum slots, index-aligned with the registry's `pos`
    spec.pos?.forEach((values, i) => {
      const a = args[i]
      if (values === null || values === undefined || a === undefined) return
      const tok = strTok(text, a)
      if (tok === null || !values.includes(tok.value)) return
      out.push({ from: tok.from, to: tok.to, word: tok.value, values })
    })
    // named enum args, wherever the options object happens to sit
    if (spec.named === undefined) continue
    for (const a of args) {
      if (a.name !== 'ObjectExpression') continue
      const props = objProps(text, a)
      for (const [key, values] of Object.entries(spec.named)) {
        const node = props.get(key)
        if (node === undefined) continue
        const tok = strTok(text, node)
        // `table:` accepts any registered wavedef, not just the built-ins
        const list = key === 'table' ? tables : values
        if (tok === null || !list.includes(tok.value)) continue
        out.push({ from: tok.from, to: tok.to, word: tok.value, values: list })
      }
    }
  }
  // eq band types live in an ARRAY of objects, not in the call's own options,
  // so the loop above cannot reach them: `eq(x, [{ type: 'peak', … }])`. They
  // also cycle within their arity group rather than across all five types —
  // see EQ_TYPE_CYCLES — because hp/lp read their numbers as freq q and the
  // others as freq gain q, so crossing groups would re-key the numbers.
  for (const n of walk(root)) {
    if (calleeName(text, n) !== 'eq') continue
    const list = callArgs(n)[1]
    if (list === undefined || list.name !== 'ArrayExpression') continue
    for (const band of kids(list)) {
      if (band.name !== 'ObjectExpression') continue
      const node = objProps(text, band).get('type')
      if (node === undefined) continue
      const tok = strTok(text, node)
      if (tok === null) continue
      const group = EQ_TYPE_CYCLES.find((g) => g.includes(tok.value))
      if (group === undefined) continue
      out.push({ from: tok.from, to: tok.to, word: tok.value, values: group })
    }
  }
  return out.sort((a, b) => a.from - b.from)
}

/* ---- the scanner set ----------------------------------------------------- */

/** JavaScript's widget scanners.
 *
 * Every family is here now, and none of them needed a writer change. They all
 * edit character ranges: a number inside an options object, a number inside an
 * array literal, and — for the roll family — the INTERIOR of a string. Hand
 * the widget a span between the quotes and its existing writer cannot leave
 * them. The work was always reading the spans out of the tree.
 *
 * The filter curves were the last family to cross, and they crossed the same
 * way: the maths, the handles and the write-verify are untouched, because a
 * handle only ever writes a number into a character range. What differed was
 * the reading — JS spells the input out, so the cutoff is the second argument
 * rather than the first — and one real semantic gap: rondo injects res 0.5
 * into a bare `ladder`, JS leaves it at the engine's 0. See JS_RES_DEFAULT.
 *
 * The one place a WRITER did have to learn something: a beat row's velocity is
 * inline in rondo (`kick:0.6`) and a parallel `.gain('1 ~ 0.6')` pattern in
 * JS, so a row can be one string or two. The row says which (BeatRow.gainSpan)
 * and the widget writes accordingly — the languages genuinely differ there,
 * which is the only reason it is not hidden behind a span. */
export const JS_SCAN: WidgetScan = {
  knobs: scanKnobsJs,
  envs: scanEnvsJs,
  envPoints: scanEnvPointsJs,
  plays: scanPlaysJs,
  richPlays: scanRichPlaysJs,
  beats: scanBeatsJs,
  wavedefs: scanWavedefsJs,
  // array elements, not space-joined: `[1, 0.5]` gains `, 0`
  wavedefDialect: { sep: ', ', scan: scanWavedefsJs },
  wavetableCalls: scanWavetableCallsJs,
  unisonHeaders: scanUnisonHeadersJs,
  filters: scanFiltersJs,
  switches: scanSwitchesJs,
  enumSpans: scanEnumSpansJs,
}
