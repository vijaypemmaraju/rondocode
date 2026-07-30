/* ------------------------------------------------------------------------- *
 * What a macro is DOING, shown where it is doing it.
 *
 * A macro reaches its destinations through arithmetic at each use site —
 * `svf bright * 0.5`, `fb = 0.6 - bright / 7300 * 0.55` — which is what lets
 * one knob drive several things at different ratios. The cost of that design
 * is that the destinations have no number in the source to read: the only
 * literal is on the macro line, and every site is an expression.
 *
 * So the editor computes them. This module is the pure half: find the macro
 * declarations, find the expressions that depend on them, and evaluate those
 * expressions for a given set of macro values. The widget layer renders the
 * results as line-end chips and refreshes them live while a macro is dragged.
 *
 * CASCADING falls out of evaluating a synth's bindings in dependency order: a
 * binding built from a macro becomes part of the environment the next binding
 * is evaluated in, so `mid = bright * 2` then `top = mid + 100` both read.
 *
 * Deliberately partial: only PURE ARITHMETIC over numbers, macros and other
 * such bindings is evaluated. Anything reaching an oscillator, an envelope or
 * a note (`adsr .003 .2`, `saw note`) has no single number to show, and is
 * skipped rather than guessed at. A chip that lies is worse than no chip.
 * ------------------------------------------------------------------------- */

/** `macro NAME DEF [lo..hi] [curve]` — the one line that owns the numbers. */
export interface MacroDecl {
  name: string
  value: number
  lo: number
  hi: number
  log: boolean
  /** char span of DEF within the doc (what a drag rewrites). */
  defFrom: number
  defTo: number
}

/** One expression that depends on a macro, and where to show its value. */
export interface MacroUse {
  /** the expression source, e.g. `0.6 - bright / 7300 * 0.55`. */
  expr: string
  /** what to label the chip with: the binding name, or the processor it feeds. */
  label: string
  /** char offset to anchor the chip at (end of the code text on that line). */
  at: number
  /** the enclosing `synth NAME`, so a chip knows whose bindings it may read. */
  synth?: string
  /** macro names this expression reaches, directly or through bindings. */
  deps: string[]
}

const MACRO_RE = /^[ \t]*macro[ \t]+([a-zA-Z_]\w*)[ \t]+(-?\d*\.?\d+)(?:[ \t]+(-?\d*\.?\d+)\.\.(-?\d*\.?\d+))?(?:[ \t]+(log|lin))?[ \t]*$/

/** Strip a rondo `#` comment, as the widget scanners do. */
const codeText = (raw: string): string => {
  const m = /(^|\s)#/.exec(raw)
  return m ? raw.slice(0, m.index + (m[1] ? m[1].length : 0)) : raw
}

/** Every `macro` declaration in the doc, with the span a knob drag rewrites. */
export function scanMacroDecls(text: string): MacroDecl[] {
  const out: MacroDecl[] = []
  let off = 0
  for (const raw of text.split('\n')) {
    const line = codeText(raw)
    const m = MACRO_RE.exec(line)
    if (m) {
      const value = Number(m[2])
      const lo = m[3] !== undefined ? Number(m[3]) : 0
      const hi = m[4] !== undefined ? Number(m[4]) : value > 0 ? value * 4 : 1
      if (Number.isFinite(value) && Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) {
        const defFrom = off + line.indexOf(m[2]!, line.indexOf(m[1]!) + m[1]!.length)
        out.push({ name: m[1]!, value, lo, hi, log: m[5] === 'log', defFrom, defTo: defFrom + m[2]!.length })
      }
    }
    off += raw.length + 1
  }
  return out
}

/* ---- a tiny arithmetic evaluator ----------------------------------------- *
 * The rondo binding grammar's numeric subset: numbers, identifiers, + - * / ^
 * and parens. Precedence-climbing, matching codegen's operator mapping. */

type Tok = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string }

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t') { i++; continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+/.exec(src.slice(i))!
      out.push({ k: 'num', v: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^\w+/.exec(src.slice(i))!
      out.push({ k: 'id', v: m[0] })
      i += m[0].length
      continue
    }
    if ('+-*/^()'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue }
    return null // anything else (`:`, `..`, `->`) is outside this subset
  }
  return out.length > 0 ? out : null
}

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 }

