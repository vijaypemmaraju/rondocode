/* rondo DECOMPILER — JavaScript → rondo, total by construction.
 *
 * The inverse of codegen: statements whose shape the sugar covers become real
 * rondo (synth pipelines, play blocks, cps/sidechain/master/bus/visual);
 * anything else survives VERBATIM inside a `js` block (the escape hatch), so
 * conversion never loses semantics — it only gains syntax where it can.
 *
 * Correctness anchor: round-trip — compile(decompile(compile(src))) must equal
 * compile(src) for every shipped rondo example (pinned in decompile.test.ts).
 *
 * Fallback discipline: expression-level bails become a `js{ … }` inline (legal
 * anywhere an expression goes); statement-level bails become a `js` block.
 * When in doubt, bail — a wrapped statement is correct, a wrong sugar isn't. */

import { parse } from 'acorn'
import { BUILTINS, isReservedBinding } from './builtins'
import { SCALE_MODE } from './codegen'

/* acorn's nodes, loosely typed — we only touch a small surface. */
interface Node {
  type: string
  start: number
  end: number
  [k: string]: unknown
}

const src = { text: '' } // module-local source for slicing (set per decompile call)
const slice = (n: Node): string => src.text.slice(n.start, n.end)

/* ---- tiny AST helpers ----------------------------------------------------- */

const isIdent = (n: Node | undefined, name?: string): boolean =>
  n !== undefined && n.type === 'Identifier' && (name === undefined || n['name'] === name)

const isCall = (n: Node | undefined): n is Node =>
  n !== undefined && n.type === 'CallExpression'

const calleeName = (n: Node): string | undefined => {
  const c = n['callee'] as Node
  return c.type === 'Identifier' ? (c['name'] as string) : undefined
}

/** X.method(args) → { obj, method, args } (or undefined). */
const methodCall = (n: Node): { obj: Node; method: string; args: Node[] } | undefined => {
  if (n.type !== 'CallExpression') return undefined
  const c = n['callee'] as Node
  if (c.type !== 'MemberExpression' || (c['computed'] as boolean)) return undefined
  const prop = c['property'] as Node
  if (prop.type !== 'Identifier') return undefined
  return { obj: c['object'] as Node, method: prop['name'] as string, args: n['arguments'] as Node[] }
}

const numValue = (n: Node): number | undefined => {
  if (n.type === 'Literal' && typeof n['value'] === 'number') return n['value']
  if (n.type === 'UnaryExpression' && n['operator'] === '-') {
    const v = numValue(n['argument'] as Node)
    return v === undefined ? undefined : -v
  }
  return undefined
}

/** A `[a, b]` array literal of two plain numbers, or undefined. Anything else
 *  — a spread, a variable, three entries — has no `switch` spelling, so the
 *  caller keeps it as JavaScript rather than emitting something that is not
 *  what was written. */
const numPair = (n: Node): [number, number] | undefined => {
  if (n.type !== 'ArrayExpression') return undefined
  const els = n['elements'] as (Node | null)[]
  if (els.length !== 2) return undefined
  const a = els[0] == null ? undefined : numValue(els[0])
  const b = els[1] == null ? undefined : numValue(els[1])
  return a === undefined || b === undefined ? undefined : [a, b]
}

/** A sidechain amount as rondo text: a literal, or the bare macro name behind
 *  a `macroNum('x')` call. Anything else has no rondo spelling and keeps the
 *  whole block as JavaScript rather than round-tripping to something else. */
const scText = (n: Node): string | undefined => {
  const v = numValue(n)
  if (v !== undefined) return num(v)
  if (n.type !== 'CallExpression') return undefined
  const callee = n['callee'] as Node
  if (callee.type !== 'Identifier' || callee['name'] !== 'macroNum') return undefined
  const a = (n['arguments'] as Node[])[0]
  const name = a === undefined ? undefined : strValue(a)
  return name !== undefined && /^[a-zA-Z_]\w*$/.test(name) ? name : undefined
}

const strValue = (n: Node): string | undefined =>
  n.type === 'Literal' && typeof n['value'] === 'string' ? n['value'] : undefined

/** Object literal → { key: valueNode } (or undefined on anything fancy). */
const objEntries = (n: Node): Record<string, Node> | undefined => {
  if (n.type !== 'ObjectExpression') return undefined
  const out: Record<string, Node> = {}
  for (const prop of n['properties'] as Node[]) {
    if (prop.type !== 'Property' || (prop['computed'] as boolean)) return undefined
    const key = prop['key'] as Node
    const name = key.type === 'Identifier' ? (key['name'] as string) : strValue(key)
    if (name === undefined) return undefined
    out[name] = prop['value'] as Node
  }
  return out
}

/** Print a number the way rondo reads them. */
const num = (v: number): string => String(v)

/* ---- expression decompiler ------------------------------------------------ *
 * Renders a JS expression as a rondo expression string, tracking the loosest
 * operator precedence in the rendered string so infix composition only
 * happens when re-parsing reproduces the same tree (rondo has no parens —
 * when composition would mis-associate, bail to js{ … }). Levels mirror the
 * parser: atom=5, ^=4, mul/div=3, add/sub=2, arrow=1. */

interface R {
  s: string
  /** loosest operator present at the top level of `s`. */
  prec: number
  /** set when `s` ENDS inside a call's argument list: an infix operator of
   *  prec >= openPrec appended after it would be absorbed into that call's
   *  last argument by greedy space-application. Positional AND named tails
   *  both parse their values at prec >= 2 (parseExpr(c, 2)), so any
   *  argument tail absorbs every operator. Unset = closed. */
  openPrec?: 2 | 3
  /** true when `s` ends in a call that would still accept another
   *  POSITIONAL: a bare juxtaposed token after it (`mix saw .5`) would be
   *  swallowed as that call's argument instead of the enclosing one's. */
  arityOpen: boolean
}

const OP_INFO: Record<string, { op: string; prec: number }> = {
  mul: { op: '*', prec: 3 },
  div: { op: '/', prec: 3 },
  add: { op: '+', prec: 2 },
  sub: { op: '-', prec: 2 },
  pow: { op: '^', prec: 4 },
}

/** What a hoisted operand of each operator is FOR, used to name it. Nothing in
 *  the JavaScript says, so the position is all there is to go on — and a name
 *  is better than `x1` in a snippet somebody is reading to learn from. */
const OP_ROLE: Record<string, string> = { mul: 'amp', div: 'amp', add: 'sum', sub: 'sum', pow: 'exp' }

const ALIAS_INV: Record<string, string> = { roomSize: 'room', maxTime: 'maxtime', warpAmt: 'warpamt' }

