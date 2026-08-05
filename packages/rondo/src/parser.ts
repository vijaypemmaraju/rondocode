/* rondo parser — lines → AST.
 *
 * Top level is a sequence of `synth` / `play` / `cps` blocks (indentation
 * bodies). Inside a synth, each body line is either a `name = …` binding or a
 * spine line; spine lines are folded left-to-right into one expression as we
 * go (the pipe is linear), following the signal/CV rules we designed:
 *   - the FIRST spine line is the source (a full expression),
 *   - a line starting with an operator is infix on the running signal (`* env`),
 *   - a line starting with a filter builtin takes the running signal as its
 *     first argument (`ladder cutoff res:.85`).
 *
 * Expressions use precedence climbing (^ > * / > + -) where the primary is a
 * builtin call with space-separated arguments (`square note/2`, `adsr a d s r`). */

import type { Binding, Comb, CpsItem, TimeSigItem, CtrlValue, CurveDefItem, Expr, MacroItem, Mod, PlayBlock, Pos, Program, RondoError, SynthBlock, TopItem , SingBlock, ScValue } from './ast'
import { lex, type Line, type Tok } from './lexer'
import { BUILTINS, isTransform, isReservedBinding } from './builtins'
import type { BuiltinSpec } from './builtins'

const SIGNALS = new Set(['sine', 'cosine', 'saw', 'isaw', 'tri', 'square', 'saw2', 'tri2', 'square2', 'sine2', 'rand', 'perlin'])
const CTRL_METHODS = new Set(['gain', 'dur', 'pan'])
const NUM_RE = /^-?\d*\.?\d+$/

/** synth-header voice options: `synth acid mono glide:.08 unison:5 …`. */
const VOICE_FLAGS = new Set(['mono'])
const VOICE_OPTS = new Set(['glide', 'unison', 'detune', 'spread', 'curve', 'blend', 'octaves', 'humanize', 'voices'])

const PREC: Record<string, number> = { '+': 2, '-': 2, '*': 3, '/': 3, '^': 4 }

/** Rendered width of a token in source columns (approximate for js{ … }). */
function tokWidth(t: Tok): number {
  switch (t.k) {
    case 'num': return t.text.length
    case 'ident': return t.v.length
    case 'range': case 'arrow': return 2
    case 'jsexpr': return t.to - t.from + 4 // `js{` + inner + `}`
    default: return 1
  }
}

class Cursor {
  i = 0
  constructor(readonly toks: Tok[], readonly errors: RondoError[], readonly fallback?: Pos) {}
  peek(): Tok | undefined { return this.toks[this.i] }
  peek2(): Tok | undefined { return this.toks[this.i + 1] }
  next(): Tok | undefined { return this.toks[this.i++] }
  eof(): boolean { return this.i >= this.toks.length }
  /** Best position for "here": the next token, or just PAST the last token
   *  (where the missing thing was expected), or the line's start — never a
   *  phantom 0:0 that puts squiggles on the wrong line. */
  pos(): Pos {
    const t = this.peek()
    if (t !== undefined) return t.pos
    const last = this.toks[this.toks.length - 1]
    if (last !== undefined) return { line: last.pos.line, col: last.pos.col + tokWidth(last) }
    return this.fallback ?? { line: 0, col: 0 }
  }
  err(message: string, pos?: Pos): void {
    const p = pos ?? this.pos()
    this.errors.push({ message, line: p.line, col: p.col })
  }
  /** a `name:` named-argument boundary — stops expression parsing. */
  atNamedArg(): boolean {
    const a = this.peek(), b = this.peek2()
    return !!a && a.k === 'ident' && !!b && b.k === 'colon'
  }
}

/** What to say about tokens left over at the end of a line. A stray `)` is
 *  worth naming: "unexpected tokens" sends someone looking at the whole line
 *  when one character is wrong. */
function leftoverMsg(c: Cursor, fallback: string): string {
  return c.peek()?.k === 'rparen' ? 'unmatched `)`' : fallback
}

/* ---- expressions --------------------------------------------------------- */

function parseExpr(c: Cursor, minPrec: number): Expr {
  let left = parseApp(c)
  for (;;) {
    const t = c.peek()
    if (t && t.k === 'op' && PREC[t.v]! >= minPrec) {
      c.next()
      const right = parseExpr(c, PREC[t.v]! + (t.v === '^' ? 0 : 1)) // ^ right-assoc
      left = { t: 'bin', op: t.v, l: left, r: right, pos: t.pos }
      continue
    }
    // `x -> lo..hi` binds loosest of all: only at statement/binding level
    // (minPrec ≤ 1), never inside a space-application argument — so
    // `sine 2 -> 200..2000` maps the OSCILLATOR, not the literal 2.
    if (t && t.k === 'arrow' && minPrec <= 1) {
      c.next()
      const lo = parseExpr(c, 3)
      const rt = c.peek()
      if (!rt || rt.k !== 'range') { c.err('expected `..` in range map (`x -> lo..hi`)'); break }
      c.next()
      const hi = parseExpr(c, 3)
      left = { t: 'map', x: left, lo, hi, pos: t.pos }
      continue
    }
    break
  }
  return left
}

/** True if the next token can begin a space-separated argument. */
function canStartArg(c: Cursor): boolean {
  const t = c.peek()
  return !!t && t.sp && (t.k === 'num' || t.k === 'jsexpr' || t.k === 'lparen' || (t.k === 'ident' && !c.atNamedArg()))
}

/** Parse named args (`res:.85 mode:hp`). Enum-kind named values (per the
 *  builtin's spec) take a bare word as a quoted enum, not a binding ref. */
function parseNamed(c: Cursor, spec?: BuiltinSpec): Record<string, Expr> {
  const named: Record<string, Expr> = {}
  while (c.atNamedArg()) {
    const nameTok = c.next() as Tok & { v: string }
    c.next() // colon
    const vt = c.peek()
    if (spec?.named?.[nameTok.v] === 'enum' && vt && vt.k === 'ident') {
      c.next()
      named[nameTok.v] = { t: 'enum', name: vt.v, pos: vt.pos }
    } else {
      named[nameTok.v] = parseExpr(c, 2)
    }
  }
  return named
}

/** Parse a builtin's declared positionals (space-separated). Enum positionals
 *  take a bare word; sig positionals a tight expression. Stops early when the
 *  next token can't start an argument (optional trailing positionals). */
function parsePositionals(c: Cursor, spec: BuiltinSpec): Expr[] {
  const args: Expr[] = []
  for (const kind of spec.pos) {
    if (!canStartArg(c)) break
    const t = c.peek()!
    if (kind === 'enum') {
      if (t.k !== 'ident') break // a number here belongs to something else
      c.next()
      args.push({ t: 'enum', name: (t as Tok & { v: string }).v, pos: t.pos })
    } else {
      args.push(parseExpr(c, 2))
    }
  }
  return args
}

/** eq band groups: a type word starts a band, following numbers are its
 *  params in order (`hp 170` / `peak 300 -3 2` = freq gain q). Emitted flat
 *  with enum markers; codegen regroups them into band objects. */
/** EQ band types the `eq` line accepts. A DELIBERATE second copy of the
 *  engine's EQ_BAND_TYPES: this package models the DSL's surface as text
 *  (see builtins.ts) and does not depend on the engine, so importing it would
 *  couple the language to the audio implementation for five words. The copy is
 *  pinned instead — a test asserts these two sets are equal, so adding a band
 *  type engine-side fails loudly here rather than being silently rejected. */
export const EQ_BAND_TYPES: ReadonlySet<string> = new Set(['hp', 'lp', 'peak', 'lowshelf', 'highshelf'])
function parseEqBands(c: Cursor): Expr[] {
  const args: Expr[] = []
  while (canStartArg(c)) {
    const t = c.peek()!
    if (t.k === 'ident') {
      c.next()
      if (!EQ_BAND_TYPES.has(t.v)) { c.err(`unknown eq band type \`${t.v}\` (${[...EQ_BAND_TYPES].join(', ')})`, t.pos); continue }
      args.push({ t: 'enum', name: t.v, pos: t.pos })
    } else {
      if (args.length === 0) { c.err('eq bands start with a type word (`eq hp 170 highshelf 7000 4`)', t.pos); c.next(); continue }
      args.push(parseExpr(c, 5))
    }
  }
  return args
}

