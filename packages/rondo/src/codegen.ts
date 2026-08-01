/* rondo codegen — AST → rondocode DSL source text.
 *
 * The output is a plain ES2022 script string that evalCode() runs unchanged:
 * synths as top-level `const NAME = synth(({ ctx }) => …)`, patterns as
 * `p('NAME', n('…')…)`, tempo as `setCps(x)`. We collect which synth-ctx
 * members each synth uses and emit exactly that destructure. */

import type { Binding, Comb, CtrlValue, Expr, Mod, PlayBlock, Pos, Program, RondoError, SynthBlock, TopItem, ScValue } from './ast'
import { BUILTINS } from './builtins'

const BIN_METHOD: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '^': 'pow' }

export const SCALE_MODE: Record<string, string> = {
  min: 'minor', maj: 'major', dor: 'dorian', phr: 'phrygian', lyd: 'lydian',
  mix: 'mixolydian', loc: 'locrian', minor: 'minor', major: 'major',
}

const num = (v: number): string => String(v)

/** Synth/post ctx members — when a `js{ … }` escape hatch inside a synth body
 *  references one, we must destructure it so the raw JS can see it. */
const KNOWN_CTX = [
  'note', 'gate', 'velocity', 'param', 'input',
  'sine', 'cosine', 'saw', 'square', 'tri', 'pulse', 'syncsaw', 'fm', 'wavetable', 'supersaw', 'lfsr', 'noise',
  'sample', 'granular', 'pluck', 'modal', 'pan',
  'svf', 'dualsvf', 'ladder', 'onepole', 'adsr', 'env', 'lfo', 'mic',
  'delay', 'reverb', 'chorus', 'comb', 'shape', 'compress', 'phaser', 'formant', 'vocoder',
  'width', 'transient', 'flanger',
  'eq', 'exciter', 'ott', 'bitcrush', 'mix',
]

/** Blank out string/template literal TEXT and comments so a ctx-name scan
 *  never matches quoted data (`'saw'` the string is not `saw` the ctx fn —
 *  a phantom destructure breaks the decompile fixed point). `${…}`
 *  interpolations inside templates are CODE and stay visible: masking those
 *  would UNDER-destructure and break the user's escape hatch at eval. */
export function maskJsLiterals(src: string): string {
  const out: string[] = []
  type Ctx = { k: 'code'; depth: number } | { k: 'tpl' }
  const stack: Ctx[] = [{ k: 'code', depth: 0 }]
  let i = 0
  while (i < src.length) {
    const top = stack[stack.length - 1]!
    const c = src[i]!
    const two = src.slice(i, i + 2)
    if (top.k === 'code') {
      if (two === '//') {
        while (i < src.length && src[i] !== '\n') { out.push(' '); i++ }
        continue
      }
      if (two === '/*') {
        out.push('  '); i += 2
        while (i < src.length && src.slice(i, i + 2) !== '*/') { out.push(src[i] === '\n' ? '\n' : ' '); i++ }
        if (i < src.length) { out.push('  '); i += 2 }
        continue
      }
      if (c === "'" || c === '"') {
        out.push(c); i++
        while (i < src.length && src[i] !== c && src[i] !== '\n') {
          if (src[i] === '\\') { out.push('  '); i += 2; continue }
          out.push(' '); i++
        }
        if (i < src.length && src[i] === c) { out.push(c); i++ }
        continue
      }
      if (c === '`') { out.push(c); i++; stack.push({ k: 'tpl' }); continue }
      if (c === '{') top.depth++
      if (c === '}') {
        if (top.depth === 0 && stack.length > 1) { stack.pop(); out.push(c); i++; continue } // closes a ${ }
        top.depth = Math.max(0, top.depth - 1)
      }
      out.push(c); i++
      continue
    }
    // template literal text
    if (c === '\\') { out.push('  '); i += 2; continue }
    if (c === '`') { out.push(c); i++; stack.pop(); continue }
    if (two === '${') { out.push('${'); i += 2; stack.push({ k: 'code', depth: 0 }); continue }
    out.push(c === '\n' ? '\n' : ' '); i++
  }
  return out.join('')
}

/** Expand a short scale name (`a-min`) to what .scale() expects (`a minor`). */
export function expandScale(short: string): string {
  const dash = short.indexOf('-')
  if (dash < 0) return `${short} major`
  const root = short.slice(0, dash)
  const mode = short.slice(dash + 1)
  return `${root} ${SCALE_MODE[mode] ?? mode}`
}

class SynthGen {
  uses = new Set<string>()
  /** macros this chain referenced, in first-seen order — one `const NAME =
   *  param('NAME')` is emitted per entry (see cgChain). */
  readonly macros = new Set<string>()
  constructor(
    readonly errors: RondoError[],
    readonly bound: ReadonlySet<string> = new Set(),
    readonly declaredMacros: ReadonlySet<string> = new Set(),
    /** Top-level `synth NAME` blocks. A synth is NOT a signal, so naming one
     *  in an expression is always a mistake — and one worth its own message,
     *  because the reason is structural rather than a typo. */
    readonly declaredSynths: ReadonlySet<string> = new Set(),
    /** Names a `js{ }` block brings into scope. Unknown-name checking has to
     *  know about these or the escape hatch stops working. */
    readonly jsNames: ReadonlySet<string> = new Set(),
  ) {}