/** Evaluate `expr` with `env` supplying identifier values. Returns undefined
 *  for anything outside the numeric subset, or naming something unknown —
 *  never a guess. */
export function evalMacroExpr(expr: string, env: Readonly<Record<string, number>>): number | undefined {
  const toks = tokenize(expr)
  if (toks === null) return undefined
  let i = 0
  const atom = (): number | undefined => {
    const t = toks[i]
    if (t === undefined) return undefined
    if (t.k === 'op' && t.v === '-') { i++; const v = atom(); return v === undefined ? undefined : -v }
    if (t.k === 'op' && t.v === '(') {
      i++
      const v = climb(1)
      if (v === undefined || toks[i]?.k !== 'op' || (toks[i] as { v: string }).v !== ')') return undefined
      i++
      return v
    }
    if (t.k === 'num') { i++; return t.v }
    if (t.k === 'id') {
      const v = env[t.v]
      if (v === undefined) return undefined
      i++
      return v
    }
    return undefined
  }
  const climb = (min: number): number | undefined => {
    let lhs = atom()
    if (lhs === undefined) return undefined
    for (;;) {
      const t = toks[i]
      if (t === undefined || t.k !== 'op' || PREC[t.v] === undefined || PREC[t.v]! < min) break
      const op = t.v
      i++
      // ^ is right-associative, the rest left
      const rhs = climb(op === '^' ? PREC[op]! : PREC[op]! + 1)
      if (rhs === undefined) return undefined
      lhs = op === '+' ? lhs + rhs : op === '-' ? lhs - rhs : op === '*' ? lhs * rhs
        : op === '/' ? lhs / rhs : lhs ** rhs
    }
    return lhs
  }
  const v = climb(1)
  if (v === undefined || i !== toks.length || !Number.isFinite(v)) return undefined
  return v
}

/* ---- finding the use sites ----------------------------------------------- */

/** Named arguments (`res:.3`, `sync:1`) are settings, not part of the value
 *  expression — strip them before evaluating what is left. */
const stripNamed = (s: string): string => s.replace(/\b[a-zA-Z_]\w*:\s*-?[\w.]+/g, ' ')

/** The value expression on a spine line: everything after the processor name,
 *  with named args removed. `svf bright * 0.5 res:.2` → `bright * 0.5`. */
function spineExpr(line: string): { head: string; expr: string } | null {
  const body = stripNamed(line).trim()
  if (body === '') return null
  // an operator-led line (`* env`) applies to the running signal: the whole
  // line after the operator is the value
  const opLed = /^([*/+\-^])\s*(.+)$/.exec(body)
  if (opLed) return { head: opLed[1]!, expr: opLed[2]! }
  const m = /^([a-zA-Z_]\w*)\s+(.+)$/.exec(body)
  if (m === null) return null
  return { head: m[1]!, expr: m[2]! }
}

/** The doc split into blocks: a `synth NAME` header and the lines under it.
 *  Bindings are block-scoped, and a rondo synth writes its spine ABOVE its
 *  bindings, so a block has to be seen whole before anything in it can be
 *  evaluated. */
function blocks(text: string): { synth?: string; lines: { line: string; at: number }[] }[] {
  const out: { synth?: string; lines: { line: string; at: number }[] }[] = [{ lines: [] }]
  let off = 0
  for (const raw of text.split('\n')) {
    const line = codeText(raw)
    const header = /^(synth|play|beat|sing|bus|section|cps|bpm|js|macro|visual)\b(?:[ \t]+([a-zA-Z_]\w*))?/.exec(line)
    if (header) {
      const entry: { synth?: string; lines: { line: string; at: number }[] } = { lines: [] }
      if (header[1] === 'synth' && header[2] !== undefined) entry.synth = header[2]
      out.push(entry)
    } else {
      out[out.length - 1]!.lines.push({ line, at: off + line.replace(/\s+$/, '').length })
    }
    off += raw.length + 1
  }
  return out
}

const BINDING_RE = /^[ \t]*([a-zA-Z_]\w*)[ \t]*=[ \t]*(.+?)[ \t]*$/

/**
 * Every expression in the doc whose value depends on a macro, in source order.
 *
 * A block's bindings are collected BEFORE its lines are examined, because a
 * rondo synth writes its spine above them (`* top` on line 2, `top = …` on
 * line 5) and codegen topo-sorts. Chips would otherwise appear only on the
 * lines that happen to come after their definitions.
 */