function namedArgs(spec: (typeof BUILTINS)[string], opts: Node | undefined): string | null {
  if (opts === undefined) return ''
  const entries = objEntries(opts)
  if (entries === undefined) return null
  const parts: string[] = []
  for (const [key, val] of Object.entries(entries)) {
    const rname = ALIAS_INV[key] ?? key
    const kind = spec.named?.[rname]
    if (kind === undefined) return null
    if (kind === 'enum') {
      const sv = strValue(val)
      if (sv === undefined || !/^[a-zA-Z_]\w*$/.test(sv)) return null
      parts.push(`${rname}:${sv}`)
    } else if (kind === 'bool') {
      if (val.type !== 'Literal' || typeof val['value'] !== 'boolean') return null
      parts.push(`${rname}:${val['value'] === true ? '1' : '0'}`)
    } else {
      const r = rExpr(val)
      if (r === null) return null
      // the value must be tight AND fully CLOSED: an open tail could absorb
      // the next pair (an inner call declaring the same named key), and an
      // arity-open call would swallow juxtaposed tokens. A modulated named
      // arg (`pos: lfo(.05).range(0, 1)`) is neither, so it gets a name.
      const tight = r.prec >= 3 && r.openPrec === undefined && !r.arityOpen
      if (!tight && !hoist.on) return null
      parts.push(`${rname}:${tight ? r.s : hoistAs(rname, r)}`)
    }
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

/* ---- hoisting -------------------------------------------------------------- *
 * rondo has NO PARENTHESES, so an operand that renders looser than its
 * position accepts cannot be written inline at all. `sine(adsr(…).range(45,
 * 160))` has no one-line spelling: `sine adsr .001 .09 0 .05 -> 45..160`
 * re-parses with the range applied to the whole sine call.
 *
 * The rondo answer is the one a person writes by hand — name it:
 *
 *   sine pitch
 *   pitch = adsr .001 .09 0 .05 -> 45..160
 *
 * which is exactly how the cookbook's kick is authored. So an operand that
 * RENDERS but will not FIT becomes a generated binding instead of collapsing
 * the whole line to a js{ } blob. This is the single biggest reason a
 * JS-authored snippet refused to convert: the range-into-an-oscillator shape
 * is how nearly every drum in the docs is built.
 *
 * Names come from the operand's ROLE, because nothing in the JS says what it
 * means, and a bare `x1` in a documentation example reads as machine output.
 * A numeric suffix appears only on collision.
 */
const hoist: { out: string[]; used: Set<string>; params: Map<string, string>; on: boolean } =
  { out: [], used: new Set(), params: new Map(), on: false }

/** Reset the hoist collector for one chain, returning the previous state so
 *  nested chains (a post inside a synth) restore rather than clobber. */
function hoistBegin(on: boolean): typeof hoist {
  const prev = { out: hoist.out, used: hoist.used, params: hoist.params, on: hoist.on }
  hoist.out = []
  hoist.used = new Set()
  hoist.params = new Map()
  hoist.on = on
  return prev
}
const hoistEnd = (prev: typeof hoist): string[] => {
  const out = hoist.out
  hoist.out = prev.out
  hoist.used = prev.used
  hoist.params = prev.params
  hoist.on = prev.on
  return out
}

/** The rondo declaration for a `param(name, default, opts)` call's arguments:
 *  `knob 900 80..8000 log`, or `switch .9 .15`. ONE definition — the binding
 *  path and the inline path must not drift, which is exactly how a switch
 *  written inline would have come back as a knob with an invented range. */
function paramDecl(pargs: Node[], want: string): string | null {
  const pname = pargs[0] !== undefined ? strValue(pargs[0]) : undefined
  const def = pargs[1] !== undefined ? numValue(pargs[1]) : undefined
  const po = pargs[2] !== undefined ? objEntries(pargs[2]) : {}
  if (pname !== want || def === undefined || po === undefined) return null
  // a SWITCH: two values, no range. Must come before the knob path — the
  // omitted min/max would otherwise default to 0..1 and emit a knob with an
  // invented range, losing the switch silently.
  if (po['values'] !== undefined) {
    const pair = numPair(po['values'])
    return pair === undefined ? null : `switch ${num(pair[0])} ${num(pair[1])}`
  }
  const min = po['min'] !== undefined ? numValue(po['min']) : 0
  const max = po['max'] !== undefined ? numValue(po['max']) : 1
  const curve = po['curve'] !== undefined ? strValue(po['curve']) : undefined
  if (min === undefined || max === undefined) return null
  return `knob ${num(def)} ${num(min)}..${num(max)}${curve === 'log' ? ' log' : ''}`
}

/* Rendering is SPECULATIVE in several places — a value is rendered once to
 * inspect it, or rendered again in its closed spelling and the first result
 * thrown away. A hoist committed by a rendering nobody keeps leaves a binding
 * with no reference, and the fuzz fixed-point check catches it immediately:
 * `mix` rendered its operand twice and emitted `sig`/`sig2` for one operand.
 * So every discarded rendering rolls its hoists back. */
const hoistMark = (): number => hoist.out.length
function hoistRollback(mark: number): void {
  for (let i = mark; i < hoist.out.length; i++) {
    const name = hoist.out[i]!.slice(0, hoist.out[i]!.indexOf(' '))
    hoist.used.delete(name)
    hoist.params.delete(name)
  }
  hoist.out.length = mark
}
/** Render `n`, keeping no hoists: for deciding ABOUT a rendering, not using it. */
function peek(n: Node): R | null {
  const mark = hoistMark()
  const r = rExpr(n)
  hoistRollback(mark)
  return r
}

/** Bind `r` to a fresh `role`-derived name and return the name. */
function hoistAs(role: string, r: R): string {
  // A role name is a guess and may already mean something: `exp` is a builtin,
  // so is `mix`, and a named argument's key (which is where some roles come
  // from) can be either. A binding that shadows a builtin is a compile error,
  // so the generated name has to clear the same bar the parser enforces.
  const taken = (n: string): boolean =>
    hoist.used.has(n) || isReservedBinding(n) || BUILTINS[n] !== undefined
  let name = role
  for (let i = 2; taken(name); i++) name = `${role}${i}`
  hoist.used.add(name)
  hoist.out.push(`${name} = ${r.s}`)
  return name
}

/** A positional argument in a builtin application parses at prec ≥ 2.
 *  A NON-last positional must also be fully closed: an arity-open rendering
 *  (`saw` bare, `fm 100`) would swallow the next positional as its own. */
function posArg(n: Node, last = true, role = 'sig'): string | null {
  const fits = (x: R): boolean => x.prec >= 2 && (last || (!x.arityOpen && x.openPrec === undefined))
  const mark = hoistMark()
  const r = rExpr(n)
  if (r === null) return null
  if (fits(r)) return r.s
  // `mix saw .3` wants saw's CLOSED spelling before it wants a binding: the
  // extra word is cheaper to read than a name for something already named
  hoistRollback(mark)
  const closed = rExpr(n, true)
  if (closed !== null && fits(closed)) return closed.s
  // renders, but will not fit HERE: give it a name rather than losing the line
  hoistRollback(mark)
  const again = rExpr(n)
  return hoist.on && again !== null ? hoistAs(role, again) : null
}

/** eq band objects → rondo's word-then-numbers groups (`hp 170 peak 300 -3 2`),
 *  or null when a band isn't expressible positionally (a q without a gain). */
const EQ_KEYS: Record<string, string[]> = {
  hp: ['freq', 'q'], lp: ['freq', 'q'],
  peak: ['freq', 'gain', 'q'], lowshelf: ['freq', 'gain', 'q'], highshelf: ['freq', 'gain', 'q'],
}
function eqBands(n: Node): string | null {
  if (n.type !== 'ArrayExpression') return null
  const parts: string[] = []
  for (const el of n['elements'] as (Node | null)[]) {
    if (el === null) return null
    const o = objEntries(el)
    if (o === undefined) return null
    const t = o['type'] !== undefined ? strValue(o['type']!) : undefined
    if (t === undefined) return null
    const keys = EQ_KEYS[t]
    if (keys === undefined) return null
    const known = new Set(['type', ...keys])
    if (Object.keys(o).some((k) => !known.has(k))) return null
    const toks: string[] = [t]
    let stopped = false
    for (const k of keys) {
      const v = o[k]
      if (v === undefined) { stopped = true; continue }
      if (stopped) return null // positional gap — not expressible
      const x = numValue(v)
      if (x === undefined) return null
      toks.push(num(x))
    }
    if (toks.length < 2) return null // freq is required
    parts.push(toks.join(' '))
  }
  return parts.join(' ')
}

/**
 * `closed` suppresses the osc freq-default shortening for THIS call only.
 *
 * `saw(note.freq)` normally renders as the bare `saw`, which is shorter and
 * what a musician writes. But bare `saw` still has arity room, so a context
 * that puts another token after it -- `mix saw .3` -- would have that token
 * read as saw's frequency. Rendering `saw note` instead closes the call and
 * says the same thing.
 *
 * The flag does NOT propagate into nested calls: only the argument that has to
 * be unambiguous pays the extra word.
 */
/** Local `const`s this pass is folding into their single use. See
 *  decompileChainFn: empty on the first attempt, populated on the second. */
const inline: { map: ReadonlyMap<string, Node> } = { map: new Map() }

/** Local names being rewritten to the param they read. In rondo a knob IS its
 *  param — `cut = knob 1500 300..6000 log` declares the param `cut` — so
 *  JavaScript that reads `param('cutoff')` into a variable called `cut` has no
 *  rondo spelling under the variable's name. Renaming the variable to the
 *  param is what makes it sayable, and it is the same knob either way. */
const renames: { map: ReadonlyMap<string, string> } = { map: new Map() }

/** THE INVARIANT: a rendering that fails leaves no hoists behind. Without it a
 *  half-rendered call (first argument hoisted, second inexpressible) drops a
 *  binding nothing references into a chain that then falls back to js{ }. */
function rExpr(n: Node, closed = false): R | null {
  const mark = hoistMark()
  const r = rExprRaw(n, closed)
  if (r === null) hoistRollback(mark)
  return r
}

function rExprRaw(n: Node, closed = false): R | null {
  // identifiers + the special refs
  if (n.type === 'Identifier') {
    const name = n['name'] as string
    const sub = inline.map.get(name)
    if (sub !== undefined) return rExpr(sub, closed)
    return { s: renames.map.get(name) ?? name, prec: 5, arityOpen: false }
  }
  const v = numValue(n)
  if (v !== undefined) return { s: num(v), prec: 5, arityOpen: false }
  if (n.type === 'MemberExpression') {
    const obj = n['object'] as Node
    const prop = n['property'] as Node
    if (isIdent(obj, 'note') && isIdent(prop, 'freq')) return { s: 'note', prec: 5, arityOpen: false }
    return null
  }
  const m = methodCall(n)
  if (m !== undefined) {
    // Sig operators → infix (left-assoc; compose only when re-parse matches)
    const info = OP_INFO[m.method]
    if (info !== undefined && m.args.length === 1) {
      let l = rExpr(m.obj)
      let r = rExpr(m.args[0]!)
      if (l === null || r === null) return null
      // Either side may be too loose to sit here without parens rondo does not
      // have. Naming it says the same thing and keeps the line.
      if (l.prec < info.prec || (l.openPrec !== undefined && info.prec >= l.openPrec)) {
        if (!hoist.on) return null
        l = { s: hoistAs(OP_ROLE[m.method] ?? 'sig', l), prec: 5, arityOpen: false }
      }
      if (r.prec <= info.prec) {
        if (!hoist.on) return null
        r = { s: hoistAs(OP_ROLE[m.method] ?? 'sig', r), prec: 5, arityOpen: false }
      }
      return { s: `${l.s} ${info.op} ${r.s}`, prec: info.prec, openPrec: r.openPrec, arityOpen: r.arityOpen }
    }
    // Sig-method builtins in EXPRESSION position: `floor wob`, `min wob .2`.
    // rondo takes the input as the FIRST positional here (same shape a proc
    // has in expression position), so the input must render CLOSED — the
    // op's own arguments follow it, and an open input would eat them.
    const sig = BUILTINS[m.method]
    if (sig?.kind === 'sigop' && m.args.length === sig.pos.length) {
      const input = posArg(m.obj, m.args.length === 0)
      if (input === null) return null
      const parts = [input]
      for (let i = 0; i < m.args.length; i++) {
        const a = posArg(m.args[i]!, i === m.args.length - 1)
        if (a === null) return null
        parts.push(a)
      }
      // an open call: `floor x * 2` re-parses as floor(x * 2), so anything
      // composing on top of this has to refuse (openPrec/arityOpen say so)
      return { s: `${m.method} ${parts.join(' ')}`, prec: 5, openPrec: 2, arityOpen: true }
    }
    // .range(lo, hi) → `x -> lo..hi`
    if (m.method === 'range' && m.args.length === 2) {
      const x = rExpr(m.obj)
      const lo = numValue(m.args[0]!)
      const hi = numValue(m.args[1]!)
      if (x === null || x.prec < 2 || lo === undefined || hi === undefined) return null
      return { s: `${x.s} -> ${num(lo)}..${num(hi)}`, prec: 1, arityOpen: false }
    }
    return null
  }
  if (isCall(n)) {
    const name = calleeName(n)
    const args = n['arguments'] as Node[]
    if (name === 'adsr') {
      // adsr(gate, { a, d, s, r })
      if (args.length === 2 && isIdent(args[0], 'gate')) {
        const o = objEntries(args[1]!)
        if (o !== undefined) {
          const vals = ['a', 'd', 's', 'r'].map((k) => (o[k] !== undefined ? numValue(o[k]!) : 0))
          if (vals.every((x) => x !== undefined)) {
            // CLOSED, not openPrec 2. adsr takes exactly four positionals, so
            // the parser finishes the call and binds any following operator to
            // the whole thing — verified for ^, * and +. Claiming it was open
            // blocked `^` (prec 4) while allowing `->` (prec 1), which is why
            // `adsr … ^ 3 -> 48..190` decompiled to a js{ } blob even though
            // rondo says it natively.
            return { s: `adsr ${vals.map((x) => num(x!)).join(' ')}`, prec: 5, arityOpen: false }
          }
        }
      }
      return null
    }
    if (name === 'env') {
      // env(gate, [[t, l], …], opts?) → `env t l t l release:… curve:… loop:1`
      if ((args.length === 2 || args.length === 3) && isIdent(args[0], 'gate')) {
        const pts = args[1]!
        if (pts.type !== 'ArrayExpression') return null
        const flat: string[] = []
        for (const el of pts['elements'] as (Node | null)[]) {
          if (el === null || el.type !== 'ArrayExpression') return null
          const pair = el['elements'] as (Node | null)[]
          // [t, level] or [t, level, curve] — the third gives THAT segment its
          // own shape and comes back as `level:curve`
          if (pair.length !== 2 && pair.length !== 3) return null
          const vals: number[] = []
          for (const p of pair) {
            const x = p !== null ? numValue(p) : undefined
            if (x === undefined) return null
            vals.push(x)
          }
          flat.push(num(vals[0]!))
          flat.push(vals.length === 3 ? `${num(vals[1]!)}:${num(vals[2]!)}` : num(vals[1]!))
        }
        if (flat.length === 0) return null
        const named = namedArgs(BUILTINS['env']!, args[2])
        if (named === null) return null
        return { s: `env ${flat.join(' ')}${named}`, prec: 5, openPrec: 2, arityOpen: true }
      }
      return null
    }
    if (name === 'eq') {
      if (args.length !== 2) return null
      const input = posArg(args[0]!)
      const bands = eqBands(args[1]!)
      if (input === null || bands === null) return null
      return { s: `eq ${input} ${bands}`, prec: 5, openPrec: 2, arityOpen: true }
    }
    // `param('x')` with no default is a MACRO REFERENCE. The numbers live on
    // the `macro` line, so the bare name is the whole rondo source — the same
    // rule decompileChainFn already applies to a `const x = param('x')`
    // binding, which is why it only ever fired when a macro was read into a
    // variable first and never when it was read inline.
    if (name === 'param') {
      const pn = args[0] !== undefined ? strValue(args[0]) : undefined
      if (pn === undefined || !/^[a-zA-Z_]\w*$/.test(pn) || isReservedBinding(pn)) return null
      if (args.length === 1) return { s: pn, prec: 5, arityOpen: false }
      // With a default it is a KNOB, and in rondo a knob's numbers live on a
      // binding. It already HAS a name — its own — so it needs no invented
      // one, and writing the same knob twice is just the same binding.
      const decl = paramDecl(args, pn)
      if (decl === null || !hoist.on) return null
      const seen = hoist.params.get(pn)
      if (seen !== undefined && seen !== decl) return null
      if (seen === undefined) {
        if (hoist.used.has(pn)) return null
        hoist.used.add(pn)
        hoist.params.set(pn, decl)
        hoist.out.push(`${pn} = ${decl}`)
      }
      return { s: pn, prec: 5, arityOpen: false }
    }
    const spec = name !== undefined ? BUILTINS[name] : undefined
    if (spec === undefined) return null
    if (spec.kind === 'sigop') return null // no expression form
    let rest = args
    let prefix = ''
    if (spec.kind === 'gated') {
      if (!isIdent(args[0], 'gate')) return null
      rest = args.slice(1)
    }
    if (spec.kind === 'proc') {
      // proc-in-expression: input is the first positional (never last — the
      // proc's own args follow it, so it must be closed)
      const input = rest[0] !== undefined ? posArg(rest[0], rest.length === 1) : null
      if (input === null) return null
      prefix = ` ${input}`
      rest = rest.slice(1)
    }
    // trailing opts object?
    let opts: Node | undefined
    if (rest.length > 0) {
      const last = rest[rest.length - 1]!
      if (last.type === 'ObjectExpression') {
        opts = last
        rest = rest.slice(0, -1)
      }
    }
    const pos: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const kind = spec.pos[i]
      if (kind === undefined) return null
      if (kind === 'enum') {
        const sv = strValue(rest[i]!)
        if (sv === undefined || !/^[a-zA-Z_]\w*$/.test(sv)) return null
        pos.push(sv)
      } else {
        // an osc's default freq arg (note.freq) is omitted entirely
        if (!closed && spec.kind === 'osc' && i === 0 && spec.freqDefault === true &&
            rest.length === 1 && opts === undefined && rest[i]!.type === 'MemberExpression' &&
            isIdent(rest[i]!['object'] as Node, 'note') && isIdent(rest[i]!['property'] as Node, 'freq')) {
          continue
        }
        // an oscillator's first positional IS its frequency, and that is a
        // better name for a hoisted pitch envelope than a generic one
        const role = spec.kind === 'osc' && i === 0 ? 'freq' : 'sig'
        const p = posArg(rest[i]!, i === rest.length - 1, role)
        if (p === null) return null
        pos.push(p)
      }
    }
    const named = namedArgs(spec, opts)
    if (named === null) return null
    const posStr = pos.length > 0 ? ' ' + pos.join(' ') : ''
    // tail decides operator absorption; arity room decides token absorption
    // (named args seal the positional list: after `k:v`, a bare token errors
    // instead of becoming a positional)
    const lastPos = rest.length > 0 && rest[rest.length - 1] !== undefined ? peek(rest[rest.length - 1]!) : null
    const arityOpen = named === '' && (pos.length < spec.pos.length || (lastPos !== null && lastPos.arityOpen))
    const openPrec = named !== '' || posStr !== '' || prefix !== '' ? (2 as const) : undefined
    return { s: `${name}${prefix}${posStr}${named}`, prec: 5, openPrec, arityOpen }
  }
  return null
}

/** A binding RHS: full rondo expression, or a js{ … } inline fallback. */
function bindingRHS(n: Node): string {
/** A `[a, b]` array literal of two plain numbers, or undefined. Anything else
 *  — a spread, a variable, three entries — has no `switch` spelling, so the
 *  caller keeps it as JavaScript rather than emitting something that is not
 *  what was written. */
function numPair(n: Node): [number, number] | undefined {
  if (n.type !== 'ArrayExpression') return undefined
  const els = n['elements'] as (Node | null)[]
  if (els.length !== 2) return undefined
  const a = els[0] === null || els[0] === undefined ? undefined : numValue(els[0])
  const b = els[1] === null || els[1] === undefined ? undefined : numValue(els[1])
  return a === undefined || b === undefined ? undefined : [a, b]
}

  // param('x', d, { min, max, curve }) is handled by the caller (knob needs
  // the binding name); everything else goes through rExpr
  const r = rExpr(n)
  return r !== null ? r.s : `js{ ${slice(n)} }`
}

/* ---- pipeline unfolding ---------------------------------------------------- *
 * The compiled voice/post return is one nested expression; unfold it back
 * into spine lines by peeling transforms off the OUTSIDE:
 *   .tanh()/.clip()/.fold()/.mix(o,t) → sig-op lines
 *   .mul(x)/.add(x)/…                → operator lines
 *   proc(inner, …)                   → processor lines
 *   ((x) => x.mix(reverb(x,o), t))(inner) → reverb … mix:t
 * What remains is the source line. Any unpeelable layer bails the WHOLE
 * chain to a single js{ … } source line (still valid rondo). */
/** Two references to the SAME running signal: the same node, or two mentions
 *  of one identifier. What `x.mix(reverb(x, …), t)` needs to be sure of. */
const sameSignal = (a: Node, b: Node): boolean =>
  a === b || (a.type === 'Identifier' && b.type === 'Identifier' && a['name'] === b['name'])

/** `dry.mix(reverb(dry, opts), t)` → the `reverb … mix:t` line, else null. */
function wetDryReverb(dry: Node, wet: Node, amount: Node): string | null {
  if (!isCall(wet) || calleeName(wet) !== 'reverb') return null
  const rargs = wet['arguments'] as Node[]
  if (rargs.length < 1 || rargs[0] === undefined || !sameSignal(dry, rargs[0])) return null
  const t = rExpr(amount)
  const named = namedArgs(BUILTINS['reverb']!, rargs[1])
  if (t === null || t.prec < 3 || named === null) return null
  return `reverb${named} mix:${t.s}`
}

function unfoldPipeline(n: Node, lines: string[]): boolean {
  const mark = hoistMark()
  const ok = unfoldPipelineRaw(n, lines)
  if (!ok) hoistRollback(mark) // same invariant as rExpr: no orphan bindings
  return ok
}

/** A sig op called as a FUNCTION, viewed as the method it also is: the ctx
 *  offers both spellings (`mix(a, b, t)` and `a.mix(b, t)`) and rondo has one
 *  line for them, so the function form should not be the one that bails. */
function sigopAsMethod(n: Node): { obj: Node; method: string; args: Node[] } | undefined {
  if (!isCall(n)) return undefined
  const name = calleeName(n)
  const spec = name === undefined ? undefined : BUILTINS[name]
  if (spec?.kind !== 'sigop') return undefined
  const args = n['arguments'] as Node[]
  if (args.length !== spec.pos.length + 1 || args[0] === undefined) return undefined
  return { obj: args[0], method: name!, args: args.slice(1) }
}

function unfoldPipelineRaw(n: Node, lines: string[]): boolean {
  if (n.type === 'Identifier') {
    const sub = inline.map.get(n['name'] as string)
    if (sub !== undefined) return unfoldPipeline(sub, lines)
  }
  const m = methodCall(n) ?? sigopAsMethod(n)
  if (m !== undefined) {
    const info = OP_INFO[m.method]
    if (info !== undefined && m.args.length === 1) {
      const arg = rExpr(m.args[0]!)
      if (arg === null) return false
      // `* adsr … * 0.2` re-associates as `(sig * adsr) * 0.2`, which is only
      // accidentally right for `*` and wrong in general, so an operand at or
      // below this operator's precedence gets a name instead.
      const s = arg.prec > info.prec ? arg.s : hoist.on ? hoistAs(OP_ROLE[m.method] ?? 'sig', arg) : null
      if (s === null) return false
      if (!unfoldPipeline(m.obj, lines)) return false
      lines.push(`${info.op} ${s}`)
      return true
    }
    // Zero-arg sigops (tanh, fold, abs, floor, sqrt, …) render as the bare
    // name. Driven off BUILTINS so a new row in that table needs nothing here.
    const spec = BUILTINS[m.method]
    if (spec?.kind === 'sigop' && spec.pos.length === 0 && m.args.length === 0) {
      if (!unfoldPipeline(m.obj, lines)) return false
      lines.push(m.method)
      return true
    }
    // One-arg sigops (min, max, mod): the operand must render CLOSED, or it
    // would swallow whatever follows it on the line.
    if (spec?.kind === 'sigop' && spec.pos.length === 1 && m.args.length === 1) {
      const mk = hoistMark()
      let arg = rExpr(m.args[0]!)
      if (arg !== null && arg.arityOpen) {
        hoistRollback(mk)
        arg = rExpr(m.args[0]!, true)
      }
      if (arg === null || arg.prec < 2 || arg.arityOpen) return false
      if (!unfoldPipeline(m.obj, lines)) return false
      lines.push(`${m.method} ${arg.s}`)
      return true
    }
    if (m.method === 'clip' && m.args.length <= 2) {
      const args = m.args.map(numValue)
      if (args.some((x) => x === undefined)) return false
      if (!unfoldPipeline(m.obj, lines)) return false
      lines.push(`clip${args.length > 0 ? ' ' + args.map((x) => num(x!)).join(' ') : ''}`)
      return true
    }
    if (m.method === 'mix' && m.args.length === 2) {
      // WET/DRY: `x.mix(reverb(x, opts), t)` is rondo's `reverb … mix:t`. The
      // IIFE spelling of this is recognised further down; this is the spelling
      // where the signal was given a NAME first, which is what a hand-written
      // post chain looks like (`const wide = width(input, .7)` then
      // `wide.mix(reverb(wide, …), .22)`). Same shape, and it has to be caught
      // before the general mix path renders `reverb(x, …)` as an operand.
      const wet = wetDryReverb(m.obj, m.args[0]!, m.args[1]!)
      if (wet !== null) {
        if (!unfoldPipeline(m.obj, lines)) return false
        lines.push(wet)
        return true
      }
      // `mix a b` puts a bare token after `a`, so `a` must have no arity room
      // left. When the short form does (bare `saw` still wants a frequency),
      // ask for the closed spelling rather than giving up on the whole line.
      const mk = hoistMark()
      let other = rExpr(m.args[0]!)
      if (other !== null && other.arityOpen) {
        hoistRollback(mk)
        other = rExpr(m.args[0]!, true)
      }
      const t = rExpr(m.args[1]!)
      // arityOpen, NOT openPrec: line 377 draws the distinction -- openPrec is
      // operator absorption, arity room is TOKEN absorption, and a bare token
      // is what follows here. openPrec is set for any call with a positional,
      // so checking it rejected the very spelling asked for above.
      if (other === null || other.prec < 2 || other.arityOpen || t === null || t.prec < 2) return false
      if (!unfoldPipeline(m.obj, lines)) return false
      lines.push(`mix ${other.s} ${t.s}`)
      return true
    }
    return false
  }
  // reverb wet/dry IIFE: ((x) => x.mix(reverb(x, opts), t))(inner)
  if (isCall(n)) {
    const callee = n['callee'] as Node
    const args = n['arguments'] as Node[]
    if (callee.type === 'ArrowFunctionExpression' && args.length === 1) {
      const params = callee['params'] as Node[]
      const body = callee['body'] as Node
      if (params.length === 1 && isIdent(params[0]) && body.type === 'CallExpression') {
        const x = params[0]!['name'] as string
        const mm = methodCall(body)
        if (mm !== undefined && mm.method === 'mix' && isIdent(mm.obj, x) && mm.args.length === 2) {
          const rev = mm.args[0]!
          if (isCall(rev) && calleeName(rev) === 'reverb') {
            const rargs = rev['arguments'] as Node[]
            if (rargs.length >= 1 && isIdent(rargs[0], x)) {
              const t = rExpr(mm.args[1]!)
              const named = namedArgs(BUILTINS['reverb']!, rargs[1])
              if (t !== null && t.prec >= 3 && named !== null) {
                if (!unfoldPipeline(args[0]!, lines)) return false
                lines.push(`reverb${named} mix:${t.s}`)
                return true
              }
            }
          }
        }
      }
      return false
    }
    const name = calleeName(n)
    if (name === 'eq' && args.length === 2) {
      // eq(inner, bands) → an `eq hp 170 …` transform line
      const bands = eqBands(args[1]!)
      if (bands === null) return false
      if (!unfoldPipeline(args[0]!, lines)) return false
      lines.push(`eq ${bands}`)
      return true
    }
    const spec = name !== undefined ? BUILTINS[name] : undefined
    if (spec !== undefined && spec.kind === 'proc' && args.length >= 1) {
      let rest = args.slice(1)
      let opts: Node | undefined
      if (rest.length > 0 && rest[rest.length - 1]!.type === 'ObjectExpression') {
        opts = rest[rest.length - 1]!
        rest = rest.slice(0, -1)
      }
      const pos: string[] = []
      for (let i = 0; i < rest.length; i++) {
        /* An ENUM positional is a bare word, not a signal. The expression
         * branch above already knew that; this one did not, and sent every
         * positional through posArg — which returns null for a string, so the
         * whole line fell out to a `js{ }` blob. No proc had an enum
         * positional until `convolve`, so the gap had never been reachable.
         * Same rule, two copies, one of them updated. */
        if (spec.pos[i] === 'enum') {
          const sv = strValue(rest[i]!)
          if (sv === undefined || !/^[a-zA-Z_]\w*$/.test(sv)) return false
          pos.push(sv)
          continue
        }
        const p = posArg(rest[i]!)
        if (p === null) return false
        pos.push(p)
      }
      const named = namedArgs(spec, opts)
      if (named === null) return false
      if (!unfoldPipeline(args[0]!, lines)) return false
      lines.push(`${name}${pos.length > 0 ? ' ' + pos.join(' ') : ''}${named}`)
      return true
    }
  }
  // whatever remains is the source line
  const r = rExpr(n)
  lines.push(r !== null ? r.s : `js{ ${slice(n)} }`)
  return true
}

/* ---- statement decompilers -------------------------------------------------- */

/** const NAME = synth(voiceFn, postFn?, opts?) → a synth block, or null. */
function decompileSynth(stmt: Node): string | null {
  if (stmt.type !== 'VariableDeclaration') return null
  const decls = stmt['declarations'] as Node[]
  if (decls.length !== 1) return null
  const d = decls[0]!
  const id = d['id'] as Node
  const init = d['init'] as Node | null
  if (!isIdent(id) || init === null || !isCall(init) || calleeName(init) !== 'synth') return null
  const name = id['name'] as string
  const args = init['arguments'] as Node[]
  const voice = args[0]
  if (voice === undefined || voice.type !== 'ArrowFunctionExpression') return null
  let post: Node | undefined
  let opts: Node | undefined
  if (args[1] !== undefined) {
    if (args[1].type === 'ArrowFunctionExpression') {
      post = args[1]
      opts = args[2]
    } else if (isIdent(args[1], 'undefined')) {
      // `synth(voice, undefined, { mono: true })` — the post slot is SKIPPED,
      // not filled with an options object. Read as opts it made objEntries
      // fail and took the whole synth down to a js block.
      opts = args[2]
    } else opts = args[1]
  }
  // header voice options
  let header = `synth ${name}`
  if (opts !== undefined) {
    const o = objEntries(opts)
    if (o === undefined) return null
    for (const [k, vNode] of Object.entries(o)) {
      if (k === 'mono' && vNode.type === 'Literal' && vNode['value'] === true) header += ' mono'
      else {
        const nv = numValue(vNode)
        if (nv === undefined) return null
        header += ` ${k}:${num(nv)}`
      }
    }
  }
  const chain = (fn: Node, indent: string, fromInput = false): string[] | null =>
    decompileChainFn(fn, indent, fromInput)
  const voiceLines = chain(voice, '  ')
  if (voiceLines === null) return null
  const out = [header, ...voiceLines]
  if (post !== undefined) {
    const postLines = chain(post, '    ', true)
    if (postLines === null) return null
    out.push('  post', ...postLines)
  }
  return out.join('\n')
}

/** Decompile a synth/post/sing-post BUILDER ARROW into rondo chain lines
 *  (spine + bindings), or null when inexpressible. `fromInput = true` drops
 *  the implicit leading `input` line of a post chain.
 *
 *  THREE ATTEMPTS, each a strict RESCUE of the one before. The plain pass is
 *  the original behaviour, unchanged: render everything inline and keep every
 *  local `const` as a named binding. Only when that leaves a `js{ }` blob do
 *  the rescues run, so nothing that already round-tripped can start coming
 *  back differently — which matters because the decompiler's contract is that
 *  compile → decompile → compile is BYTE-IDENTICAL JS, and a binding is not
 *  byte-identical to the expression it replaces even when it is the same
 *  sound. The fuzzer catches that immediately; it is how this ordering was
 *  found.
 *
 *    1. plain          — as authored, everything inline
 *    2. + hoisting     — name an operand rondo cannot place inline
 *    3. + inlining     — fold single-use `const`s into their one use, for a
 *                        post chain like `const echo = input.add(delay(…));
 *                        return reverb(echo, …)`, which has no spelling with
 *                        `echo` still named: a post spine folds from `input`
 *                        implicitly and cannot start anywhere else. Inlined
 *                        it is `+ delay input .25 .4` then `reverb room:…`,
 *                        which is how it would have been written by hand. */
function decompileChainFn(fn: Node, indent: string, fromInput = false): string[] | null {
  const prevRenames = renames.map
  renames.map = paramRenames(fn)
  try {
    return chainAttempts(fn, indent, fromInput)
  } finally {
    renames.map = prevRenames
  }
}

/** Local variables holding a `param('other')`, mapped to that param's name.
 *  Skipped when the target is spoken for — by another binding here, by a
 *  builtin, or by a keyword — because a rename that collides says something
 *  different from what was written. */
function paramRenames(fn: Node): Map<string, string> {
  const out = new Map<string, string>()
  const body = fn['body'] as Node
  if (body.type !== 'BlockStatement') return out
  const taken = new Set<string>()
  const want: [string, string][] = []
  for (const s of body['body'] as Node[]) {
    if (s.type !== 'VariableDeclaration') continue
    const bd = (s['declarations'] as Node[])[0]
    if (bd === undefined || !isIdent(bd['id'] as Node)) continue
    const bname = (bd['id'] as Node)['name'] as string
    taken.add(bname)
    const init = bd['init'] as Node | null
    if (init === null || !isCall(init) || calleeName(init) !== 'param') continue
    const pn = (init['arguments'] as Node[])[0]
    const pname = pn === undefined ? undefined : strValue(pn)
    if (pname !== undefined && pname !== bname) want.push([bname, pname])
  }
  for (const [from, to] of want) {
    if (!/^[a-zA-Z_]\w*$/.test(to) || taken.has(to) || isReservedBinding(to) || BUILTINS[to] !== undefined) continue
    out.set(from, to)
    taken.add(to)
  }
  return out
}

function chainAttempts(fn: Node, indent: string, fromInput: boolean): string[] | null {
  let best: string[] | null = null
  for (const mode of [
    { hoist: false, inline: false },
    { hoist: true, inline: false },
    { hoist: true, inline: true },
  ]) {
    const prevHoist = hoistBegin(mode.hoist)
    const prevInline = inline.map
    inline.map = mode.inline ? singleUseBindings(fn) : EMPTY_INLINE
    const got = mode.inline && inline.map.size === 0 ? null : chainLines(fn, fromInput)
    const hoisted = hoistEnd(prevHoist)
    inline.map = prevInline
    if (got === null) continue
    const lines = [...got.spine, ...got.bindings, ...hoisted]
    if (!lines.some((l) => l.includes('js{'))) return lines.map((l) => indent + l)
    best ??= lines // a blob is the answer only if no later attempt does better
  }
  return best === null ? null : best.map((l) => indent + l)
}

const EMPTY_INLINE: ReadonlyMap<string, Node> = new Map()

/** Every name a chain body declares, in source order. */
function bindingNames(fn: Node): string[] {
  const body = fn['body'] as Node
  if (body.type !== 'BlockStatement') return []
  const out: string[] = []
  for (const s of body['body'] as Node[]) {
    if (s.type !== 'VariableDeclaration') continue
    const bd = (s['declarations'] as Node[])[0]
    if (bd !== undefined && isIdent(bd['id'] as Node)) out.push((bd['id'] as Node)['name'] as string)
  }
  return out
}

/** Local `const`s referenced exactly once, mapped to their value. Bindings the
 *  rondo output NEEDS by name (a `param`, which becomes a knob or a switch)
 *  are never inlined: the name is the wiring. */
function singleUseBindings(fn: Node): Map<string, Node> {
  const body = fn['body'] as Node
  const out = new Map<string, Node>()
  if (body.type !== 'BlockStatement') return out
  const inits = new Map<string, Node>()
  for (const s of body['body'] as Node[]) {
    if (s.type !== 'VariableDeclaration') continue
    const bd = (s['declarations'] as Node[])[0]
    if (bd === undefined || !isIdent(bd['id'] as Node)) continue
    const init = bd['init'] as Node | null
    if (init === null || (isCall(init) && calleeName(init) === 'param')) continue
    inits.set((bd['id'] as Node)['name'] as string, init)
  }
  if (inits.size === 0) return out
  // count uses across the whole body, then subtract the declaration ids
  const counts = new Map<string, number>()
  countIdents(body, counts)
  // A wet/dry mix mentions its signal TWICE (`wide.mix(reverb(wide, …), t)`)
  // and rondo says it in one line, so those two mentions are one use.
  for (const name of wetDryNames(body)) counts.set(name, (counts.get(name) ?? 0) - 1)
  for (const [name, init] of inits) if ((counts.get(name) ?? 0) === 2) out.set(name, init)
  return out
}

/** Identifiers appearing as the `x` of an `x.mix(reverb(x, …), t)` anywhere. */
function wetDryNames(n: unknown, into = new Set<string>()): Set<string> {
  if (n === null || typeof n !== 'object') return into
  if (Array.isArray(n)) {
    for (const x of n) wetDryNames(x, into)
    return into
  }
  const node = n as Node
  const m = methodCall(node)
  if (m !== undefined && m.method === 'mix' && m.args.length === 2 && m.obj.type === 'Identifier') {
    const rev = m.args[0]!
    if (isCall(rev) && calleeName(rev) === 'reverb') {
      const r0 = (rev['arguments'] as Node[])[0]
      if (r0 !== undefined && sameSignal(m.obj, r0)) into.add(m.obj['name'] as string)
    }
  }
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue
    wetDryNames(node[k], into)
  }
  return into
}