  expr(e: Expr): string {
    switch (e.t) {
      case 'num':
        return num(e.v)
      case 'ident':
        if (e.name === 'note') { this.uses.add('note'); return 'note.freq' }
        if (e.name === 'gate') { this.uses.add('gate'); return 'gate' }
        if (e.name === 'input') { this.uses.add('input'); return 'input' }
        if (e.name === 'velocity') { this.uses.add('velocity'); return 'velocity' }
        // a project-wide macro, referenced bare. A LOCAL binding of the same
        // name wins (ordinary scoping), which is why this is checked second.
        if (!this.bound.has(e.name) && this.declaredMacros.has(e.name)) {
          this.uses.add('param')
          this.macros.add(e.name)
          return e.name
        }
        // a bare proc/sigop name that is NOT a binding was a call missing its
        // input (the parser left it as an ident for us to resolve)
        if (!this.bound.has(e.name) && BUILTINS[e.name] !== undefined) {
          const msg = e.name === 'env'
            ? '`env` needs time/level pairs (`env .005 1 .15 .4`) — or define a binding named env'
            : `\`${e.name}\` needs an input here (or use it as a pipeline line)`
          this.errors.push({ message: msg, line: e.pos.line, col: e.pos.col })
          return '0'
        }
        if (this.bound.has(e.name)) return e.name // a binding-local const
        if (this.declaredSynths.has(e.name)) {
          this.errors.push({
            message: `\`${e.name}\` is a synth, not a signal. A synth runs once PER VOICE, so it has no single output a line here could read — route it through a bus instead (\`bus fx\` + \`send ${e.name} 1\`, then process \`input\` there).`,
            line: e.pos.line,
            col: e.pos.col,
          })
          return '0'
        }
        if (!this.jsNames.has(e.name)) {
          // Everything else fell through to a bare JS identifier, so a typo'd
          // binding surfaced as `foo is not defined` at eval — a JavaScript
          // error, with no rondo position, for a rondo mistake.
          const known = [...this.bound].sort()
          const near = known.filter((k) => k.startsWith(e.name.slice(0, 2)))
          const hint = near.length > 0 ? ` (did you mean ${near.map((k) => `\`${k}\``).join(' or ')}?)` : ''
          this.errors.push({
            message: `unknown name \`${e.name}\` — no binding, macro or builtin here${hint}`,
            line: e.pos.line,
            col: e.pos.col,
          })
          return '0'
        }
        return e.name
      case 'enum':
        return `'${e.name}'`
      case 'bin': {
        const method = BIN_METHOD[e.op]!
        // constant-fold number⊗number (a numeric literal has no Sig methods —
        // `1.sub(env)` would be a JS SyntaxError, `(1).sub` a runtime one)
        if (e.l.t === 'num' && e.r.t === 'num') {
          const l = e.l.v, r = e.r.v
          const v = e.op === '+' ? l + r : e.op === '-' ? l - r : e.op === '*' ? l * r : e.op === '/' ? l / r : Math.pow(l, r)
          return num(v)
        }
        if (e.l.t === 'num') {
          // commutative ops flip onto the Sig operand; `num - Sig` rewrites
          // algebraically; the rest have no Sig form — error, don't emit garbage
          if (e.op === '+' || e.op === '*') return `${this.expr(e.r)}.${method}(${this.expr(e.l)})`
          if (e.op === '-') return `${this.expr(e.r)}.mul(-1).add(${this.expr(e.l)})`
          this.errors.push({
            message: `\`number ${e.op} signal\` isn't expressible — rewrite the expression (or use js{ … })`,
            line: e.pos.line, col: e.pos.col,
          })
          return '0'
        }
        return `${this.expr(e.l)}.${method}(${this.expr(e.r)})`
      }
      case 'map':
        if (e.x.t === 'num') {
          // a constant mapped through a range is a constant — fold when the
          // bounds are constant too, otherwise it's not a Sig call: error
          if (e.lo.t === 'num' && e.hi.t === 'num') return num(e.lo.v + e.x.v * (e.hi.v - e.lo.v))
          this.errors.push({ message: 'the left side of `->` must be a signal (or all three values constant)', line: e.pos.line, col: e.pos.col })
          return '0'
        }
        return `${this.expr(e.x)}.range(${this.expr(e.lo)}, ${this.expr(e.hi)})`
      case 'call':
        return this.call(e)
      case 'js':
        // escape hatch: raw JS, verbatim. Destructure any ctx members it names
        // so the raw code can see them — EXCEPT names shadowed by this chain's
        // own bindings (destructuring those too would double-declare: a
        // param `env` + `const env` is a SyntaxError, not a shadow). The scan
        // runs over a literal-masked copy (`'saw'` in a string is data) and
        // skips property/method positions (`x.mix(…)`) and object keys
        // (`{ mix: 0.8 }`) — those are not references to the ctx member.
        {
          const masked = maskJsLiterals(e.code)
          for (const name of KNOWN_CTX) {
            if (!this.bound.has(name) && new RegExp(`(?<![.\\w$])${name}\\b(?!:)`).test(masked)) this.uses.add(name)
          }
        }
        return e.code
      case 'curved':
        this.errors.push({ message: '`level:curve` is only for an env breakpoint (`env .005 1:3 .15 .4`)', line: e.pos.line, col: e.pos.col })
        return this.expr(e.level)
      case 'switch':
        this.errors.push({ message: 'switch can only appear on a binding (`fat = switch 1 9`) or at the top level (`switch fat 1 9`)', line: e.pos.line, col: e.pos.col })
        return '0'
      case 'knob':
        this.errors.push({ message: 'knob can only appear on a binding (`cutoff = knob …`)', line: e.pos.line, col: e.pos.col })
        return '0'
    }
  }

  call(e: Extract<Expr, { t: 'call' }>): string {
    const name = e.name
    // a chain binding shadows a same-named builtin: a bare reference means
    // the binding; calling the builtin with args is a hard error (destructure
    // + const would both declare the name — a JS SyntaxError at eval time)
    if (this.bound.has(name)) {
      if (e.args.length === 0 && Object.keys(e.named).length === 0) return name
      this.errors.push({ message: `binding '${name}' shadows the builtin '${name}' — rename the binding to use both`, line: e.pos.line, col: e.pos.col })
      return '0'
    }
    if (name === 'adsr') {
      const a = e.args.map((x) => this.expr(x))
      this.uses.add('adsr'); this.uses.add('gate')
      return `adsr(gate, { a: ${a[0] ?? '0'}, d: ${a[1] ?? '0'}, s: ${a[2] ?? '0'}, r: ${a[3] ?? '0'} })`
    }
    const spec = BUILTINS[name]
    if (spec === undefined) {
      this.errors.push({ message: `unknown builtin \`${name}\``, line: e.pos.line, col: e.pos.col })
      return '0'
    }
    // sig-ops are methods on the running signal, not ctx members to destructure
    if (spec.kind !== 'sigop') this.uses.add(name)

    if (name === 'eq') return this.eqCall(e)

    // positional args (parser already ordered them; procs/sigops carry the
    // input/running signal as args[0])
    // env: flat time/level pairs → ONE [[t, l], …] points argument. Built from
    // the RAW args, since a level may carry its own curve (`1:3`).
    let a: string[]
    if (name === 'env') {
      const pairs: string[] = []
      for (let i = 0; i + 1 < e.args.length; i += 2) {
        const time = this.expr(e.args[i]!)
        const lv = e.args[i + 1]!
        pairs.push(lv.t === 'curved'
          ? `[${time}, ${this.expr(lv.level)}, ${this.expr(lv.curve)}]`
          : `[${time}, ${this.expr(lv)}]`)
      }
      a = [`[${pairs.join(', ')}]`]
    } else {
      a = e.args.map((x) => this.expr(x))
    }
    // an osc/gated source with a freq default and no freq arg reads the note
    // (gated too: bare `pluck` / `modal model:bell` should pitch from the note)
    if ((spec.kind === 'osc' || spec.kind === 'gated') && spec.freqDefault === true && a.length === 0) {
      this.uses.add('note')
      a.push('note.freq')
    }
    // fill omitted positionals from the registry (see BuiltinSpec.posDefault):
    // a trailing opts object must never slide into a positional slot.
    if (spec.posDefault !== undefined) {
      const implicit = spec.kind === 'proc' || spec.kind === 'sigop' ? 1 : 0
      for (let k = a.length - implicit; k < spec.pos.length; k++) a.push(spec.posDefault[k]!)
    }

    // named args → an opts object (aliases applied; enums quoted by expr();
    // bool kinds turn a truthy number into `true`)
    const parts: string[] = []
    for (const [key, kind] of Object.entries(spec.named ?? {})) {
      if (name === 'reverb' && key === 'mix') continue // wet/dry sugar, below
      const v = e.named[key]
      if (v === undefined) continue
      const out = spec.alias?.[key] ?? key
      parts.push(`${out}: ${kind === 'bool' ? (v.t === 'num' && v.v !== 0 ? 'true' : 'false') : this.expr(v)}`)
    }
    for (const [key, dflt] of Object.entries(spec.defaults ?? {})) {
      if (!parts.some((p) => p.startsWith(`${key}:`))) parts.push(`${key}: ${e.named[key] !== undefined ? this.expr(e.named[key]!) : dflt}`)
    }
    // warn on named args the builtin doesn't declare — silent drops lie
    for (const key of Object.keys(e.named)) {
      if (key === 'mix' && name === 'reverb') continue
      if (!(key in (spec.named ?? {}))) {
        this.errors.push({ message: `\`${name}\` has no \`${key}:\` argument`, line: e.pos.line, col: e.pos.col })
      }
    }
    const opts = parts.length > 0 ? `, { ${parts.join(', ')} }` : ''

    if (spec.kind === 'sigop') {
      // a Sig method on the input: input.tanh() / input.clip(-1, 1) / input.mix(other, t)
      const [input, ...rest] = a
      // a fully-constant pipe has no Sig methods — `220.fold()` is not even
      // valid JS. Same rule as constant folding: error, never emit broken code.
      if (input !== undefined && /^-?(\d+\.?\d*|\.\d+)$/.test(input)) {
        this.errors.push({
          message: `the signal before \`${name}\` is a plain number (${input}) — ${name} needs a signal`,
          line: e.pos.line, col: e.pos.col,
        })
        return '0'
      }
      return `${input}.${name}(${rest.join(', ')})`
    }
    if (spec.kind === 'gated') {
      this.uses.add('gate')
      return `${name}(gate${a.length > 0 ? ', ' + a.join(', ') : ''}${opts})`
    }
    if (name === 'reverb' && e.named.mix !== undefined) {
      // `mix:` is wet/dry sugar — reverb is wet-only, so blend it over the dry.
      // Bind the input once (an inline arrow) so a long upstream chain isn't
      // emitted twice — duplicated nodes waste the graph.
      return `((x) => x.mix(reverb(x${opts}), ${this.expr(e.named.mix)}))(${a[0]})`
    }
    return `${name}(${a.join(', ')}${opts})`
  }

  /** eq: regroup the parser's flat [input, enum, num…] args into band objects.
   *  hp/lp numbers mean freq q; peak/shelves mean freq gain q. */
  eqCall(e: Extract<Expr, { t: 'call' }>): string {
    const input = e.args[0] !== undefined ? this.expr(e.args[0]) : 'input'
    const bands: string[] = []
    let cur: string[] | null = null
    let keys: string[] = []
    const close = (): void => { if (cur !== null) bands.push(`{ ${cur.join(', ')} }`) }
    for (const x of e.args.slice(1)) {
      if (x.t === 'enum') {
        if (cur !== null && cur.length < 2) this.errors.push({ message: 'eq band is missing its freq', line: x.pos.line, col: x.pos.col })
        close()
        cur = [`type: '${x.name}'`]
        keys = x.name === 'hp' || x.name === 'lp' ? ['freq', 'q'] : ['freq', 'gain', 'q']
      } else if (cur !== null) {
        const k = keys.shift()
        if (k === undefined) { this.errors.push({ message: 'too many numbers in an eq band', line: e.pos.line, col: e.pos.col }); continue }
        cur.push(`${k}: ${this.expr(x)}`)
      }
    }
    if (cur !== null && cur.length < 2) this.errors.push({ message: 'eq band is missing its freq', line: e.pos.line, col: e.pos.col })
    close()
    for (const key of Object.keys(e.named)) this.errors.push({ message: `\`eq\` has no \`${key}:\` argument`, line: e.pos.line, col: e.pos.col })
    return `eq(${input}, [${bands.join(', ')}])`
  }

  bindingRHS(b: Binding): string {
    if (b.expr.t === 'switch') {
      // the same param() a knob emits — a switch IS a param with two values,
      // so setParam, MIDI mapping and both editor scanners need no new case
      this.uses.add('param')
      return `param('${b.name}', ${num(b.expr.a)}, { values: [${num(b.expr.a)}, ${num(b.expr.b)}] })`
    }
    if (b.expr.t === 'knob') {
      this.uses.add('param')
      const k = b.expr
      const curve = k.curve ? `, curve: '${k.curve}'` : ''
      return `param('${b.name}', ${this.expr(k.def)}, { min: ${this.expr(k.lo)}, max: ${this.expr(k.hi)}${curve} })`
    }
    return this.expr(b.expr)
  }
}