function parseApp(c: Cursor): Expr {
  const t = c.peek()
  if (!t) { c.err('unexpected end of line'); return { t: 'num', v: 0, pos: c.pos() } }
  // ( … ) groups arithmetic, and nothing else: the contents are a full
  // expression, so precedence and `->` inside a group work as written.
  if (t.k === 'lparen') {
    c.next()
    const inner = parseExpr(c, 0)
    const close = c.peek()
    if (!close || close.k !== 'rparen') {
      c.err('unclosed `(`', t.pos)
      return inner
    }
    c.next()
    return inner
  }
  if (t.k === 'rparen') {
    c.err('unmatched `)`', t.pos)
    c.next()
    return { t: 'num', v: 0, pos: t.pos }
  }
  if (t.k === 'jsexpr') { c.next(); return { t: 'js', code: t.v, pos: t.pos } }
  if (t.k === 'num') { c.next(); return { t: 'num', v: t.v, pos: t.pos } }
  if (t.k === 'ident') {
    const name = t.v
    if (name === 'adsr') {
      c.next()
      const args = [parseExpr(c, 5), parseExpr(c, 5), parseExpr(c, 5), parseExpr(c, 5)]
      return { t: 'call', name, args, named: {}, pos: t.pos }
    }
    if (name === 'knob') return parseKnob(c)
    if (name === 'switch') return parseSwitch(c)
    if (name === 'env') {
      // breakpoint envelope: variadic time/level pairs, then named args.
      // Bare `env` stays an ident — it's a reference to a binding named env.
      c.next()
      const args: Expr[] = []
      while (canStartArg(c)) {
        const arg = parseExpr(c, 5)
        // `LEVEL:CURVE` gives THIS segment its own shape. Only after a level
        // (odd slot); a colon after a time would be `time:` and means nothing.
        // Unambiguous because a number followed by a colon has no other
        // meaning in an expression — named args are `word:value`.
        const nx = c.peek()
        if (nx?.k === 'colon' && args.length % 2 === 1) {
          c.next()
          args.push({ t: 'curved', level: arg, curve: parseExpr(c, 5), pos: nx.pos })
          continue
        }
        args.push(arg)
      }
      const named = parseNamed(c, BUILTINS['env'])
      if (args.length === 0 && Object.keys(named).length === 0) return { t: 'ident', name, pos: t.pos }
      if (args.length === 0 || args.length % 2 !== 0) c.err('env takes time/level pairs, e.g. `env .005 1 .15 .4 release:.3`', t.pos)
      return { t: 'call', name, args, named, pos: t.pos }
    }
    const spec = BUILTINS[name]
    if (spec !== undefined) {
      c.next()
      const args: Expr[] = []
      // a proc/sigop in EXPRESSION position names its input explicitly
      // (`wet = reverb osc room:.9`); in a spine line the pipe is the input
      // (handled by foldSpine, which passes it as args[0]).
      if (spec.kind === 'proc' || spec.kind === 'sigop') {
        // no input following → this may be a REFERENCE to a same-named chain
        // binding, not a call; leave it as an ident and let codegen (which
        // knows the binding names) resolve or reject it.
        if (!canStartArg(c)) return { t: 'ident', name, pos: t.pos }
        args.push(parseExpr(c, 2))
      }
      args.push(...(name === 'eq' ? parseEqBands(c) : parsePositionals(c, spec)))
      // a builtin that declares NO named args consumes none — trailing
      // `key:value` pairs belong to an ENCLOSING call (`vocoder mic bands:24`
      // must give bands: to the vocoder, not the nested mic)
      const named = spec.named !== undefined && Object.keys(spec.named).length > 0 ? parseNamed(c, spec) : {}
      return { t: 'call', name, args, named, pos: t.pos }
    }
    // a plain reference: a binding name, or note / gate / velocity / input
    c.next()
    return { t: 'ident', name, pos: t.pos }
  }
  c.err(`unexpected ${t.k}`)
  c.next()
  return { t: 'num', v: 0, pos: t.pos }
}

/** `switch 1 9` — two literals, nothing else.
 *
 *  Both must be plain numbers rather than expressions: the widget writes the
 *  pair back into the source when you tap it, so a value the source cannot
 *  spell is a value the switch could never return to. */
function parseSwitch(c: Cursor): Expr {
  const kw = c.next()! // 'switch'
  const read = (which: string): number => {
    const t = c.peek()
    if (!t || t.k !== 'num') {
      c.err(`switch needs two numbers, e.g. \`fat = switch 1 9\` (missing the ${which})`)
      return 0
    }
    c.next()
    return t.v
  }
  const a = read('first value')
  const b = read('second value')
  if (a === b) c.err(`switch needs two DIFFERENT values (both are ${a})`)
  return { t: 'switch', a, b, pos: kw.pos }
}

function parseKnob(c: Cursor): Expr {
  const kw = c.next()! // 'knob'
  const def = parseExpr(c, 5)
  const loT = c.peek()
  if (!loT || loT.k !== 'num') { c.err('knob needs a range, e.g. `knob 800 80..8000 log`'); return { t: 'knob', def, lo: def, hi: def, pos: kw.pos } }
  const lo: Expr = { t: 'num', v: loT.v, pos: loT.pos }; c.next()
  const rg = c.peek()
  if (!rg || rg.k !== 'range') { c.err('expected `..` in knob range'); return { t: 'knob', def, lo, hi: lo, pos: kw.pos } }
  c.next()
  const hiT = c.peek()
  if (!hiT || hiT.k !== 'num') { c.err('expected a number after `..`'); return { t: 'knob', def, lo, hi: lo, pos: kw.pos } }
  const hi: Expr = { t: 'num', v: hiT.v, pos: hiT.pos }; c.next()
  let curve: string | undefined
  const cv = c.peek()
  if (cv && cv.k === 'ident') { curve = cv.v; c.next() }
  return { t: 'knob', def, lo, hi, curve, pos: kw.pos }
}

/* ---- blocks -------------------------------------------------------------- */

/** Steps a single `sum` may unroll to. */
const SUM_MAX_STEPS = 64

function bodyLines(lines: Line[], start: number, min = 0): { body: Line[]; next: number } {
  const body: Line[] = []
  let j = start
  while (j < lines.length && lines[j]!.indent > min) { body.push(lines[j]!); j++ }
  return { body, next: j }
}

/**
 * `sum k 1..16` — header and indented body into one Expr.
 *
 * The range is written with the same `..` the rest of the language uses, and
 * both ends must be plain integers: this unrolls at compile time, so a range
 * that is not known then is not a range this can take.
 */
function parseSum(header: Line, body: Line[], errors: RondoError[]): Expr | null {
  const at = { line: header.line, col: header.rawCol }
  const nameTok = header.toks[1]
  if (!nameTok || nameTok.k !== 'ident') {
    errors.push({ message: 'sum needs an index name and a range (`sum k 1..16`)', ...at })
    return null
  }
  const lo = header.toks[2]
  const dots = header.toks[3]
  const hi = header.toks[4]
  if (lo?.k !== 'num' || dots?.k !== 'range' || hi?.k !== 'num') {
    errors.push({ message: `sum needs a range after the index (\`sum ${nameTok.v} 1..16\`)`, ...at })
    return null
  }
  const loV = (lo as Tok & { v: number }).v
  const hiV = (hi as Tok & { v: number }).v
  if (!Number.isInteger(loV) || !Number.isInteger(hiV)) {
    errors.push({ message: 'sum range ends must be whole numbers — the body is repeated once per step', ...at })
    return null
  }
  if (hiV < loV) {
    errors.push({ message: `sum range runs backwards (\`${loV}..${hiV}\`)`, ...at })
    return null
  }
  // A guard, not a limit anyone will meet writing music: every step becomes
  // real DSP nodes, so a typo'd `1..1000` should say so rather than build a
  // graph that stalls the audio thread.
  if (hiV - loV + 1 > SUM_MAX_STEPS) {
    errors.push({ message: `sum of ${hiV - loV + 1} steps is more voices than this can build (max ${SUM_MAX_STEPS})`, ...at })
    return null
  }
  if (body.length === 0) {
    errors.push({ message: 'sum needs an indented body — the lines to repeat', ...at })
    return null
  }
  const folded = foldSpine(body, null, errors)
  if (folded.spine === null) {
    errors.push({ message: 'sum body has no audio line', ...at })
    return null
  }
  return {
    t: 'sum',
    index: nameTok.v,
    lo: loV,
    hi: hiV,
    bindings: folded.bindings,
    body: folded.spine,
    pos: header.toks[0]!.pos,
  }
}

