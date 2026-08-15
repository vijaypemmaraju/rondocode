/* Property fuzzer for the compile ⇄ decompile pair.
 *
 * genProgram(seed) walks the grammar with a seeded PRNG and produces a VALID
 * rondo program: synth pipelines built from the real builtin registry (so new
 * builtins are fuzzed the day they land), bindings, posts, play/beat blocks
 * with modifiers, sections/song, buses, sing, js escapes. The invariant
 * (checkFixedPoint) is the decompiler's contract: compile → decompile →
 * compile again is byte-identical JS. shrink() greedily minimizes a failing
 * program to the smallest source that still violates the property, so a
 * failure reads as a bug report, not a random blob.
 *
 * Everything is deterministic: same seed, same program, forever. */

import { parse } from 'acorn'
import { BUILTINS } from '../src/builtins'
import { compile } from '../src/compile'
import { decompile } from '../src/decompile'

/* ---- seeded PRNG ---------------------------------------------------------- */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class R {
  private rnd: () => number
  constructor(seed: number) {
    this.rnd = mulberry32(seed)
  }
  /** uniform int in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rnd() * (hi - lo + 1))
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(0, a.length - 1)]!
  }
  chance(p: number): boolean {
    return this.rnd() < p
  }
}

/* ---- vocabulary ------------------------------------------------------------ */

// none of these may collide with a builtin, a special ref, or the `s` global
const SYNTH_NAMES = ['kickx', 'bassx', 'leadx', 'padx', 'keysx', 'subby', 'arpx', 'stab'] as const
const BINDING_NAMES = ['e1', 'en2', 'cut', 'wet2', 'lf1', 'amt', 'mo', 'dp'] as const
const ENUM_WORDS = ['pink', 'white', 'tri', 'sine', 'saw', 'hp', 'lp', 'bell', 'tube', 'soft'] as const
const SCALES = ['a-min', 'c-maj', 'e-dor', 'g-phr', 'd-lyd', 'c-19edo', 'd-pelogx'] as const
// scaledef names: must not collide with builtins/synths/bindings
const SCALEDEF_NAMES = ['pelogx', 'slendro', 'bellcurve', 'quartz'] as const
const SCALEDEF_STEPS = ['0', '.5', '1.2', '2.7', '3.86', '5.4', '-1.1', '7.02', '9.7', '10.9'] as const
// wavedef names: same rule (and never the built-in tables basic/harmonic/pwm)
const WAVEDEF_NAMES = ['wtx', 'morphy', 'vowelz', 'glasswt'] as const
// partial amplitudes incl. a negative (a phase flip — legal, must round-trip)
const WAVEDEF_AMPS = ['0', '.1', '.25', '.5', '.75', '.9', '1', '-.5'] as const
const SMALL = ['.1', '.25', '.3', '.5', '.75', '.85', '.9'] as const
const FREQS = ['55', '110', '220', '440', '800', '1200', '2400', '5200'] as const
const TIMES = ['.003', '.01', '.05', '.1', '.2', '.4'] as const

const num = (r: R): string => r.pick([...SMALL, '0', '1', '2', '3', '4', '8', ...FREQS])

/* ---- expressions ------------------------------------------------------------
 * Rules that keep generated expressions compilable:
 * - a bare number never sits LEFT of an operator against a signal (codegen
 *   folds num-op-num and rewrites num-sig; the rest is an error by design)
 * - gated calls (need the voice gate) only appear in synth voice context
 * - refs draw from bindings declared EARLIER (no cycles) + the special refs */

interface ExprCtx {
  refs: string[] // in-scope binding names
  post: boolean // post chain: `input` exists, note/gate/gated calls don't
}

/** A nested call SAFE inside any sig argument slot: these oscillators take
 *  exactly one positional and declare no named args, so they can't absorb an
 *  enclosing call's later positionals or `k:v` pairs. */
function genClosedCall(r: R, depth = 1): string {
  if (r.chance(0.2)) return `noise ${r.pick(['pink', 'white'])}`
  // closed calls can nest (`sine saw 2` = sine(saw(2))) and stay closed
  const arg = depth > 0 && r.chance(0.2) ? genClosedCall(r, depth - 1) : r.pick(['2', '4', '8', '110', '.5'])
  return `${r.pick(['sine', 'saw', 'tri', 'square'])} ${arg}`
}

/** a value for a 'sig' argument slot: usually a leaf, sometimes (depth
 *  permitting) a whole nested CALL — calls-in-argument-position is real
 *  rondo the decompiler must survive (bailing to js{ } is fine; breaking
 *  the fixed point isn't). */
function genSigArg(r: R, ctx: ExprCtx, depth: number): string {
  if (depth > 0 && r.chance(0.25)) return genClosedCall(r)
  return genAtom(r, ctx)
}

function genCall(r: R, ctx: ExprCtx, depth = 1): string {
  const names = Object.keys(BUILTINS).filter((n) => {
    const b = BUILTINS[n]!
    // procs stay spine-only, but a SIGOP has an expression form (`floor wob`,
    // `min wob .2`) that the decompiler now renders, so it must be fuzzed:
    // the input becomes the first positional and can absorb what follows it.
    if (b.kind === 'proc') return false
    if (b.kind === 'sigop') return !ctx.post
    if (n === 'env') return false // variadic pair syntax, binding-only
    if (n === 'lfo') return true
    return ctx.post ? b.kind === 'osc' : true
  })
  const name = r.pick(names)
  const spec = BUILTINS[name]!
  const parts: string[] = [name]
  if (spec.kind === 'sigop') {
    // Input first, then the op's own args. The input must be an actual SIGNAL:
    // codegen rejects a constant there ('220.fold()' is not valid JS), so a
    // number would only generate programs that never compile.
    parts.push(r.chance(0.4) ? 'note' : genClosedCall(r))
    for (const kind of spec.pos) parts.push(kind === 'enum' ? r.pick(ENUM_WORDS) : genSigArg(r, ctx, depth))
    return parts.join(' ')
  }
  if (name === 'lfo') {
    parts.push(r.pick(['2', '4', '.5', '8']), r.pick(['tri', 'sine', 'saw', 'square']))
  } else if (spec.freqDefault && r.chance(0.5)) {
    // bare source plays the note
  } else {
    for (const kind of spec.pos) parts.push(kind === 'enum' ? r.pick(ENUM_WORDS) : genSigArg(r, ctx, depth))
  }
  for (const [k, kind] of Object.entries(spec.named ?? {})) {
    if (!r.chance(0.3)) continue
    // bools go BOTH ways: `reverse:0` compiles to `false` and has its own
    // decompile path, so generating only `1` would leave half of it unfuzzed
    const v = kind === 'enum' ? r.pick(ENUM_WORDS)
      : kind === 'bool' ? (r.chance(0.5) ? '1' : '0')
      : kind === 'num' ? num(r) : genSigArg(r, ctx, depth)
    parts.push(`${k}:${v}`)
  }
  return parts.join(' ')
}

/** a leaf: number (sometimes negative), ref, or note-derived. Never an
 *  operator expression. */
function genAtom(r: R, ctx: ExprCtx): string {
  const roll = r.int(0, 3)
  if (roll === 0 && ctx.refs.length > 0) return r.pick(ctx.refs)
  if (roll === 1 && !ctx.post) return r.pick(['note', 'note/2', 'note*2'])
  if (roll === 1 && ctx.post) return 'input'
  if (roll === 2 && r.chance(0.2)) return r.pick(['-6', '-.5', '-2'])
  return num(r)
}

function genExpr(r: R, ctx: ExprCtx, depth: number): string {
  if (depth <= 0) return genAtom(r, ctx)
  const roll = r.int(0, 5)
  if (roll <= 1) return genAtom(r, ctx)
  if (roll <= 3) return genCall(r, ctx)
  /* infix: LEFT is never a bare number (num-op-sig is an error by design), and
   * a CALL is bracketed. A named-argument tail parses at prec >= 2, so
   * `granular … spray:2400 + note/2` makes `2400 + note/2` the value of
   * `spray:` rather than a term of the sum. That used to compile: the signal
   * was dropped by the config mapper and the argument silently fell back to
   * its default. Now it is an error, correctly, so the generator has to say
   * which grouping it meant. */
  const call = (): string => `(${genCall(r, ctx)})`
  const left = r.chance(0.4) ? call() : ctx.refs.length > 0 ? r.pick(ctx.refs) : call()
  const op = r.pick(['+', '-', '*', '*', '^'])
  const right = op === '^' ? r.pick(['2', '3']) : genExpr(r, ctx, depth - 1)
  return `${left} ${op} ${right}`
}

/* ---- synth blocks ----------------------------------------------------------- */

interface SynthInfo {
  name: string
  knob?: string // a drivable param name, if one was declared
}

function genBinding(r: R, name: string, ctx: ExprCtx): { line: string; isKnob: boolean } {
  const roll = r.int(0, 5)
  if (roll === 0) return { line: `${name} = adsr ${r.pick(TIMES)} ${r.pick(TIMES)} ${r.pick(SMALL)} ${r.pick(TIMES)}`, isKnob: false }
  if (roll === 1) {
    const pairs = Array.from({ length: r.int(2, 3) }, () => `${r.pick(TIMES)} ${r.pick(SMALL)}`).join(' ')
    const tail = r.chance(0.5) ? ` release:${r.pick(TIMES)}` : ''
    return { line: `${name} = env ${pairs}${tail}`, isKnob: false }
  }
  if (roll === 2) {
    // sometimes a NEGATIVE range (`knob -6 -12..0`) — gain-style knobs
    if (r.chance(0.3)) {
      return { line: `${name} = knob ${r.pick(['-6', '-3', '-.5'])} -12..${r.pick(['0', '6'])}`, isKnob: true }
    }
    const lo = r.pick(['0', '80', '.1'])
    const hi = r.pick(['1', '8000', '2400'])
    const curve = r.chance(0.5) ? ' log' : ''
    return { line: `${name} = knob ${r.pick(SMALL)} ${lo}..${hi}${curve}`, isKnob: true }
  }
  if (roll === 3) {
    const base = r.chance(0.5) ? genCall(r, ctx) : genExpr(r, ctx, 1)
    return { line: `${name} = ${base} -> ${r.pick(['0', '200'])}..${r.pick(['1', '2000'])}`, isKnob: false }
  }
  if (roll === 4) {
    // inline js{ … } escape hatch as a binding RHS (tiny + deterministic)
    return { line: `${name} = ${r.pick(['js{ note.freq.mul(3) }', 'js{ velocity.mul(0.5) }'])}`, isKnob: false }
  }
  return { line: `${name} = ${genExpr(r, ctx, 2)}`, isKnob: false }
}

function genEqLine(r: R): string {
  const bands: string[] = []
  if (r.chance(0.6)) bands.push(`hp ${r.pick(['120', '170', '300'])}`)
  if (r.chance(0.6)) bands.push(`peak ${r.pick(FREQS)} ${r.pick(['-3', '2', '-2'])} ${r.pick(['1', '2'])}`)
  if (bands.length === 0 || r.chance(0.4)) bands.push(`highshelf ${r.pick(['5000', '7000'])} ${r.pick(['-2', '3', '4'])}`)
  return `eq ${bands.join(' ')}`
}

function genTransformLine(r: R, ctx: ExprCtx): string {
  const roll = r.int(0, 5)
  if (roll <= 1) return `${r.pick(['*', '*', '+', '-'])} ${genExpr(r, ctx, 1)}`
  if (roll === 2) return r.pick(['tanh', 'fold', `clip ${r.pick(['-1', '0'])} 1`, `mix ${genAtom(r, ctx)} ${r.pick(SMALL)}`])
  if (roll === 3) return genEqLine(r)
  // a proc with registry-driven args
  const procs = Object.keys(BUILTINS).filter((n) => BUILTINS[n]!.kind === 'proc' && n !== 'eq')
  const name = r.pick(procs)
  const spec = BUILTINS[name]!
  const parts = [name]
  for (const kind of spec.pos) parts.push(kind === 'enum' ? r.pick(ENUM_WORDS) : genSigArg(r, ctx, 1))
  for (const [k, kind] of Object.entries(spec.named ?? {})) {
    if (!r.chance(0.35)) continue
    const v = kind === 'enum' ? r.pick(ENUM_WORDS)
      : kind === 'bool' ? (r.chance(0.5) ? '1' : '0')
      : kind === 'num' ? num(r) : genSigArg(r, ctx, 1)
    parts.push(`${k}:${v}`)
  }
  return parts.join(' ')
}

function genSynth(r: R, name: string): { text: string; info: SynthInfo } {
  const nBind = r.int(0, 2)
  const bindNames: string[] = []
  const bindLines: string[] = []
  let knob: string | undefined
  for (let i = 0; i < nBind; i++) {
    const bn = BINDING_NAMES[(r.int(0, 99) + i) % BINDING_NAMES.length]!
    if (bindNames.includes(bn)) continue
    const b = genBinding(r, bn, { refs: [...bindNames], post: false })
    bindNames.push(bn)
    bindLines.push(`  ${b.line}`)
    if (b.isKnob) knob = bn
  }
  const ctx: ExprCtx = { refs: bindNames, post: false }
  const lines: string[] = []
  const opts = r.chance(0.15)
    ? ` ${r.pick(['mono', 'glide:.05', 'unison:3', 'unison:5 curve:2 blend:.6', 'unison:4 octaves:2', 'unison:7 detune:22 spread:.9 curve:1.5'])}`
    : ''
  lines.push(`synth ${name}${opts}`)
  // the source is never a bare constant: a fully numeric pipe correctly
  // REJECTS sigop lines now (220.fold() is not a thing), so a constant
  // source + random transforms would be a generator bug, not a compiler one
  let srcLine = r.chance(0.7) ? genCall(r, ctx) : genExpr(r, ctx, 2)
  if (/^[\d. ^*/+-]+$/.test(srcLine)) srcLine = genCall(r, ctx)
  lines.push(`  ${srcLine}`)
  const nT = r.int(0, 3)
  for (let i = 0; i < nT; i++) lines.push(`  ${genTransformLine(r, ctx)}`)
  lines.push(...bindLines)
  if (r.chance(0.3)) {
    lines.push('  post')
    const pctx: ExprCtx = { refs: [], post: true }
    const nP = r.int(1, 2)
    for (let i = 0; i < nP; i++) {
      const l = genTransformLine(r, pctx)
      lines.push(`    ${l.startsWith('eq') || r.chance(0.7) ? l : `reverb room:${r.pick(SMALL)} mix:${r.pick(SMALL)}`}`)
    }
  }
  return { text: lines.join('\n'), info: { name, knob } }
}

/* ---- pattern blocks ---------------------------------------------------------- */

function genToken(r: R): string {
  const d = (): number => r.int(0, 7)
  switch (r.int(0, 11)) {
    case 0: return '~'
    case 1: return `<${d()} ${d()} ${d()}>`
    case 2: return `[${d()} ${d()}]`
    case 3: return `${d()}(${r.pick(['3,8', '5,8', '7,16'])})`
    case 4: return `{${d()} ${d()} ${d()}}%${r.pick(['4', '8'])}`
    case 5: return `${d()}@${r.int(2, 4)}`
    case 6: return `${d()}*2`
    // nested mini: a bracket inside a bracket, alternation inside brackets
    case 7: return `[[${d()} ${d()}] ${d()}]`
    case 8: return `[<${d()} ${d()}> ${d()}]`
    case 9: return `<[${d()} ${d()}] ${d()}>`
    default: return String(d())
  }
}

function genNotationLine(r: R): string {
  if (r.chance(0.1)) {
    // chord names (uppercase root picks the chord() entry)
    return r.pick(['Cmaj7 Fmaj7', '<Am F C G>', 'Dm7 G7 Cmaj7 Am7', '<Em7 A7> <Dm7 G7>'])
  }
  if (r.chance(0.15)) return r.pick(['c4 e4 g4', 'c2 ~ g2 ~', 'a3 c4 e4 a4'])
  return Array.from({ length: r.int(2, 6) }, () => genToken(r)).join(' ')
}

function genPlay(r: R, synths: SynthInfo[], indent: string): string {
  const target = r.pick(synths)
  const head = r.chance(0.12) ? `play ch${r.int(1, 3)} synth:${target.name}` : `play ${target.name}`
  const lines = [head]
  lines.push(`${indent}  ${genNotationLine(r)}`)
  if (r.chance(0.2)) lines.push(`${indent}  ${genNotationLine(r)}`) // stacked voice
  if (r.chance(0.6)) lines.push(`${indent}  scale: ${r.pick(SCALES)}`)
  if (r.chance(0.3)) lines.push(`${indent}  gain: ${r.chance(0.8) ? r.pick(SMALL) : 'fall 4'}`)
  if (r.chance(0.3)) lines.push(`${indent}  dur: ${r.pick(['.5', '.75', '.98'])}`)
  if (r.chance(0.2)) lines.push(`${indent}  ${r.pick(['fast 2', 'slow 2'])}`)
  if (r.chance(0.25)) lines.push(`${indent}  every ${r.int(2, 4)}: ${r.pick(['rev', 'palindrome', 'degrade'])}`)
  if (r.chance(0.1)) lines.push(`${indent}  jux: rev`)
  if (r.chance(0.1)) lines.push(`${indent}  off .25: gain .3`)
  // the rest of the FN_COMBS table
  if (r.chance(0.15)) {
    lines.push(`${indent}  ${r.pick([
      'chunk 2: rev',
      'sometimesby .3: fast 2',
      'juxby .5: rev',
      'superimpose: gain .3',
      'sometimes: rev',
    ])}`)
  }
  if (r.chance(0.1)) lines.push(`${indent}  struct t ~ t t`)
  if (target.knob !== undefined && r.chance(0.5)) {
    const k = target.knob
    lines.push(
      `${indent}  ${r.pick([
        `${k}: sine 200..2400 slow:4`,
        `${k}: rise 8 0..1`,
        `${k}: <${num(r)} ${num(r)}>`,
        `${k}: ${num(r)}`,
      ])}`,
    )
  }
  return lines.map((l, i) => (i === 0 ? `${indent}${l}` : l)).join('\n')
}

function genBeat(r: R, synths: SynthInfo[]): string {
  const lines = [r.chance(0.5) ? 'beat' : `beat drums${r.int(1, 2)}`]
  const nRows = r.int(1, 3)
  for (let i = 0; i < nRows; i++) {
    const name = r.pick(synths).name
    const steps = r.pick([4, 8])
    const row: string[] = Array.from({ length: steps }, () => {
      if (!r.chance(0.45)) return '~'
      return r.chance(0.25) ? `${name}:${r.pick(['.6', '.3'])}` : name
    })
    if (!row.some((t) => t !== '~')) row[0] = name // an all-rest row needs its keeper comment; just place a hit
    lines.push(`  ${row.join(' ')}`)
  }
  if (r.chance(0.25)) lines.push(`  every 4: rev`)
  return lines.join('\n')
}

/* ---- whole programs ----------------------------------------------------------- */

export function genProgram(seed: number): string {
  const r = new R(seed)
  const blocks: string[] = []
  const nSynths = r.int(1, 3)
  const synths: SynthInfo[] = []
  for (let i = 0; i < nSynths; i++) {
    const g = genSynth(r, SYNTH_NAMES[(seed + i * 3) % SYNTH_NAMES.length]!)
    synths.push(g.info)
    blocks.push(g.text)
  }

  if (r.chance(0.2)) {
    // custom wavetable: 2-4 '/'-separated frames of 1-8 partials — and,
    // usually, a synth whose oscillator references it by `table:` (the refs
    // must survive the round trip too). 'wavtx' collides with nothing above.
    const wname = r.pick(WAVEDEF_NAMES)
    const frames = Array.from({ length: r.int(2, 4) }, () =>
      Array.from({ length: r.int(1, 8) }, () => r.pick(WAVEDEF_AMPS)).join(' '))
    blocks.push(`wavedef ${wname} ${frames.join(' / ')}`)
    if (r.chance(0.7)) {
      // sometimes with real warp args (warp:enum + warpamt:sig round-trip)
      const warp = r.chance(0.4)
        ? ` warp:${r.pick(['sync', 'bend', 'mirror'])}${r.chance(0.6) ? ` warpamt:${r.pick(SMALL)}` : ''}`
        : ''
      blocks.push(`synth wavtx\n  wavetable note ${r.pick(SMALL)} table:${wname}${warp}\n  * ${r.pick(SMALL)}`)
      synths.push({ name: 'wavtx' })
    }
  }

  if (r.chance(0.2)) {
    // sections + song (all plays live inside the sections)
    const secA = [`section intro ${r.pick(['2', '4'])}`, genPlay(r, synths, '  ')].join('\n')
    const secB = [`section drop ${r.pick(['4', '8'])}`, genPlay(r, synths, '  ')].join('\n')
    blocks.push(secA, secB)
    if (r.chance(0.7)) blocks.push('song intro drop drop intro')
  } else {
    const nPlays = r.int(1, 2)
    for (let i = 0; i < nPlays; i++) blocks.push(genPlay(r, synths, ''))
    if (r.chance(0.35)) blocks.push(genBeat(r, synths))
  }

  if (r.chance(0.2)) {
    // custom tuning: 3-7 float steps (compile/decompile only — never eval'd)
    const vals = Array.from({ length: r.int(3, 7) }, () => r.pick(SCALEDEF_STEPS))
    blocks.push(`scaledef ${r.pick(SCALEDEF_NAMES)} ${vals.join(' ')}`)
  }
  if (r.chance(0.15) && synths.length >= 2) {
    blocks.push(`sidechain ${synths[0]!.name} depth:${r.pick(SMALL)} release:90 ${synths[1]!.name}:${r.pick(SMALL)}`)
  }
  if (r.chance(0.15)) blocks.push(`master threshold:-6 ratio:2 makeup:1`)
  if (r.chance(0.15)) {
    blocks.push([`bus space`, `  reverb room:${r.pick(SMALL)} damp:${r.pick(SMALL)}`, `  send ${r.pick(synths).name} ${r.pick(SMALL)}`].join('\n'))
  }
  if (r.chance(0.1)) {
    const n = r.int(2, 4)
    const lyr = Array.from({ length: n }, () => r.pick(['la', 'da', 'sing', 'lo-ver'])).join(' ')
    // melodies carry mini @weights (a dotted lilt), and a phrase may span
    // several cycles
    const mel = Array.from({ length: n }, () => {
      const nt = r.pick(['c4', 'e4', 'g4', 'a4'])
      return r.chance(0.4) ? `${nt}@${r.int(2, 6)}` : nt
    }).join(' ')
    const lines = [`sing v1${r.chance(0.4) ? ` voice:${r.pick(['barbara', 'alto'])}` : ''}`, `  ${lyr}`, `  ${mel}`]
    if (r.chance(0.4)) lines.push(`  cycles: ${r.int(2, 8)}`)
    if (r.chance(0.6)) lines.push(`  gain: .9`)
    if (r.chance(0.3)) lines.push(`  ${r.pick(['every 2: rev', 'sometimes: rev', 'dur: .9'])}`)
    if (r.chance(0.3)) lines.push('  post', `    reverb room:${r.pick(SMALL)} mix:${r.pick(SMALL)}`)
    blocks.push(lines.join('\n'))
  }
  // NOTE: no comments in generated js blocks — a trailing comment on a
  // RECOGNIZED statement (setCps → cps sugar) is dropped by design (the
  // toggle's documented comment tradeoff); byte-identity here would fail
  // on that, not on a bug. Verbatim-with-comments is pinned in decompile.test.
  if (r.chance(0.1)) blocks.push(`js\n  setCps(0.52)`)
  // the tempo line, in EITHER unit — the round trip must preserve which one
  if (r.chance(0.7)) {
    blocks.push(r.chance(0.4)
      ? `bpm ${r.pick(['90', '120', '128', '174'])}`
      : `cps ${r.pick(['.3', '.45', '.6'])}`)
  }

  return blocks.join('\n\n') + '\n'
}

/* ---- the property + shrinking --------------------------------------------------- */

export type FuzzFailure =
  | { kind: 'gen-compile'; errors: string }
  | { kind: 'bad-js'; error: string }
  | { kind: 'decompile-throw'; error: string }
  | { kind: 'recompile'; errors: string; rondo2: string }
  | { kind: 'mismatch'; rondo2: string; diff: string }

/** null = the fixed point holds. */
export function checkFixedPoint(src: string): FuzzFailure | null {
  const c1 = compile(src)
  if (!c1.ok) return { kind: 'gen-compile', errors: JSON.stringify(c1.errors) }
  try {
    parse(c1.code, { ecmaVersion: 2022, sourceType: 'script' })
  } catch (e) {
    // the compiler must NEVER emit unparseable JS from a program it accepted
    return { kind: 'bad-js', error: String(e) }
  }
  let rondo2: string
  try {
    rondo2 = decompile(c1.code)
  } catch (e) {
    return { kind: 'decompile-throw', error: String(e) }
  }
  const c2 = compile(rondo2)
  if (!c2.ok) return { kind: 'recompile', errors: JSON.stringify(c2.errors), rondo2 }
  const a0 = normalizedProgram(c1.code)
  const b0 = normalizedProgram(c2.code)
  if (a0 !== b0) {
    const a = a0.split('\n')
    const b = b0.split('\n')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return { kind: 'mismatch', rondo2, diff: `at ${i + 1}:\n  first:  ${a[i] ?? '<end>'}\n  second: ${b[i] ?? '<end>'}` }
  }
  return null
}

/* ---- naming-insensitive comparison ------------------------------------------ *
 * The contract is "the same program", and it USED to be checkable as byte
 * identity because anything the decompiler could not say inline it kept as a
 * verbatim `js{ ... }` blob -- which round-trips as itself, trivially.
 *
 * Now that a blob is a last resort rather than a first one, an operand rondo
 * has no inline spelling for (it has no parentheses) comes back as a binding:
 *
 *   sine(tri(110).mix(220, 5200).add(4))
 *   const sig = tri(110); const sum = sig.mix(220, 5200); ... sine(sum.add(4))
 *
 * Same program, different text. So both sides are compared as ASTs with every
 * single-use `const` folded back into its one use -- which normalizes exactly
 * the freedom the decompiler now has, and nothing else. A binding used twice,
 * a renamed binding, a changed argument: all still differ.
 *
 * On the AST rather than the text because SCOPE decides what "used once"
 * means: two synths may each bind `amp`, and a voice and its post chain may
 * each bind `amp`, inside one `const x = synth(voice, post)` statement. Every
 * text-level attempt at this counted one scope's uses against another's.
 */
type AstNode = Record<string, unknown>

export function normalizedProgram(js: string): string {
  const tree = parse(js, { ecmaVersion: 2022, sourceType: 'script' }) as unknown as AstNode
  foldFunctions(tree)
  return JSON.stringify(tree, (k, v) => (k === 'start' || k === 'end' ? undefined : v), 1)
}

/** Fold single-use consts in every function body, innermost first. */
function foldFunctions(n: unknown): void {
  if (n === null || typeof n !== 'object') return
  if (Array.isArray(n)) {
    for (const x of n) foldFunctions(x)
    return
  }
  const node = n as AstNode
  for (const k of Object.keys(node)) if (k !== 'type') foldFunctions(node[k])
  const body = node['body']
  if (
    (node['type'] === 'ArrowFunctionExpression' || node['type'] === 'FunctionExpression') &&
    body !== null && typeof body === 'object' && (body as AstNode)['type'] === 'BlockStatement'
  ) foldBody(body as AstNode)
}

function foldBody(block: AstNode): void {
  for (let pass = 0; pass < 50; pass++) {
    const stmts = block['body'] as AstNode[]
    let folded = false
    for (let i = 0; i < stmts.length && !folded; i++) {
      const s = stmts[i]!
      if (s['type'] !== 'VariableDeclaration' || s['kind'] !== 'const') continue
      const decls = s['declarations'] as AstNode[]
      if (decls.length !== 1) continue
      const d = decls[0]!
      const id = d['id'] as AstNode
      const init = d['init'] as AstNode | null
      if (id['type'] !== 'Identifier' || init === null) continue
      const refs: { holder: AstNode | AstNode[]; key: string | number }[] = []
      collectRefs(block, id['name'] as string, id, refs)
      if (refs.length !== 1) continue
      const r = refs[0]!
      ;(r.holder as Record<string | number, unknown>)[r.key] = init
      stmts.splice(i, 1)
      folded = true
    }
    if (!folded) return
  }
}

/** Every REFERENCE to `name` under `n`: not the declaration id, not a
 *  non-computed member property (`x.freq`), not a non-computed object key. */
function collectRefs(
  n: unknown,
  name: string,
  declId: AstNode,
  out: { holder: AstNode | AstNode[]; key: string | number }[],
  holder?: AstNode | AstNode[],
  key?: string | number,
): void {
  if (n === null || typeof n !== 'object') return
  if (Array.isArray(n)) {
    for (let i = 0; i < n.length; i++) collectRefs(n[i], name, declId, out, n as AstNode[], i)
    return
  }
  const node = n as AstNode
  if (node === declId) return
  if (node['type'] === 'Identifier') {
    if (node['name'] === name && holder !== undefined && key !== undefined) out.push({ holder, key })
    return
  }
  const skip =
    node['type'] === 'MemberExpression' && node['computed'] !== true ? 'property'
    : node['type'] === 'Property' && node['computed'] !== true ? 'key'
    : ''
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === skip) continue
    collectRefs(node[k], name, declId, out, node, k)
  }
}

/** Greedy structural shrink: drop whole blocks, then single lines, as long as
 *  the program still compiles AND still violates the fixed point. */
export function shrink(src: string, failsLike: (s: string) => boolean): string {
  let cur = src
  let changed = true
  while (changed) {
    changed = false
    // pass 1: whole blocks (blank-line separated)
    const blocks = cur.split(/\n\n+/)
    for (let i = 0; i < blocks.length; i++) {
      if (blocks.length <= 1) break
      const cand = blocks.filter((_, j) => j !== i).join('\n\n') + '\n'
      if (failsLike(cand)) {
        cur = cand
        changed = true
        break
      }
    }
    if (changed) continue
    // pass 2: single lines (headers/sources included; compile-check rejects bad cuts)
    const lines = cur.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '') continue
      const cand = lines.filter((_, j) => j !== i).join('\n')
      if (failsLike(cand)) {
        cur = cand
        changed = true
        break
      }
    }
  }
  return cur
}

/** The shrink predicate: still a COMPILING program that still fails. */
export const stillFailing = (s: string): boolean => {
  const f = checkFixedPoint(s)
  return f !== null && f.kind !== 'gen-compile'
}
