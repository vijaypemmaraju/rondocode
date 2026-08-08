/* ------------------------------------------------------------------------- *
 * Context-aware rondo completion.
 *
 * The old source filtered ONE flat list by prefix, so `s` offered `saw`,
 * `scale:`, `struct`, `slow` and `sample` wherever you were — inside a filter
 * call, on a play line, at the top level. Most of those are illegal in most of
 * those places, and a completion list that is mostly wrong is worse than none:
 * it trains you to ignore it.
 *
 * Everything needed to do better is already in the compiler. BUILTINS knows
 * each call's named arguments; ENUM_VALUE_TABLE knows their legal values; the
 * indentation says which block you are in. This reads all three and answers
 * the actual question — "what may go HERE".
 *
 * Four positions, each with a different answer:
 *
 *   top level        block headers (`synth`, `play`, `macro`, `bpm`, …)
 *   synth / bus body builtins, this block's bindings, the project's macros
 *   play / beat body modifier keywords (`scale:`, `dur:`, `every`, `rev`, …)
 *   inside a call    THAT builtin's named args — and after `mode:`, its enums
 *
 * The last one is the point. `svf 900 ` should offer `res:` and `mode:`, not
 * every oscillator in the language.
 * ------------------------------------------------------------------------- */

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { BUILTINS, BLOCK_KEYWORDS } from '@rondocode/rondo'
import { ENUM_VALUE_TABLE } from './enums'

/** Where the cursor is, as far as completion cares. */
export type RondoPos =
  | { kind: 'top' }
  | { kind: 'synth'; block: string }
  | { kind: 'play' }
  | { kind: 'named'; builtin: string; arg: string }
  | { kind: 'args'; builtin: string; block: string }

/** Imported from the parser, not restated: this copy was missing `curvedef`
 *  and `switch`, so two blocks the grammar accepts were never offered. */
const BLOCK_HEADERS: readonly string[] = BLOCK_KEYWORDS

/** Blocks whose body is a signal pipeline. `post` is nested inside a synth but
 *  takes the same vocabulary, so it reads as one. */
const SIGNAL_BLOCKS = new Set(['synth', 'bus', 'post'])

const stripComment = (s: string): string => {
  const m = /(^|\s)#/.exec(s)
  return m === null ? s : s.slice(0, m.index + (m[1] ? m[1].length : 0))
}

/**
 * Classify the cursor. `text` is the whole doc, `pos` an absolute offset.
 *
 * Pure and exported so the rules are testable without an editor: the failure
 * mode here is a list that is subtly wrong in one position out of four, which
 * is exactly what a unit test catches and a glance does not.
 */