/** Fold a run of body lines into one spine expression + a list of bindings.
 *  `initial` is null for a voice body (the first spine line is the source) or
 *  the `input` node for a post body (every line is a transform of input). */
function foldSpine(body: Line[], initial: Expr | null, errors: RondoError[]): { spine: Expr | null; bindings: Binding[] } {
  const bindings: Binding[] = []
  let spine = initial
  for (let li = 0; li < body.length; li++) {
    const ln = body[li]!
    const c = new Cursor(ln.toks, errors, { line: ln.line, col: ln.rawCol })
    const t0 = ln.toks[0]
    // `sum k 1..16` + an indented body: the body summed once per k. Parsed
    // here rather than as an expression because it OWNS the lines under it,
    // and only the line walker knows where they end. A following `=` means a
    // binding, which `sum` is reserved against — but reading the header first
    // would report the wrong error for it.
    if (t0 && t0.k === 'ident' && t0.v === 'sum' && ln.toks[1]?.k !== 'eq') {
      const sub = bodyLines(body, li + 1, ln.indent)
      const sumExpr = parseSum(ln, sub.body, errors)
      li = sub.next - 1
      if (sumExpr === null) continue
      if (spine === null) spine = sumExpr
      else spine = { t: 'bin', op: '+', l: spine, r: sumExpr, pos: t0.pos }
      continue
    }
    // binding: NAME = …
    if (ln.toks.length >= 2 && t0 && t0.k === 'ident' && ln.toks[1]!.k === 'eq') {
      const bname = t0.v
      c.next(); c.next()
      const rhs = parseExpr(c, 0)
      if (!c.eof()) c.err(leftoverMsg(c, 'unexpected tokens after binding'))
      if (bindings.some((b) => b.name === bname)) {
        c.err(`duplicate binding '${bname}' — each name can be defined once`, t0.pos)
        continue
      }
      if (isReservedBinding(bname)) {
        c.err(`binding '${bname}' shadows a builtin — pick another name`, t0.pos)
        continue
      }
      bindings.push({ name: bname, expr: rhs, pos: t0.pos })
      continue
    }
    if (spine === null) {
      spine = parseExpr(c, 0) // the source line
    } else if (t0 && t0.k === 'op') {
      const op = t0.v; c.next()
      spine = { t: 'bin', op, l: spine, r: parseExpr(c, 0), pos: t0.pos }
    } else if (t0 && t0.k === 'ident' && isTransform(t0.v)) {
      // a processor/sig-op line: the running signal is the implicit input
      const name = t0.v; c.next()
      const spec = BUILTINS[name]!
      const args: Expr[] = [spine, ...(name === 'eq' ? parseEqBands(c) : parsePositionals(c, spec))]
      const named = parseNamed(c, spec)
      spine = { t: 'call', name, args, named, pos: t0.pos }
    } else {
      c.err('expected a transform — an operator (`* env`), a filter/effect (`ladder …`, `delay …`), or a sig op (`tanh`).')
      continue
    }
    if (!c.eof()) c.err(leftoverMsg(c, 'unexpected tokens at end of line'))
  }
  return { spine, bindings }
}

function parseSynth(lines: Line[], i: number, errors: RondoError[]): { block: SynthBlock; next: number } {
  const header = lines[i]!
  const nameTok = header.toks[1]
  const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
  if (!name) errors.push({ message: 'synth needs a name (`synth lead`)', line: header.line, col: header.rawCol })
  // header voice options: `synth acid mono glide:.08 unison:5 detune:12 …`
  let voiceOpts: Record<string, number | boolean> | undefined
  for (let k = 2; k < header.toks.length; k++) {
    const t = header.toks[k]!
    if (t.k === 'ident' && VOICE_FLAGS.has(t.v)) {
      ;(voiceOpts ??= {})[t.v] = true
      continue
    }
    if (t.k === 'ident' && VOICE_OPTS.has(t.v) && header.toks[k + 1]?.k === 'colon' && header.toks[k + 2]?.k === 'num') {
      ;(voiceOpts ??= {})[t.v] = (header.toks[k + 2] as Tok & { v: number }).v
      k += 2
      continue
    }
    errors.push({ message: `unknown synth option \`${t.k === 'ident' ? t.v : t.k}\` (mono, glide:, unison:, detune:, spread:, curve:, blend:, octaves:, humanize:, voices:)`, line: t.pos.line, col: t.pos.col })
    break
  }
  const { body, next } = bodyLines(lines, i + 1)

  // split off a trailing `post` sub-block (a lone `post` line + deeper-indented body)
  let voiceBody = body
  let postBody: Line[] | null = null
  const pIdx = body.findIndex((ln) => ln.toks.length === 1 && ln.toks[0]!.k === 'ident' && ln.toks[0]!.v === 'post')
  if (pIdx >= 0) {
    const postIndent = body[pIdx]!.indent
    const rest = body.slice(pIdx + 1)
    postBody = rest.filter((ln) => ln.indent > postIndent)
    if (rest.length !== postBody.length) errors.push({ message: 'post must be the last section of a synth', line: body[pIdx]!.line, col: body[pIdx]!.rawCol })
    voiceBody = body.slice(0, pIdx)
  }

  const voice = foldSpine(voiceBody, null, errors)
  let spine = voice.spine
  if (spine === null) {
    errors.push({ message: `synth '${name}' has no audio output`, line: header.line, col: header.rawCol })
    spine = { t: 'num', v: 0, pos: header.toks[0]!.pos }
  }

  const block: SynthBlock = { t: 'synth', name, bindings: voice.bindings, spine, pos: header.toks[0]!.pos }
  if (voiceOpts !== undefined) block.voiceOpts = voiceOpts
  if (postBody && postBody.length > 0) {
    const input: Expr = { t: 'ident', name: 'input', pos: header.toks[0]!.pos }
    const post = foldSpine(postBody, input, errors)
    block.post = post.spine ?? input
    block.postBindings = post.bindings
  }
  return { block, next }
}

/** Function-taking pattern combinators usable as `NAME [pre…]: <comb>` lines.
 *  `pre` = leading numeric args before the colon; `js` = the JS method name. */
export const FN_COMBS: Record<string, { pre: number; js: string }> = {
  every: { pre: 1, js: 'every' },
  off: { pre: 1, js: 'off' },
  chunk: { pre: 1, js: 'chunk' },
  sometimesby: { pre: 1, js: 'sometimesBy' },
  juxby: { pre: 1, js: 'juxBy' },
  sometimes: { pre: 0, js: 'sometimes' },
  often: { pre: 0, js: 'often' },
  rarely: { pre: 0, js: 'rarely' },
  always: { pre: 0, js: 'always' },
  superimpose: { pre: 0, js: 'superimpose' },
  jux: { pre: 0, js: 'jux' },
}

/** A breakpoint number in a `curve` ctrl value: a plain number, or a level
 *  carrying its own curve (`1:3`). Deliberately NOT matching `slow:4` — a
 *  named suffix starts with a letter — so the pair run stops where it should. */
const CURVE_NUM = /^-?\d*\.?\d+(?::-?\d*\.?\d+)?$/

/** Parse a modifier value: number | signal (`sine 200..2400 slow:4`,
 *  `rise 8 0..1`, `curve 8 1 8 .2`, `shape swell 16`) | mini. */
