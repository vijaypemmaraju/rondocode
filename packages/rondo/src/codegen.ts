/* rondo codegen — AST → rondocode DSL source text.
 *
 * The output is a plain ES2022 script string that evalCode() runs unchanged:
 * synths as top-level `const NAME = synth(({ ctx }) => …)`, patterns as
 * `p('NAME', n('…')…)`, tempo as `setCps(x)`. We collect which synth-ctx
 * members each synth uses and emit exactly that destructure. */

import type { Binding, Comb, CtrlValue, Expr, Mod, PlayBlock, Program, RondoError, SynthBlock, TopItem } from './ast'
import { BUILTINS } from './builtins'

const BIN_METHOD: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '^': 'pow' }

const SCALE_MODE: Record<string, string> = {
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
  'svf', 'ladder', 'onepole', 'adsr', 'env', 'lfo',
  'delay', 'reverb', 'chorus', 'comb', 'shape', 'compress', 'phaser', 'formant', 'vocoder',
  'eq', 'exciter', 'ott', 'bitcrush', 'mix',
]

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
  constructor(readonly errors: RondoError[]) {}

  expr(e: Expr): string {
    switch (e.t) {
      case 'num':
        return num(e.v)
      case 'ident':
        if (e.name === 'note') { this.uses.add('note'); return 'note.freq' }
        if (e.name === 'gate') { this.uses.add('gate'); return 'gate' }
        if (e.name === 'input') { this.uses.add('input'); return 'input' }
        if (e.name === 'velocity') { this.uses.add('velocity'); return 'velocity' }
        return e.name // a binding-local const
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
        // so the raw code can see them inside the synth fn.
        for (const name of KNOWN_CTX) if (new RegExp(`\\b${name}\\b`).test(e.code)) this.uses.add(name)
        return e.code
      case 'knob':
        this.errors.push({ message: 'knob can only appear on a binding (`cutoff = knob …`)', line: e.pos.line, col: e.pos.col })
        return '0'
    }
  }

  call(e: Extract<Expr, { t: 'call' }>): string {
    const name = e.name
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

    // positional args (parser already ordered them; procs/sigops carry the
    // input/running signal as args[0])
    const a = e.args.map((x) => this.expr(x))
    // an osc with a freq default and no freq arg reads the note
    if (spec.kind === 'osc' && spec.freqDefault === true && a.length === 0) {
      this.uses.add('note')
      a.push('note.freq')
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
function cgChain(bindings: Binding[], spine: Expr, headOrder: string[], errors: RondoError[]): string {
  const g = new SynthGen(errors)
  const ordered = orderBindings(bindings, errors)
  const bindingLines = ordered.map((b) => `  const ${b.name} = ${g.bindingRHS(b)}`)
  const spineStr = g.expr(spine)
  const head = headOrder.filter((n) => g.uses.has(n))
  const rest = [...g.uses].filter((n) => !head.includes(n)).sort()
  const destructure = [...head, ...rest].join(', ')
  const body = [...bindingLines, `  return ${spineStr}`].join('\n')
  return `({ ${destructure} }) => {\n${body}\n}`
}

function cgSynth(block: SynthBlock, errors: RondoError[]): string {
  const voice = cgChain(block.bindings, block.spine, ['note', 'gate', 'param'], errors)
  // header voice options: `synth acid mono glide:.08` → the synth() opts arg
  const opts = block.voiceOpts !== undefined
    ? `{ ${Object.entries(block.voiceOpts).map(([k, v]) => `${k}: ${v === true ? 'true' : num(v as number)}`).join(', ')} }`
    : undefined
  if (block.post) {
    const post = cgChain(block.postBindings ?? [], block.post, ['input', 'param'], errors)
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

function cgMod(m: Mod): string {
  switch (m.kind) {
    case 'ctrl': return `.ctrl(${q(m.name)}, ${cgCtrlValue(m.value)})`
    case 'method': return `.${m.name}(${cgCtrlValue(m.value)})`
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
  if (/[a-g]/.test(notation)) return 'note'
  return 'n'
}

/** The pattern EXPRESSION for a play block (no p() wrapper) — sections stack
 *  these; a top-level play wraps it in p(). */
function cgPlayPat(block: PlayBlock): string {
  const lineExpr = (notation: string): string => `${entryFor(notation)}(${q(notation)})`
  // multiple notation lines stack into voices, like the JS stack(n(…), n(…))
  let pat = block.voices !== undefined && block.voices.length > 0
    ? `stack(${[block.notation, ...block.voices.map((v) => v.notation)].map(lineExpr).join(', ')})`
    : lineExpr(block.notation)
  if (block.scale) pat += `.scale('${expandScale(block.scale)}')`
  pat += `.sound('${block.name}')`
  for (const m of block.mods) pat += cgMod(m)
  return pat
}

function cgPlay(block: PlayBlock): string {
  return `p('${block.name}', ${cgPlayPat(block)})`
}

function cgSection(item: Extract<TopItem, { t: 'section' }>): string {
  const pats = item.plays.map(cgPlayPat)
  const body = pats.length === 1 ? pats[0]! : `stack(${pats.join(', ')})`
  return `const __sec_${item.name} = ${body}`
}

function cgSidechain(item: Extract<TopItem, { t: 'sidechain' }>): string {
  const parts: string[] = []
  if (item.depth !== undefined) parts.push(`depth: ${num(item.depth)}`)
  if (item.release !== undefined) parts.push(`release: ${num(item.release)}`)
  const duckEntries = Object.entries(item.duck)
  if (duckEntries.length > 0) parts.push(`duck: { ${duckEntries.map(([k, v]) => `${k}: ${num(v)}`).join(', ')} }`)
  return `sidechain('${item.source}'${parts.length > 0 ? `, { ${parts.join(', ')} }` : ''})`
}

function cgMaster(item: Extract<TopItem, { t: 'master' }>): string {
  const parts = Object.entries(item.opts).map(([k, v]) => `${k}: ${num(v)}`)
  return `masterCompress(${parts.length > 0 ? `{ ${parts.join(', ')} }` : ''})`
}

function cgBus(item: Extract<TopItem, { t: 'bus' }>, errors: RondoError[]): string {
  const fx = cgChain(item.bindings, item.fx, ['input'], errors)
  const sendEntries = Object.entries(item.sends)
  const sends = sendEntries.length > 0 ? `, { ${sendEntries.map(([k, v]) => `${k}: ${num(v)}`).join(', ')} }` : ''
  return `bus('${item.name}', ${fx}${sends})`
}

function cgVisual(item: Extract<TopItem, { t: 'visual' }>): string {
  // WGSL has no backticks/template holes, but escape defensively
  const body = item.wgsl.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  return `visual(\`\n${body}\n\`)`
}

export function codegen(program: Program, errors: RondoError[]): string {
  const sections = program.items.filter((it): it is Extract<TopItem, { t: 'section' }> => it.t === 'section')
  const song = program.items.find((it): it is Extract<TopItem, { t: 'song' }> => it.t === 'song')
  const parts = program.items.map((item: TopItem) => {
    if (item.t === 'synth') return cgSynth(item, errors)
    if (item.t === 'play') return cgPlay(item)
    if (item.t === 'raw') return item.code // escape hatch, verbatim
    if (item.t === 'sidechain') return cgSidechain(item)
    if (item.t === 'master') return cgMaster(item)
    if (item.t === 'bus') return cgBus(item, errors)
    if (item.t === 'visual') return cgVisual(item)
    if (item.t === 'section') return cgSection(item)
    if (item.t === 'song') return '' // assembled below, after all sections exist
    return `setCps(${num(item.value)})` // cps
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