/** Topologically order bindings so each `const` is declared before its uses. */
function orderBindings(bindings: Binding[], errors: RondoError[]): Binding[] {
  const byName = new Map(bindings.map((b) => [b.name, b]))
  const refs = (e: Expr): string[] => {
    switch (e.t) {
      case 'ident': return byName.has(e.name) ? [e.name] : []
      case 'bin': return [...refs(e.l), ...refs(e.r)]
      case 'map': return [...refs(e.x), ...refs(e.lo), ...refs(e.hi)]
      case 'call': return [...e.args.flatMap(refs), ...Object.values(e.named).flatMap(refs)]
      case 'curved': return [...refs(e.level), ...refs(e.curve)]
      case 'switch': return [] // two literals; nothing to order against
      case 'knob': return [...refs(e.def), ...refs(e.lo), ...refs(e.hi)]
      case 'js': return []
      default: return []
    }
  }
  const out: Binding[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (b: Binding): void => {
    const s = state.get(b.name)
    if (s === 'done') return
    if (s === 'visiting') { errors.push({ message: `binding cycle involving '${b.name}'`, line: b.pos.line, col: b.pos.col }); return }
    state.set(b.name, 'visiting')
    for (const r of refs(b.expr)) { const dep = byName.get(r); if (dep && dep !== b) visit(dep) }
    state.set(b.name, 'done')
    out.push(b)
  }
  for (const b of bindings) visit(b)
  return out
}

/** Render one `(ctx) => …` chain function: topo-sorted bindings + `return`. */
function cgChain(
  bindings: Binding[],
  spine: Expr,
  headOrder: string[],
  errors: RondoError[],
  opts: {
    macros?: ReadonlySet<string>
    noMacros?: { why: string; pos: Pos }
    synths?: ReadonlySet<string>
    jsNames?: ReadonlySet<string>
  } = {},
): string {
  const g = new SynthGen(
    errors,
    new Set(bindings.map((b) => b.name)),
    opts.macros,
    opts.synths,
    opts.jsNames,
  )
  const ordered = orderBindings(bindings, errors)
  const bindingLines = ordered.map((b) => `  const ${b.name} = ${g.bindingRHS(b)}`)
  const spineStr = g.expr(spine)
  // A macro reference becomes an ordinary param with no default: the numbers
  // live on the macro line, so no use site can drift from another. These come
  // FIRST — they depend on nothing, and a binding may be built from them.
  const macroLines = [...g.macros].map((m) => `  const ${m} = param('${m}')`)
  if (macroLines.length > 0 && opts.noMacros !== undefined) {
    errors.push({ message: opts.noMacros.why, line: opts.noMacros.pos.line, col: opts.noMacros.pos.col })
  }
  // a binding may reuse a builtin's name (lfo = …) — but not while the chain
  // ALSO calls that builtin: the destructured ctx member and the const would
  // collide ("Identifier 'x' has already been declared" at eval time)
  for (const b of bindings) {
    if (g.uses.has(b.name)) {
      errors.push({ message: `binding '${b.name}' shadows the builtin '${b.name}' used in this chain — rename the binding`, line: b.pos?.line ?? 1, col: b.pos?.col ?? 1 })
    }
  }
  const head = headOrder.filter((n) => g.uses.has(n))
  const rest = [...g.uses].filter((n) => !head.includes(n)).sort()
  const destructure = [...head, ...rest].join(', ')
  const body = [...macroLines, ...bindingLines, `  return ${spineStr}`].join('\n')
  return `({ ${destructure} }) => {\n${body}\n}`
}

function cgSynth(
  block: SynthBlock,
  errors: RondoError[],
  macros: ReadonlySet<string>,
  scope: { synths: ReadonlySet<string>; jsNames: ReadonlySet<string> },
): string {
  const voice = cgChain(block.bindings, block.spine, ['note', 'gate', 'param'], errors, { macros, ...scope })
  // header voice options: `synth acid mono glide:.08` → the synth() opts arg
  const opts = block.voiceOpts !== undefined
    ? `{ ${Object.entries(block.voiceOpts).map(([k, v]) => `${k}: ${v === true ? 'true' : num(v as number)}`).join(', ')} }`
    : undefined
  if (block.post) {
    const post = cgChain(block.postBindings ?? [], block.post, ['input', 'param'], errors, { macros, ...scope })
    return `const ${block.name} = synth(${voice}, ${post}${opts !== undefined ? `, ${opts}` : ''})`
  }
  return `const ${block.name} = synth(${voice}${opts !== undefined ? `, ${opts}` : ''})`
}

const q = (s: string): string => `'${s.replace(/'/g, "\\'")}'`

function cgCtrlValue(v: CtrlValue): string {
  if (v.kind === 'num') return num(v.v)
  if (v.kind === 'mini') return q(v.text)
  let s = v.sig
  if (v.lo !== undefined && v.hi !== undefined) s += `.range(${num(v.lo)}, ${num(v.hi)})`
  if (v.slow !== undefined) s += `.slow(${num(v.slow)})`
  if (v.fast !== undefined) s += `.fast(${num(v.fast)})`
  return s
}

/** A combinator → a chained method call. `struct` wraps its arg in mini();
 *  word arguments are quoted (`arp updown` → .arp('updown')), numbers stay raw. */
function cgComb(c: Comb): string {
  const name = c.name === 'degradeby' ? 'degradeBy' : c.name
  if (name === 'struct') return `struct(mini(${q(c.args[0] ?? '')}))`
  if (name === 'rev' || name === 'degrade' || name === 'palindrome') return `${name}()`
  const args = c.args.map((arg) => (/^-?\d*\.?\d+$/.test(arg) ? String(Number(arg)) : q(arg)))
  return `${name}(${args.join(', ')})`
}

/** A NUMERIC modifier's mini value may hold numbers, rests and the grouping
 *  operators — never a bare word.
 *
 *  `dur: bright / 7300` used to compile to `.dur('bright / 7300')`, a mini
 *  string, and every event came out with dur set to the STRING "bright". No
 *  error, no sound change you could trace: the scheduler wants a number and
 *  quietly got a word. The mistake is an easy one to make, because `bright`
 *  IS a real name — just a synth param, which lives in the audio graph and
 *  cannot be read from the pattern layer at all. */
function checkNumericMini(
  name: string,
  v: CtrlValue,
  pos: Pos,
  errors: RondoError[],
  macros: ReadonlySet<string>,
): void {
  if (v.kind !== 'mini') return
  const word = /(^|[\s<>[\]()])([a-zA-Z_]\w*)/.exec(v.text)
  if (word === null) return
  // `curve`/`shape` ARE legal here — reaching this means the value did not
  // parse as one, and blaming the synth would send you looking in the wrong
  // place entirely
  if (word[2] === 'curve' || word[2] === 'shape') {
    errors.push({
      message: word[2] === 'curve'
        ? `\`${name}: ${v.text}\` — a curve lane takes fraction/level PAIRS (\`${name}: curve 8 1 8 .2\`).`
        : `\`${name}: ${v.text}\` — a named shape takes a name and a length in cycles (\`${name}: shape swell 16\`).`,
      line: pos.line,
      col: pos.col,
    })
    return
  }
  if (macros.has(word[2]!)) {
    // The word IS a macro, so it is legal here in principle — we only reach
    // this when cgMacroCtrl could not express the expression (a reciprocal,
    // say). Falling through to a mini string would be the silent-garbage the
    // whole check exists to stop, so say what happened.
    errors.push({
      message: `\`${name}: ${v.text}\` can't be expressed here — a macro modifier takes + - * and / with the macro on the left (\`${name}: ${word[2]!} / 7300\`, \`${name}: 0.6 - ${word[2]!} / 7300\`).`,
      line: pos.line,
      col: pos.col,
    })
    return
  }
  errors.push({
    message: `\`${name}:\` takes numbers, not \`${word[2]}\` — a knob or binding lives in the synth, and a play block can't read it. Use a number, a signal (\`${name}: sine .1..2 slow:4\`) or alternation (\`${name}: <.5 1>\`).`,
    line: pos.line,
    col: pos.col,
  })
}

/**
 * A numeric modifier's value, when it is arithmetic over MACROS.
 *
 * `dur: bright / 7300` -> `macroval('bright').div(7300)`. `dur`, `gain` and
 * `pan` are structural — the scheduler consumes them per event and they never
 * reach the engine — so a synth param could never drive one. macroval reads
 * the same macro from the pattern side, and Pattern already carries the same
 * .add/.sub/.mul/.div the audio side does, so the emitted shape is identical.
 *
 * Returns null when the text is not pure macro arithmetic, leaving the caller
 * to emit a plain mini value or reject an unknown word as before.
 */
function cgMacroCtrl(text: string, macros: ReadonlySet<string>): string | null {
  if (macros.size === 0) return null
  const toks = text.match(/[a-zA-Z_]\w*|\d*\.?\d+|[-+*/()]/g)
  if (toks === null || toks.join('') !== text.replace(/\s+/g, '')) return null
  const names = toks.filter((t) => /^[a-zA-Z_]/.test(t))
  if (names.length === 0 || !names.every((n) => macros.has(n))) return null
  const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }
  const METHOD: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }
  let i = 0
  // `lit` tracks whether the head is still a bare NUMBER: a number has no
  // .sub, so `0.6 - bright` has to lift its head into a pattern first
  type Node = { js: string; lit: boolean }
  const atom = (): Node | null => {
    const t = toks[i]
    if (t === undefined) return null
    if (t === '(') {
      i++
      const v = climb(1)
      if (v === null || toks[i] !== ')') return null
      i++
      return v
    }
    if (/^[a-zA-Z_]/.test(t)) { i++; return { js: `macroval('${t}')`, lit: false } }
    if (/^\d*\.?\d+$/.test(t)) { i++; return { js: num(Number(t)), lit: true } }
    return null
  }
  const climb = (min: number): Node | null => {
    let lhs = atom()
    if (lhs === null) return null
    for (;;) {
      const t = toks[i]
      if (t === undefined || PREC[t] === undefined || PREC[t]! < min) break
      i++
      const rhs = climb(PREC[t]! + 1)
      if (rhs === null) return null
      if (lhs.lit) {
        // a NUMBER on the left has no .add, so commute onto the pattern — the
        // same shape the synth side emits for `0.6 - norm * 0.55`
        const a: string = lhs.js
        if (t === '+') lhs = { js: `${rhs.js}.add(${a})`, lit: false }
        else if (t === '-') lhs = { js: `${rhs.js}.mul(-1).add(${a})`, lit: false }
        else if (t === '*') lhs = { js: `${rhs.js}.mul(${a})`, lit: false }
        else return null // `2 / bright` has no reciprocal combinator to lean on
        continue
      }
      lhs = { js: `${lhs.js}.${METHOD[t]!}(${rhs.js})`, lit: false }
    }
    return lhs
  }
  const out = climb(1)
  if (out === null || i !== toks.length || out.lit) return null
  return out.js
}