export function rondoPositionAt(text: string, pos: number): RondoPos {
  const upto = text.slice(0, pos)
  const lineStart = upto.lastIndexOf('\n') + 1
  const line = stripComment(upto.slice(lineStart))
  const indent = /^[ \t]*/.exec(line)![0].length

  // which block encloses this line: the nearest line above at LESS indent
  let block = ''
  let blockIndent = 0
  const before = upto.slice(0, lineStart).split('\n')
  for (let i = before.length - 1; i >= 0; i--) {
    const l = stripComment(before[i]!)
    if (l.trim() === '') continue
    const ind = /^[ \t]*/.exec(l)![0].length
    if (ind >= indent) continue
    const head = /^[ \t]*([a-zA-Z_]\w*)/.exec(l)?.[1]
    if (head === undefined) continue
    // a `post` sub-block keeps the signal vocabulary; anything else at a
    // lower indent is the real enclosing block
    block = head
    blockIndent = ind
    if (head !== 'post') break
    break
  }
  void blockIndent

  const body = line.slice(indent)

  // `mode:` — the value slot of a named argument. Checked FIRST: `svf 900
  // mode:` is inside a call, but only the enum belongs here.
  const named = /(?:^|[\s(])([a-zA-Z_]\w*)[ \t]*:[ \t]*[a-zA-Z_]*$/.exec(body)
  if (named !== null) {
    const callName = /^[ \t]*([*/+\-^][ \t]*)?([a-zA-Z_]\w*)/.exec(body)?.[2]
    if (callName !== undefined && callName !== named[1]) {
      return { kind: 'named', builtin: callName, arg: named[1]! }
    }
  }

  if (indent === 0) return { kind: 'top' }
  if (block === 'play' || block === 'beat' || block === 'sing' || block === 'section') {
    return { kind: 'play' }
  }

  // inside a signal block: is there already a call on this line?
  if (SIGNAL_BLOCKS.has(block)) {
    // a binding line (`cut = …`) puts us in expression position, not a call
    const rhs = /^[ \t]*[a-zA-Z_]\w*[ \t]*=[ \t]*(.*)$/.exec(line)
    const expr = rhs !== null ? rhs[1]! : body
    const lead = /^([*/+\-^][ \t]*)?([a-zA-Z_]\w*)[ \t]+/.exec(expr)
    if (lead !== null && BUILTINS[lead[2]!] !== undefined) {
      return { kind: 'args', builtin: lead[2]!, block }
    }
    return { kind: 'synth', block }
  }
  return { kind: 'synth', block: block === '' ? 'synth' : block }
}

/** Binding names declared in the block the cursor sits in — `env`, `cut`, the
 *  things you actually reference. The old source never offered these, which is
 *  why the most-typed identifiers in a synth were the ones it could not help
 *  with. */
export function localBindings(text: string, pos: number): string[] {
  const upto = text.slice(0, pos)
  const lineStart = upto.lastIndexOf('\n') + 1
  const lines = text.split('\n')
  // line index of the cursor
  let idx = 0
  let acc = 0
  for (let i = 0; i < lines.length; i++) {
    if (acc + lines[i]!.length + 1 > lineStart) { idx = i; break }
    acc += lines[i]!.length + 1
  }
  // walk out to the enclosing top-level header, then collect its bindings
  let start = idx
  while (start > 0 && (stripComment(lines[start]!).trim() === '' || /^[ \t]/.test(lines[start]!))) start--
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = stripComment(lines[i]!)
    if (l.trim() === '') continue
    if (!/^[ \t]/.test(l)) break // next top-level block
    const m = /^[ \t]*([a-zA-Z_]\w*)[ \t]*=/.exec(l)
    if (m !== null && !out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

/** Project-wide macro names, which are legal anywhere inside a synth. */
export function macroNames(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const m = /^[ \t]*macro[ \t]+([a-zA-Z_]\w*)/.exec(stripComment(raw))
    if (m !== null && !out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

const opt = (label: string, type: string, detail: string, info?: string): Completion =>
  info !== undefined ? { label, type, detail, info } : { label, type, detail }

/** The options for a classified position. Exported for tests: the contract is
 *  "what is offered here", which is exactly what should be asserted. */
export function optionsFor(
  where: RondoPos,
  base: readonly Completion[],
  ctx: { locals: string[]; macros: string[] },
): Completion[] {
  if (where.kind === 'named') {
    // null = a RUNTIME set (a connected device, a loaded sample): the slot
    // takes a bare word, but there is no list to offer
    const values = ENUM_VALUE_TABLE[where.builtin]?.named?.[where.arg]
    if (values === undefined || values === null) return []
    return values.map((v) => opt(v, 'enum', `${where.builtin} ${where.arg}:${v}`))
  }

  if (where.kind === 'args') {
    const spec = BUILTINS[where.builtin]
    const out: Completion[] = []
    for (const [name, kind] of Object.entries(spec?.named ?? {})) {
      out.push(opt(`${name}:`, 'property', `${where.builtin} … ${name}:${kind === 'bool' ? '1' : ''}`,
        `A named argument of \`${where.builtin}\`.`))
    }
    // an argument is an expression, so bindings and macros belong here too
    for (const l of ctx.locals) out.push(opt(l, 'variable', 'binding in this block'))
    for (const m of ctx.macros) out.push(opt(m, 'variable', 'project macro'))
    return out
  }

  if (where.kind === 'top') {
    return base.filter((o) => BLOCK_HEADERS.includes(String(o.label)))
      .concat(BLOCK_HEADERS.filter((h) => !base.some((o) => o.label === h))
        .map((h) => opt(h, 'keyword', h, 'A top-level block.')))
  }

  if (where.kind === 'play') {
    // pattern modifiers only — an oscillator on a play line is a syntax error,
    // and offering one is how the old list sent people there
    return base.filter((o) => o.type === 'keyword' && !BLOCK_HEADERS.includes(String(o.label)))
      .concat(opt('overchord:', 'keyword', 'overchord: <Am7 F>', 'Read the degrees as CHORD degrees.'))
  }

  // a signal block: builtins, this block's bindings, the project's macros
  const out: Completion[] = base.filter((o) => o.type === 'function' || o.label === 'knob')
  for (const l of ctx.locals) out.push(opt(l, 'variable', 'binding in this block'))
  for (const m of ctx.macros) out.push(opt(m, 'variable', 'project macro'))
  if (where.block === 'synth') out.push(opt('post', 'keyword', 'post', 'Per-synth effects chain.'))
  return out
}

/** Build a completion source over a base option list (the vocabulary table in
 *  rondo/index.ts, which stays the single place words are described). */
export function makeRondoCompletionSource(
  base: readonly Completion[],
): (ctx: CompletionContext) => CompletionResult | null {
  return (ctx: CompletionContext): CompletionResult | null => {
    const text = ctx.state.doc.toString()
    const where = rondoPositionAt(text, ctx.pos)
    const word = ctx.matchBefore(/[a-zA-Z_]\w*/)
    const from = word !== null ? word.from : ctx.pos
    if (word === null && !ctx.explicit && where.kind !== 'named') return null
    const options = optionsFor(where, base, {
      locals: localBindings(text, ctx.pos),
      macros: macroNames(text),
    })
    const typed = word !== null ? word.text : ''
    const filtered = typed === '' ? options : options.filter((o) => String(o.label).startsWith(typed))
    if (filtered.length === 0) return null
    return { from, options: filtered, validFor: /^[a-zA-Z_]\w*$/ }
  }
}