/** Tally every Identifier by name in an AST subtree. */
function countIdents(n: unknown, into: Map<string, number>): void {
  if (n === null || typeof n !== 'object') return
  if (Array.isArray(n)) {
    for (const x of n) countIdents(x, into)
    return
  }
  const node = n as Node
  if (node.type === 'Identifier') {
    const name = node['name'] as string
    into.set(name, (into.get(name) ?? 0) + 1)
    return
  }
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue
    countIdents(node[k], into)
  }
}

function chainLines(fn: Node, fromInput: boolean): { spine: string[]; bindings: string[] } | null {
    const body = fn['body'] as Node
    let ret: Node | undefined
    const bindings: string[] = []
    // EVERY binding name is claimed up front, not as each is reached. A
    // hoisted operand inside the FIRST binding's value would otherwise be free
    // to take a name the third binding is about to declare — `pitch = note *
    // amp` alongside a real `amp = env …` two lines down, which is a duplicate
    // binding and a compile error.
    for (const bn of bindingNames(fn)) hoist.used.add(renames.map.get(bn) ?? bn)
    if (body.type === 'BlockStatement') {
      for (const s of body['body'] as Node[]) {
        if (s.type === 'VariableDeclaration') {
          const bd = (s['declarations'] as Node[])[0]
          if (bd === undefined || !isIdent(bd['id'] as Node)) return null
          const bname = (bd['id'] as Node)['name'] as string
          // a rondo binding may not shadow a builtin — bail the whole synth
          // to a js block rather than emit source that won't compile back
          if (isReservedBinding(bname)) return null
          const bin = bd['init'] as Node | null
          if (bin === null) return null
          // folded into its one use by this attempt — emitting it too would
          // leave an unreferenced binding behind
          if (inline.map.has(bname)) continue
          const bound = renames.map.get(bname) ?? bname
          hoist.used.add(bound) // a generated name must not collide with it
          // param('x', d, opts) → knob (name must match the binding)
          if (isCall(bin) && calleeName(bin) === 'param') {
            const pa = bin['arguments'] as Node[]
            // param('bright') with NO default is a MACRO reference: the
            // numbers live on the macro line, so there is nothing to write
            // here — the bare `bright` in the spine IS the rondo source.
            if (pa.length === 1 && strValue(pa[0]!) === bound) continue
            const decl = paramDecl(pa, bound)
            if (decl === null) return null
            bindings.push(`${bound} = ${decl}`)
          } else {
            bindings.push(`${bound} = ${bindingRHS(bin)}`)
          }
        } else if (s.type === 'ReturnStatement') {
          ret = (s['argument'] as Node | null) ?? undefined
        } else return null
      }
    } else ret = body
    if (ret === undefined) return null
    const spine: string[] = []
    if (!unfoldPipeline(ret, spine)) {
      // total fallback for the whole chain — still valid rondo
      spine.length = 0
      spine.push(`js{ ${slice(ret)} }`)
    }
    // a post chain folds from `input` implicitly: drop the literal source
    // line (and bail if the chain doesn't actually start there)
    if (fromInput) {
      if (spine[0] !== 'input') return null
      spine.shift()
    }
    return { spine, bindings }
  }

