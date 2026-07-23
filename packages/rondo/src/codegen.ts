/* rondo codegen — AST → rondocode DSL source text.
 *
 * The output is a plain ES2022 script string that evalCode() runs unchanged:
 * synths as top-level `const NAME = synth(({ ctx }) => …)`, patterns as
 * `p('NAME', n('…')…)`, tempo as `setCps(x)`. We collect which synth-ctx
 * members each synth uses and emit exactly that destructure. */

import type { Binding, Expr, Program, RondoError, SynthBlock, TopItem } from './ast'

const BIN_METHOD: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '^': 'pow' }

const SCALE_MODE: Record<string, string> = {
  min: 'minor', maj: 'major', dor: 'dorian', phr: 'phrygian', lyd: 'lydian',
  mix: 'mixolydian', loc: 'locrian', minor: 'minor', major: 'major',
}

const num = (v: number): string => String(v)

/** Expand a short scale name (`a-min`) to what .scale() expects (`a minor`). */
function expandScale(short: string): string {
  const dash = short.indexOf('-')
  if (dash < 0) return `${short} major`
  const root = short.slice(0, dash)
  const mode = short.slice(dash + 1)
  return `${root} ${SCALE_MODE[mode] ?? mode}`
}

class SynthGen {
  uses = new Set<string>()
  constructor(readonly errors: RondoError[]) {}

  expr(e: Expr): string {
    switch (e.t) {
      case 'num':
        return num(e.v)
      case 'ident':
        if (e.name === 'note') { this.uses.add('note'); return 'note.freq' }
        if (e.name === 'gate') { this.uses.add('gate'); return 'gate' }
        return e.name // a binding-local const
      case 'bin': {
        const method = BIN_METHOD[e.op]!
        // both operands are Sigs normally; if the left is a bare number and the
        // op is commutative, call the method on the (Sig) right operand instead
        if (e.l.t === 'num' && (e.op === '+' || e.op === '*')) return `${this.expr(e.r)}.${method}(${this.expr(e.l)})`
        return `${this.expr(e.l)}.${method}(${this.expr(e.r)})`
      }
      case 'map':
        return `${this.expr(e.x)}.range(${this.expr(e.lo)}, ${this.expr(e.hi)})`
      case 'call':
        return this.call(e)
      case 'knob':
        this.errors.push({ message: 'knob can only appear on a binding (`cutoff = knob …`)', line: e.pos.line, col: e.pos.col })
        return '0'
    }
  }

  call(e: Extract<Expr, { t: 'call' }>): string {
    const a = e.args.map((x) => this.expr(x))
    const name = e.name
    if (name === 'saw' || name === 'square' || name === 'sine' || name === 'tri') {
      this.uses.add(name)
      if (a.length === 0) { this.uses.add('note'); return `${name}(note.freq)` }
      return `${name}(${a[0]})`
    }
    if (name === 'adsr') {
      this.uses.add('adsr'); this.uses.add('gate')
      return `adsr(gate, { a: ${a[0] ?? '0'}, d: ${a[1] ?? '0'}, s: ${a[2] ?? '0'}, r: ${a[3] ?? '0'} })`
    }
    if (name === 'ladder') {
      this.uses.add('ladder')
      return `ladder(${a[0]}, ${a[1]}, { res: ${e.named.res ? this.expr(e.named.res) : '0.5'} })`
    }
    if (name === 'svf') {
      this.uses.add('svf')
      const opts: string[] = []
      if (e.named.res) opts.push(`res: ${this.expr(e.named.res)}`)
      if (e.named.mode) opts.push(`mode: '${(e.named.mode as { t: 'ident'; name: string }).name}'`)
      return `svf(${a[0]}, ${a[1]}${opts.length ? `, { ${opts.join(', ')} }` : ''})`
    }
    if (name === 'onepole') {
      this.uses.add('onepole')
      return `onepole(${a[0]}, ${a[1]})`
    }
    this.errors.push({ message: `unknown builtin \`${name}\``, line: e.pos.line, col: e.pos.col })
    return '0'
  }

  bindingRHS(b: Binding): string {
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
      case 'knob': return [...refs(e.def), ...refs(e.lo), ...refs(e.hi)]
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

function cgSynth(block: SynthBlock, errors: RondoError[]): string {
  const g = new SynthGen(errors)
  const ordered = orderBindings(block.bindings, errors)
  const bindingLines = ordered.map((b) => `  const ${b.name} = ${g.bindingRHS(b)}`)
  const spine = g.expr(block.spine)
  // canonical destructure order: note, gate, param, then the rest sorted
  const head = ['note', 'gate', 'param'].filter((n) => g.uses.has(n))
  const rest = [...g.uses].filter((n) => !head.includes(n)).sort()
  const destructure = [...head, ...rest].join(', ')
  const body = [...bindingLines, `  return ${spine}`].join('\n')
  return `const ${block.name} = synth(({ ${destructure} }) => {\n${body}\n})`
}

function cgPlay(block: { name: string; notation: string; scale?: string }): string {
  const entry = /[a-gA-G]/.test(block.notation) ? 'note' : 'n'
  let pat = `${entry}('${block.notation.replace(/'/g, "\\'")}')`
  if (block.scale) pat += `.scale('${expandScale(block.scale)}')`
  pat += `.sound('${block.name}')`
  return `p('${block.name}', ${pat})`
}

export function codegen(program: Program, errors: RondoError[]): string {
  const parts = program.items.map((item: TopItem) => {
    if (item.t === 'synth') return cgSynth(item, errors)
    if (item.t === 'play') return cgPlay(item)
    return `setCps(${num(item.value)})`
  })
  return parts.join('\n\n') + '\n'
}
