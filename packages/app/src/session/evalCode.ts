import { parse } from 'acorn'
import type { Expression, Program } from 'acorn'
import { simple as walkSimple } from 'acorn-walk'
import { MiniError, Pattern, note, automation, TimeSpan, F, hasOnset, bpmToCps, quartersPerBar, DEFAULT_TIME_SIG, clearCustomScales, snapshotCustomScales, restoreCustomScales, setMacroValue, clearMacroValues, clearCurveShapes, snapshotCurveShapes, restoreCurveShapes } from '@rondocode/pattern'
import type { ControlMap, Hap, TimeSig } from '@rondocode/pattern'
import { RESERVED_PARAM_NAMES, busGraph, tapLoc, synth, micDevicesIn, usesMicIn, clearCustomWavetables, snapshotCustomWavetables, restoreCustomWavetables, clearMacros, snapshotMacros, restoreMacros, getMacros } from '@rondocode/engine'
import type { SynthDef, GraphSpec } from '@rondocode/engine'
import { parseMelodyMini } from '../sing/warp'
import { MASK_SLOT_MAX, MASK_SLOT_MIN, paintFrame } from '../mask/frame'
import type { MaskFrame, MaskPainter } from '../mask/frame'
import { MASK_SOUND } from '../mask/protocol'

/** Sounds that are OUTPUTS OUTSIDE THE ENGINE. A pattern routed to one still
 *  runs through the scheduler and reaches onPatternEvents (where the mask
 *  module picks it up, mask/output.ts), but Session.dispatchEvents never turns
 *  it into engine messages: there is no synth by that name, and every step
 *  would otherwise log `unknown synth`. The same set is why defineSynth
 *  refuses these names: a synth called `mask` would compile and never be
 *  heard. */
export const EXTERNAL_OUTPUTS: ReadonlySet<string> = new Set([MASK_SOUND])

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

/** A staged shared send-bus: its compiled FX graph plus an output gain. */
export interface BusDef {
  graph: GraphSpec
  gain: number
}

/** A staged per-synth send into a bus (0..1); collected from the bus() send
 *  maps and diffed into setSend messages by the Session. */
export interface SendSpec {
  synth: string
  bus: string
  amount: number
}

/** A staged sing() request: turn `lyrics` (mini-notation) into a vocal on
 *  `notes` (mini-notation) in the RVC `voice`. sing() has already staged a
 *  sampler synth (`synthName`) + a trigger pattern under it, so once the editor
 *  renders the clip (async, neural) and loadSamplePcm's it as `sampleName`, it
 *  plays. Pure eval can't await the render, hence this hand-off. */
export interface SingRequest {
  sampleName: string
  synthName: string
  voice: string
  lyrics: string
  notes: string
  /** How many CYCLES the melody spans (default 1). A real song phrase runs
   *  several bars, so the melody mini unrolls over `cycles` cycles, the baked
   *  clip is that long, and the trigger fires once per `cycles`. */
  cycles: number
}

/** Automation steps per cycle under a sing() trigger: a 16th grid, so a
 *  patterned post param moves at the same resolution a `<a b c d>` value
 *  pattern is usually written in. A step holds until the next one. */
export const SING_AUTOMATION_RATE = 16

