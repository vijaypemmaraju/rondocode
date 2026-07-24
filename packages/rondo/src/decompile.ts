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
import { BUILTINS } from './builtins'
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
}

const OP_INFO: Record<string, { op: string; prec: number }> = {
  mul: { op: '*', prec: 3 },
  div: { op: '/', prec: 3 },
  add: { op: '+', prec: 2 },
  sub: { op: '-', prec: 2 },
  pow: { op: '^', prec: 4 },
}

const ALIAS_INV: Record<string, string> = { roomSize: 'room', maxTime: 'maxtime' }

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
      if (r === null || r.prec < 3) return null // named values parse tight
      parts.push(`${rname}:${r.s}`)
    }
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

/** A positional argument in a builtin application parses at prec ≥ 2. */
function posArg(n: Node): string | null {
  const r = rExpr(n)
  return r !== null && r.prec >= 2 ? r.s : null
}

function rExpr(n: Node): R | null {
  // identifiers + the special refs
  if (n.type === 'Identifier') {
    return { s: n['name'] as string, prec: 5 }
  }
  const v = numValue(n)
  if (v !== undefined) return { s: num(v), prec: 5 }
  if (n.type === 'MemberExpression') {
    const obj = n['object'] as Node
    const prop = n['property'] as Node
    if (isIdent(obj, 'note') && isIdent(prop, 'freq')) return { s: 'note', prec: 5 }
    return null
  }
  const m = methodCall(n)
  if (m !== undefined) {
    // Sig operators → infix (left-assoc; compose only when re-parse matches)
    const info = OP_INFO[m.method]
    if (info !== undefined && m.args.length === 1) {
      const l = rExpr(m.obj)
      const r = rExpr(m.args[0]!)
      if (l === null || r === null) return null
      if (l.prec < info.prec || r.prec <= info.prec) return null // would mis-associate
      return { s: `${l.s} ${info.op} ${r.s}`, prec: info.prec }
    }
    // .range(lo, hi) → `x -> lo..hi`
    if (m.method === 'range' && m.args.length === 2) {
      const x = rExpr(m.obj)
      const lo = numValue(m.args[0]!)
      const hi = numValue(m.args[1]!)
      if (x === null || x.prec < 2 || lo === undefined || hi === undefined) return null
      return { s: `${x.s} -> ${num(lo)}..${num(hi)}`, prec: 1 }
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
            return { s: `adsr ${vals.map((x) => num(x!)).join(' ')}`, prec: 5 }
          }
        }
      }
      return null
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
      // proc-in-expression: input is the first positional
      const input = rest[0] !== undefined ? posArg(rest[0]) : null
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
        if (spec.kind === 'osc' && i === 0 && spec.freqDefault === true &&
            rest.length === 1 && opts === undefined && rest[i]!.type === 'MemberExpression' &&
            isIdent(rest[i]!['object'] as Node, 'note') && isIdent(rest[i]!['property'] as Node, 'freq')) {
          continue
        }
        const p = posArg(rest[i]!)
        if (p === null) return null
        pos.push(p)
      }
    }
    const named = namedArgs(spec, opts)
    if (named === null) return null
    const posStr = pos.length > 0 ? ' ' + pos.join(' ') : ''
    return { s: `${name}${prefix}${posStr}${named}`, prec: 5 }
  }
  return null
}