function parseCtrlValue(raw: string): CtrlValue {
  const s = raw.trim()
  const toks = s.split(/\s+/)
  if (toks.length === 1 && NUM_RE.test(toks[0]!)) return { kind: 'num', v: Number(toks[0]) }
  // `rise 8` / `fall 4` — arrange ramps as ctrl values (cycles arg optional)
  let sig: string | undefined
  let rest = toks.slice(1)
  if (SIGNALS.has(toks[0]!)) {
    sig = toks[0]!
  } else if ((toks[0] === 'rise' || toks[0] === 'fall')) {
    if (rest[0] !== undefined && NUM_RE.test(rest[0])) { sig = `${toks[0]}(${rest[0]})`; rest = rest.slice(1) }
    else sig = `${toks[0]}()`
  } else if (toks[0] === 'curve') {
    // `cutoff: curve 8 1 8 .2 300..6000` — a breakpoint automation lane in
    // CYCLES. Pairs are eaten until a token that is not a plain number, so the
    // range/slow/fast suffixes below still land.
    const pairs: string[] = []
    const buf: string[] = []
    while (rest[0] !== undefined && CURVE_NUM.test(rest[0])) { buf.push(rest[0]); rest = rest.slice(1) }
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const lv = /^(-?\d*\.?\d+):(-?\d*\.?\d+)$/.exec(buf[i + 1]!)
      pairs.push(lv !== null
        ? `[${Number(buf[i])}, ${Number(lv[1])}, ${Number(lv[2])}]`
        : `[${Number(buf[i])}, ${Number(buf[i + 1])}]`)
    }
    // an odd count is half a breakpoint — leave sig unset so it falls through
    // to a mini value and the usual "that is not a number" diagnostic
    if (pairs.length > 0 && buf.length % 2 === 0) sig = `curve([${pairs.join(', ')}])`
  } else if (toks[0] === 'shape') {
    // `cutoff: shape swell 16 300..6000` — a NAMED shape scaled to 16 cycles
    if (rest[0] !== undefined && /^[a-zA-Z_]\w*$/.test(rest[0]) && rest[1] !== undefined && NUM_RE.test(rest[1])) {
      sig = `curve(shape('${rest[0]}', ${Number(rest[1])}))`
      rest = rest.slice(2)
    }
  }
  if (sig !== undefined) {
    const v: CtrlValue = { kind: 'sig', sig }
    for (const t of rest) {
      const rg = /^(-?\d*\.?\d+)\.\.(-?\d*\.?\d+)$/.exec(t)
      if (rg) { v.lo = Number(rg[1]); v.hi = Number(rg[2]); continue }
      const sl = /^slow:(-?\d*\.?\d+)$/.exec(t)
      if (sl) { v.slow = Number(sl[1]); continue }
      const fa = /^fast:(-?\d*\.?\d+)$/.exec(t)
      if (fa) { v.fast = Number(fa[1]); continue }
    }
    return v
  }
  return { kind: 'mini', text: s }
}

function parseMod(ln: Line, errors: RondoError[]): Mod | null {
  const raw = ln.raw.trim()
  const pos: Pos = { line: ln.line, col: ln.rawCol }
  // function-taking combinators: `every 4: rev`, `jux: rev`, `off .25: gain .3`
  const fc = /^([a-zA-Z_]\w*)((?:\s+-?\d*\.?\d+)*)\s*:\s*(.+)$/.exec(raw)
  if (fc) {
    const spec = FN_COMBS[fc[1]!.toLowerCase()]
    if (spec !== undefined) {
      const pre = (fc[2] ?? '').trim().split(/\s+/).filter(Boolean).map(Number)
      if (pre.length !== spec.pre) {
        errors.push({ message: `\`${fc[1]}\` takes ${spec.pre} argument(s) before the colon`, line: ln.line, col: ln.rawCol })
        return null
      }
      return { kind: 'fncomb', name: spec.js, pre, comb: parseComb(fc[3]!), pos }
    }
  }
  // NAME: value  (dedicated method for gain/dur/pan, else a .ctrl)
  const kv = /^([a-zA-Z_]\w*)\s*:\s*(.+)$/.exec(raw)
  if (kv) {
    const name = kv[1]!
    const value = parseCtrlValue(kv[2]!)
    if (CTRL_METHODS.has(name)) return { kind: 'method', name: name as 'gain', value, pos }
    return { kind: 'ctrl', name, value, pos }
  }
  // bare combinator: rev | fast 2 | struct ~ t ~ t | euclid 3 8
  if (/^[a-zA-Z_]\w*/.test(raw)) return { kind: 'comb', comb: parseComb(raw), pos }
  errors.push({ message: `can't parse modifier \`${raw}\``, line: ln.line, col: ln.rawCol })
  return null
}

function parseComb(raw: string): Comb {
  const s = raw.trim()
  const sp = s.indexOf(' ')
  const name = sp < 0 ? s : s.slice(0, sp)
  const rest = sp < 0 ? '' : s.slice(sp + 1).trim()
  // struct takes the rest as a single mini string; others take numeric args
  if (name === 'struct') return { name, args: rest ? [rest] : [] }
  return { name, args: rest ? rest.split(/\s+/) : [] }
}

/** Combinator words that mark a play-body line as a MODIFIER rather than
 *  another stacked notation line. */
const COMB_WORDS = new Set([
  'rev', 'fast', 'slow', 'struct', 'euclid', 'euclidinv', 'euclidInv', 'arp', 'ply', 'iter', 'iterBack',
  'palindrome', 'degrade', 'degradeby', 'degradeBy', 'undegradeBy', 'segment', 'chunk', 'swing', 'swingBy',
  'linger', 'roll', 'echo', 'ping', 'add', 'sub', 'mul', 'div', 'invert', 'octave', 'voicing', 'voiceLead',
  'onsetsOnly', 'early', 'late', 'jux',
])

/** Is this play-body line a modifier (`name: value`, `every 4: rev`, bare
 *  combinator) as opposed to another stacked notation voice? */
export function isModifierLine(ln: Line, kind: 'play' | 'beat' = 'play'): boolean {
  const nv = /^([a-zA-Z_]\w*)[ \t]*:/.exec(ln.raw)
  if (nv !== null) {
    // BEAT ambiguity: `kick:.6 ~ kick ~` is a velocity ROW whose first step
    // carries an accent, not a `kick:` modifier. An IMMEDIATE `:digit` on a
    // word that isn't a known modifier head reads as velocity — modifiers
    // are written with a space (`gain: .8`), velocity suffixes never are.
    if (
      kind === 'beat' &&
      /^[a-zA-Z_]\w*:[.\d]/.test(ln.raw) &&
      !COMB_WORDS.has(nv[1]!) &&
      nv[1] !== 'gain' && nv[1] !== 'dur' && nv[1] !== 'scale'
    ) {
      return false
    }
    return true
  }
  const first = /^([a-zA-Z_]\w*)/.exec(ln.raw)?.[1]
  if (first === undefined) return false
  // fn-combinators (`every 4: rev`, `off .25: gain .3`) — the colon comes
  // after the pre-args, so the name:value regex above misses them
  if (FN_COMBS[first.toLowerCase()] !== undefined && ln.raw.includes(':')) return true
  return COMB_WORDS.has(first)
}

/** Extract notation text (before an inline `scale:`) from a body line.
 *  The name char class includes uppercase + underscore so long mode names
 *  (`minorPentatonic`) and `scaledef` names round-trip whole. */