// Invert keeping the FIRST spelling per long name: SCALE_MODE lists the terse
// forms first and the identity entries (minor→minor) last — a plain map-from-
// entries would let the identities overwrite the short forms ('a-minor').
const SCALE_INV = new Map<string, string>()
for (const [short, long] of Object.entries(SCALE_MODE)) {
  if (!SCALE_INV.has(long)) SCALE_INV.set(long, short)
}

/** A .ctrl/.gain value node → modifier value text, or null. */
/** Arithmetic over a project MACRO, as a modifier value: `bright / 9000 + .5`.
 *
 *  A macro reaches the pattern layer through macroval(), so `gain: bright / 2`
 *  compiles to `.gain(macroval('bright').div(2))`. Nothing brought that back,
 *  so any docs example using one knob to drive a pattern control decompiled to
 *  a js block — which is the case the feature exists for.
 *
 *  Precedence guarded the same way rExpr does it: only emit infix when the
 *  text re-parses to the same tree, since a modifier value has no parentheses
 *  to fall back on. */
function macroArith(n: Node): { s: string; prec: number } | null {
  const nv = numValue(n)
  if (nv !== undefined) return { s: num(nv), prec: 5 }
  if (isCall(n) && calleeName(n) === 'macroval') {
    const a = n['arguments'] as Node[]
    const name = a.length === 1 ? strValue(a[0]!) : undefined
    return name !== undefined && /^[a-zA-Z_]\w*$/.test(name) ? { s: name, prec: 5 } : null
  }
  const m = methodCall(n)
  if (m === undefined || m.args.length !== 1) return null
  const info = OP_INFO[m.method]
  if (info === undefined) return null
  const l = macroArith(m.obj)
  const r = macroArith(m.args[0]!)
  if (l === null || r === null) return null
  if (l.prec < info.prec || r.prec <= info.prec) return null // would mis-associate
  return { s: `${l.s} ${info.op} ${r.s}`, prec: info.prec }
}