/** A binding RHS: full rondo expression, or a js{ … } inline fallback. */
function bindingRHS(n: Node): string {
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
function unfoldPipeline(n: Node, lines: string[]): boolean {
  const m = methodCall(n)
  if (m !== undefined) {
    const info = OP_INFO[m.method]
    if (info !== undefined && m.args.length === 1) {
      const arg = rExpr(m.args[0]!)
      if (arg === null || arg.prec <= info.prec) return false
      if (!unfoldPipeline(m.obj, lines)) return false
      lines.push(`${info.op} ${arg.s}`)
      return true
    }
    if ((m.method === 'tanh' || m.method === 'fold') && m.args.length === 0) {
      if (!unfoldPipeline(m.obj, lines)) return false
      lines.push(m.method)
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
      const other = rExpr(m.args[0]!)
      const t = rExpr(m.args[1]!)
      if (other === null || other.prec < 2 || t === null || t.prec < 2) return false
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
    const spec = name !== undefined ? BUILTINS[name] : undefined
    if (spec !== undefined && spec.kind === 'proc' && args.length >= 1) {
      let rest = args.slice(1)
      let opts: Node | undefined
      if (rest.length > 0 && rest[rest.length - 1]!.type === 'ObjectExpression') {
        opts = rest[rest.length - 1]!
        rest = rest.slice(0, -1)
      }
      const pos: string[] = []
      for (const a of rest) {
        const p = posArg(a)
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
  const chain = (fn: Node, indent: string, fromInput = false): string[] | null => {
    const body = fn['body'] as Node
    const lines: string[] = []
    let ret: Node | undefined
    const bindings: string[] = []
    if (body.type === 'BlockStatement') {
      for (const s of body['body'] as Node[]) {
        if (s.type === 'VariableDeclaration') {
          const bd = (s['declarations'] as Node[])[0]
          if (bd === undefined || !isIdent(bd['id'] as Node)) return null
          const bname = (bd['id'] as Node)['name'] as string
          const bin = bd['init'] as Node | null
          if (bin === null) return null
          // param('x', d, opts) → knob (name must match the binding)
          if (isCall(bin) && calleeName(bin) === 'param') {
            const pa = bin['arguments'] as Node[]
            const pname = pa[0] !== undefined ? strValue(pa[0]) : undefined
            const def = pa[1] !== undefined ? numValue(pa[1]) : undefined
            const po = pa[2] !== undefined ? objEntries(pa[2]) : {}
            if (pname !== bname || def === undefined || po === undefined) return null
            const min = po['min'] !== undefined ? numValue(po['min']) : 0
            const max = po['max'] !== undefined ? numValue(po['max']) : 1
            const curve = po['curve'] !== undefined ? strValue(po['curve']) : undefined
            if (min === undefined || max === undefined) return null
            bindings.push(`${bname} = knob ${num(def)} ${num(min)}..${num(max)}${curve === 'log' ? ' log' : ''}`)
          } else {
            bindings.push(`${bname} = ${bindingRHS(bin)}`)
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
    return [...spine, ...bindings].map((l) => indent + l)
  }
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

const SCALE_INV = new Map(Object.entries(SCALE_MODE).map(([short, long]) => [long, short]))

/** A .ctrl/.gain value node → modifier value text, or null. */
function ctrlValue(n: Node): string | null {
  const nv = numValue(n)
  if (nv !== undefined) return num(nv)
  const sv = strValue(n)
  if (sv !== undefined) return sv // a mini string
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
function chainToPlay(chainNode: Node): { sound: string; body: string[] } | null {
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
      const [root, mode] = sv.split(' ')
      if (root === undefined || mode === undefined) return null
      scale = `${root}-${SCALE_INV.get(mode) ?? mode}`
    } else if (m.method === 'sound' && m.args.length === 1) {
      const sv = strValue(m.args[0]!)
      if (sv === undefined) return null
      sound = sv
    } else if (m.method === 'ctrl' && m.args.length === 2) {
      const cname = strValue(m.args[0]!)
      const cval = ctrlValue(m.args[1]!)
      if (cname === undefined || cval === null) return null
      mods.unshift(`${cname}: ${cval}`)
    } else if ((m.method === 'gain' || m.method === 'dur' || m.method === 'pan') && m.args.length === 1) {
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
  // the entry: n/note/chord('…') or stack(entries…)
  const entryNotation = (e: Node): string | null => {
    if (!isCall(e)) return null
    const en = calleeName(e)
    if (en !== 'n' && en !== 'note' && en !== 'chord') return null
    const a = e['arguments'] as Node[]
    const sv = a[0] !== undefined ? strValue(a[0]) : undefined
    return sv !== undefined && !sv.includes('\n') ? sv : null
  }
  const voices: string[] = []
  if (isCall(cur) && calleeName(cur) === 'stack') {
    for (const e of cur['arguments'] as Node[]) {
      const nv = entryNotation(e)
      if (nv === null) return null
      voices.push(nv)
    }
  } else {
    const nv = entryNotation(cur)
    if (nv === null) return null
    voices.push(nv)
  }
  if (sound === undefined) return null
  const body = [...voices, ...(scale !== undefined ? [`scale: ${scale}`] : []), ...mods]
  return { sound, body }
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
  if (play === null || play.sound !== pname) return null // play NAME routes to itself
  return [`play ${pname}`, ...play.body.map((l) => `  ${l}`)].join('\n')
}

/** A section const: its plays (one per stack member), or null. */
function sectionPlays(chainNode: Node): string[] | null {
  const members = isCall(chainNode) && calleeName(chainNode) === 'stack' &&
      !((chainNode['arguments'] as Node[]).some((a) => {
        const nv = isCall(a) && (calleeName(a) === 'n' || calleeName(a) === 'note' || calleeName(a) === 'chord')
        return nv // a stack of ENTRIES is stacked voices, not section plays
      }))
    ? (chainNode['arguments'] as Node[])
    : [chainNode]
  const out: string[] = []
  for (const m of members) {
    const play = chainToPlay(m)
    if (play === null) return null
    out.push([`  play ${play.sound}`, ...play.body.map((l) => `    ${l}`)].join('\n'))
  }
  return out
}

/** Simple staging statements → their rondo lines, or null. */
function decompileStaging(stmt: Node): string | null {
  if (stmt.type !== 'ExpressionStatement') return null
  const call = stmt['expression'] as Node
  if (!isCall(call)) return null
  const name = calleeName(call)
  const args = call['arguments'] as Node[]
  if (name === 'setCps' && args.length === 1) {
    const v = numValue(args[0]!)
    return v !== undefined ? `cps ${num(v)}` : null
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
            const v = numValue(dv)
            if (v === undefined) return null
            out += ` ${dk}:${num(v)}`
          }
        } else {
          const v = numValue(vn)
          if (v === undefined) return null
          out += ` ${k}:${num(v)}`
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
    if (jsRun.length === 0) return
    parts.push(['js', ...jsRun.flatMap((stmt) => stmt.split('\n').map((l) => (l.length > 0 ? `  ${l}` : '')))].join('\n'))
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
    const r = secConst(stmt) ?? songArrange(stmt) ?? decompileSynth(stmt) ?? decompilePlay(stmt) ?? decompileStaging(stmt)
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