function notationOf(ln: Line, errors: RondoError[]): { notation: string; from: number; scale?: string; synth?: string } {
  // `synth:NAME` is a per-LINE route, the same shape as the header's. Layers
  // otherwise share the block's synth, which is right for a hand-built chord
  // and wrong for a drum pattern where each layer is a different instrument.
  const sy = /[ \t]synth:([a-zA-Z_]\w*)[ \t]*$/.exec(ln.raw)
  const withoutSynth = sy ? ln.raw.slice(0, sy.index) : ln.raw
  const m = /\bscale:([a-gA-G][a-zA-Z0-9#_-]*)/.exec(withoutSynth)
  const raw = m ? withoutSynth.slice(0, m.index) : withoutSynth
  const notation = raw.replace(/\s+$/, '')
  // near-miss like `scale:minor` (no a–g root) doesn't match the extractor —
  // error rather than silently shipping "scale:minor" inside the notation
  if (/\bscale:/.test(notation)) {
    errors.push({ message: 'bad scale — write it like `scale:a-min` (root + mode)', line: ln.line, col: ln.rawCol })
  }
  return { notation, from: ln.offset, scale: m?.[1], synth: sy?.[1] }
}

/**
 * How many notation groups a line leaves OPEN: `<` `[` `{` minus their closers.
 *
 * Only structural characters count. `(` is euclid (`rim(7,16)`) and never
 * spans lines, and a `#` inside a note name has already gone.
 */
function openDepth(text: string): number {
  let d = 0
  for (const c of text) {
    if (c === '<' || c === '[' || c === '{') d++
    else if (c === '>' || c === ']' || c === '}') d--
  }
  return d
}

/**
 * Join notation lines that are still INSIDE a group onto the line that opened
 * it, so a long pattern can be broken across lines.
 *
 * The rule is "you haven't closed your bracket yet", which needs nothing new
 * to learn and — the reason it is safe — can only change programs that do not
 * work today. Two notation lines already mean two STACKED voices, so joining
 * by adjacency or indentation would silently re-read working code; an
 * unbalanced line is an eval error (`unclosed '<'`), so giving it a meaning
 * takes nothing away.
 *
 * The join uses the EXACT gap between the two lines, filled with spaces, so
 * every character of the merged notation sits at the offset it occupies in the
 * document. That is what keeps note-play flash lighting the right characters
 * on a continuation line, and mini-notation reads a run of spaces the same as
 * the newline it replaced.
 */
function joinOpenLines(body: Line[], errors: RondoError[]): Line[] {
  const out: Line[] = []
  for (let i = 0; i < body.length; i++) {
    let ln = body[i]!
    if (openDepth(ln.raw) <= 0) {
      out.push(ln)
      continue
    }
    const startedAt = ln
    let depth = openDepth(ln.raw)
    let raw = ln.raw
    while (depth > 0 && i + 1 < body.length) {
      const nxt = body[++i]!
      const gap = Math.max(1, nxt.offset - (ln.offset + raw.length))
      raw += ' '.repeat(gap) + nxt.raw
      depth += openDepth(nxt.raw)
      ln = startedAt
    }
    if (depth > 0) {
      errors.push({
        message: 'notation leaves a group open — add the closing `>`, `]` or `}` (a pattern may run across lines while it is open)',
        line: startedAt.line,
        col: startedAt.rawCol,
      })
    }
    out.push({ ...startedAt, raw })
  }
  return out
}

/** `irand N [seg:M]` as a notation line — random scale degrees. */
const IRAND_RE = /^irand[ \t]+(\d+)(?:[ \t]+seg:(\d+))?$/

function parsePlay(lines: Line[], i: number, errors: RondoError[], kind: 'play' | 'beat' = 'play'): { block: PlayBlock; next: number } {
  const header = lines[i]!
  const nameTok = header.toks[1]
  // a beat block's name is optional (it's a channel name, not a synth route)
  const name = nameTok && nameTok.k === 'ident' ? nameTok.v : kind === 'beat' ? 'beat' : ''
  if (!name) errors.push({ message: 'play needs a synth name (`play lead`)', line: header.line, col: header.rawCol })
  // `play pad synth:keys` — the channel is `pad`, the notes route to `keys`
  // (two patterns can drive one synth on separate channels)
  let synthName: string | undefined
  for (let k = 2; k < header.toks.length; k++) {
    const t = header.toks[k]!
    if (kind === 'play' && t.k === 'ident' && t.v === 'synth' && header.toks[k + 1]?.k === 'colon' && header.toks[k + 2]?.k === 'ident') {
      synthName = (header.toks[k + 2] as Tok & { v: string }).v
      k += 2
      continue
    }
    errors.push({ message: kind === 'play' ? 'unknown play option (only `synth:NAME`)' : 'unknown beat option', line: t.pos.line, col: t.pos.col })
    break
  }
  // body = lines deeper than the header, so a play nests inside a section too
  const { body, next } = bodyLines(lines, i + 1, header.indent)
  if (body.length === 0) errors.push({ message: `play '${name}' has no notation`, line: header.line, col: header.rawCol })
  // Leading non-modifier lines are notation VOICES (2+ → a stacked chord of
  // lines, like the JS stack(n(…), n(…)) idiom); the rest are modifiers.
  // Notation keeps its internal spacing so char ranges line up with the buffer
  // 1:1 — that's what lets note-play flash highlight the source.
  const noteLines: Line[] = []
  const modLines: Line[] = []
  for (const ln of joinOpenLines(body, errors)) {
    if (modLines.length === 0 && !isModifierLine(ln, kind)) noteLines.push(ln)
    else modLines.push(ln)
  }
  let notation = ''
  let notationFrom = body[0]?.offset ?? 0
  let scale: string | undefined
  let scalePos: Pos | undefined
  let voices: { notation: string; notationFrom: number; synthName?: string }[] | undefined
  let lineSynth: string | undefined
  const noteInfos: { text: string; pos: Pos }[] = []
  for (let v = 0; v < noteLines.length; v++) {
    const ln = noteLines[v]!
    const parsed = notationOf(ln, errors)
    if (parsed.scale !== undefined) { scale = parsed.scale; scalePos = { line: ln.line, col: ln.rawCol } }
    if (parsed.synth !== undefined && kind === 'beat') {
      errors.push({ message: "a beat block's words are already synth names — `synth:` doesn't apply", line: ln.line, col: ln.rawCol })
    }
    noteInfos.push({ text: parsed.notation, pos: { line: ln.line, col: ln.rawCol } })
    if (v === 0) {
      notation = parsed.notation
      notationFrom = parsed.from
      lineSynth = parsed.synth
    } else {
      ;(voices ??= []).push({
        notation: parsed.notation,
        notationFrom: parsed.from,
        ...(parsed.synth !== undefined ? { synthName: parsed.synth } : {}),
      })
    }
  }
  const mods: Mod[] = []
  for (const ln of modLines) {
    // `scale: a-min` as a modifier line (the stacked-voices form needs it
    // somewhere other than inline)
    const sm = /^scale[ \t]*:[ \t]*([a-gA-G][a-zA-Z0-9#_-]*)[ \t]*$/.exec(ln.raw)
    if (sm) { scale = sm[1]; scalePos = { line: ln.line, col: ln.rawCol }; continue }
    const mod = parseMod(ln, errors)
    if (mod) mods.push(mod)
  }
  // validate `irand …` notation lines here so errors carry positions
  for (const nl of noteInfos) {
    if (!/^irand\b/.test(nl.text)) continue
    if (kind === 'beat') errors.push({ message: 'irand makes scale degrees — it belongs in a `play` block, not `beat`', line: nl.pos.line, col: nl.pos.col })
    else if (!IRAND_RE.test(nl.text)) errors.push({ message: 'irand notation is `irand N [seg:M]` (N random degrees, M steps per cycle)', line: nl.pos.line, col: nl.pos.col })
  }
  if (kind === 'beat' && scale !== undefined) {
    const p = scalePos ?? { line: header.line, col: header.rawCol }
    errors.push({ message: "a beat block's words are synth names — `scale:` doesn't apply", line: p.line, col: p.col })
  }
  const block: PlayBlock = { t: 'play', name, notation, notationFrom, scale, mods, pos: header.toks[0]!.pos }
  if (kind === 'beat') block.entry = 'sound'
  // a `synth:` on the FIRST notation line is the same thing the header says,
  // so it settles into synthName rather than needing a second place to look
  if (synthName !== undefined) block.synthName = synthName
  else if (lineSynth !== undefined) block.synthName = lineSynth
  if (voices !== undefined) block.voices = voices
  return { block, next }
}

/** `sing NAME [voice:WORD]` — body: alternating LYRIC / MELODY line pairs
 *  (lyric above its notes, sheet-music style), then modifier lines, then an
 *  optional trailing `post` FX sub-block (same shape as a synth's). */
function parseSing(lines: Line[], i: number, errors: RondoError[]): { block: SingBlock; next: number } {
  const header = lines[i]!
  const nameTok = header.toks[1]
  const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
  if (!name) errors.push({ message: 'sing needs a channel name (`sing vox`)', line: header.line, col: header.rawCol })
  let voice: string | undefined
  for (let k = 2; k < header.toks.length; k++) {
    const t = header.toks[k]!
    if (t.k === 'ident' && t.v === 'voice' && header.toks[k + 1]?.k === 'colon' && header.toks[k + 2]?.k === 'ident') {
      voice = (header.toks[k + 2] as Tok & { v: string }).v
      k += 2
      continue
    }
    errors.push({ message: 'unknown sing option (only `voice:NAME`)', line: t.pos.line, col: t.pos.col })
    break
  }
  const { body: fullBody, next } = bodyLines(lines, i + 1, header.indent)
  // split off a trailing `post` sub-block, exactly like a synth's
  let body = fullBody
  let postBody: Line[] | null = null
  const pIdx = fullBody.findIndex((ln) => ln.toks.length === 1 && ln.toks[0]!.k === 'ident' && ln.toks[0]!.v === 'post')
  if (pIdx >= 0) {
    const postIndent = fullBody[pIdx]!.indent
    const rest = fullBody.slice(pIdx + 1)
    postBody = rest.filter((ln) => ln.indent > postIndent)
    if (rest.length !== postBody.length) errors.push({ message: 'post must be the last section of a sing block', line: fullBody[pIdx]!.line, col: fullBody[pIdx]!.rawCol })
    body = fullBody.slice(0, pIdx)
  }
  // leading non-modifier lines are the lyric/melody pairs; the rest modify
  const pairLines: Line[] = []
  const modLines: Line[] = []
  for (const ln of body) {
    if (modLines.length === 0 && !isModifierLine(ln)) pairLines.push(ln)
    else modLines.push(ln)
  }
  if (pairLines.length === 0) {
    errors.push({ message: 'sing needs lyric/melody line pairs (lyrics above, notes below)', line: header.line, col: header.rawCol })
  } else if (pairLines.length % 2 !== 0) {
    errors.push({ message: 'sing lines come in pairs — each LYRIC line needs a MELODY line under it', line: pairLines[pairLines.length - 1]!.line, col: pairLines[pairLines.length - 1]!.rawCol })
  }
  const lyrics: { text: string; from: number }[] = []
  const notes: { text: string; from: number }[] = []
  for (let k = 0; k < pairLines.length; k++) {
    const ln = pairLines[k]!
    ;(k % 2 === 0 ? lyrics : notes).push({ text: ln.raw, from: ln.offset })
  }
  const mods: Mod[] = []
  for (const ln of modLines) {
    if (/^scale[ \t]*:/.test(ln.raw)) {
      errors.push({ message: "sing melodies use absolute note names — `scale:` doesn't apply", line: ln.line, col: ln.rawCol })
      continue
    }
    const mod = parseMod(ln, errors)
    if (mod) mods.push(mod)
  }
  const block: SingBlock = { t: 'sing', name, lyrics, notes, mods, pos: header.toks[0]!.pos }
  if (voice !== undefined) block.voice = voice
  if (postBody && postBody.length > 0) {
    const input: Expr = { t: 'ident', name: 'input', pos: header.toks[0]!.pos }
    const post = foldSpine(postBody, input, errors)
    block.post = post.spine ?? input
    block.postBindings = post.bindings
  }
  return { block, next }
}

/** `cps .6` and `bpm 128` are one statement in two units: same line shape, the
 *  unit rides along on the item (see CpsItem). */
function parseCps(lines: Line[], i: number, errors: RondoError[], unit: 'cps' | 'bpm'): { block: CpsItem; next: number } {
  const header = lines[i]!
  const v = header.toks[1]
  const example = unit === 'bpm' ? '`bpm 128`' : '`cps .6`'
  if (!v || v.k !== 'num') errors.push({ message: `${unit} needs a number (${example})`, line: header.line, col: header.rawCol })
  const fallback = unit === 'bpm' ? 120 : 0.5
  return { block: { t: 'cps', value: v && v.k === 'num' ? v.v : fallback, unit, pos: header.toks[0]!.pos }, next: i + 1 }
}

/** EVERY keyword the top-level dispatch below accepts, in the order the
 *  grammar introduces them. The editor needs this list to offer blocks in
 *  completion and to colour them, and it kept its own copies: the completion
 *  list was missing `curvedef` and `switch`, so two real blocks were never
 *  suggested. The dispatch, this list and the "unknown block" message are now
 *  one thing.
 *
 *  BODY-level words (`post`, `send`) are NOT here: they open nothing at the
 *  top level. See words.ts, which adds them for highlighting. */
export const BLOCK_KEYWORDS: readonly string[] = [
  'synth', 'play', 'beat', 'sing', 'section', 'song', 'cps', 'bpm', 'timesig', 'level',
  'bus', 'sidechain', 'master', 'macro', 'switch', 'curvedef', 'scaledef',
  'wavedef', 'visual', 'js',
]

/** The top-level items that are ONE LINE rather than a block with an indented
 *  body. The formatter needs exactly this set to know a line belongs at column
 *  0 (see format.ts), and it lived there as a second copy until `timesig` was
 *  added to one list and not the other — so it lives HERE, next to the dispatch
 *  that defines it, and the formatter imports it. */
export const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  'cps', 'bpm', 'timesig', 'level', 'song', 'sidechain', 'master', 'macro', 'scaledef', 'wavedef',
])

/** `timesig 3 4` — beats per bar, then the beat unit. The unit must be a power
 *  of two, because that is what a time signature can express and what the MIDI
 *  meta event can store: 7/8 and 5/4 are ordinary, 4/6 is not a thing. */
function parseTimeSig(lines: Line[], i: number, errors: RondoError[]): { block: TimeSigItem; next: number } {
  const header = lines[i]!
  const a = header.toks[1]
  const b = header.toks[2]
  const bad = (message: string): void => { errors.push({ message, line: header.line, col: header.rawCol }) }
  if (!a || a.k !== 'num' || !b || b.k !== 'num') {
    bad('timesig needs two numbers: beats per bar, then the beat unit (`timesig 3 4`)')
  }
  const num = a && a.k === 'num' ? a.v : 4
  const den = b && b.k === 'num' ? b.v : 4
  if (!Number.isInteger(num) || num < 1 || num > 64) {
    bad(`beats per bar must be a whole number in 1..64, got ${num}`)
  }
  if (!Number.isInteger(den) || den < 1 || den > 64 || (den & (den - 1)) !== 0) {
    bad(`the beat unit must be a power of two in 1..64 (2, 4, 8, 16…), got ${den}`)
  }
  const ok = Number.isInteger(num) && num >= 1 && num <= 64 &&
    Number.isInteger(den) && den >= 1 && den <= 64 && (den & (den - 1)) === 0
  return {
    block: { t: 'timesig', num: ok ? num : 4, den: ok ? den : 4, pos: header.toks[0]!.pos },
    next: i + 1,
  }
}

export function parse(src: string): { program: Program; errors: RondoError[]; jsRegions: { from: number; to: number }[] } {
  const { lines, errors, jsRegions } = lex(src)
  const items: TopItem[] = []
  let i = 0
  while (i < lines.length) {
    const ln = lines[i]!
    if (ln.indent !== 0) { errors.push({ message: 'unexpected indentation', line: ln.line, col: 1 }); i++; continue }
    const head = ln.toks[0]
    // escape hatch, one-liner: `js{ … }` alone on a top-level line → raw statement
    if (head && head.k === 'jsexpr') { items.push({ t: 'raw', code: head.v, pos: head.pos }); i++; continue }
    if (!head || head.k !== 'ident') { errors.push({ message: 'expected `synth`, `play`, `cps`/`bpm`/`timesig`, or `js`', line: ln.line, col: ln.rawCol }); i++; continue }
    if (head.v === 'synth') { const r = parseSynth(lines, i, errors); items.push(r.block); i = r.next }
    else if (head.v === 'play') { const r = parsePlay(lines, i, errors); items.push(r.block); i = r.next }
    // `beat [NAME]` — notation words are SYNTH NAMES (the JS s('kick hat'))
    else if (head.v === 'beat') { const r = parsePlay(lines, i, errors, 'beat'); items.push(r.block); i = r.next }
    else if (head.v === 'cps') { const r = parseCps(lines, i, errors, 'cps'); items.push(r.block); i = r.next }
    // `bpm 128` — the same tempo line in the unit every producer thinks in
    // (one cycle is one bar of 4/4, so 128 bpm is 0.5333 cps)
    else if (head.v === 'bpm') { const r = parseCps(lines, i, errors, 'bpm'); items.push(r.block); i = r.next }
    // `timesig 3 4` — a cycle is a bar, and this is how long a bar is. It
    // scales `bpm` wherever the two lines sit relative to each other.
    else if (head.v === 'timesig') { const r = parseTimeSig(lines, i, errors); items.push(r.block); i = r.next }
    // `sing NAME [voice:WORD]` — a neural vocal block
    else if (head.v === 'sing') { const r = parseSing(lines, i, errors); items.push(r.block); i = r.next }
    // `sidechain kick depth:.7 release:.09 lead:.5 …` — extra named args are
    // per-channel duck amounts
    else if (head.v === 'sidechain') {
      const srcTok = ln.toks[1]
      const source = srcTok && srcTok.k === 'ident' ? srcTok.v : ''
      if (!source) errors.push({ message: 'sidechain needs a source synth (`sidechain kick …`)', line: ln.line, col: ln.rawCol })
      const item: TopItem = { t: 'sidechain', source, duck: {}, pos: head.pos }
      for (let k = 2; k + 2 < ln.toks.length + 1; k += 3) {
        const nameT = ln.toks[k], colonT = ln.toks[k + 1], valT = ln.toks[k + 2]
        if (!nameT || nameT.k !== 'ident' || colonT?.k !== 'colon' || (valT?.k !== 'num' && valT?.k !== 'ident')) {
          if (nameT) errors.push({ message: 'sidechain args are `name:number` pairs, or `name:macro` to follow a project control (depth: / release: / <synth>:duck)', line: nameT.pos.line, col: nameT.pos.col })
          break
        }
        // a bare word here is a macro or switch NAME: the pump follows it, and
        // updates on the eval that a knob move or a switch tap triggers
        const v: ScValue = valT.k === 'num' ? (valT as Tok & { v: number }).v : { macro: valT.v }
        if (nameT.v === 'depth') item.depth = v
        else if (nameT.v === 'release') item.release = v
        else item.duck[nameT.v] = v
      }
      items.push(item)
      i++
    }
    // `macro bright 1480 500..7300 log` → macro('bright', 1480, {…}):
    // a project-wide control. Same shape as a `knob` binding, except it lives
    // at the top level and is referenced BARE from any synth or post chain.
    // `switch NAME A B` — a project-wide switch. Same registry as `macro`,
    // because it IS a macro: one control, every destination that names it.
    else if (head.v === 'switch') {
      const nameTok = ln.toks[1]
      const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
      const aTok = ln.toks[2]
      const bTok = ln.toks[3]
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        errors.push({ message: 'switch needs a name (`switch fat 1 9`)', line: ln.line, col: ln.rawCol })
      }
      if (!aTok || aTok.k !== 'num' || !bTok || bTok.k !== 'num') {
        errors.push({ message: 'switch needs two numbers (`switch fat 1 9`)', line: ln.line, col: ln.rawCol })
        items.push({ t: 'macro', name, def: 0, values: [0, 1], pos: head.pos })
        i++
        continue
      }
      if (aTok.v === bTok.v) {
        errors.push({ message: `switch needs two DIFFERENT values (both are ${aTok.v})`, line: ln.line, col: ln.rawCol })
      }
      if (ln.toks.length > 4) {
        errors.push({ message: 'switch takes exactly two values — a switch has no range or curve', line: ln.toks[4]!.pos.line, col: ln.toks[4]!.pos.col })
      }
      items.push({ t: 'macro', name, def: aTok.v, values: [aTok.v, bTok.v], pos: head.pos })
      i++
    }
    else if (head.v === 'macro') {
      const nameTok = ln.toks[1]
      const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        errors.push({ message: 'macro needs a name (`macro bright 1480 500..7300 log`)', line: ln.line, col: ln.rawCol })
      }
      const defTok = ln.toks[2]
      if (!defTok || defTok.k !== 'num') {
        errors.push({ message: 'macro needs a default value (`macro bright 1480 500..7300 log`)', line: ln.line, col: ln.rawCol })
        items.push({ t: 'macro', name, def: 0, pos: head.pos })
        i++
        continue
      }
      const item: MacroItem = { t: 'macro', name, def: defTok.v, pos: head.pos }
      // the range is optional — without it the engine's param bounds apply
      let k = 3
      if (ln.toks[k]?.k === 'num' && ln.toks[k + 1]?.k === 'range') {
        item.lo = (ln.toks[k] as Tok & { v: number }).v
        const hiT = ln.toks[k + 2]
        if (!hiT || hiT.k !== 'num') {
          errors.push({ message: 'expected a number after `..`', line: ln.toks[k + 1]!.pos.line, col: ln.toks[k + 1]!.pos.col })
        } else {
          item.hi = hiT.v
          k += 3
        }
      }
      const cv = ln.toks[k]
      if (cv !== undefined && cv.k === 'ident') { item.curve = cv.v; k++ }
      if (ln.toks[k] !== undefined) {
        errors.push({ message: 'macro takes a name, a default, an optional `lo..hi` range and an optional curve', line: ln.toks[k]!.pos.line, col: ln.toks[k]!.pos.col })
      }
      items.push(item)
      i++
    }
    // `curvedef swell .25 1 .75 .2` → curvedef('swell', [[…]]): a named shape,
    // fractions + levels in the same pair form `env` uses, and `level:curve`
    // for a segment that wants its own bend.
    else if (head.v === 'curvedef') {
      const nameTok = ln.toks[1]
      const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        errors.push({ message: 'curvedef needs a name (`curvedef swell .25 1 .75 .2`)', line: ln.line, col: ln.rawCol })
      }
      const nums: { v: number; curve?: number }[] = []
      let bad = false
      for (let k = 2; k < ln.toks.length; k++) {
        const t = ln.toks[k]!
        if (t.k !== 'num') {
          errors.push({ message: 'curvedef takes fraction/level pairs (`curvedef swell .25 1 .75 .2`)', line: t.pos.line, col: t.pos.col })
          bad = true
          break
        }
        const entry: { v: number; curve?: number } = { v: t.v }
        // `level:curve`, the same suffix env uses — only after a level
        if (nums.length % 2 === 1 && ln.toks[k + 1]?.k === 'colon' && ln.toks[k + 2]?.k === 'num') {
          entry.curve = (ln.toks[k + 2] as Tok & { v: number }).v
          k += 2
        }
        nums.push(entry)
      }
      if (!bad && (nums.length < 2 || nums.length % 2 !== 0)) {
        errors.push({ message: 'curvedef takes fraction/level PAIRS (`curvedef swell .25 1 .75 .2`)', line: ln.line, col: ln.rawCol })
        bad = true
      }
      const points: CurveDefItem['points'] = []
      if (!bad) {
        for (let k = 0; k + 1 < nums.length; k += 2) {
          const pt: { frac: number; level: number; curve?: number } = { frac: nums[k]!.v, level: nums[k + 1]!.v }
          if (nums[k + 1]!.curve !== undefined) pt.curve = nums[k + 1]!.curve
          points.push(pt)
        }
        if (!points.some((pt) => pt.frac > 0)) {
          errors.push({ message: 'curvedef: at least one segment needs a fraction above 0', line: ln.line, col: ln.rawCol })
        }
      }
      items.push({ t: 'curvedef', name, points, pos: head.pos })
      i++
    }
    // `scaledef pelog 0 1.2 2.7 5.4 6.7` → defineScale('pelog', [0, …]):
    // a custom tuning, steps in semitones from the root (floats welcome)
    else if (head.v === 'scaledef') {
      const nameTok = ln.toks[1]
      const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        errors.push({ message: 'scaledef needs a name (`scaledef pelog 0 1.2 2.7 5.4 6.7`)', line: ln.line, col: ln.rawCol })
      }
      // an optional UNIT word: `scaledef pelog cents 0 120 270 670 785`
      let unit: 'cents' | 'ratios' | undefined
      let k = 2
      const unitTok = ln.toks[2]
      if (unitTok !== undefined && unitTok.k === 'ident' && (unitTok.v === 'cents' || unitTok.v === 'ratios')) {
        unit = unitTok.v
        k = 3
      }
      const values: number[] = []
      let period: number | undefined
      let bad = false
      for (; k < ln.toks.length; k++) {
        const t = ln.toks[k]!
        // `period:1902` — the repeat interval, in the same unit as the steps
        if (t.k === 'ident' && t.v === 'period' && ln.toks[k + 1]?.k === 'colon') {
          const pv = ln.toks[k + 2]
          if (pv === undefined || pv.k !== 'num' || pv.v <= 0) {
            errors.push({ message: '`period:` needs a positive number, in the same unit as the steps', line: t.pos.line, col: t.pos.col })
            bad = true
            break
          }
          period = pv.v
          k += 2
          continue
        }
        if (t.k !== 'num') {
          errors.push({ message: 'scaledef steps are numbers — semitones from the root (or `cents` / `ratios`), floats welcome', line: t.pos.line, col: t.pos.col })
          bad = true
          break
        }
        values.push(t.v)
      }
      if (!bad && values.length < 2) {
        errors.push({ message: 'scaledef needs at least 2 steps (`scaledef pelog 0 1.2 2.7 5.4 6.7`)', line: ln.line, col: ln.rawCol })
      }
      if (!bad && period !== undefined && unit === undefined) {
        errors.push({ message: '`period:` needs a unit — `scaledef bp ratios 1 25/21 … period:3`', line: ln.line, col: ln.rawCol })
      }
      items.push({ t: 'scaledef', name, values, ...(unit !== undefined ? { unit } : {}), ...(period !== undefined ? { period } : {}), pos: head.pos })
      i++
    }
    // `wavedef vox 1 .3 / .5 1 .6 / .3 .8 1` → defineWavetable('vox', [[…]]):
    // a custom wavetable — '/'-separated FRAMES of harmonic partial
    // amplitudes (harmonic 1, 2, 3, … per frame; the morph scans frames)
    else if (head.v === 'wavedef') {
      const nameTok = ln.toks[1]
      const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        errors.push({ message: 'wavedef needs a name (`wavedef vox 1 .3 / .5 1 .6`)', line: ln.line, col: ln.rawCol })
      }
      const frames: number[][] = []
      let frame: number[] = []
      let bad = false
      for (let k = 2; k < ln.toks.length; k++) {
        const t = ln.toks[k]!
        if (t.k === 'op' && t.v === '/') {
          if (frame.length === 0) {
            errors.push({ message: 'wavedef: empty frame — every `/` needs partial amplitudes on both sides', line: t.pos.line, col: t.pos.col })
            bad = true
            break
          }
          frames.push(frame)
          frame = []
          continue
        }
        if (t.k !== 'num') {
          errors.push({ message: 'wavedef frames are numbers — harmonic partial amplitudes, `/` separates frames', line: t.pos.line, col: t.pos.col })
          bad = true
          break
        }
        if (frame.length >= 32) {
          errors.push({ message: 'wavedef: a frame has at most 32 partials', line: t.pos.line, col: t.pos.col })
          bad = true
          break
        }
        frame.push(t.v)
      }
      if (!bad) {
        if (frame.length > 0) frames.push(frame)
        else if (frames.length > 0) {
          errors.push({ message: 'wavedef: empty frame — every `/` needs partial amplitudes on both sides', line: ln.line, col: ln.rawCol })
          bad = true
        }
      }
      if (!bad && frames.length < 2) {
        errors.push({ message: 'wavedef needs at least 2 frames to morph between (`wavedef vox 1 .3 / .5 1 .6`)', line: ln.line, col: ln.rawCol })
      }
      items.push({ t: 'wavedef', name, frames, pos: head.pos })
      i++
    }
    // `level -4` → masterGain(-4): the whole output, in dB. NOT spelled
    // `gain`, which is already a play modifier (`gain: .5`) — one word for two
    // things reads as one thing, and it silently knocked the modifier out of
    // the play-body completions.
    else if (head.v === 'level') {
      const v = ln.toks[1]
      if (!v || v.k !== 'num') {
        errors.push({ message: 'level needs a number of dB (`level -4`)', line: ln.line, col: ln.rawCol })
      }
      items.push({ t: 'level', db: v && v.k === 'num' ? v.v : 0, pos: head.pos })
      i++
    }
    // `master threshold:-6 ratio:2 …` → masterCompress(opts)
    else if (head.v === 'master') {
      const opts: Record<string, number> = {}
      for (let k = 1; k + 2 < ln.toks.length + 1; k += 3) {
        const nameT = ln.toks[k], colonT = ln.toks[k + 1], valT = ln.toks[k + 2]
        if (!nameT || nameT.k !== 'ident' || colonT?.k !== 'colon' || valT?.k !== 'num') {
          if (nameT) errors.push({ message: 'master args are `name:number` pairs (threshold: ratio: attack: release: knee: makeup:)', line: nameT.pos.line, col: nameT.pos.col })
          break
        }
        opts[nameT.v] = (valT as Tok & { v: number }).v
      }
      items.push({ t: 'master', opts, pos: head.pos })
      i++
    }
    // `bus NAME` block: FX lines fold from `input`; `send SYNTH AMT` routes
    else if (head.v === 'bus') {
      const nameTok = ln.toks[1]
      const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
      if (!name) errors.push({ message: 'bus needs a name (`bus space`)', line: ln.line, col: ln.rawCol })
      const { body, next } = bodyLines(lines, i + 1)
      const sends: Record<string, number> = {}
      const fxLines: Line[] = []
      for (const b of body) {
        const s = /^send[ \t]+([a-zA-Z_]\w*)[ \t]+(-?\d*\.?\d+)[ \t]*$/.exec(b.raw)
        if (s) { sends[s[1]!] = Number(s[2]) } else fxLines.push(b)
      }
      const input: Expr = { t: 'ident', name: 'input', pos: head.pos }
      const fx = foldSpine(fxLines, input, errors)
      for (const b of fx.bindings) {
        if (b.expr.t === 'knob') errors.push({ message: 'a knob can\'t live in a bus — buses have no .ctrl route (use a fixed value)', line: b.pos.line, col: b.pos.col })
      }
      items.push({ t: 'bus', name, fx: fx.spine ?? input, bindings: fx.bindings, sends, pos: head.pos })
      i = next
    }
    // `section NAME LEN` block of nested plays; `song A B C` sequences them
    else if (head.v === 'section') {
      const nameTok = ln.toks[1]
      const lenTok = ln.toks[2]
      const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
      const len = lenTok && lenTok.k === 'num' ? lenTok.v : 0
      if (!name || !(len > 0)) {
        errors.push({ message: 'section needs a name and a length in cycles (`section drop 8`)', line: ln.line, col: ln.rawCol })
      }
      const { body, next } = bodyLines(lines, i + 1)
      const plays: PlayBlock[] = []
      let j = 0
      while (j < body.length) {
        const bl = body[j]!
        const bh = bl.toks[0]
        if (bh && bh.k === 'ident' && (bh.v === 'play' || bh.v === 'beat')) {
          // sub-parse against the ABSOLUTE line array so offsets stay global
          const abs = lines.indexOf(bl)
          const r = parsePlay(lines, abs, errors, bh.v)
          plays.push(r.block)
          j += r.next - abs
        } else {
          errors.push({ message: 'a section holds `play` and `beat` blocks', line: bl.line, col: bl.rawCol })
          j++
        }
      }
      if (plays.length === 0) errors.push({ message: `section '${name}' has no plays`, line: ln.line, col: ln.rawCol })
      items.push({ t: 'section', name, len, plays, pos: head.pos })
      i = next
    }
    else if (head.v === 'song') {
      const order: string[] = []
      for (let k = 1; k < ln.toks.length; k++) {
        const t = ln.toks[k]!
        if (t.k === 'ident') order.push(t.v)
        else errors.push({ message: 'song lists section names (`song intro drop drop`)', line: t.pos.line, col: t.pos.col })
      }
      items.push({ t: 'song', order, pos: head.pos })
      i++
    }
    // `visual` block: raw WGSL, verbatim
    else if (head.v === 'visual' && ln.toks.length === 1) {
      const { body, next } = bodyLines(lines, i + 1)
      items.push({ t: 'visual', wgsl: verbatimBody(src, body), pos: head.pos })
      i = next
    }
    // escape hatch, block: a lone `js` header + indented body → raw verbatim JS
    else if (head.v === 'js' && ln.toks.length === 1) {
      const { body, next } = bodyLines(lines, i + 1)
      items.push({ t: 'raw', code: verbatimBody(src, body), pos: head.pos })
      // the whole body is ONE js region (note-flash scans it for mini
      // strings; one region keeps multi-line statements parseable)
      if (body.length > 0) {
        const first = body[0]!
        const last = body[body.length - 1]!
        const lastStart = last.offset - last.indent
        const nl = src.indexOf('\n', lastStart)
        const full = src.slice(lastStart, nl === -1 ? src.length : nl).replace(/\s+$/, '')
        jsRegions.push({ from: first.offset - first.indent, to: lastStart + full.length })
      }
      i = next
    }
    else { errors.push({ message: `unknown block \`${head.v}\` (expected ${BLOCK_KEYWORDS.join(' / ')})`, line: ln.line, col: ln.rawCol }); i++ }
  }
  return { program: { items }, errors, jsRegions }
}

/** Reconstruct a block body VERBATIM from the original source (Line.raw has
 *  rondo `#`-comments stripped — a `#` inside a JS/WGSL string must survive),
 *  dedented by the block's base indent so relative indentation is kept. */
function verbatimBody(src: string, body: Line[]): string {
  const base = body.length > 0 ? Math.min(...body.map((b) => b.indent)) : 0
  return body
    .map((b) => {
      const lineStart = b.offset - b.indent
      const nl = src.indexOf('\n', lineStart)
      const full = src.slice(lineStart, nl === -1 ? src.length : nl).replace(/\s+$/, '')
      return full.slice(base)
    })
    .join('\n')
}