function ctrlValue(n: Node): string | null {
  const nv = numValue(n)
  if (nv !== undefined) return num(nv)
  const sv = strValue(n)
  if (sv !== undefined) return sv // a mini string
  // a macro driving a pattern control, with any arithmetic on it
  const mac = macroArith(n)
  if (mac !== null) return mac.s
  // signal chains: sig[.range(a,b)][.slow(n)|.fast(n)] / rise(n)/fall(n) bases
  let cur: Node = n
  let slow: number | undefined
  let fast: number | undefined
  let range: [number, number] | undefined
  for (;;) {
    const m = methodCall(cur)
    if (m === undefined) break
    if ((m.method === 'slow' || m.method === 'fast') && m.args.length === 1) {
      const v = numValue(m.args[0]!)
      if (v === undefined) return null
      if (m.method === 'slow') slow = v
      else fast = v
      cur = m.obj
    } else if (m.method === 'range' && m.args.length === 2) {
      const lo = numValue(m.args[0]!)
      const hi = numValue(m.args[1]!)
      if (lo === undefined || hi === undefined) return null
      range = [lo, hi]
      cur = m.obj
    } else return null
  }
  let base: string | undefined
  if (isIdent(cur)) base = cur['name'] as string
  else if (isCall(cur) && (calleeName(cur) === 'rise' || calleeName(cur) === 'fall')) {
    const a = cur['arguments'] as Node[]
    if (a.length === 0) base = calleeName(cur)!
    else if (a.length === 1) {
      const v = numValue(a[0]!)
      if (v === undefined) return null
      base = `${calleeName(cur)!} ${num(v)}`
    } else return null
  } else if (isCall(cur) && calleeName(cur) === 'curve') {
    const a = cur['arguments'] as Node[]
    if (a.length !== 1) return null
    const arg = a[0]!
    // curve(shape('swell', 16)) → `shape swell 16`
    if (isCall(arg) && calleeName(arg) === 'shape') {
      const sa = arg['arguments'] as Node[]
      const sn = sa[0] !== undefined ? strValue(sa[0]) : undefined
      const sl = sa[1] !== undefined ? numValue(sa[1]) : undefined
      if (sn === undefined || sl === undefined || sa.length !== 2) return null
      base = `shape ${sn} ${num(sl)}`
    } else if (arg.type === 'ArrayExpression') {
      // curve([[8, 1], [8, .2, 3]]) → `curve 8 1 8 .2:3`
      const flat: string[] = []
      for (const el of arg['elements'] as (Node | null)[]) {
        if (el === null || el.type !== 'ArrayExpression') return null
        const pair = el['elements'] as (Node | null)[]
        if (pair.length !== 2 && pair.length !== 3) return null
        const vals: number[] = []
        for (const q of pair) {
          const x = q !== null ? numValue(q) : undefined
          if (x === undefined) return null
          vals.push(x)
        }
        flat.push(num(vals[0]!))
        flat.push(vals.length === 3 ? `${num(vals[1]!)}:${num(vals[2]!)}` : num(vals[1]!))
      }
      if (flat.length === 0) return null
      base = `curve ${flat.join(' ')}`
    } else return null
  }
  if (base === undefined) return null
  let out = base
  if (range !== undefined) out += ` ${num(range[0])}..${num(range[1])}`
  if (slow !== undefined) out += ` slow:${num(slow)}`
  if (fast !== undefined) out += ` fast:${num(fast)}`
  return out
}

const FN_COMB_INV: Record<string, { rname: string; pre: number }> = {
  every: { rname: 'every', pre: 1 },
  off: { rname: 'off', pre: 1 },
  chunk: { rname: 'chunk', pre: 1 },
  sometimesBy: { rname: 'sometimesby', pre: 1 },
  juxBy: { rname: 'juxby', pre: 1 },
  sometimes: { rname: 'sometimes', pre: 0 },
  often: { rname: 'often', pre: 0 },
  rarely: { rname: 'rarely', pre: 0 },
  always: { rname: 'always', pre: 0 },
  superimpose: { rname: 'superimpose', pre: 0 },
  jux: { rname: 'jux', pre: 0 },
}

/** A pattern chain expression → { sound, body lines } (voices, scale,
 *  modifiers), or null. Shared by p('name', CHAIN) and section stacks. */
/** `sing([voice,] lyrics, notes, { name, cycles?, post? })` → the header
 *  suffix and body lines of a rondo `sing` block, or null.
 *
 *  rondo writes the phrase as alternating LYRIC / MELODY line pairs and joins
 *  each pair with a space, so one pair reproduces the two joined strings the
 *  JS API takes. `name` is the channel and lives on the header; `cycles` is an
 *  option in JavaScript and a modifier line in rondo. */
function singEntry(n: Node): { header: string; name: string; body: string[] } | null {
  if (!isCall(n) || calleeName(n) !== 'sing') return null
  const a = n['arguments'] as Node[]
  if (a.length !== 3 && a.length !== 4) return null
  const withVoice = a.length === 4
  const voice = withVoice ? strValue(a[0]!) : undefined
  if (withVoice && (voice === undefined || !/^[a-zA-Z_]\w*$/.test(voice))) return null
  const lyrics = strValue(a[withVoice ? 1 : 0]!)
  const melody = strValue(a[withVoice ? 2 : 1]!)
  const opts = objEntries(a[withVoice ? 3 : 2]!)
  if (lyrics === undefined || melody === undefined || opts === undefined) return null
  // a multi-line template would need the pair structure rebuilt line by line;
  // the collapsed single-line form is what the compiler emits
  const L = lyrics.trim()
  const M = melody.trim()
  if (L === '' || M === '' || L.includes('\n') || M.includes('\n')) return null
  const name = opts['name'] !== undefined ? strValue(opts['name']) : undefined
  if (name === undefined) return null
  const mods: string[] = []
  let post: string[] = []
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'name') continue
    if (k === 'cycles') {
      const cv = numValue(v)
      if (cv === undefined) return null
      mods.push(`cycles: ${num(cv)}`)
      continue
    }
    if (k === 'post') {
      if (v.type !== 'ArrowFunctionExpression') return null
      const pl = decompileChainFn(v, '  ', true)
      if (pl === null || pl.some((l) => l.includes('js{'))) return null
      post = ['post', ...pl]
      continue
    }
    return null // an option with no rondo spelling
  }
  return { header: withVoice ? ` voice:${voice!}` : '', name, body: [L, M, ...mods, ...post] }
}

