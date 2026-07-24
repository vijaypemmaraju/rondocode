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

import type { Binding, Comb, CpsItem, CtrlValue, Expr, Mod, PlayBlock, Pos, Program, RondoError, SynthBlock, TopItem } from './ast'
import { lex, type Line, type Tok } from './lexer'
import { BUILTINS, isTransform, isReservedBinding } from './builtins'
import type { BuiltinSpec } from './builtins'

const SIGNALS = new Set(['sine', 'cosine', 'saw', 'isaw', 'tri', 'square', 'saw2', 'tri2', 'square2', 'sine2', 'rand', 'perlin'])
const CTRL_METHODS = new Set(['gain', 'dur', 'pan'])
const NUM_RE = /^-?\d*\.?\d+$/

/** synth-header voice options: `synth acid mono glide:.08 unison:5 …`. */
const VOICE_FLAGS = new Set(['mono'])
const VOICE_OPTS = new Set(['glide', 'unison', 'detune', 'spread', 'voices'])

const PREC: Record<string, number> = { '+': 2, '-': 2, '*': 3, '/': 3, '^': 4 }

class Cursor {
  i = 0
  constructor(readonly toks: Tok[], readonly errors: RondoError[]) {}
  peek(): Tok | undefined { return this.toks[this.i] }
  peek2(): Tok | undefined { return this.toks[this.i + 1] }
  next(): Tok | undefined { return this.toks[this.i++] }
  eof(): boolean { return this.i >= this.toks.length }
  err(message: string, pos?: Pos): void {
    const p = pos ?? this.peek()?.pos ?? { line: 0, col: 0 }
    this.errors.push({ message, line: p.line, col: p.col })
  }
  /** a `name:` named-argument boundary — stops expression parsing. */
  atNamedArg(): boolean {
    const a = this.peek(), b = this.peek2()
    return !!a && a.k === 'ident' && !!b && b.k === 'colon'
  }
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
  return !!t && t.sp && (t.k === 'num' || t.k === 'jsexpr' || (t.k === 'ident' && !c.atNamedArg()))
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
const EQ_BAND_TYPES = new Set(['hp', 'lp', 'peak', 'lowshelf', 'highshelf'])
function parseEqBands(c: Cursor): Expr[] {
  const args: Expr[] = []
  while (canStartArg(c)) {
    const t = c.peek()!
    if (t.k === 'ident') {
      c.next()
      if (!EQ_BAND_TYPES.has(t.v)) { c.err(`unknown eq band type \`${t.v}\` (hp, lp, peak, lowshelf, highshelf)`, t.pos); continue }
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
  if (!t) { c.err('unexpected end of line'); return { t: 'num', v: 0, pos: { line: 0, col: 0 } } }
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
    if (name === 'env') {
      // breakpoint envelope: variadic time/level pairs, then named args.
      // Bare `env` stays an ident — it's a reference to a binding named env.
      c.next()
      const args: Expr[] = []
      while (canStartArg(c)) args.push(parseExpr(c, 5))
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
      const named = parseNamed(c, spec)
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

function bodyLines(lines: Line[], start: number, min = 0): { body: Line[]; next: number } {
  const body: Line[] = []
  let j = start
  while (j < lines.length && lines[j]!.indent > min) { body.push(lines[j]!); j++ }
  return { body, next: j }
}

/** Fold a run of body lines into one spine expression + a list of bindings.
 *  `initial` is null for a voice body (the first spine line is the source) or
 *  the `input` node for a post body (every line is a transform of input). */
function foldSpine(body: Line[], initial: Expr | null, errors: RondoError[]): { spine: Expr | null; bindings: Binding[] } {
  const bindings: Binding[] = []
  let spine = initial
  for (const ln of body) {
    const c = new Cursor(ln.toks, errors)
    const t0 = ln.toks[0]
    // binding: NAME = …
    if (ln.toks.length >= 2 && t0 && t0.k === 'ident' && ln.toks[1]!.k === 'eq') {
      const bname = t0.v
      c.next(); c.next()
      const rhs = parseExpr(c, 0)
      if (!c.eof()) c.err('unexpected tokens after binding')
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
    if (!c.eof()) c.err('unexpected tokens at end of line')
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
    errors.push({ message: `unknown synth option \`${t.k === 'ident' ? t.v : t.k}\` (mono, glide:, unison:, detune:, spread:, voices:)`, line: t.pos.line, col: t.pos.col })
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
    if (rest.length !== postBody.length) errors.push({ message: 'post must be the last section of a synth', line: body[pIdx]!.line, col: 1 })
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
const FN_COMBS: Record<string, { pre: number; js: string }> = {
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

/** Parse a modifier value: number | signal (`sine 200..2400 slow:4`,
 *  `rise 8 0..1`) | mini. */
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
function isModifierLine(ln: Line): boolean {
  if (/^[a-zA-Z_]\w*[ \t]*:/.test(ln.raw)) return true
  const first = /^([a-zA-Z_]\w*)/.exec(ln.raw)?.[1]
  return first !== undefined && COMB_WORDS.has(first)
}

/** Extract notation text (before an inline `scale:`) from a body line. */
function notationOf(ln: Line, errors: RondoError[]): { notation: string; from: number; scale?: string } {
  const m = /\bscale:([a-gA-G][a-z0-9#-]*)/.exec(ln.raw)
  const raw = m ? ln.raw.slice(0, m.index) : ln.raw
  const notation = raw.replace(/\s+$/, '')
  // near-miss like `scale:minor` (no a–g root) doesn't match the extractor —
  // error rather than silently shipping "scale:minor" inside the notation
  if (/\bscale:/.test(notation)) {
    errors.push({ message: 'bad scale — write it like `scale:a-min` (root + mode)', line: ln.line, col: ln.rawCol })
  }
  return { notation, from: ln.offset, scale: m?.[1] }
}

function parsePlay(lines: Line[], i: number, errors: RondoError[]): { block: PlayBlock; next: number } {
  const header = lines[i]!
  const nameTok = header.toks[1]
  const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
  if (!name) errors.push({ message: 'play needs a synth name (`play lead`)', line: header.line, col: header.rawCol })
  // body = lines deeper than the header, so a play nests inside a section too
  const { body, next } = bodyLines(lines, i + 1, header.indent)
  if (body.length === 0) errors.push({ message: `play '${name}' has no notation`, line: header.line, col: header.rawCol })
  // Leading non-modifier lines are notation VOICES (2+ → a stacked chord of
  // lines, like the JS stack(n(…), n(…)) idiom); the rest are modifiers.
  // Notation keeps its internal spacing so char ranges line up with the buffer
  // 1:1 — that's what lets note-play flash highlight the source.
  const noteLines: Line[] = []
  const modLines: Line[] = []
  for (const ln of body) {
    if (modLines.length === 0 && !isModifierLine(ln)) noteLines.push(ln)
    else modLines.push(ln)
  }
  let notation = ''
  let notationFrom = body[0]?.offset ?? 0
  let scale: string | undefined
  let voices: { notation: string; notationFrom: number }[] | undefined
  for (let v = 0; v < noteLines.length; v++) {
    const parsed = notationOf(noteLines[v]!, errors)
    if (parsed.scale !== undefined) scale = parsed.scale
    if (v === 0) {
      notation = parsed.notation
      notationFrom = parsed.from
    } else {
      ;(voices ??= []).push({ notation: parsed.notation, notationFrom: parsed.from })
    }
  }
  const mods: Mod[] = []
  for (const ln of modLines) {
    // `scale: a-min` as a modifier line (the stacked-voices form needs it
    // somewhere other than inline)
    const sm = /^scale[ \t]*:[ \t]*([a-gA-G][a-z0-9#-]*)[ \t]*$/.exec(ln.raw)
    if (sm) { scale = sm[1]; continue }
    const mod = parseMod(ln, errors)
    if (mod) mods.push(mod)
  }
  const block: PlayBlock = { t: 'play', name, notation, notationFrom, scale, mods, pos: header.toks[0]!.pos }
  if (voices !== undefined) block.voices = voices
  return { block, next }
}

function parseCps(lines: Line[], i: number, errors: RondoError[]): { block: CpsItem; next: number } {
  const header = lines[i]!
  const v = header.toks[1]
  if (!v || v.k !== 'num') errors.push({ message: 'cps needs a number (`cps .6`)', line: header.line, col: header.rawCol })
  return { block: { t: 'cps', value: v && v.k === 'num' ? v.v : 0.5, pos: header.toks[0]!.pos }, next: i + 1 }
}

export function parse(src: string): { program: Program; errors: RondoError[] } {
  const { lines, errors } = lex(src)
  const items: TopItem[] = []
  let i = 0
  while (i < lines.length) {
    const ln = lines[i]!
    if (ln.indent !== 0) { errors.push({ message: 'unexpected indentation', line: ln.line, col: 1 }); i++; continue }
    const head = ln.toks[0]
    // escape hatch, one-liner: `js{ … }` alone on a top-level line → raw statement
    if (head && head.k === 'jsexpr') { items.push({ t: 'raw', code: head.v, pos: head.pos }); i++; continue }
    if (!head || head.k !== 'ident') { errors.push({ message: 'expected `synth`, `play`, `cps`, or `js`', line: ln.line, col: ln.rawCol }); i++; continue }
    if (head.v === 'synth') { const r = parseSynth(lines, i, errors); items.push(r.block); i = r.next }
    else if (head.v === 'play') { const r = parsePlay(lines, i, errors); items.push(r.block); i = r.next }
    else if (head.v === 'cps') { const r = parseCps(lines, i, errors); items.push(r.block); i = r.next }
    // `sidechain kick depth:.7 release:.09 lead:.5 …` — extra named args are
    // per-channel duck amounts
    else if (head.v === 'sidechain') {
      const srcTok = ln.toks[1]
      const source = srcTok && srcTok.k === 'ident' ? srcTok.v : ''
      if (!source) errors.push({ message: 'sidechain needs a source synth (`sidechain kick …`)', line: ln.line, col: ln.rawCol })
      const item: TopItem = { t: 'sidechain', source, duck: {}, pos: head.pos }
      for (let k = 2; k + 2 < ln.toks.length + 1; k += 3) {
        const nameT = ln.toks[k], colonT = ln.toks[k + 1], valT = ln.toks[k + 2]
        if (!nameT || nameT.k !== 'ident' || colonT?.k !== 'colon' || valT?.k !== 'num') {
          if (nameT) errors.push({ message: 'sidechain args are `name:number` pairs (depth: / release: / <synth>:duck)', line: nameT.pos.line, col: nameT.pos.col })
          break
        }
        const v = (valT as Tok & { v: number }).v
        if (nameT.v === 'depth') item.depth = v
        else if (nameT.v === 'release') item.release = v
        else item.duck[nameT.v] = v
      }
      items.push(item)
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
        if (bh && bh.k === 'ident' && bh.v === 'play') {
          // sub-parse against the ABSOLUTE line array so offsets stay global
          const abs = lines.indexOf(bl)
          const r = parsePlay(lines, abs, errors)
          plays.push(r.block)
          j += r.next - abs
        } else {
          errors.push({ message: 'a section holds `play` blocks', line: bl.line, col: bl.rawCol })
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
      i = next
    }
    else { errors.push({ message: `unknown block \`${head.v}\` (expected synth / play / section / song / cps / bus / sidechain / master / visual / js)`, line: ln.line, col: ln.rawCol }); i++ }
  }
  return { program: { items }, errors }
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
