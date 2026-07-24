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

const SIGNALS = new Set(['sine', 'cosine', 'saw', 'isaw', 'tri', 'square', 'saw2', 'tri2', 'square2', 'sine2', 'rand', 'perlin'])
const CTRL_METHODS = new Set(['gain', 'dur', 'pan'])
const NUM_RE = /^-?\d*\.?\d+$/

const OSC = new Set(['saw', 'square', 'sine', 'tri'])
const FILTER = new Set(['ladder', 'svf', 'onepole'])
/** processor-led effects that take only the running signal + named args. */
const EFFECT = new Set(['reverb', 'chorus', 'exciter', 'ott'])
const PROC = new Set([...FILTER, ...EFFECT])

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
  return !!t && t.sp && (t.k === 'num' || (t.k === 'ident' && !c.atNamedArg()))
}

function parseNamed(c: Cursor): Record<string, Expr> {
  const named: Record<string, Expr> = {}
  while (c.atNamedArg()) {
    const name = (c.next() as Tok & { v: string }).v
    c.next() // colon
    named[name] = parseExpr(c, 2)
  }
  return named
}

function parseApp(c: Cursor): Expr {
  const t = c.peek()
  if (!t) { c.err('unexpected end of line'); return { t: 'num', v: 0, pos: { line: 0, col: 0 } } }
  if (t.k === 'jsexpr') { c.next(); return { t: 'js', code: t.v, pos: t.pos } }
  if (t.k === 'num') { c.next(); return { t: 'num', v: t.v, pos: t.pos } }
  if (t.k === 'ident') {
    const name = t.v
    if (OSC.has(name)) {
      c.next()
      const args: Expr[] = []
      if (canStartArg(c)) args.push(parseExpr(c, 2))
      return { t: 'call', name, args, named: {}, pos: t.pos }
    }
    if (name === 'adsr') {
      c.next()
      const args = [parseExpr(c, 5), parseExpr(c, 5), parseExpr(c, 5), parseExpr(c, 5)]
      return { t: 'call', name, args, named: {}, pos: t.pos }
    }
    if (FILTER.has(name)) {
      c.next()
      const args = [parseExpr(c, 2)]
      const named = parseNamed(c)
      return { t: 'call', name, args, named, pos: t.pos }
    }
    if (name === 'knob') return parseKnob(c)
    // a plain reference: a binding name, or note / gate
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

function bodyLines(lines: Line[], start: number): { body: Line[]; next: number } {
  const body: Line[] = []
  let j = start
  while (j < lines.length && lines[j]!.indent > 0) { body.push(lines[j]!); j++ }
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
      bindings.push({ name: bname, expr: rhs, pos: t0.pos })
      continue
    }
    if (spine === null) {
      spine = parseExpr(c, 0) // the source line
    } else if (t0 && t0.k === 'op') {
      const op = t0.v; c.next()
      spine = { t: 'bin', op, l: spine, r: parseExpr(c, 0), pos: t0.pos }
    } else if (t0 && t0.k === 'ident' && PROC.has(t0.v)) {
      const name = t0.v; c.next()
      const args: Expr[] = [spine]
      if (FILTER.has(name)) args.push(parseExpr(c, 2)) // filters take a cutoff
      const named = parseNamed(c)
      spine = { t: 'call', name, args, named, pos: t0.pos }
    } else {
      c.err('expected a transform — an operator (`* env`), a filter (`ladder …`), or an effect (`reverb …`).')
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
  if (postBody && postBody.length > 0) {
    const input: Expr = { t: 'ident', name: 'input', pos: header.toks[0]!.pos }
    const post = foldSpine(postBody, input, errors)
    block.post = post.spine ?? input
    block.postBindings = post.bindings
  }
  return { block, next }
}

/** Parse a modifier value: number | signal (`sine 200..2400 slow:4`) | mini. */
function parseCtrlValue(raw: string): CtrlValue {
  const s = raw.trim()
  const toks = s.split(/\s+/)
  if (toks.length === 1 && NUM_RE.test(toks[0]!)) return { kind: 'num', v: Number(toks[0]) }
  if (SIGNALS.has(toks[0]!)) {
    const v: CtrlValue = { kind: 'sig', sig: toks[0]! }
    for (const t of toks.slice(1)) {
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
  // every N: <combinator>
  const ev = /^every\s+(\d+)\s*:\s*(.+)$/.exec(raw)
  if (ev) return { kind: 'every', n: Number(ev[1]), comb: parseComb(ev[2]!), pos }
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

function parsePlay(lines: Line[], i: number, errors: RondoError[]): { block: PlayBlock; next: number } {
  const header = lines[i]!
  const nameTok = header.toks[1]
  const name = nameTok && nameTok.k === 'ident' ? nameTok.v : ''
  if (!name) errors.push({ message: 'play needs a synth name (`play lead`)', line: header.line, col: header.rawCol })
  const { body, next } = bodyLines(lines, i + 1)
  if (body.length === 0) errors.push({ message: `play '${name}' has no notation`, line: header.line, col: header.rawCol })
  // first body line = notation (+ optional inline `scale:`); the rest = modifiers.
  // Keep the notation's internal spacing intact so its char range lines up with
  // the buffer 1:1 — that's what lets note-play flash highlight the source.
  const first = body[0]
  let notation = ''
  let notationFrom = first ? first.offset : 0
  let scale: string | undefined
  if (first) {
    const m = /\bscale:([a-gA-G][a-z0-9#-]*)/.exec(first.raw)
    if (m) scale = m[1]
    const raw = m ? first.raw.slice(0, m.index) : first.raw // notation is the part before `scale:`
    notation = raw.replace(/\s+$/, '')
    notationFrom = first.offset
    // near-miss like `scale:minor` (no a–g root) doesn't match the extractor —
    // error rather than silently shipping "scale:minor" inside the notation
    if (/\bscale:/.test(notation)) {
      errors.push({ message: 'bad scale — write it like `scale:a-min` (root + mode)', line: first.line, col: first.rawCol })
    }
  }
  const mods: Mod[] = []
  for (const ln of body.slice(1)) {
    const mod = parseMod(ln, errors)
    if (mod) mods.push(mod)
  }
  return { block: { t: 'play', name, notation, notationFrom, scale, mods, pos: header.toks[0]!.pos }, next }
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
    // escape hatch, block: a lone `js` header + indented body → raw verbatim
    // JS. Reconstruct each line from the ORIGINAL source (not Line.raw, which
    // has rondo `#`-comments stripped — a `#` inside a JS string must survive)
    // and dedent by the block's base indent so relative indentation is kept.
    else if (head.v === 'js' && ln.toks.length === 1) {
      const { body, next } = bodyLines(lines, i + 1)
      const base = body.length > 0 ? Math.min(...body.map((b) => b.indent)) : 0
      const code = body
        .map((b) => {
          const lineStart = b.offset - b.indent
          const nl = src.indexOf('\n', lineStart)
          const full = src.slice(lineStart, nl === -1 ? src.length : nl).replace(/\s+$/, '')
          return full.slice(base)
        })
        .join('\n')
      items.push({ t: 'raw', code, pos: head.pos })
      i = next
    }
    else { errors.push({ message: `unknown block \`${head.v}\` (expected synth / play / cps / js)`, line: ln.line, col: ln.rawCol }); i++ }
  }
  return { program: { items }, errors }
}