function chainToPlay(chainNode: Node):
  { sound?: string; entry: 'notes' | 'sound' | 'sing'; header?: string; perLine?: boolean; body: string[] } | null {
  // walk the method chain from the OUTSIDE in
  const mods: string[] = []
  let scale: string | undefined
  let sound: string | undefined
  let cur: Node = chainNode
  for (;;) {
    const m = methodCall(cur)
    if (m === undefined) break
    if (m.method === 'scale' && m.args.length === 1) {
      const sv = strValue(m.args[0]!)
      if (sv === undefined) return null
      /* A PATTERNED scale comes back as it went out, with the `_` separators
       * turned back into the `-` the language writes. Without this a
       * `scale: <c-maj f-min>` line survived a round trip only as a js{} blob,
       * which is the language failing to spell something it accepts. */
      if (/[<>[\]{}*!@?|,]/.test(sv)) {
        scale = sv.replace(/_/g, '-')
        cur = m.obj
        continue
      }
      const [root, mode, extra] = sv.split(' ')
      if (root === undefined || mode === undefined || extra !== undefined) return null
      // the short form must re-lex as `scale:root-mode` — a root outside
      // a..g or a mode with other characters bails to a js block instead
      // of emitting a scale: line the parser reads as something else
      if (!/^[a-gA-G][#b]?$/.test(root) || !/^[a-zA-Z0-9_]+$/.test(mode)) return null
      scale = `${root}-${SCALE_INV.get(mode) ?? mode}`
    } else if (m.method === 'sound' && m.args.length === 1) {
      const sv = strValue(m.args[0]!)
      if (sv === undefined) return null
      sound = sv
    } else if (m.method === 'overChord' && m.args.length === 1) {
      // .overChord(chord('<Am7 F>')) → `overchord: <Am7 F>`. Only the literal
      // chord() form has sugar; a shared const or a computed pattern has no
      // rondo spelling, so it stays a js block rather than round-trip wrong.
      const arg = m.args[0]!
      if (!isCall(arg) || calleeName(arg) !== 'chord') return null
      const cargs = arg['arguments'] as Node[]
      const cv = cargs.length === 1 ? strValue(cargs[0]!) : undefined
      if (cv === undefined) return null
      mods.unshift(`overchord: ${cv}`)
    } else if (m.method === 'ctrl' && m.args.length === 2) {
      const cname = strValue(m.args[0]!)
      const cval = ctrlValue(m.args[1]!)
      if (cname === undefined || cval === null) return null
      mods.unshift(`${cname}: ${cval}`)
    } else if ((m.method === 'gain' || m.method === 'dur' || m.method === 'pan') && m.args.length === 1) {
      // .gain directly on s()/sound() is a PER-VOICE velocity pattern — stop
      // here and let entryNotation zip it into `word:v` suffixes instead of
      // hoisting it to a block-wide `gain:` modifier
      if (m.method === 'gain' && isCall(m.obj) &&
          (calleeName(m.obj) === 's' || calleeName(m.obj) === 'sound')) break
      const cval = ctrlValue(m.args[0]!)
      if (cval === null) return null
      mods.unshift(`${m.method}: ${cval}`)
    } else if (m.method === 'struct' && m.args.length === 1 &&
               isCall(m.args[0]) && calleeName(m.args[0] as Node) === 'mini') {
      const mv = strValue(((m.args[0] as Node)['arguments'] as Node[])[0]!)
      if (mv === undefined) return null
      mods.unshift(`struct ${mv}`)
    } else if (FN_COMB_INV[m.method] !== undefined) {
      const inv = FN_COMB_INV[m.method]!
      const pre = m.args.slice(0, inv.pre).map(numValue)
      const fn = m.args[inv.pre]
      if (pre.some((x) => x === undefined) || fn === undefined || fn.type !== 'ArrowFunctionExpression') return null
      const body = fn['body'] as Node
      const bm = methodCall(body)
      if (bm === undefined || !isIdent(bm.obj)) return null
      const combArgs = bm.args.map((a) => {
        const nv = numValue(a)
        if (nv !== undefined) return num(nv)
        return strValue(a) ?? null
      })
      if (combArgs.some((x) => x === null)) return null
      const comb = `${bm.method}${combArgs.length > 0 ? ' ' + combArgs.join(' ') : ''}`
      mods.unshift(`${inv.rname}${pre.length > 0 ? ' ' + pre.map((x) => num(x!)).join(' ') : ''}: ${comb}`)
    } else {
      // a bare combinator with number/word args
      const combArgs = m.args.map((a) => {
        const nv = numValue(a)
        if (nv !== undefined) return num(nv)
        const sv = strValue(a)
        return sv !== undefined && /^[\w~ .!@*<>[\]-]+$/.test(sv) ? sv : null
      })
      if (combArgs.some((x) => x === null)) return null
      mods.unshift(`${m.method === 'degradeBy' ? 'degradeby' : m.method}${combArgs.length > 0 ? ' ' + combArgs.join(' ') : ''}`)
    }
    cur = m.obj
  }
  // a sung phrase is its own entry: `sing([voice,] lyrics, notes, { … })`
  const sung = singEntry(cur)
  if (sung !== null) {
    // the block name IS the `name:` option — rondo has one place to say it,
    // so a p() whose channel differs from it has no faithful spelling
    return { entry: 'sing', sound: sung.name, header: sung.header, body: [...sung.body, ...mods] }
  }
  // the entry: n/note/chord('…'), s/sound('…') (a beat block), or stack(entries…)
  let entry: 'notes' | 'sound' | undefined
  const entryNotation = (e: Node): string | null => {
    // s('kick ~ kick ~').gain('1 ~ 0.6 ~') → `kick ~ kick:0.6 ~` — zip the
    // aligned per-voice gain pattern back into velocity suffixes (FLAT lines
    // only; a structured gain bails the play to a js block — totality holds)
    const gm = methodCall(e)
    if (gm !== undefined) {
      if (gm.method !== 'gain' || gm.args.length !== 1) return null
      const inner = gm.obj
      const gv = strValue(gm.args[0]!)
      if (gv === undefined || !isCall(inner)) return null
      const ien = calleeName(inner)
      if (ien !== 's' && ien !== 'sound') return null
      const notes = strValue((inner['arguments'] as Node[])[0] ?? { type: 'X' } as Node)
      if (notes === undefined) return null
      const nToks = notes.trim().split(/\s+/)
      const gToks = gv.trim().split(/\s+/)
      if (nToks.length !== gToks.length) return null
      if (!nToks.every((t) => t === '~' || /^[a-zA-Z_]\w*$/.test(t))) return null // flat words only
      const merged: string[] = []
      for (let i = 0; i < nToks.length; i++) {
        const w = nToks[i]!, g = gToks[i]!
        if (w === '~') { merged.push('~'); continue }
        if (g === '1' || g === '~') { merged.push(w); continue }
        if (!/^\d*\.?\d+$/.test(g)) return null
        merged.push(`${w}:${g}`)
      }
      if (entry !== undefined && entry !== 'sound') return null
      entry = 'sound'
      return merged.join(' ')
    }
    if (!isCall(e)) return null
    const en = calleeName(e)
    const kind = en === 'n' || en === 'note' || en === 'chord' ? 'notes'
      : en === 's' || en === 'sound' ? 'sound' : undefined
    if (kind === undefined) return null
    if (entry !== undefined && entry !== kind) return null // mixed stack — not expressible
    entry = kind
    const a = e['arguments'] as Node[]
    // n(irand(N).segment(M)) → an `irand N seg:M` notation line
    if (en === 'n' && a[0] !== undefined && strValue(a[0]) === undefined) {
      const mm = methodCall(a[0]!)
      if (mm !== undefined && mm.method === 'segment' && mm.args.length === 1 &&
          isCall(mm.obj) && calleeName(mm.obj) === 'irand' && (mm.obj['arguments'] as Node[]).length === 1) {
        const nN = numValue((mm.obj['arguments'] as Node[])[0]!)
        const nM = numValue(mm.args[0]!)
        if (nN !== undefined && nM !== undefined) return `irand ${num(nN)} seg:${num(nM)}`
      }
      return null
    }
    const sv = a[0] !== undefined ? strValue(a[0]) : undefined
    return sv !== undefined && !sv.includes('\n') ? sv : null
  }
  const voices: string[] = []
  let perLine = false
  if (isCall(cur) && calleeName(cur) === 'stack') {
    // a stack member may carry its OWN .sound(): a layered drum pattern is
    // one channel of several instruments. Peel it and write it back as the
    // per-line `synth:` route, since rondo's layers otherwise share one.
    // `stack(stack(a, b), c)` is `stack(a, b, c)` — stacking is associative,
    // and an importer emits the nested form when it groups by track. Only a
    // BARE nested stack flattens: one carrying its own methods
    // (`stack(a, b).gain(.5)`) means something the flat form would not.
    const flat = (nodes: Node[]): Node[] =>
      nodes.flatMap((e) => (isCall(e) && calleeName(e) === 'stack' ? flat(e['arguments'] as Node[]) : [e]))
    const members = flat(cur['arguments'] as Node[]).map((e) => {
      const sm = methodCall(e)
      if (sm !== undefined && sm.method === 'sound' && sm.args.length === 1) {
        const sv = strValue(sm.args[0]!)
        if (sv !== undefined && /^[a-zA-Z_]\w*$/.test(sv)) return { node: sm.obj, own: sv }
      }
      return { node: e, own: undefined }
    })
    // every member routed the same way is the block's route, not a per-line one
    const owns = members.map((m) => m.own)
    const uniform = owns.every((o) => o !== undefined && o === owns[0])
    if (uniform && sound === undefined) sound = owns[0]
    for (const m of members) {
      const nv = entryNotation(m.node)
      if (nv === null) return null
      // a member with no route of its own inside a routed stack has nothing
      // to fall back to, so the whole play bails rather than inventing one
      if (!uniform && owns.some((o) => o !== undefined)) {
        if (m.own === undefined) return null
        perLine = true
        voices.push(`${nv} synth:${m.own}`)
        continue
      }
      voices.push(nv)
    }
  } else {
    const nv = entryNotation(cur)
    if (nv === null) return null
    voices.push(nv)
  }
  if (entry === 'sound') {
    // a beat pattern carries no .sound()/.scale() of its own
    if (sound !== undefined || scale !== undefined) return null
    return { entry, body: [...voices, ...mods] }
  }
  const body = [...voices, ...(scale !== undefined ? [`scale: ${scale}`] : []), ...mods]
  // every line names its own synth, so the header names none
  if (perLine) return { entry: 'notes', perLine, body }
  if (sound === undefined) return null
  return { sound, entry: 'notes', body }
}

/** p('name', CHAIN) → a play block, or null. */
function decompilePlay(stmt: Node): string | null {
  if (stmt.type !== 'ExpressionStatement') return null
  const call = stmt['expression'] as Node
  if (!isCall(call) || calleeName(call) !== 'p') return null
  const args = call['arguments'] as Node[]
  if (args.length !== 2) return null
  const pname = strValue(args[0]!)
  if (pname === undefined) return null
  const play = chainToPlay(args[1]!)
  if (play === null) return null
  if (play.entry === 'sing') {
    if (play.sound !== pname) return null
    return [`sing ${pname}${play.header ?? ''}`, ...play.body.map((l) => `  ${l}`)].join('\n')
  }
  if (play.entry === 'sound') {
    // p('beat', s('…')) → a bare `beat`; any other name is kept on the header
    return [`beat${pname === 'beat' ? '' : ` ${pname}`}`, ...play.body.map((l) => `  ${l}`)].join('\n')
  }
  // perLine: each notation line carries its own `synth:`, so the header has
  // no single route to name
  if (play.sound === undefined && play.perLine !== true) return null
  const header = play.perLine === true || play.sound === pname
    ? `play ${pname}`
    : `play ${pname} synth:${play.sound}`
  return [header, ...play.body.map((l) => `  ${l}`)].join('\n')
}

/** A section const: its plays (one per stack member), or null. */
function sectionPlays(chainNode: Node): string[] | null {
  const members = isCall(chainNode) && calleeName(chainNode) === 'stack' &&
      !((chainNode['arguments'] as Node[]).some((a) => {
        const en = isCall(a) ? calleeName(a) : undefined
        // a stack of ENTRIES is stacked voices, not section plays
        return en === 'n' || en === 'note' || en === 'chord' || en === 's' || en === 'sound'
      }))
    ? (chainNode['arguments'] as Node[])
    : [chainNode]
  const out: string[] = []
  for (const m of members) {
    const play = chainToPlay(m)
    if (play === null) return null
    const header = play.entry === 'sound' ? '  beat' : `  play ${play.sound}`
    out.push([header, ...play.body.map((l) => `    ${l}`)].join('\n'))
  }
  return out
}

/** p('name', sing([voice,] lyrics, notes, { name, post? })<mods>) → a sing
 *  block, or null. The joined lyric/melody strings come back as ONE pair of
 *  lines (line structure isn't recoverable from the joined form). */
function decompileSing(stmt: Node): string | null {
  if (stmt.type !== 'ExpressionStatement') return null
  const call = stmt['expression'] as Node
  if (!isCall(call) || calleeName(call) !== 'p') return null
  const pargs = call['arguments'] as Node[]
  if (pargs.length !== 2) return null
  const pname = strValue(pargs[0]!)
  if (pname === undefined) return null
  // walk pattern modifiers from the outside in (gain/dur/pan, ctrls,
  // fn-combinators, bare combinators — anything else bails)
  const mods: string[] = []
  let cur: Node = pargs[1]!
  for (;;) {
    const m = methodCall(cur)
    if (m === undefined) break
    if (m.method === 'ctrl' && m.args.length === 2) {
      const cname = strValue(m.args[0]!)
      const cval = ctrlValue(m.args[1]!)
      if (cname === undefined || cval === null) return null
      mods.unshift(`${cname}: ${cval}`)
    } else if ((m.method === 'gain' || m.method === 'dur' || m.method === 'pan') && m.args.length === 1) {
      const cval = ctrlValue(m.args[0]!)
      if (cval === null) return null
      mods.unshift(`${m.method}: ${cval}`)
    } else if (FN_COMB_INV[m.method] !== undefined) {
      const inv = FN_COMB_INV[m.method]!
      const pre = m.args.slice(0, inv.pre).map(numValue)
      const fn = m.args[inv.pre]
      if (pre.some((x) => x === undefined) || fn === undefined || fn.type !== 'ArrowFunctionExpression') return null
      const body = fn['body'] as Node
      const bm = methodCall(body)
      if (bm === undefined || !isIdent(bm.obj)) return null
      const combArgs = bm.args.map((a) => {
        const nv = numValue(a)
        if (nv !== undefined) return num(nv)
        return strValue(a) ?? null
      })
      if (combArgs.some((x) => x === null)) return null
      const comb = `${bm.method}${combArgs.length > 0 ? ' ' + combArgs.join(' ') : ''}`
      mods.unshift(`${inv.rname}${pre.length > 0 ? ' ' + pre.map((x) => num(x!)).join(' ') : ''}: ${comb}`)
    } else {
      const combArgs = m.args.map((a) => {
        const nv = numValue(a)
        if (nv !== undefined) return num(nv)
        const sv = strValue(a)
        return sv !== undefined && /^[\w~ .!@*<>[\]-]+$/.test(sv) ? sv : null
      })
      if (combArgs.some((x) => x === null)) return null
      mods.unshift(`${m.method === 'degradeBy' ? 'degradeby' : m.method}${combArgs.length > 0 ? ' ' + combArgs.join(' ') : ''}`)
    }
    cur = m.obj
  }
  if (!isCall(cur) || calleeName(cur) !== 'sing') return null
  const args = cur['arguments'] as Node[]
  // sing(voice, lyrics, notes, opts?) | sing(lyrics, notes, opts?)
  const s0 = args[0] !== undefined ? strValue(args[0]) : undefined
  const s1 = args[1] !== undefined ? strValue(args[1]) : undefined
  const s2 = args[2] !== undefined ? strValue(args[2]) : undefined
  let voice: string | undefined, lyrics: string | undefined, notes: string | undefined, optsNode: Node | undefined
  if (s2 !== undefined) {
    voice = s0; lyrics = s1; notes = s2; optsNode = args[3]
    if (voice === undefined) return null
  } else {
    lyrics = s0; notes = s1; optsNode = args[2]
  }
  if (lyrics === undefined || notes === undefined) return null
  if (lyrics.includes('\n') || notes.includes('\n')) return null
  // opts must name the channel after the p() (that's what cgSing emits);
  // anything else (hash-named vocals, unknown keys) stays a js block
  if (optsNode === undefined) return null
  const o = objEntries(optsNode)
  if (o === undefined) return null
  let postLines: string[] | null = null
  let cyclesLine: string | null = null
  for (const [k, vNode] of Object.entries(o)) {
    if (k === 'name') {
      if (strValue(vNode) !== pname) return null
    } else if (k === 'cycles') {
      // the multi-cycle phrase length reverses to its own modifier line
      const cv = numValue(vNode)
      if (cv === undefined || !Number.isInteger(cv) || cv < 1) return null
      if (cv > 1) cyclesLine = `cycles: ${num(cv)}`
    } else if (k === 'post') {
      if (vNode.type !== 'ArrowFunctionExpression') return null
      postLines = decompileChainFn(vNode, '    ', true)
      if (postLines === null) return null
    } else return null
  }
  if (o['name'] === undefined) return null
  const header = `sing ${pname}${voice !== undefined && /^[a-zA-Z_]\w*$/.test(voice) ? ` voice:${voice}` : ''}`
  if (voice !== undefined && !/^[a-zA-Z_]\w*$/.test(voice)) return null
  const out = [header, `  ${lyrics}`, `  ${notes}`, ...(cyclesLine !== null ? [`  ${cyclesLine}`] : []), ...mods.map((l) => `  ${l}`)]
  if (postLines !== null) out.push('  post', ...postLines)
  return out.join('\n')
}

/** Simple staging statements → their rondo lines, or null. */
function decompileStaging(stmt: Node): string | null {
  if (stmt.type !== 'ExpressionStatement') return null
  const call = stmt['expression'] as Node
  if (!isCall(call)) return null
  const name = calleeName(call)
  const args = call['arguments'] as Node[]
  // tempo, in the unit the JS states: setCps → `cps`, setBpm → `bpm`. The
  // round trip is unit-preserving in BOTH directions — `bpm 128` converted to
  // JS and back is `bpm 128`, never a silently rewritten `cps .5333`.
  if ((name === 'setCps' || name === 'setBpm') && args.length === 1) {
    const v = numValue(args[0]!)
    return v !== undefined ? `${name === 'setBpm' ? 'bpm' : 'cps'} ${num(v)}` : null
  }
  // `masterGain(-4)` → `level -4`, in the same dB the JS states.
  if (name === 'masterGain' && args.length === 1) {
    const v = numValue(args[0]!)
    return v !== undefined ? `level ${num(v)}` : null
  }
  // `setTimeSig(3, 4)` → `timesig 3 4`. Non-literal arguments stay a js block:
  // there is no rondo spelling for a computed meter.
  if (name === 'setTimeSig' && args.length === 2) {
    const a = numValue(args[0]!)
    const b = numValue(args[1]!)
    return a !== undefined && b !== undefined ? `timesig ${num(a)} ${num(b)}` : null
  }
  if (name === 'defineScale' && args.length === 2) {
    // `scaledef NAME [cents|ratios] v v … [period:p]` — a word name and at
    // least two values; anything else stays a js block
    const sname = strValue(args[0]!)
    if (sname === undefined || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(sname)) return null
    const numList = (arr: Node): string[] | null => {
      if (arr.type !== 'ArrayExpression') return null
      const vals: string[] = []
      for (const el of arr['elements'] as (Node | null)[]) {
        if (el === null) return null
        const v = numValue(el)
        if (v === undefined) return null
        vals.push(num(v))
      }
      return vals.length >= 2 ? vals : null
    }
    const spec = args[1]!
    if (spec.type === 'ArrayExpression') {
      const vals = numList(spec)
      return vals === null ? null : `scaledef ${sname} ${vals.join(' ')}`
    }
    // the object spec: { cents: […], periodCents? } or { ratios: […], periodRatio? }
    const o = objEntries(spec)
    if (o === undefined) return null
    const unit = o['cents'] !== undefined ? 'cents' : o['ratios'] !== undefined ? 'ratios' : undefined
    if (unit === undefined) return null
    const vals = numList(o[unit]!)
    if (vals === null) return null
    const pkey = unit === 'cents' ? 'periodCents' : 'periodRatio'
    let period = ''
    if (o[pkey] !== undefined) {
      const pv = numValue(o[pkey]!)
      if (pv === undefined || pv <= 0) return null
      period = ` period:${num(pv)}`
    }
    // an unrecognised key would be silently dropped, so refuse the whole thing
    if (Object.keys(o).some((k) => k !== unit && k !== pkey)) return null
    return `scaledef ${sname} ${unit} ${vals.join(' ')}${period}`
  }
  if (name === 'macro' && args.length >= 2 && args.length <= 3) {
    // macro('bright', 1480, { min, max, curve }) → `macro bright 1480 500..7300 log`
    const mname = strValue(args[0]!)
    const mdef = numValue(args[1]!)
    if (mname === undefined || mdef === undefined || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(mname)) return null
    const o = args[2] !== undefined ? objEntries(args[2]) : {}
    if (o === undefined) return null
    if (o['values'] !== undefined) {
      const pair = numPair(o['values'])
      // the pair must be the ONLY option, and the default must be one of it,
      // or this is not something `switch NAME A B` can say
      if (pair === undefined || Object.keys(o).length !== 1) return null
      if (mdef !== pair[0]) return null
      return `switch ${mname} ${num(pair[0])} ${num(pair[1])}`
    }
    for (const k of Object.keys(o)) if (k !== 'min' && k !== 'max' && k !== 'curve') return null
    const lo = o['min'] !== undefined ? numValue(o['min']) : undefined
    const hi = o['max'] !== undefined ? numValue(o['max']) : undefined
    // a HALF range has no rondo spelling (`lo..hi` is one token pair), so it
    // stays a js block rather than round-tripping to something else
    if ((lo === undefined) !== (hi === undefined)) return null
    const curve = o['curve'] !== undefined ? strValue(o['curve']) : undefined
    if (o['curve'] !== undefined && curve === undefined) return null
    const range = lo !== undefined && hi !== undefined ? ` ${num(lo)}..${num(hi)}` : ''
    return `macro ${mname} ${num(mdef)}${range}${curve !== undefined ? ` ${curve}` : ''}`
  }
  if (name === 'curvedef' && args.length === 2) {
    // curvedef('swell', [[.25, 1], [.75, .2, 3]]) → `curvedef swell .25 1 .75 .2:3`
    const cname = strValue(args[0]!)
    if (cname === undefined || !/^[a-zA-Z_]\w*$/.test(cname)) return null
    const arr = args[1]!
    if (arr.type !== 'ArrayExpression') return null
    const flat: string[] = []
    for (const el of arr['elements'] as (Node | null)[]) {
      if (el === null || el.type !== 'ArrayExpression') return null
      const pair = el['elements'] as (Node | null)[]
      if (pair.length !== 2 && pair.length !== 3) return null
      const vals: number[] = []
      for (const q of pair) {
        const x = q !== null ? numValue(q) : undefined
        if (x === undefined) return null
        vals.push(x)
      }
      flat.push(num(vals[0]!))
      flat.push(vals.length === 3 ? `${num(vals[1]!)}:${num(vals[2]!)}` : num(vals[1]!))
    }
    if (flat.length === 0) return null
    return `curvedef ${cname} ${flat.join(' ')}`
  }
  if (name === 'defineWavetable' && args.length === 2) {
    // only the literal frames-of-numbers form has sugar (`wavedef NAME a b /
    // c d`, >= 2 frames of 1..32 partials, a word name); anything computed
    // stays a js block
    const wname = strValue(args[0]!)
    if (wname === undefined || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(wname)) return null
    const outer = args[1]!
    if (outer.type !== 'ArrayExpression') return null
    const frames: string[] = []
    for (const fr of outer['elements'] as (Node | null)[]) {
      if (fr === null || fr.type !== 'ArrayExpression') return null
      const parts: string[] = []
      for (const el of fr['elements'] as (Node | null)[]) {
        if (el === null) return null
        const v = numValue(el)
        if (v === undefined) return null
        parts.push(num(v))
      }
      if (parts.length < 1 || parts.length > 32) return null
      frames.push(parts.join(' '))
    }
    if (frames.length < 2) return null
    return `wavedef ${wname} ${frames.join(' / ')}`
  }
  if (name === 'masterCompress' && args.length <= 1) {
    if (args.length === 0) return 'master'
    const o = objEntries(args[0]!)
    if (o === undefined) return null
    const parts: string[] = []
    for (const [k, vn] of Object.entries(o)) {
      const v = numValue(vn)
      if (v === undefined) return null
      parts.push(`${k}:${num(v)}`)
    }
    return `master ${parts.join(' ')}`
  }
  /* `stereo({ width, monoBelow })` → `stereo width:… monobelow:…`. The key
   *  loses its camelCase on the way back: rondo has none anywhere, and the
   *  mapping lives in exactly these two places. */
  if (name === 'stereo' && args.length <= 1) {
    if (args.length === 0) return 'stereo'
    const o = objEntries(args[0]!)
    if (o === undefined) return null
    const parts: string[] = []
    for (const [k, vn] of Object.entries(o)) {
      const v = numValue(vn)
      if (v === undefined) return null
      parts.push(`${k === 'monoBelow' ? 'monobelow' : k}:${num(v)}`)
    }
    return `stereo ${parts.join(' ')}`
  }
  if (name === 'sidechain' && args.length >= 1 && args.length <= 2) {
    const srcName = strValue(args[0]!)
    if (srcName === undefined) return null
    let out = `sidechain ${srcName}`
    if (args[1] !== undefined) {
      const o = objEntries(args[1])
      if (o === undefined) return null
      for (const [k, vn] of Object.entries(o)) {
        if (k === 'duck') {
          const duck = objEntries(vn)
          if (duck === undefined) return null
          for (const [dk, dv] of Object.entries(duck)) {
            const t = scText(dv)
            if (t === undefined) return null
            out += ` ${dk}:${t}`
          }
        } else {
          const t = scText(vn)
          if (t === undefined) return null
          out += ` ${k}:${t}`
        }
      }
    }
    return out
  }
  if (name === 'bus' && args.length >= 2) {
    const bname = strValue(args[0]!)
    const fx = args[1]!
    if (bname === undefined || fx.type !== 'ArrowFunctionExpression') return null
    const body = fx['body'] as Node
    const ret = body.type === 'BlockStatement'
      ? ((body['body'] as Node[]).find((s) => s.type === 'ReturnStatement')?.['argument'] as Node | undefined)
      : body
    if (ret === undefined || (body.type === 'BlockStatement' && (body['body'] as Node[]).length !== 1)) return null
    const lines: string[] = []
    if (!unfoldPipeline(ret, lines)) return null
    if (lines[0] !== 'input') return null // fx must fold from input
    const out = [`bus ${bname}`, ...lines.slice(1).map((l) => `  ${l}`)]
    if (args[2] !== undefined) {
      const sends = objEntries(args[2])
      if (sends === undefined) return null
      for (const [k, vn] of Object.entries(sends)) {
        const v = numValue(vn)
        if (v === undefined) return null
        out.push(`  send ${k} ${num(v)}`)
      }
    }
    return out.join('\n')
  }
  if (name === 'visual' && args.length === 1) {
    const a = args[0]!
    if (a.type === 'TemplateLiteral' && (a['expressions'] as Node[]).length === 0) {
      const quasis = a['quasis'] as Node[]
      const cooked = (quasis[0]!['value'] as { cooked?: string }).cooked
      if (cooked !== undefined) {
        const body = cooked.replace(/^\n/, '').replace(/\n$/, '')
        return ['visual', ...body.split('\n').map((l) => (l.length > 0 ? `  ${l}` : ''))].join('\n')
      }
    }
    return null
  }
  return null
}

/* ---- entry ------------------------------------------------------------------ */

/** JavaScript → rondo. TOTAL: statements the sugar doesn't cover survive
 *  verbatim in `js` blocks, so semantics are always preserved. */
export function decompile(js: string): string {
  src.text = js
  let program: Node
  try {
    program = parse(js, { ecmaVersion: 2022, sourceType: 'script' }) as unknown as Node
  } catch {
    // not parseable as JS at all — hand it back wrapped so nothing is lost
    return ['js', ...js.split('\n').map((l) => (l.length > 0 ? `  ${l}` : ''))].join('\n') + '\n'
  }
  const parts: string[] = []
  let jsRun: string[] = [] // consecutive unrecognized statements → ONE js block
  const flushJs = (): void => {
    // one js block PER statement — merging them would need a blank line
    // between statements to round-trip (the compiler spaces top-level
    // statements with one), and a blank line inside a block would END it
    for (const stmt of jsRun) {
      parts.push(['js', ...stmt.split('\n').map((l) => (l.length > 0 ? `  ${l}` : ''))].join('\n'))
    }
    jsRun = []
  }
  // sections: `const __sec_X = <stack of plays>` held aside; the matching
  // p('song', arrange([len, __sec_X], …)) emits section blocks + a song line.
  // A partial match falls back to js blocks for everything involved.
  const pendingSecs = new Map<string, { plays: string[]; raw: string; placeholder: number }>()
  const secConst = (stmt: Node): string | null => {
    if (stmt.type !== 'VariableDeclaration') return null
    const d = (stmt['declarations'] as Node[])[0]
    if (d === undefined || !isIdent(d['id'] as Node)) return null
    const name = (d['id'] as Node)['name'] as string
    if (!name.startsWith('__sec_')) return null
    const init = d['init'] as Node | null
    if (init === null) return null
    const plays = sectionPlays(init)
    if (plays === null) return null
    // flush any pending js run BEFORE claiming the placeholder slot — the
    // placeholder index must come after it, or a bailed statement written
    // just above this section would be emitted below it (order inversion)
    flushJs()
    pendingSecs.set(name.slice('__sec_'.length), { plays, raw: slice(stmt), placeholder: parts.length })
    parts.push('') // placeholder — filled by the song matcher (or restored raw)
    return ''
  }
  const songArrange = (stmt: Node): string | null => {
    if (stmt.type !== 'ExpressionStatement') return null
    const call = stmt['expression'] as Node
    if (!isCall(call) || calleeName(call) !== 'p') return null
    const a = call['arguments'] as Node[]
    if (a.length !== 2 || strValue(a[0]!) !== 'song') return null
    const arr = a[1]!
    if (!isCall(arr) || calleeName(arr) !== 'arrange') return null
    const order: string[] = []
    const lens = new Map<string, number>()
    for (const entry of arr['arguments'] as Node[]) {
      if (entry.type !== 'ArrayExpression') return null
      const [lenN, secN] = entry['elements'] as Node[]
      const len = lenN !== undefined ? numValue(lenN) : undefined
      if (len === undefined || secN === undefined || !isIdent(secN)) return null
      const ref = (secN['name'] as string)
      if (!ref.startsWith('__sec_')) return null
      const name = ref.slice('__sec_'.length)
      const sec = pendingSecs.get(name)
      if (sec === undefined) return null
      const prev = lens.get(name)
      if (prev !== undefined && prev !== len) return null // inconsistent lens
      lens.set(name, len)
      order.push(name)
    }
    // fill each section's placeholder with its block, in definition position
    for (const [name, sec] of pendingSecs) {
      const len = lens.get(name)
      if (len === undefined) return null // a section the song never uses → bail
      parts[sec.placeholder] = [`section ${name} ${num(len)}`, ...sec.plays].join('\n')
    }
    pendingSecs.clear()
    return `song ${order.join(' ')}`
  }
  for (const stmt of program['body'] as Node[]) {
    const r = secConst(stmt) ?? songArrange(stmt) ?? decompileSynth(stmt) ?? decompileSing(stmt) ?? decompilePlay(stmt) ?? decompileStaging(stmt)
    if (r !== null) {
      flushJs()
      if (r !== '') parts.push(r)
    } else {
      jsRun.push(slice(stmt))
    }
  }
  flushJs()
  // sections that never met their song line: restore the raw statements
  for (const sec of pendingSecs.values()) {
    parts[sec.placeholder] = ['js', ...sec.raw.split('\n').map((l) => (l.length > 0 ? `  ${l}` : ''))].join('\n')
  }
  return parts.filter((x) => x !== '').join('\n\n') + '\n'
}
