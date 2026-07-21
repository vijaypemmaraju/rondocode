import { parse } from 'acorn'
import type { Expression, Program } from 'acorn'
import { simple as walkSimple } from 'acorn-walk'
import { MiniError, Pattern } from '@rondocode/pattern'
import type { ControlMap } from '@rondocode/pattern'
import type { SynthDef } from '@rondocode/engine'

/* ------------------------------------------------------------------------- *
 * evalCode: source text in, STAGED registrations out. This is the pure core
 * of the Session layer (and later the MCP eval surface): it never touches
 * live state — synths/patterns/cps land in fresh maps the caller applies
 * only when `ok` (the last-good-version contract). A failed eval returns
 * EMPTY maps even if some p()/defineSynth() calls ran before the throw:
 * staging is all-or-nothing per eval.
 *
 * Pipeline:
 *   1. acorn parse (script, ES2022) — syntax errors → positioned diagnostics.
 *   2. Source transform: top-level `const X = synth(...)` / `let X = ...`
 *      gets `;defineSynth("X", X);` appended after the statement, so synth
 *      definitions register under their variable name. LIMITS (pinned in
 *      tests): only top-level const/let declarations whose initializer is a
 *      DIRECT `synth(...)` call — not `var`, not declarations inside
 *      functions/blocks, not reassignments, not wrapped calls like
 *      `id(synth(...))`. Insertions stay on the statement's last line, so
 *      line numbers never shift (columns after a same-line insertion may —
 *      accepted).
 *      A bare top-level `synth(...)` expression statement draws a non-fatal
 *      warning: its result is unreachable and registers nothing.
 *   3. Execute via `new Function(...names, body)` with the scope values as
 *      arguments (no `with`: CSP-friendlier and faster; scope keys must be
 *      valid identifiers). The body runs in strict mode. p/defineSynth/
 *      setCps are appended per-eval — they close over this call's staging.
 *      This is a NAMESPACE, not a security sandbox: real globals stay
 *      reachable (see scope.ts).
 *   4. Runtime errors → diagnostics. V8 stack frames report the Function
 *      body as `<anonymous>:LINE:COL` where LINE = user line + 3 (two
 *      wrapper lines + the 'use strict' prologue) — mapped best-effort,
 *      falling back to 1:1. A MiniError from a pattern-string parse is
 *      mapped INTO the source when its src is a unique, escape-free string
 *      literal (caret = literal offset + 1 quote char + err.pos).
 * ------------------------------------------------------------------------- */

export interface Diagnostic {
  /** 1-based. */
  line: number
  /** 1-based. */
  col: number
  message: string
  endLine?: number
  endCol?: number
  severity: 'error' | 'warning'
  /** Producing stage: 'eval' (parse/transform/execute — everything this
   *  module emits), 'scheduler' (a pattern query threw during a tick),
   *  'engine' (an audio-thread error event). */
  source: 'eval' | 'scheduler' | 'engine'
}

export interface EvalResult {
  /** True when the source parsed and ran to completion (warnings allowed). */
  ok: boolean
  diagnostics: Diagnostic[]
  /** Staged synth registrations — populated only when ok. */
  synths: Map<string, SynthDef>
  /** Staged pattern registrations — populated only when ok. */
  patterns: Map<string, Pattern<ControlMap>>
  /** Present iff the code called setCps(x); clamped to [0.05, 4]. */
  cps?: number
  /** Present iff the code called sidechain(source, opts). `release` in the
   *  DSL is SECONDS; it is stored here as releaseMs. depth/releaseMs are
   *  validated on the engine side (clamped there). `amounts` are per-synth
   *  duck responses (0..1) from the opts `duck` map; a synth not listed
   *  defaults to full duck (1). Present only when a duck map was given. */
  sidechain?: { source: string; depth: number; releaseMs: number; amounts?: Record<string, number> }
  /** Present iff the code called masterCompress(opts): the master-bus glue
   *  compressor config. All fields in the compressor's native units (dB /
   *  ratio / ms); validated + clamped engine-side. */
  masterComp?: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }
  /** Present iff the code called visual(wgsl): the WGSL fragment source for
   *  the programmable shader visualizer (compiled + swapped live by the GPU
   *  layer, never through this evaluator). Last call wins. */
  visual?: string
}