export function scanMacroUses(text: string, decls: readonly MacroDecl[]): MacroUse[] {
  if (decls.length === 0) return []
  const macroNames = new Set(decls.map((d) => d.name))
  const out: MacroUse[] = []
  for (const block of blocks(text)) {
    const locals: Record<string, string> = {}
    for (const { line } of block.lines) {
      const m = BINDING_RE.exec(line)
      if (m) locals[m[1]!] = m[2]!
    }
    const depsOf = (expr: string, seen = new Set<string>()): string[] => {
      const found = new Set<string>()
      for (const id of expr.match(/[a-zA-Z_]\w*/g) ?? []) {
        if (macroNames.has(id)) found.add(id)
        else if (locals[id] !== undefined && !seen.has(id)) {
          seen.add(id)
          for (const d of depsOf(locals[id]!, seen)) found.add(d)
        }
      }
      return [...found]
    }
    for (const { line, at } of block.lines) {
      const bind = BINDING_RE.exec(line)
      if (bind) {
        const deps = depsOf(bind[2]!)
        if (deps.length > 0) {
          const use: MacroUse = { expr: bind[2]!, label: bind[1]!, at, deps }
          if (block.synth !== undefined) use.synth = block.synth
          out.push(use)
        }
        continue
      }
      const sp = spineExpr(line)
      if (sp === null) continue
      const deps = depsOf(sp.expr)
      if (deps.length > 0) {
        const use: MacroUse = { expr: sp.expr, label: sp.head, at, deps }
        if (block.synth !== undefined) use.synth = block.synth
        out.push(use)
      }
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Resolve every use against a set of macro values, dropping the ones that are
 *  not plain arithmetic. `values` overrides the declared defaults, which is how
 *  a drag updates every chip without touching the document. */
export function macroReadouts(
  text: string,
  decls: readonly MacroDecl[],
  values: Readonly<Record<string, number>> = {},
): { at: number; label: string; value: number; deps: string[] }[] {
  const env: Record<string, number> = {}
  for (const d of decls) env[d.name] = values[d.name] ?? d.value
  const out: { at: number; label: string; value: number; deps: string[] }[] = []

  // Scan ONCE and index the uses by block. This used to re-scan the whole
  // document inside the block loop and then find each use's block with a
  // linear .some() — quadratic, and measurably so: 0.45ms at four synths but
  // 39ms at forty-eight. It runs on every decoration rebuild AND on every
  // pointer move of a macro drag, on the same thread the WGSL visualiser
  // renders on, so it showed up as dropped frames rather than as a slow
  // editor.
  const uses = scanMacroUses(text, decls)
  if (uses.length === 0) return out
  const blockList = blocks(text)
  const blockAt = new Map<number, number>()
  blockList.forEach((b, i) => { for (const l of b.lines) blockAt.set(l.at, i) })
  const usesByBlock = new Map<number, typeof uses>()
  for (const use of uses) {
    const i = blockAt.get(use.at)
    if (i === undefined) continue
    const list = usesByBlock.get(i)
    if (list === undefined) usesByBlock.set(i, [use])
    else list.push(use)
  }

  for (const [bi, blockUses] of usesByBlock) {
    const block = blockList[bi]!
    const locals: Record<string, string> = {}
    for (const { line } of block.lines) {
      const m = BINDING_RE.exec(line)
      if (m) locals[m[1]!] = m[2]!
    }
    // Lazily resolve a binding by evaluating its expression, so a spine line
    // written above its bindings still reads (and cascades through them). The
    // `resolving` set stops a binding cycle from recursing forever — the
    // compiler reports the cycle; the chip just declines to show a number.
    const memo = new Map<string, number | undefined>()
    const resolving = new Set<string>()
    const scope = new Proxy({} as Record<string, number>, {
      get: (_t, key: string): number | undefined => {
        if (env[key] !== undefined) return env[key]
        if (memo.has(key)) return memo.get(key)
        const src = locals[key]
        if (src === undefined || resolving.has(key)) return undefined
        resolving.add(key)
        const v = evalMacroExpr(src, scope)
        resolving.delete(key)
        memo.set(key, v)
        return v
      },
      has: () => true,
    })
    for (const use of blockUses) {
      const v = evalMacroExpr(use.expr, scope)
      if (v === undefined) continue
      out.push({ at: use.at, label: use.label, value: v, deps: use.deps })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}