function cgMod(m: Mod, errors: RondoError[], macros: ReadonlySet<string>): string {
  const macroVal = (m.kind === 'ctrl' || m.kind === 'method') && m.value.kind === 'mini'
    ? cgMacroCtrl(m.value.text, macros)
    : null
  switch (m.kind) {
    case 'ctrl':
      if (macroVal === null) checkNumericMini(m.name, m.value, m.pos, errors, macros)
      return `.ctrl(${q(m.name)}, ${macroVal ?? cgCtrlValue(m.value)})`
    case 'method':
      if (macroVal === null) checkNumericMini(m.name, m.value, m.pos, errors, macros)
      return `.${m.name}(${macroVal ?? cgCtrlValue(m.value)})`
    case 'fncomb': {
      const pre = m.pre.map(num)
      return `.${m.name}(${[...pre, `x => x.${cgComb(m.comb)}`].join(', ')})`
    }
    case 'comb': return `.${cgComb(m.comb)}`
  }
}

/** Pick the pattern entry point for a notation line: an UPPERCASE root means
 *  chord names (`<Am F C G>`, `Dm7`); lowercase letters mean note names
 *  (`c4 e4`); bare digits/rests mean scale degrees. */
function entryFor(notation: string): 'chord' | 'note' | 'n' {
  if (/(^|[\s<[(])[A-G][#b]?[A-Za-z0-9]*/.test(notation)) return 'chord'
  // A `b` glued to DIGITS is an accidental on a scale degree (`3b`), not the
  // note B. Without this, one flattened degree flipped the whole line to
  // note(), which then read `0` as a note name and dropped the scale on the
  // floor — silently, since note() accepts a `.scale()` call and ignores it.
  if (/[a-g]/.test(notation.replace(/(?<=\d)[#b]+/g, ''))) return 'note'
  return 'n'
}

/** Split per-step velocities out of a beat line: `kick ~ kick:.6 ~` →
 *  notes `kick ~ kick ~` + gains `1 ~ 0.6 ~`. STRUCTURE-PRESERVING (only the
 *  word tokens are rewritten), so it works inside any mini nesting — the
 *  gain pattern always lines up with the note pattern's events. Exported for
 *  the editor's step sequencer (its playhead matches the STRIPPED text). */
export function splitBeatVelocities(notation: string): { notes: string; gains: string; has: boolean } {
  let has = false
  const notes = notation.replace(/([a-zA-Z_]\w*):(\d*\.?\d+)/g, (_, w: string) => { has = true; return w })
  const gains = notation.replace(/([a-zA-Z_]\w*)(?::(\d*\.?\d+))?/g, (_, __, v: string | undefined) =>
    // normalize spellings (`.6` → `0.6`) so decompile → recompile is stable
    v !== undefined ? String(Number(v)) : '1')
  return { notes, gains, has }
}

/** Order a play/sing block's modifiers for emission: SIGNAL-driven lines
 *  (`cutoff: sine 200..2400 slow:4`, `wet: rise 8`) move AFTER everything
 *  else. A signal is modulation in ABSOLUTE time — `every 4: rev` should
 *  remix the notes, never run the sweep backwards (a combinator applied
 *  outside a .ctrl reverses the signal's query time on affected cycles).
 *  Number/mini values keep source order: step-tied accents like `gain: 1 .5`
 *  legitimately travel with the notes they decorate. */
function orderMods(mods: Mod[]): Mod[] {
  const isSignal = (m: Mod): boolean => (m.kind === 'ctrl' || m.kind === 'method') && m.value.kind === 'sig'
  return [...mods.filter((m) => !isSignal(m)), ...mods.filter(isSignal)]
}

/** The pattern EXPRESSION for a play block (no p() wrapper) — sections stack
 *  these; a top-level play wraps it in p(). */
function cgPlayPat(block: PlayBlock, errors: RondoError[], macros: ReadonlySet<string>): string {
  const lineExpr = (notation: string): string => {
    // `beat` blocks: words are synth names → s('kick hat kick hat');
    // `word:v` velocity suffixes become an aligned per-voice gain pattern
    if (block.entry === 'sound') {
      const { notes, gains, has } = splitBeatVelocities(notation)
      return has ? `s(${q(notes)}).gain(${q(gains)})` : `s(${q(notation)})`
    }
    // `irand N [seg:M]`: N random degrees, M steps per cycle (default 8)
    const ir = /^irand[ \t]+(\d+)(?:[ \t]+seg:(\d+))?$/.exec(notation)
    if (ir) return `n(irand(${ir[1]}).segment(${ir[2] ?? '8'}))`
    return `${entryFor(notation)}(${q(notation)})`
  }
  // multiple notation lines stack into voices, like the JS stack(n(…), n(…))
  let pat = block.voices !== undefined && block.voices.length > 0
    ? `stack(${[block.notation, ...block.voices.map((v) => v.notation)].map(lineExpr).join(', ')})`
    : lineExpr(block.notation)
  if (block.scale) pat += `.scale('${expandScale(block.scale)}')`
  // `overchord: <Am7 F>` re-reads the degrees as CHORD degrees. It applies
  // BEFORE .sound(), like the JS twin: it rewrites the notes themselves, and
  // every later modifier (a .ctrl sweep, a gain) decorates the result.
  const over = block.mods.find((m): m is Extract<Mod, { kind: 'ctrl' }> => m.kind === 'ctrl' && m.name === 'overchord')
  if (over !== undefined) {
    if (over.value.kind !== 'mini') {
      errors.push({ message: '`overchord:` takes chord names (`overchord: <Am7 Fmaj7 Cmaj7 G>`)', line: over.pos.line, col: over.pos.col })
    } else {
      pat += `.overChord(chord(${q(over.value.text)}))`
    }
  }
  if (block.entry !== 'sound') pat += `.sound('${block.synthName ?? block.name}')`
  for (const m of orderMods(block.mods)) {
    if (m === over) continue // already emitted, ahead of .sound()
    pat += cgMod(m, errors, macros)
  }
  return pat
}

function cgPlay(block: PlayBlock, errors: RondoError[], macros: ReadonlySet<string>): string {
  return `p('${block.name}', ${cgPlayPat(block, errors, macros)})`
}

/** `sing NAME [voice:V]` → p(NAME, sing([voice,] lyrics, notes, { name, post? })<mods>).
 *  Lyric/melody line pairs join with single spaces — mini treats the joined
 *  strings exactly like the multi-line template literals the JS API uses. */
function cgSing(block: Extract<TopItem, { t: 'sing' }>, errors: RondoError[], macros: ReadonlySet<string>): string {
  const lyrics = block.lyrics.map((l) => l.text).join(' ')
  const notes = block.notes.map((l) => l.text).join(' ')
  const voiceArg = block.voice !== undefined ? `${q(block.voice)}, ` : ''
  const opts: string[] = [`name: ${q(block.name)}`]
  // `cycles: N` is an OPT (how many bars the phrase spans), not a pattern
  // method — a real song phrase runs several cycles, and the clip length +
  // trigger spacing both follow from it.
  const mods: Mod[] = []
  for (const m of block.mods) {
    if (m.kind === 'ctrl' && m.name === 'cycles') {
      const v = m.value
      if (v.kind !== 'num' || !Number.isInteger(v.v) || v.v < 1) {
        errors.push({ message: '`cycles:` needs a whole number of cycles (1 or more)', line: m.pos.line, col: m.pos.col })
        continue
      }
      opts.push(`cycles: ${num(v.v)}`)
      continue
    }
    mods.push(m)
  }
  if (block.post) {
    opts.push(`post: ${cgChain(block.postBindings ?? [], block.post, ['input', 'param'], errors, { macros })}`)
  }
  let pat = `sing(${voiceArg}${q(lyrics)}, ${q(notes)}, { ${opts.join(', ')} })`
  for (const m of orderMods(mods)) pat += cgMod(m, errors, macros)
  return `p(${q(block.name)}, ${pat})`
}

function cgSection(item: Extract<TopItem, { t: 'section' }>, errors: RondoError[], macros: ReadonlySet<string>): string {
  const pats = item.plays.map((pb) => cgPlayPat(pb, errors, macros))
  const body = pats.length === 1 ? pats[0]! : `stack(${pats.join(', ')})`
  return `const __sec_${item.name} = ${body}`
}

/** A sidechain amount: a literal, or `macroNum('x')` when it follows a macro.
 *  sidechain() takes plain NUMBERS (the duck depth is captured at eval, not
 *  read per sample), so a macro reference resolves at eval time — which is
 *  exactly when a switch tap re-runs the program. */
const scNum = (v: ScValue): string => (typeof v === 'number' ? num(v) : `macroNum('${v.macro}')`)

function cgSidechain(
  item: Extract<TopItem, { t: 'sidechain' }>,
  errors: RondoError[],
  macroNames: ReadonlySet<string>,
): string {
  // A bare word here must NAME a declared macro or switch. Accepting an
  // unknown one would resolve to 0 at eval — a pump silently turned off by a
  // typo, which is worse than the syntax error this used to be.
  const check = (v: ScValue, key: string): ScValue => {
    if (typeof v !== 'number' && !macroNames.has(v.macro)) {
      const known = [...macroNames].sort().join(', ')
      errors.push({
        message: `\`${key}:${v.macro}\` — no macro or switch named '${v.macro}'${known === '' ? '' : ` (have: ${known})`}. sidechain amounts are numbers, or the name of a project control.`,
        line: item.pos.line,
        col: item.pos.col,
      })
    }
    return v
  }
  const parts: string[] = []
  if (item.depth !== undefined) parts.push(`depth: ${scNum(check(item.depth, 'depth'))}`)
  if (item.release !== undefined) parts.push(`release: ${scNum(check(item.release, 'release'))}`)
  const duckEntries = Object.entries(item.duck)
  if (duckEntries.length > 0) parts.push(`duck: { ${duckEntries.map(([k, v]) => `${k}: ${scNum(check(v, k))}`).join(', ')} }`)
  return `sidechain('${item.source}'${parts.length > 0 ? `, { ${parts.join(', ')} }` : ''})`
}

function cgMaster(item: Extract<TopItem, { t: 'master' }>): string {
  const parts = Object.entries(item.opts).map(([k, v]) => `${k}: ${num(v)}`)
  return `masterCompress(${parts.length > 0 ? `{ ${parts.join(', ')} }` : ''})`
}

/** `scaledef pelog 0 1.2 2.7 …` → defineScale('pelog', [0, 1.2, 2.7, …]),
 *  and with a unit word → the object spec defineScale also takes. */
function cgScaleDef(item: Extract<TopItem, { t: 'scaledef' }>): string {
  const list = `[${item.values.map(num).join(', ')}]`
  if (item.unit === undefined) return `defineScale('${item.name}', ${list})`
  const periodKey = item.unit === 'cents' ? 'periodCents' : 'periodRatio'
  const period = item.period !== undefined ? `, ${periodKey}: ${num(item.period)}` : ''
  return `defineScale('${item.name}', { ${item.unit}: ${list}${period} })`
}

/** `curvedef swell .25 1 .75 .2` → curvedef('swell', [[0.25, 1], [0.75, 0.2]]). */
function cgCurveDef(item: Extract<TopItem, { t: 'curvedef' }>): string {
  const pts = item.points.map((p) =>
    p.curve !== undefined ? `[${num(p.frac)}, ${num(p.level)}, ${num(p.curve)}]` : `[${num(p.frac)}, ${num(p.level)}]`)
  return `curvedef('${item.name}', [${pts.join(', ')}])`
}

/** `wavedef vox 1 .3 / .5 1 .6` → defineWavetable('vox', [[1, 0.3], …]). */
function cgWaveDef(item: Extract<TopItem, { t: 'wavedef' }>): string {
  const frames = item.frames.map((f) => `[${f.map(num).join(', ')}]`).join(', ')
  return `defineWavetable('${item.name}', [${frames}])`
}

function cgBus(item: Extract<TopItem, { t: 'bus' }>, errors: RondoError[], macros: ReadonlySet<string>): string {
  // A bus has no notes and no .ctrl route, so a param in its FX chain could
  // never change — the engine rejects one outright. Say so here, pointing at
  // the bus, rather than letting the eval fail with the engine's wording.
  const fx = cgChain(item.bindings, item.fx, ['input'], errors, {
    macros,
    noMacros: { why: 'a macro can\'t be used in a bus — a bus has no notes or .ctrl route, so it could never change (use a fixed value)', pos: item.pos },
  })
  const sendEntries = Object.entries(item.sends)
  const sends = sendEntries.length > 0 ? `, { ${sendEntries.map(([k, v]) => `${k}: ${num(v)}`).join(', ')} }` : ''
  return `bus('${item.name}', ${fx}${sends})`
}

/** `macro bright 1480 500..7300 log` → macro('bright', 1480, { … }). */
function cgMacro(item: Extract<TopItem, { t: 'macro' }>): string {
  if (item.values !== undefined) {
    const [a, b] = item.values
    return `macro('${item.name}', ${num(a)}, { values: [${num(a)}, ${num(b)}] })`
  }
  const parts: string[] = []
  if (item.lo !== undefined) parts.push(`min: ${num(item.lo)}`)
  if (item.hi !== undefined) parts.push(`max: ${num(item.hi)}`)
  if (item.curve !== undefined) parts.push(`curve: '${item.curve}'`)
  return `macro('${item.name}', ${num(item.def)}${parts.length > 0 ? `, { ${parts.join(', ')} }` : ''})`
}

function cgVisual(item: Extract<TopItem, { t: 'visual' }>): string {
  // WGSL has no backticks/template holes, but escape defensively
  const body = item.wgsl.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  return `visual(\`\n${body}\n\`)`
}

export function codegen(program: Program, errors: RondoError[]): string {
  const sections = program.items.filter((it): it is Extract<TopItem, { t: 'section' }> => it.t === 'section')
  const song = program.items.find((it): it is Extract<TopItem, { t: 'song' }> => it.t === 'song')
  // scaledef lines HOIST to the top: .scale('c pelog') parses eagerly at
  // eval time, so a tuning must be registered before any play that uses it,
  // wherever the scaledef sits in the rondo source. wavedef lines hoist for
  // the same reason, one stage earlier: synth() eager-compiles its graph and
  // the wavetable kernel resolves table names at CONSTRUCTION, so a table
  // must be registered before any synth that names it.
  // MACROS hoist for the same reason wavetables do: synth() eager-compiles,
  // and param('bright') resolves its bounds from the registry at that moment,
  // so the declaration must run first wherever the musician wrote it.
  const macroNames = new Set(
    program.items.filter((it): it is Extract<TopItem, { t: 'macro' }> => it.t === 'macro').map((it) => it.name),
  )
  const synthNames = new Set(
    program.items.filter((it): it is SynthBlock => it.t === 'synth').map((it) => it.name),
  )
  // `js{ }` blocks bring their own names into scope; unknown-name checking has
  // to know about them or the escape hatch stops working
  const jsNames = new Set<string>()
  for (const it of program.items) {
    if (it.t !== 'raw') continue
    for (const m of it.code.matchAll(/(?:^|\n)\s*(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) {
      jsNames.add(m[1]!)
    }
  }
  const scope = { synths: synthNames, jsNames }
  for (const it of program.items) {
    if (it.t !== 'macro') continue
    if (BUILTINS[it.name] !== undefined) {
      errors.push({ message: `macro '${it.name}' collides with the builtin '${it.name}' — rename the macro`, line: it.pos.line, col: it.pos.col })
    }
  }
  const isDef = (it: TopItem): boolean =>
    it.t === 'scaledef' || it.t === 'wavedef' || it.t === 'macro' || it.t === 'curvedef'
  const items = [...program.items.filter(isDef), ...program.items.filter((it) => !isDef(it))]
  const parts = items.map((item: TopItem) => {
    if (item.t === 'synth') return cgSynth(item, errors, macroNames, scope)
    if (item.t === 'play') return cgPlay(item, errors, macroNames)
    if (item.t === 'sing') return cgSing(item, errors, macroNames)
    if (item.t === 'raw') return item.code // escape hatch, verbatim
    if (item.t === 'sidechain') return cgSidechain(item, errors, macroNames)
    if (item.t === 'master') return cgMaster(item)
    if (item.t === 'scaledef') return cgScaleDef(item)
    if (item.t === 'wavedef') return cgWaveDef(item)
    if (item.t === 'curvedef') return cgCurveDef(item)
    if (item.t === 'bus') return cgBus(item, errors, macroNames)
    if (item.t === 'macro') return cgMacro(item)
    if (item.t === 'visual') return cgVisual(item)
    if (item.t === 'section') return cgSection(item, errors, macroNames)
    if (item.t === 'song') return '' // assembled below, after all sections exist
    // the tempo line, in the unit it was written in: `bpm 128` → setBpm(128),
    // `cps .5333` → setCps(0.5333). Keeping the unit in the JS is what lets
    // the decompiler hand the same spelling back (see decompile.ts).
    return item.unit === 'bpm' ? `setBpm(${num(item.value)})` : `setCps(${num(item.value)})`
  })
  // sections → ONE arranged 'song' pattern, in `song` order (or definition
  // order without a song line)
  if (sections.length > 0) {
    const byName = new Map(sections.map((s) => [s.name, s]))
    const order = song !== undefined ? song.order : sections.map((s) => s.name)
    const entries: string[] = []
    for (const name of order) {
      const sec = byName.get(name)
      if (sec === undefined) {
        errors.push({ message: `song references unknown section '${name}'`, line: song?.pos.line ?? 1, col: song?.pos.col ?? 1 })
        continue
      }
      entries.push(`[${num(sec.len)}, __sec_${name}]`)
    }
    parts.push(`p('song', arrange(${entries.join(', ')}))`)
  } else if (song !== undefined) {
    errors.push({ message: 'song needs section blocks to sequence', line: song.pos.line, col: song.pos.col })
  }
  return parts.filter((s) => s !== '').join('\n\n') + '\n'
}