/** djb2 string hash → short stable id (for the per-sing sample/synth names). */
function singId(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** True when any staged synth's voice or post graph contains a live mic()
 *  node — the signal a host uses to open/close the device microphone. */
export function synthsUseMic(synths: ReadonlyMap<string, SynthDef>): boolean {
  // usesMicIn is the engine's walk — the offline render sweep asks the same
  // question (a mic voice is silent with no input device), and two walks of
  // the same node type is how they drift.
  return [...synths.values()].some((d) => usesMicIn(d.graph) || (d.post !== undefined && usesMicIn(d.post)))
}

/** EVERY input device the staged program asks for via `mic(device:…)`, in
 *  first-appearance order across voice and post graphs, each once. The app
 *  hands the list to AudioSession, which opens one live capture per name
 *  (slots are capped engine-side at MAX_MIC_INPUTS; extras are dropped with
 *  a console warning). A bare mic() reads the default capture and needs no
 *  entry here. */
export function synthsMicDevices(synths: ReadonlyMap<string, SynthDef>): string[] {
  const out: string[] = []
  for (const d of synths.values()) {
    for (const name of [...micDevicesIn(d.graph), ...(d.post !== undefined ? micDevicesIn(d.post) : [])]) {
      if (!out.includes(name)) out.push(name)
    }
  }
  return out
}

export interface EvalResult {
  /** True when the source parsed and ran to completion (warnings allowed). */
  ok: boolean
  diagnostics: Diagnostic[]
  /** Staged synth registrations — populated only when ok. */
  synths: Map<string, SynthDef>
  /** Staged pattern registrations — populated only when ok. */
  patterns: Map<string, Pattern<ControlMap>>
  /** Staged shared send buses — populated only when ok. */
  buses: Map<string, BusDef>
  /** Staged per-synth sends into buses — populated only when ok. */
  sends: SendSpec[]
  /** Present iff the code called setCps(x) or setBpm(x); clamped to [0.05, 4].
   *  A bpm is converted with the meter below, whichever line came first. */
  cps?: number
  /** The project's meter. Present on every SUCCESSFUL eval — 4/4 when the code
   *  never called setTimeSig — because the document owns it: deleting the line
   *  has to mean 4/4 again, not "keep whatever it was". */
  timeSig?: TimeSig
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
  /** Present iff the code called masterGain(db): overall output level in dB.
   *  The one lever that scales EVERYTHING equally. Without it the only way to
   *  change a project's level was to edit every synth, and a project mixed
   *  past the render's 0.89 peak ceiling could not be brought back under it at
   *  all — every per-part gain above the ceiling is inert (see normalizeDb).
   *  Last call wins. */
  masterGain?: number
  /** Present iff the code called stereo(opts): master-bus mid/side. */
  stereo?: { width?: number; monoBelow?: number }
  /** Present iff the code called route(): per-synth hardware output routing,
   *  1-BASED channel pairs as written (`route('click', 3, 4)`). The live
   *  session converts to the engine's 0-based setChannel `out`; the offline
   *  render ignores routing by design (the bounce is the stereo master). */
  routes?: Record<string, { lo: number; hi: number }>
  /** Present iff the code called visual(wgsl): the WGSL fragment source for
   *  the programmable shader visualizer (compiled + swapped live by the GPU
   *  layer, never through this evaluator). Last call wins. */
  visual?: string
  /** Staged sing() requests — the editor renders each neural vocal (async) and
   *  loadSamplePcm's it under sampleName; the sampler synth + trigger pattern are
   *  already in `synths`/`patterns`, so the clip plays once loaded. */
  sings: SingRequest[]
  /** Staged maskFrame() pictures by DIY slot, for the LED mask (mask/). Not
   *  audio: the offline render never sees them, the live mask module diffs
   *  them against what the connected mask holds and uploads the changes. */
  maskFrames: Map<number, MaskFrame>
}

/** Tempo bounds shared with the Session (setCps and transport clamp alike). */
export const clampCps = (x: number): number => Math.min(4, Math.max(0.05, x))

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** Names injected per-eval; never taken from the caller's scope object.
 *  EXPORTED so the docs-coverage test can check itself against this list
 *  instead of keeping a second copy that drifts (docs.test.ts). */
export const STAGING_NAMES = new Set(['p', 'defineSynth', 'setCps', 'setBpm', 'setTimeSig', 'sidechain', 'masterCompress', 'masterGain', 'stereo', 'visual', 'bus', 'sing', 'route', 'maskFrame', '__rcTap'])

/** DSL sidechain defaults. `release` is MILLISECONDS, like every other
 *  release in the language — it used to be seconds here and only here, so the
 *  same word meant 0.18 in one place and 180 in the next. Exported so the
 *  editor's duck-curve widget draws the shape an omitted arg actually makes
 *  rather than keeping a third copy of these numbers. */
export const DEFAULT_SIDECHAIN_DEPTH = 0.6
export const DEFAULT_SIDECHAIN_RELEASE_MS = 180

/** Below this, a `release` was almost certainly written in seconds. A duck
 *  that recovers in under 5 ms is not a pump, it is a click, so treating the
 *  old spelling as a valid new one would silently destroy the effect. */
const SUSPICIOUS_RELEASE_MS = 5

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
  // Live-value probe: wrap modulation signal expressions with __rcTap(from, to, …)
  // so the builder tags each produced node with its source span (see tapLoc /
  // SynthDef.nodeLocs). Targets are Call/Member expressions in the positions
  // where a signal feeds something — call arguments and variable-declarator
  // inits — which is exactly `sine(0.5).range(200,2000)` as a filter cutoff, an
  // adsr in a .mul(), an lfo bound to a const, etc. Transparent at runtime and a
  // no-op for non-Sig values (patterns, numbers, objects), so wrapping widely is
  // safe. Embedded offsets are into the ORIGINAL source (= the editor doc).
  const wrap = (node: { type: string; start: number; end: number } | null | undefined): void => {
    if (node != null && (node.type === 'CallExpression' || node.type === 'MemberExpression')) {
      inserts.push({ at: node.start, text: `__rcTap(${node.start},${node.end},` })
      inserts.push({ at: node.end, text: ')' })
    }
  }
  walkSimple(program, {
    CallExpression(node) {
      for (const arg of node.arguments) wrap(arg as { type: string; start: number; end: number })
    },
    VariableDeclarator(node) {
      wrap(node.init as { type: string; start: number; end: number } | null)
    },
  })
  let transformed = source
  // High-offset-first so earlier splices don't shift later offsets. Proper AST
  // nesting means an open (at start) and a close (at end) never share an offset.
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

/** Control keys that are NOT synth params (they carry structural meaning and
 *  never reach setParam). MUST mirror Session.NON_PARAM_KEYS — the dispatch
 *  loop sends every OTHER numeric control key as a setParam, so those are the
 *  ones a synth must actually declare. */
/** Structural keys, DERIVED rather than restated. This was a second copy of
 *  the engine's list, and it drifted the moment `nAcc` was added: a scale
 *  degree with an accidental staged as `ctrl('nAcc')` against a synth that
 *  could never declare it, so an entirely valid line failed to run. */
const NON_PARAM_CTRL_KEYS: ReadonlySet<string> = RESERVED_PARAM_NAMES

/** How many cycles to sample when discovering which (sound, param) controls a
 *  pattern actually drives. Covers `<a b>` alternations and typical
 *  `arrange([8,…],[8,…])` / slow `cat` sections that only route a given synth
 *  after several cycles; a still-slower structural switch can escape (queries
 *  are cheap, but this stays bounded). */
const CTRL_SCAN_CYCLES = 16

/** Extra SINGLE cycles probed after the dense window, at the bar counts real
 *  arrangements start sections on.
 *
 *  The dense window is [0, 16), so a program whose second section begins at
 *  bar 16 — `section build 16` then `section drop 16`, the most ordinary shape
 *  in dance music — had every ctrl in its second half unchecked, and the bad
 *  one surfaced as an engine warning while it played. Probing one cycle at
 *  each boundary costs a fraction of widening the window (this runs on every
 *  eval, including a widget drag) and covers arrangements out to 64 bars. */
const CTRL_PROBE_CYCLES = [16, 24, 32, 48, 64]

/** What every eval-time pattern check reads: the haps a scan of the staged
 *  patterns turns up, queried ONCE.
 *
 *  Four checks want this (ctrl targets, mono chords, orphan sing() requests,
 *  gate length) and each used to run its own 16-cycle query, so the cost of
 *  the scan was paid three times over on every keystroke-triggered eval and a
 *  fourth check would have cost a fourth. `dense` is the contiguous window,
 *  which is the only part where the GAP between two haps means anything;
 *  `probes` are the far single cycles, useful for "does this ever happen" and
 *  useless for "what happens next". */
interface ScannedHaps {
  dense: Hap<ControlMap>[]
  probes: Hap<ControlMap>[]
}

/** Query every staged pattern over the scan window and the far probes. A
 *  pattern whose query throws is skipped: a pattern bug must never block an
 *  eval, it has its own failure path at play time. */
const scanHaps = (patterns: Map<string, Pattern<ControlMap>>): ScannedHaps => {
  const dense: Hap<ControlMap>[] = []
  const probes: Hap<ControlMap>[] = []
  const denseSpan = new TimeSpan(F(0), F(CTRL_SCAN_CYCLES))
  const probeSpans = CTRL_PROBE_CYCLES.map((c) => new TimeSpan(F(c), F(c + 1)))
  for (const pat of patterns.values()) {
    try {
      dense.push(...pat.query(denseSpan))
      for (const sp of probeSpans) probes.push(...pat.query(sp))
    } catch {
      continue
    }
  }
  return { dense, probes }
}

/**
 * Catch `.ctrl('name', …)` targets that the engine would reject at play time as
 * `unknown param 'name'` — a bug that otherwise only surfaces as a per-cycle
 * console warning (the audio path is typo-tolerant by design). We know the spec
 * here, so we turn it into a positioned editor diagnostic BEFORE it plays.
 *
 * A control key becomes a setParam iff it's numeric and not structural
 * (NON_PARAM_CTRL_KEYS), and the engine validates it against the routed synth's
 * VOICE params only (graph.params). A `param()` declared in the POST chain lands
 * in post.params and is unreachable by .ctrl — the most common trap — so we call
 * that out specifically. Positions come from the `.ctrl('name', …)` call sites
 * in the source AST. Best-effort: a pattern whose query throws is skipped.
 */
const validateCtrlParams = (
  synths: Map<string, SynthDef>,
  haps: ScannedHaps,
  program: Program,
): Diagnostic[] => {
  if (synths.size === 0) return []
  // Collect `.ctrl('KEY', …)` call sites for positioning, keyed by KEY.
  const ctrlSites = new Map<string, { line: number; col: number }[]>()
  walkSimple(program, {
    CallExpression(node) {
      const callee = node.callee
      const arg0 = node.arguments[0] as { type?: string; value?: unknown; loc?: { start: { line: number; column: number } } } | undefined
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'ctrl' &&
        arg0?.type === 'Literal' &&
        typeof arg0.value === 'string' &&
        arg0.loc !== undefined
      ) {
        const arr = ctrlSites.get(arg0.value) ?? []
        arr.push({ line: arg0.loc.start.line, col: arg0.loc.start.column + 1 })
        ctrlSites.set(arg0.value, arr)
      }
    },
  })
  const diags: Diagnostic[] = []
  const seen = new Set<string>() // dedup by `${sound}|${key}`
  for (const h of [...haps.dense, ...haps.probes]) {
    const c = h.value
    const sound = c.sound
    if (typeof sound !== 'string') continue
    const def = synths.get(sound)
    if (def === undefined) continue // unknown sound: not this check's concern
    for (const [key, val] of Object.entries(c)) {
      if (NON_PARAM_CTRL_KEYS.has(key) || typeof val !== 'number') continue
      const dedup = `${sound}|${key}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      if (def.graph.params.some((p) => p.name === key)) continue // valid voice param
      if (def.post?.params.some((p) => p.name === key) === true) continue // valid POST param (now driveable)
      const message = `ctrl('${key}'): synth '${sound}' declares no param '${key}'.`
      const sites = ctrlSites.get(key) ?? [{ line: 1, col: 1 }]
      for (const s of sites) {
        diags.push({ line: s.line, col: s.col, message, severity: 'error', source: 'eval' })
      }
    }
  }
  return diags
}

/** How many times longer than its own next trigger a gate has to run before
 *  it is worth saying something. Legato wants a little overlap (dur 1.05 on a
 *  run of eighths is a normal, deliberate thing), so the threshold is not
 *  "overlaps at all" — it is "so far past the retrigger that the number cannot
 *  mean what it looks like it means". */
const GATE_OVERRUN_FACTOR = 2

/**
 * Catch a `dur` that holds a note's gate long past its own next trigger.
 *
 * `dur` MULTIPLIES the note's whole; it is not a length in bars. So
 * `.slow(16).dur(16)` does not mean "sixteen bars", it means sixteen times a
 * sixteen-bar note: a 256-bar gate on a riser that retriggers every 16, which
 * is how a build-up sailed straight through the drop it was built for with
 * nothing anywhere reporting it.
 *
 * Nothing downstream can catch this. The gate is legal, the render is clean,
 * and because a retrigger of the SAME note steals its own voice, dur 16 and
 * dur 1.0001 sound identical past the retrigger point: the extra length is
 * inert, so there is no audible symptom to chase either.
 *
 * A warning, not an error: it plays, and the fix is a judgement call.
 *
 * The probe cycles count here, as SUCCESSORS only. A 16-bar note has exactly
 * one onset inside a 16-cycle window, so the dense window alone cannot see it
 * retrigger and missed the very case this was written for. Since the dense
 * window is contiguous, any onset before its end is already in it, so the
 * earliest probe onset after a hap is an UPPER bound on the true gap. An
 * over-estimated gap can only under-state the overrun, so this can miss a
 * case but never invent one.
 */
const validateGateLength = (
  synths: Map<string, SynthDef>,
  haps: ScannedHaps,
  program: Program,
): Diagnostic[] => {
  if (synths.size === 0) return []
  // Onsets grouped by the voice they land on: same sound AND same note, since
  // that is what shares (and steals) a voice. A chord's notes are separate.
  const byVoice = new Map<string, { at: number; gate: number; dur: number }[]>()
  for (const h of [...haps.dense, ...haps.probes]) {
    if (!hasOnset(h)) continue
    const c = h.value
    if (typeof c.sound !== 'string' || typeof c.note !== 'number') continue
    if (!synths.has(c.sound)) continue
    const dur = typeof c.dur === 'number' ? c.dur : 1
    const whole = h.whole!.length.valueOf()
    const key = `${c.sound}|${c.note}`
    const arr = byVoice.get(key) ?? []
    arr.push({ at: h.whole!.begin.valueOf(), gate: whole * dur, dur })
    byVoice.set(key, arr)
  }
  // Position on the `.dur(` call sites, keyed by the LITERAL they were given.
  // A file with several dur() calls would otherwise get the same warning
  // repeated once per call site — five copies of one finding, which reads as
  // five problems. Matching on the value pairs them in the ordinary case.
  const durSites: { line: number; col: number; value?: number }[] = []
  walkSimple(program, {
    CallExpression(node) {
      const callee = node.callee
      const arg0 = node.arguments[0] as { type?: string; value?: unknown } | undefined
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'dur' &&
        callee.property.loc != null
      ) {
        const site: { line: number; col: number; value?: number } = {
          line: callee.property.loc.start.line,
          col: callee.property.loc.start.column + 1,
        }
        if (arg0?.type === 'Literal' && typeof arg0.value === 'number') site.value = arg0.value
        durSites.push(site)
      }
    },
  })
  const diags: Diagnostic[] = []
  const warned = new Set<string>()
  for (const [key, list] of byVoice) {
    if (list.length < 2) continue // no next trigger inside the window to run past
    list.sort((a, b) => a.at - b.at)
    for (let i = 0; i < list.length - 1; i++) {
      const cur = list[i]!
      const gap = list[i + 1]!.at - cur.at
      if (gap <= 0 || cur.gate <= gap * GATE_OVERRUN_FACTOR) continue
      const sound = key.slice(0, key.lastIndexOf('|'))
      if (warned.has(sound)) break
      warned.add(sound)
      const round = (n: number): string => String(Math.round(n * 100) / 100)
      const message =
        `dur ${round(cur.dur)} on '${sound}' holds the gate ${round(cur.gate)} cycles, but the same note ` +
        `retriggers after ${round(gap)} — dur MULTIPLIES the note's own length, it is not a count of bars. ` +
        `The extra length can never sound.`
      // exactly one diagnostic per finding: the site whose literal matches,
      // else the first dur() in the file, else the top.
      const site = durSites.find((d) => d.value === cur.dur) ?? durSites[0] ?? { line: 1, col: 1 }
      diags.push({ line: site.line, col: site.col, message, severity: 'warning', source: 'eval' })
      break
    }
  }
  return diags
}

/**
 * Catch bus()/sidechain() targeting synth names that don't exist. Like a stray
 * `.ctrl` target, an unknown send/duck target otherwise VANISHES silently — the
 * Session guards sends/ducks on `liveSynths.has(...)` and the engine never
 * checks the sidechain source — so the send never routes and the sidechain
 * never ducks, with zero feedback. We know the staged synth set here.
 */
const validateStagingTargets = (
  synths: Map<string, SynthDef>,
  sends: SendSpec[],
  sidechain: { source: string; amounts?: Record<string, number> } | undefined,
  program: Program,
): Diagnostic[] => {
  const diags: Diagnostic[] = []
  // Positions: the first bus()/sidechain() call site (good enough to locate it).
  let busPos: { line: number; col: number } | undefined
  let scPos: { line: number; col: number } | undefined
  walkSimple(program, {
    CallExpression(node) {
      const callee = node.callee as { type?: string; name?: string }
      const loc = (node as { loc?: { start: { line: number; column: number } } }).loc
      if (callee.type === 'Identifier' && loc !== undefined) {
        if (callee.name === 'bus' && busPos === undefined) busPos = { line: loc.start.line, col: loc.start.column + 1 }
        if (callee.name === 'sidechain' && scPos === undefined) scPos = { line: loc.start.line, col: loc.start.column + 1 }
      }
    },
  })
  const push = (message: string, p?: { line: number; col: number }): void => {
    diags.push({ line: p?.line ?? 1, col: p?.col ?? 1, message, severity: 'error', source: 'eval' })
  }
  const seen = new Set<string>()
  for (const s of sends) {
    if (!synths.has(s.synth) && !seen.has(`send|${s.synth}`)) {
      seen.add(`send|${s.synth}`)
      push(`bus('${s.bus}'): send source synth '${s.synth}' is not defined — the send is silently dropped.`, busPos)
    }
  }
  if (sidechain !== undefined) {
    if (!synths.has(sidechain.source)) {
      push(`sidechain('${sidechain.source}'): source synth is not defined — nothing will duck.`, scPos)
    }
    for (const name of Object.keys(sidechain.amounts ?? {})) {
      if (!synths.has(name) && !seen.has(`duck|${name}`)) {
        seen.add(`duck|${name}`)
        push(`sidechain(): duck target synth '${name}' is not defined.`, scPos)
      }
    }
  }
  return diags
}

/**
 * Non-fatal WARNING: a chord / stacked simultaneous notes routed to a MONO
 * synth silently plays only one note (the mono voice retriggers). We caught the
 * ctrl/param traps as errors; this one is legal but surprising, so warn.
 */
const detectMonoChords = (
  synths: Map<string, SynthDef>,
  haps: ScannedHaps,
): Diagnostic[] => {
  const warned = new Set<string>()
  const diags: Diagnostic[] = []
  const counts = new Map<string, number>() // `${sound}@${onsetTime}` -> notes
  for (const h of haps.dense) {
    if (!hasOnset(h)) continue
    const c = h.value
    if (typeof c.sound !== 'string' || typeof c.note !== 'number') continue
    const def = synths.get(c.sound)
    if (def?.voiceOpts?.mono !== true || warned.has(c.sound)) continue
    const k = `${c.sound}@${h.whole!.begin.toString()}`
    const next = (counts.get(k) ?? 0) + 1
    counts.set(k, next)
    if (next > 1) {
      warned.add(c.sound)
      diags.push({
        line: 1,
        col: 1,
        message: `synth '${c.sound}' is mono, but it's fed simultaneous notes (a chord/stack) — only one sounds. Drop mono (or set voices>1) to hear the harmony.`,
        severity: 'warning',
        source: 'eval',
      })
    }
  }
  return diags
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
    return { ok: false, diagnostics: [parsed.error], synths: new Map(), patterns: new Map(), buses: new Map(), sends: [], sings: [], maskFrames: new Map() }
  }
  const { program } = parsed
  const { transformed, warnings } = transformSynthDecls(source, program)
  const diagnostics: Diagnostic[] = [...warnings]

  // Per-eval staging: closed over by the injected p/defineSynth/setCps.
  const synths = new Map<string, SynthDef>()
  const patterns = new Map<string, Pattern<ControlMap>>()
  const buses = new Map<string, BusDef>()
  const sends: SendSpec[] = []
  const sings: SingRequest[] = []
  /** sing() synth name -> its content id, to catch name collisions (a different
   *  vocal or a user synth reusing the name) while allowing identical re-calls. */
  const singNames = new Map<string, string>()
  /** The tempo line as WRITTEN. Resolved to cps once the eval closes, because
   *  bpm needs the meter and the meter can be set on any line. */
  let tempo: { unit: 'cps' | 'bpm'; value: number } | undefined
  let timeSig: TimeSig | undefined
  let sidechainCfg: { source: string; depth: number; releaseMs: number; amounts?: Record<string, number> } | undefined
  let masterCompCfg: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number } | undefined
  let masterGainDb: number | undefined
  let stereoCfg: { width?: number; monoBelow?: number } | undefined
  let visualSrc: string | undefined
  const maskFrames = new Map<number, MaskFrame>()

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

  /** Register a pattern; same name twice in one eval → last wins, and SAYS SO.
   *
   *  Silent replacement is the worst possible behaviour here: the earlier
   *  block is still on screen, still highlighted, still flashing its notes in
   *  the roll — and completely inaudible. It cost a shipped example, where two
   *  `play lead` blocks meant the first one never played and nothing said a
   *  word. Two notation lines inside ONE block are layers; two blocks are not.
   *
   *  A warning rather than an error: last-wins is legitimate when a later eval
   *  deliberately redefines a channel, and refusing to run would break that. */
  const p = (name: unknown, pat: unknown): void => {
    assertOpen('p')
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`p(): name must be a non-empty string, got ${JSON.stringify(name)}`)
    }
    if (!(pat instanceof Pattern)) {
      throw new TypeError(`p('${name}'): second argument must be a Pattern`)
    }
    if (patterns.has(name)) {
      diagnostics.push({
        line: 1,
        col: 1,
        message: `two blocks both play '${name}' — the second REPLACES the first, so the earlier one is silent. Put the extra notation line inside the same block to layer them, or route it to another synth.`,
        severity: 'warning',
        source: 'eval',
      })
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
    if (singNames.has(name)) {
      throw new TypeError(`synth '${name}' collides with a sing() vocal of the same name — rename one`)
    }
    if (EXTERNAL_OUTPUTS.has(name)) {
      throw new TypeError(`'${name}' is the sound name of the LED mask output, so a synth called '${name}' would never be heard — rename it`)
    }
    synths.set(name, def as SynthDef)
  }

  const setCps = (x: unknown): void => {
    assertOpen('setCps')
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new TypeError(`setCps(): expected a finite number, got ${String(x)}`)
    }
    tempo = { unit: 'cps', value: x }
  }

  /** The same tempo staging, in the unit producers count in. One cycle is one
   *  BAR, so at 4/4 128 bpm is 0.5333 cps — the identical convention MIDI
   *  import and export use (bpmToCps is the one conversion, in @rondocode/pattern).
   *  setCps and setBpm are the same slot: the last call in an eval wins.
   *
   *  DEFERRED, not converted here: bpm depends on how many quarters a bar
   *  holds, and setTimeSig may not have been called yet. Converting on the
   *  spot would make `bpm 120` + `timesig 3 4` mean something different from
   *  the same two lines in the other order, which no one would ever guess. */
  const setBpm = (x: unknown): void => {
    assertOpen('setBpm')
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new TypeError(`setBpm(): expected a finite number, got ${String(x)}`)
    }
    tempo = { unit: 'bpm', value: x }
  }

  /** The project's meter. A cycle is one BAR, so this is what makes a bar
   *  three quarters long instead of four: it scales `bpm`, the header tempo
   *  readout, the MIDI clock and the exported file's bar lines, all of which
   *  read it back off the session state. Written down rather than baked into
   *  a decimal cps, so the intent survives.
   *
   *  Only the DENOMINATOR is restricted (a power of two): that is what a time
   *  signature can express, and what the SMF meta event can store. 7/8 and
   *  5/4 are ordinary; 4/6 is not a thing. */
  const setTimeSig = (num: unknown, den: unknown): void => {
    assertOpen('setTimeSig')
    if (typeof num !== 'number' || !Number.isInteger(num) || num < 1 || num > 64) {
      throw new TypeError(`setTimeSig(): beats per bar must be a whole number in 1..64, got ${String(num)}`)
    }
    if (typeof den !== 'number' || !Number.isInteger(den) || den < 1 || den > 64 || (den & (den - 1)) !== 0) {
      throw new TypeError(
        `setTimeSig(): the beat unit must be a power of two in 1..64 (2, 4, 8, 16…), got ${String(den)}`,
      )
    }
    timeSig = { num, den }
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
    let releaseMs = DEFAULT_SIDECHAIN_RELEASE_MS
    if (o.release !== undefined) {
      if (typeof o.release !== 'number' || !Number.isFinite(o.release)) {
        throw new TypeError(`sidechain('${source}'): release must be a finite number of milliseconds`)
      }
      if (o.release > 0 && o.release < SUSPICIOUS_RELEASE_MS) {
        throw new TypeError(
          `sidechain('${source}'): release is MILLISECONDS, and ${o.release} ms is a click rather `
          + `than a pump. This used to be seconds — write ${Math.round(o.release * 1000)} for the `
          + `same sound.`,
        )
      }
      releaseMs = o.release
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
    sidechainCfg = { source, depth, releaseMs, ...(amounts !== undefined ? { amounts } : {}) }
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

  /** Set the overall output level in dB (0 = unity, negative = quieter).
   *  Applied to the summed mix, so it scales every part equally and changes
   *  nothing about the balance. This is the lever to reach for when the bounce
   *  reports `normalized -N dB`: per-part gains above that ceiling are inert,
   *  and only a uniform trim brings the whole mix back under it. Clamped to
   *  [-60, +12] dB. Last call wins. */
  /** `stereo({ width, monoBelow })` — master-bus mid/side. Staged like every
   *  other master-bus call so a failed eval changes nothing. */
  const stereo = (opts: unknown): void => {
    assertOpen('stereo')
    const o = typeof opts === 'object' && opts !== null ? (opts as Record<string, unknown>) : {}
    const out: { width?: number; monoBelow?: number } = {}
    for (const k of ['width', 'monoBelow'] as const) {
      const v = o[k]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new TypeError(`stereo(): ${k} must be a finite number, got ${JSON.stringify(v)}`)
      }
      out[k] = v
    }
    stereoCfg = out
  }

  const masterGain = (db: unknown): void => {
    assertOpen('masterGain')
    if (typeof db !== 'number' || !Number.isFinite(db)) {
      throw new TypeError(`masterGain(): expected a number of dB, got ${String(db)}`)
    }
    masterGainDb = Math.min(12, Math.max(-60, db))
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

  /** Paint a picture for a DIY slot on the LED mask (see docs 'LED mask').
   *  The painter runs NOW, once per pixel, so a bad colour fails on this line
   *  rather than five seconds into an upload. Last call per slot wins. */
  const maskFrame = (slot: unknown, paint: unknown): void => {
    assertOpen('maskFrame')
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < MASK_SLOT_MIN || slot > MASK_SLOT_MAX) {
      throw new RangeError(`maskFrame(): slot must be a whole number ${MASK_SLOT_MIN}..${MASK_SLOT_MAX}, got ${JSON.stringify(slot)}`)
    }
    if (typeof paint !== 'function') {
      throw new TypeError('maskFrame(): second argument must be a painter, (x, y) => colour')
    }
    maskFrames.set(slot, paintFrame(paint as MaskPainter))
  }

  /** Declare a shared send bus: a named FX chain that synths feed. `fxFn` is a
   *  POST-style chain — `({ input, reverb, delay, ... }) => sig` — compiled
   *  like a synth's post chain. `sendMap` (optional) routes synths into the bus:
   *  `{ pad: 0.4, arp: 0.2 }` sends 40% of pad and 20% of arp (pre-fader, so a
   *  reverb send doesn't pump with the sidechain). `opts.gain` (default 1)
   *  scales the bus output, which is summed into the master before the glue
   *  compressor. Last bus() with a given name wins. */
  const bus = (name: unknown, fxFn: unknown, sendMap?: unknown, opts?: unknown): void => {
    assertOpen('bus')
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`bus(): name must be a non-empty string, got ${JSON.stringify(name)}`)
    }
    if (typeof fxFn !== 'function') {
      throw new TypeError(`bus('${name}'): second argument must be an FX function ({ input, reverb, ... }) => sig`)
    }
    const o = (typeof opts === 'object' && opts !== null ? opts : {}) as { gain?: unknown }
    let gain = 1
    if (o.gain !== undefined) {
      if (typeof o.gain !== 'number' || !Number.isFinite(o.gain)) {
        throw new TypeError(`bus('${name}'): gain must be a finite number`)
      }
      gain = o.gain
    }
    // Compile the FX chain now (throws map into eval diagnostics like any
    // synth-body error), staging a plain GraphSpec for the engine.
    const graph = busGraph(fxFn as Parameters<typeof busGraph>[0])
    buses.set(name, { graph, gain })
    if (sendMap !== undefined) {
      if (typeof sendMap !== 'object' || sendMap === null) {
        throw new TypeError(`bus('${name}'): third argument must be a send map { synth: amount }`)
      }
      for (const [synth, amount] of Object.entries(sendMap as Record<string, unknown>)) {
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1) {
          throw new TypeError(`bus('${name}'): send['${synth}'] must be a number in [0, 1], got ${String(amount)}`)
        }
        sends.push({ synth, bus: name, amount })
      }
    }
  }

  /** Sing `lyrics` (mini-notation) on `notes` (mini-notation) in an RVC `voice`.
   *  Stages a sampler synth + a render request the editor fulfils (neural,
   *  async), and RETURNS the once-per-cycle trigger Pattern so the caller
   *  registers + shapes it like any other voice — the vocal is a first-class
   *  channel, so it flows through the full FX / post / bus / sidechain chain:
   *
   *    p('vox', sing('barbara', lyr, notes).gain(0.9).late(0.004))
   *
   *  `opts.post` attaches a per-synth DSP FX chain to the vocal itself
   *  (reverb/filter/crush/…, the same builder `synth()`'s 2nd arg takes).
   *  `opts.name` overrides the synth/channel name (default: a content hash) so
   *  bus() sends and sidechain() can target the vocal by that name.
   *
   *  First arg may be omitted to use the default voice. Last sing() with a
   *  given (voice,lyrics,notes) wins the bake; identical calls dedupe. */
  const sing = (a: unknown, b?: unknown, c?: unknown, d?: unknown): Pattern<ControlMap> => {
    assertOpen('sing')
    // Forms: sing(voice, lyrics, notes, opts?) | sing(lyrics, notes, opts?).
    // If `c` is a string it's the 3-string form (opts is `d`); otherwise `b` is
    // the notes string (2-string form, default voice) and opts is `c`.
    let v: unknown, l: unknown, nt: unknown, opts: unknown
    if (typeof c === 'string') {
      v = a
      l = b
      nt = c
      opts = d
    } else {
      v = 'kizuna'
      l = a
      nt = b
      opts = c
    }
    if (typeof v !== 'string' || typeof l !== 'string' || typeof nt !== 'string') {
      throw new TypeError(
        'sing(): expected sing("voice", "lyrics", "notes"[, opts]) or sing("lyrics", "notes"[, opts])',
      )
    }
    if (opts !== undefined && (typeof opts !== 'object' || opts === null)) {
      throw new TypeError('sing(): opts must be an object like { name?, post?, cycles? }')
    }
    const o = (opts ?? {}) as { name?: unknown; post?: unknown; cycles?: unknown }
    let cycles = 1
    if (o.cycles !== undefined) {
      if (typeof o.cycles !== 'number' || !Number.isInteger(o.cycles) || o.cycles < 1 || o.cycles > 64) {
        throw new TypeError('sing(): opts.cycles must be a whole number of cycles from 1 to 64')
      }
      cycles = o.cycles
    }
    if (o.post !== undefined && typeof o.post !== 'function') {
      throw new TypeError('sing(): opts.post must be a function (a post-FX chain builder)')
    }
    if (l.trim() === '' || nt.trim() === '') {
      throw new TypeError('sing(): lyrics and notes must both be non-empty')
    }
    // Parse the note mini-notation NOW so a syntax error is a POSITIONED editor
    // diagnostic (a MiniError maps to the notes literal), not a vague async
    // "Singing failed" dialog only after the model download at bake time.
    parseMelodyMini(nt, 0.5, cycles)
    const id = singId(`${v}\n${l}\n${nt}\n${cycles}`)
    const sampleName = `singclip${id}`
    // synth/channel name: default the content hash (also what karaoke + bake
    // dedup key on); opts.name overrides so bus() + sidechain() can target it.
    let synthName = `singv${id}`
    if (o.name !== undefined) {
      if (typeof o.name !== 'string' || o.name.length === 0) {
        throw new TypeError('sing(): opts.name must be a non-empty string')
      }
      synthName = o.name
    }
    // Name-collision guard: two DIFFERENT vocals sharing a name (one silently
    // wins its bake), or a vocal name colliding with a user synth, both cause
    // silent wrong/missing audio. An identical re-call (same content id) is fine.
    const priorId = singNames.get(synthName)
    if (priorId !== undefined && priorId !== id) {
      throw new Error(`sing(): the name '${synthName}' is used by two different vocals — give one a distinct opts.name`)
    }
    if (priorId === undefined && synths.has(synthName)) {
      throw new Error(`sing(): name '${synthName}' collides with an existing synth — choose another opts.name`)
    }
    singNames.set(synthName, id)
    // sampler synth: plays the (to-be-loaded) clip at natural speed on gate,
    // through the optional per-synth post-FX chain when one is given.
    synths.set(
      synthName,
      synth(
        ({ gate, sample }) => sample(gate, sampleName, { root: 60 }),
        o.post as Parameters<typeof synth>[1],
      ),
    )
    sings.push({ sampleName, synthName, voice: v, lyrics: l, notes: nt, cycles })
    // trigger once per `cycles` (note c4 = the clip's root = natural speed) so
    // the vocal loops with the transport: a 16-cycle phrase retriggers every
    // 16 bars, not every bar. Returned (not auto-registered) — the caller
    // wraps it in p(...).
    const trig = note('c4').sound(synthName) as unknown as Pattern<ControlMap>
    /* CONTINUOUS PARAMS. A param on a note lands when the note does, and a
     * vocal has one note per phrase: `.ctrl('mix', '<.2 .8>')` on a 4-bar
     * phrase moved once every 4 bars, which read as automation that does not
     * work. The automation grid under the trigger carries the same .ctrl()
     * values (a method on the stack reaches both) at SING_AUTOMATION_RATE
     * steps a cycle, whatever the phrase length. */
    const auto = automation(synthName, SING_AUTOMATION_RATE)
    return Pattern.stack(cycles === 1 ? trig : trig.slow(cycles), auto) as Pattern<ControlMap>
  }

  /** Hardware output routing: route('click', 3, 4) sends that synth's strip
   *  to interface outputs 3/4 — 1-BASED, like the jacks are numbered, so the
   *  code reads like the hardware. hi defaults to lo+1 (the adjacent pair);
   *  hi === lo routes MONO. Staged like every other mix control; the live
   *  session turns it into setChannel{out} (0-based) after the defines. */
  const routesCfg: Record<string, { lo: number; hi: number }> = {}
  const route = (name: unknown, lo: unknown, hi?: unknown): void => {
    assertOpen('route')
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`route(): first argument is the synth name, got ${JSON.stringify(name)}`)
    }
    const h = hi === undefined ? (typeof lo === 'number' ? lo + 1 : lo) : hi
    if (typeof lo !== 'number' || !Number.isInteger(lo) || typeof h !== 'number' || !Number.isInteger(h)) {
      throw new TypeError(`route('${name}'): channels are whole numbers, 1-based like the jacks (route('${name}', 3, 4))`)
    }
    if (lo < 1 || h < lo || h > lo + 1 || h > 32) {
      throw new TypeError(`route('${name}'): lo..hi must be one channel or an adjacent pair within 1..32`)
    }
    routesCfg[name] = { lo, hi: h }
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
  names.push('p', 'defineSynth', 'setCps', 'setBpm', 'setTimeSig', 'sidechain', 'masterCompress', 'masterGain', 'stereo', 'visual', 'bus', 'sing', 'route', 'maskFrame', '__rcTap')
  values.push(p, defineSynth, setCps, setBpm, setTimeSig, sidechain, masterCompress, masterGain, stereo, visual, bus, sing, route, maskFrame, tapLoc)

  // Custom-scale registry lifecycle. defineScale (from the scope) writes a
  // MODULE-GLOBAL registry in the pattern package, the one exception to
  // "registrations land in per-eval maps": .scale('c custom') must resolve
  // while this eval's code RUNS, so the registry can't be staged and applied
  // later. The all-or-nothing contract is kept by hand — clear before the
  // run (a removed defineScale call must not leave a stale scale), restore
  // the previous registry on ANY failure (last-good patterns re-resolve
  // scale names at query time in .add/.sub, so a failed eval must not yank
  // their scales), keep the new registry only when the eval is applied.
  // Custom WAVETABLES follow the identical lifecycle (registry in the engine
  // package): synth() eager-compiles while the code runs and resolves table
  // names at construction, so defineWavetable can't be staged either — and a
  // failed eval must not yank tables from playing patterns (live kernels
  // re-resolve their bank per block against the engine-side store, which only
  // the Session's diff of a SUCCESSFUL eval rewrites).
  // MACROS are the third registry on this lifecycle, and for the same reason:
  // param('bright') resolves its bounds from the macro registry while synth()
  // eager-compiles, so a macro cannot be staged and applied afterwards either.
  const priorScales = snapshotCustomScales()
  const priorWavetables = snapshotCustomWavetables()
  const priorMacros = snapshotMacros()
  const priorShapes = snapshotCurveShapes()
  clearCustomScales()
  clearCustomWavetables()
  clearMacros()
  clearMacroValues()
  clearCurveShapes()

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
    // DISCARDED — fresh empty maps, never the staging ones — and the
    // custom-scale + custom-wavetable registries roll back with them.
    restoreCustomScales(priorScales)
    restoreCustomWavetables(priorWavetables)
    restoreMacros(priorMacros)
    restoreCurveShapes(priorShapes)
    return { ok: false, diagnostics, synths: new Map(), patterns: new Map(), buses: new Map(), sends: [], sings: [], maskFrames: new Map() }
  } finally {
    sealed = true
  }

  // Mirror every DECLARED macro into the pattern layer, so a play block's
  // `dur: bright / 7300` reads the same number the synths do. The knob writes
  // here too as it moves (Session.holdMacro), so this only has to establish
  // the value the text currently says.
  for (const [name, spec] of getMacros()) setMacroValue(name, spec.default)

  // The code ran; now catch `.ctrl()` targets the engine would reject at play
  // time (unknown/post-only params). Treated as errors: like any failed eval,
  // the broken version is NOT applied (last-good keeps playing) and the editor
  // shows a positioned diagnostic — instead of a silent per-cycle console warn.
  // ONE query pass, four readers (see ScannedHaps) — it used to be three
  // passes for three checks, and this adds a fourth for free.
  const scanned = scanHaps(patterns)
  const stagingErrors = [
    ...validateCtrlParams(synths, scanned, program),
    ...validateStagingTargets(synths, sends, sidechainCfg, program),
  ]
  if (stagingErrors.length > 0) {
    diagnostics.push(...stagingErrors)
    restoreCustomScales(priorScales) // this version is not applied — roll scales back too
    restoreCustomWavetables(priorWavetables) // ...and the wavetables with them
    restoreMacros(priorMacros) // ...and the macros
    restoreCurveShapes(priorShapes) // ...and the named curve shapes
    return { ok: false, diagnostics, synths: new Map(), patterns: new Map(), buses: new Map(), sends: [], sings: [], maskFrames: new Map() }
  }
  // Non-fatal: warn about a chord routed to a mono synth (plays, but collapses).
  diagnostics.push(...detectMonoChords(synths, scanned))
  diagnostics.push(...validateGateLength(synths, scanned, program))

  // A sing() whose returned pattern was never registered with p(...) still
  // staged a bake request — which triggers the (~GB) model download and blocks
  // playback for a vocal that can never sound. Drop unreferenced sing requests
  // and warn (mirrors the bare-synth() warning).
  let keptSings = sings
  if (sings.length > 0) {
    const routed = new Set<string>()
    for (const h of scanned.dense) {
      const s = h.value.sound
      if (typeof s === 'string') routed.add(s)
    }
    keptSings = sings.filter((req) => routed.has(req.synthName))
    for (const req of sings) {
      if (!routed.has(req.synthName)) {
        synths.delete(req.synthName) // drop the orphan sampler synth too
        diagnostics.push({
          line: 1,
          col: 1,
          message: `sing() result was never registered with p(...), so it can't play (and won't bake) — wrap it: p('vox', sing(…)).`,
          severity: 'warning',
          source: 'eval',
        })
      }
    }
  }

  const result: EvalResult = { ok: true, diagnostics, synths, patterns, buses, sends, sings: keptSings, maskFrames }
  // Resolve the tempo LAST, now that the meter is known however it was
  // ordered: `bpm 120` under `timesig 3 4` is 0.667 cps, not 0.5.
  if (tempo !== undefined) {
    result.cps = clampCps(
      tempo.unit === 'bpm' ? bpmToCps(tempo.value, quartersPerBar(timeSig ?? DEFAULT_TIME_SIG)) : tempo.value,
    )
  }
  // The meter is reported on EVERY successful eval, not only when written:
  // the doc is the source of truth for it, so deleting the line has to put
  // the session back to 4/4 — otherwise a stale 3/4 would keep rescaling the
  // header BPM against a cps that was computed for 4/4.
  result.timeSig = timeSig ?? DEFAULT_TIME_SIG
  if (sidechainCfg !== undefined) result.sidechain = sidechainCfg
  if (masterCompCfg !== undefined) result.masterComp = masterCompCfg
  if (masterGainDb !== undefined) result.masterGain = masterGainDb
  if (stereoCfg !== undefined) result.stereo = stereoCfg
  if (visualSrc !== undefined) result.visual = visualSrc
  if (Object.keys(routesCfg).length > 0) {
    // A typo'd route is the classic silently-does-nothing bug: say so now,
    // while the synth list of this very eval is in hand.
    for (const target of Object.keys(routesCfg)) {
      if (!synths.has(target) && !singNames.has(target)) {
        diagnostics.push({
          line: 1,
          col: 1,
          message: `route('${target}'): no synth or vocal with that name — the routing does nothing`,
          severity: 'warning',
          source: 'eval',
        })
      }
    }
    result.routes = routesCfg
  }
  return result
}