/** Tempo bounds shared with the Session (setCps and transport clamp alike). */
export const clampCps = (x: number): number => Math.min(4, Math.max(0.05, x))

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** Names injected per-eval; never taken from the caller's scope object. */
const STAGING_NAMES = new Set(['p', 'defineSynth', 'setCps', 'sidechain', 'masterCompress', 'visual'])

/** DSL sidechain defaults (release in SECONDS, converted to ms downstream). */
const DEFAULT_SIDECHAIN_DEPTH = 0.6
const DEFAULT_SIDECHAIN_RELEASE_SEC = 0.18

/** Lines added ahead of user code inside the compiled function: V8 renders
 *  `new Function(a, b, body)` as `function anonymous(a,b\n) {\n<body>\n}`
 *  (2 lines) and we prepend `'use strict';\n` (1 more). */
const WRAPPER_LINES = 3

const isSynthCall = (e: Expression): boolean =>
  e.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === 'synth'

const offsetToLineCol = (source: string, offset: number): { line: number; col: number } => {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  return { line, col: offset - lineStart + 1 }
}

const parseSource = (
  source: string,
): { program: Program } | { error: Diagnostic } => {
  try {
    return {
      program: parse(source, { ecmaVersion: 2022, sourceType: 'script', locations: true }),
    }
  } catch (e) {
    // acorn's SyntaxError carries loc {line, column(0-based)}.
    const loc = (e as { loc?: { line: number; column: number } }).loc
    const message = e instanceof Error ? e.message : String(e)
    return {
      error: {
        line: loc?.line ?? 1,
        col: (loc?.column ?? 0) + 1,
        message,
        severity: 'error',
        source: 'eval',
      },
    }
  }
}

/** Step 2: append defineSynth calls, collect bare-synth warnings. */
const transformSynthDecls = (
  source: string,
  program: Program,
): { transformed: string; warnings: Diagnostic[] } => {
  const inserts: { at: number; text: string }[] = []
  const warnings: Diagnostic[] = []
  for (const stmt of program.body) {
    if (stmt.type === 'VariableDeclaration' && (stmt.kind === 'const' || stmt.kind === 'let')) {
      const regs: string[] = []
      for (const d of stmt.declarations) {
        if (d.id.type === 'Identifier' && d.init != null && isSynthCall(d.init)) {
          regs.push(d.id.name)
        }
      }
      if (regs.length > 0) {
        inserts.push({
          at: stmt.end,
          text: regs.map((nm) => `;defineSynth(${JSON.stringify(nm)}, ${nm});`).join(''),
        })
      }
    } else if (stmt.type === 'ExpressionStatement' && isSynthCall(stmt.expression)) {
      const start = stmt.loc!.start
      warnings.push({
        line: start.line,
        col: start.column + 1,
        message:
          "synth() result not assigned or registered: assign it to a top-level const, or call defineSynth('name', synth(...))",
        severity: 'warning',
        source: 'eval',
      })
    }
  }
  let transformed = source
  for (const ins of inserts.sort((a, b) => b.at - a.at)) {
    transformed = transformed.slice(0, ins.at) + ins.text + transformed.slice(ins.at)
  }
  return { transformed, warnings }
}

/**
 * Map a MiniError into the eval'd source: if err.src appears as EXACTLY ONE
 * escape-free string literal, the caret is that literal's content offset +
 * err.pos. Otherwise (no literal, several identical ones, or escapes making
 * cooked ≠ raw) fall back to a position-less 1:1 diagnostic carrying the
 * MiniError's own caret-snippet message.
 */
const mapMiniError = (e: MiniError, source: string, program: Program): Diagnostic => {
  const starts: number[] = []
  walkSimple(program, {
    Literal(node) {
      if (
        typeof node.value === 'string' &&
        node.value === e.src &&
        source.slice(node.start + 1, node.end - 1) === node.value // raw === cooked
      ) {
        starts.push(node.start)
      }
    },
  })
  if (starts.length === 1) {
    const offset = starts[0]! + 1 + e.pos // +1: opening quote
    const { line, col } = offsetToLineCol(source, offset)
    return { line, col, message: e.message, severity: 'error', source: 'eval' }
  }
  return { line: 1, col: 1, message: e.message, severity: 'error', source: 'eval' }
}

/** Best-effort V8 stack mapping for anything that isn't a MiniError. */
const mapRuntimeError = (e: unknown, sourceLineCount: number): Diagnostic => {
  const message = e instanceof Error ? e.message : String(e)
  const stack = e instanceof Error ? e.stack : undefined
  if (stack !== undefined) {
    const m = /<anonymous>:(\d+):(\d+)/.exec(stack)
    if (m !== null) {
      const line = Number(m[1]) - WRAPPER_LINES
      const col = Number(m[2])
      if (line >= 1 && line <= sourceLineCount) {
        return { line, col, message, severity: 'error', source: 'eval' }
      }
    }
  }
  return { line: 1, col: 1, message, severity: 'error', source: 'eval' }
}

/**
 * Evaluate `source` against the sandbox vocabulary in `scope` (typically
 * scope.ts's baseScope; every key must be a valid identifier). PURE with
 * respect to the caller: all registrations land in the returned maps, and a
 * failed eval returns empty maps regardless of how far it got.
 */
export function evalCode(source: string, scope: Record<string, unknown>): EvalResult {
  const parsed = parseSource(source)
  if ('error' in parsed) {
    return { ok: false, diagnostics: [parsed.error], synths: new Map(), patterns: new Map() }
  }
  const { program } = parsed
  const { transformed, warnings } = transformSynthDecls(source, program)
  const diagnostics: Diagnostic[] = [...warnings]

  // Per-eval staging: closed over by the injected p/defineSynth/setCps.
  const synths = new Map<string, SynthDef>()
  const patterns = new Map<string, Pattern<ControlMap>>()
  let cps: number | undefined
  let sidechainCfg: { source: string; depth: number; releaseMs: number; amounts?: Record<string, number> } | undefined
  let masterCompCfg: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number } | undefined
  let visualSrc: string | undefined

  // Staging is SEALED once the synchronous eval returns: a p() reached from
  // a timer/promise would otherwise silently vanish (its eval's maps are
  // already applied or discarded). Sealing turns that loss into an honest
  // error at the call site.
  let sealed = false
  const assertOpen = (fn: string): void => {
    if (sealed) {
      throw new Error(`${fn}(): eval already completed; async registration is not supported`)
    }
  }

  /** Register a pattern; same name twice in one eval → last wins. */
  const p = (name: unknown, pat: unknown): void => {
    assertOpen('p')
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`p(): name must be a non-empty string, got ${JSON.stringify(name)}`)
    }
    if (!(pat instanceof Pattern)) {
      throw new TypeError(`p('${name}'): second argument must be a Pattern`)
    }
    patterns.set(name, pat as Pattern<ControlMap>)
  }

  const defineSynth = (name: unknown, def: unknown): void => {
    assertOpen('defineSynth')
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(
        `defineSynth(): name must be a non-empty string, got ${JSON.stringify(name)}`,
      )
    }
    if (typeof def !== 'object' || def === null || !('graph' in def)) {
      throw new TypeError(`defineSynth('${name}'): second argument must be a synth(...) result`)
    }
    synths.set(name, def as SynthDef)
  }

  const setCps = (x: unknown): void => {
    assertOpen('setCps')
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new TypeError(`setCps(): expected a finite number, got ${String(x)}`)
    }
    cps = clampCps(x)
  }

  /** Arm the sidechain duck: `source` synth's notes duck every other channel.
   *  `opts.depth` 0..1 (default 0.6), `opts.release` in SECONDS (default 0.18),
   *  stored as releaseMs. `opts.duck` is an optional per-synth map of duck
   *  amounts (0..1): `{ arp: 1, pad: 0.4 }` ducks the arp fully and the pad
   *  lightly; any synth not listed defaults to 1 (full duck). Last call in
   *  one eval wins. */
  const sidechain = (source: unknown, opts?: unknown): void => {
    assertOpen('sidechain')
    if (typeof source !== 'string' || source.length === 0) {
      throw new TypeError(`sidechain(): source must be a non-empty string, got ${JSON.stringify(source)}`)
    }
    const o = (typeof opts === 'object' && opts !== null ? opts : {}) as {
      depth?: unknown
      release?: unknown
      duck?: unknown
    }
    let depth = DEFAULT_SIDECHAIN_DEPTH
    if (o.depth !== undefined) {
      if (typeof o.depth !== 'number' || !Number.isFinite(o.depth)) {
        throw new TypeError(`sidechain('${source}'): depth must be a finite number (0..1)`)
      }
      depth = o.depth
    }
    let releaseSec = DEFAULT_SIDECHAIN_RELEASE_SEC
    if (o.release !== undefined) {
      if (typeof o.release !== 'number' || !Number.isFinite(o.release)) {
        throw new TypeError(`sidechain('${source}'): release must be a finite number of seconds`)
      }
      releaseSec = o.release
    }
    let amounts: Record<string, number> | undefined
    if (o.duck !== undefined) {
      if (typeof o.duck !== 'object' || o.duck === null) {
        throw new TypeError(`sidechain('${source}'): duck must be an object mapping synth names to amounts (0..1)`)
      }
      amounts = {}
      for (const [synth, amount] of Object.entries(o.duck as Record<string, unknown>)) {
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1) {
          throw new TypeError(`sidechain('${source}'): duck['${synth}'] must be a number in [0, 1], got ${String(amount)}`)
        }
        amounts[synth] = amount
      }
    }
    sidechainCfg = { source, depth, releaseMs: releaseSec * 1000, ...(amounts !== undefined ? { amounts } : {}) }
  }

  /** Arm the master-bus glue compressor (stereo-linked, after master gain,
   *  before the limiter). All opts optional with compressor defaults
   *  (threshold -18 dB, ratio 4, attack 10 ms, release 120 ms, knee 6 dB,
   *  makeup 0 dB). Values are validated + clamped engine-side. Last call wins. */
  const masterCompress = (opts?: unknown): void => {
    assertOpen('masterCompress')
    const o = (typeof opts === 'object' && opts !== null ? opts : {}) as Record<string, unknown>
    const numField = (key: string, def: number): number => {
      if (o[key] === undefined) return def
      if (typeof o[key] !== 'number' || !Number.isFinite(o[key])) {
        throw new TypeError(`masterCompress(): ${key} must be a finite number`)
      }
      return o[key] as number
    }
    masterCompCfg = {
      threshold: numField('threshold', -18),
      ratio: numField('ratio', 4),
      attack: numField('attack', 10),
      release: numField('release', 120),
      knee: numField('knee', 6),
      makeup: numField('makeup', 0),
    }
  }

  /** Register the WGSL fragment source for the shader visualizer. The string
   *  is NOT parsed here (it's not JavaScript) — it's handed verbatim to the
   *  GPU layer, which compiles + swaps it live and surfaces WGSL errors
   *  separately. Last call wins. */
  const visual = (wgsl: unknown): void => {
    assertOpen('visual')
    if (typeof wgsl !== 'string') {
      throw new TypeError('visual(): shader source must be a string (a WGSL template literal)')
    }
    visualSrc = wgsl
  }

  const names: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(scope)) {
    if (STAGING_NAMES.has(key)) continue // per-eval versions win
    if (!IDENT_RE.test(key)) {
      throw new Error(`evalCode: scope key '${key}' is not a valid identifier`) // caller bug
    }
    names.push(key)
    values.push(value)
  }
  names.push('p', 'defineSynth', 'setCps', 'sidechain', 'masterCompress', 'visual')
  values.push(p, defineSynth, setCps, sidechain, masterCompress, visual)

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...names, `'use strict';\n${transformed}`)
    fn(...values)
  } catch (e) {
    const lineCount = source.split('\n').length
    diagnostics.push(
      e instanceof MiniError ? mapMiniError(e, source, program) : mapRuntimeError(e, lineCount),
    )
    // All-or-nothing: partial registrations from before the throw are
    // DISCARDED — fresh empty maps, never the staging ones.
    return { ok: false, diagnostics, synths: new Map(), patterns: new Map() }
  } finally {
    sealed = true
  }

  const result: EvalResult = { ok: true, diagnostics, synths, patterns }
  if (cps !== undefined) result.cps = cps
  if (sidechainCfg !== undefined) result.sidechain = sidechainCfg
  if (masterCompCfg !== undefined) result.masterComp = masterCompCfg
  if (visualSrc !== undefined) result.visual = visualSrc
  return result
}
