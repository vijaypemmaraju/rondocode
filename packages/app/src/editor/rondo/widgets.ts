/* Inline rondo widgets — the prototype's controls, made real in the editor.
 *
 * v1: the KNOB. A `knob DEF lo..hi [log|lin]` binding renders a small draggable
 * dial right after its default value. Dragging it rewrites DEF in the source
 * (mapped through the range + curve) and re-evals live — the same "the text is
 * the source of truth" contract the rondocode slider()/scrub widgets use.
 *
 * Only active in rondo mode: this extension is bundled into rondoLanguage()'s
 * LanguageSupport, so it comes and goes with the language Compartment.
 *
 * Drag robustness: while dragging we edit only DEF (everything before it is
 * fixed), so the widget's anchor never moves; the plugin suppresses decoration
 * rebuilds mid-drag (mapping through our own edits instead) so the dial DOM —
 * and its pointer capture — survive. */

import { StateEffect, StateField } from '@codemirror/state'
import { scrubLens } from '../widgets/scrub'
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { formatNumber, literalWidth, niceStep } from '../widgets/rewrite'
import { F, TimeSpan, miniParse, parseScaleName, scaleDegree } from '@rondocode/pattern'
import { expandScale, splitBeatVelocities } from '@rondocode/rondo'
import { LiveWriter, MultiLiveWriter, attachGesture, verifiedChanges } from './gesture'
import type { Drag } from './gesture'
import { RONDO_WAVEDEF, WavetableRibbonWidget, previewFrames, scanWavedefs, scanWavetableCalls, warpWave, wavedefBlockDecos } from './wavetable'
import type { WavedefDialect, WavedefScan, WavetableCallScan } from './wavetable'
import { cycleEnumEdit, scanEnumSpans } from './enums'
import type { EnumSpan } from './enums'
import { FilterCurveWidget, scanFilters } from './filtercurve'
import type { FilterScan } from './filtercurve'
import { scanUnisonHeaders, unisonFan } from './unison'
import { macroReadouts, scanMacroDecls } from './macrolens'
import { scanClampedOpts } from './clamps'
import { envGeometry, scanEnvPoints } from './envpoints'
import type { EnvPointsScan } from './envpoints'
import type { EffectiveOpt } from './clamps'
import type { MacroDecl } from './macrolens'
import type { UnisonScan } from './unison'

/** `knob DEF lo..hi [curve]` — groups: 1=prefix(`knob `), 2=DEF, 3=lo, 4=hi, 5=curve. */
const KNOB_RE = /\b(knob\s+)(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\.\.(-?\d*\.?\d+)(?:\s+(log|lin))?/g

/** A scheduler note event, reduced to what widget animation needs. */
export interface NoteEv {
  /** the mini-notation source string the note's Loc indexes into. */
  src?: string
  /** char offset of the note's atom within `src`. */
  start: number
  /** absolute time (audio clock, seconds) + musical duration. */
  timeSec: number
  durSec: number
  /** the synth/channel the event routes to. */
  sound?: string
  /** the event's control map (drives the live knob display). */
  controls?: Record<string, unknown>
}

export interface Hooks {
  requestEval: (immediate: boolean) => void
  /** audio-clock "now" in seconds — the clock NoteEv.timeSec lives on. */
  now?: () => number
  /** audio time → TRANSPORT cycle position. The playhead anchors with this
   *  rather than `timeSec * cps`, which is wall-clock phase and lands
   *  wherever the clock happens to be after a stop/run. */
  cycleAt?: (timeSec: number) => number
  /** subscribe to note events; returns unsubscribe. When present, widgets go
   *  LIVE: the piano-roll lights with the playhead, the envelope fires its
   *  marker per note, and a pattern-driven knob's dial follows the drive. */
  onNoteEvents?: (fn: (evs: NoteEv[]) => void) => () => void
  /** TOUCH-TO-OVERRIDE: while a hand holds a knob, the held value plays and
   *  the pattern drive for that param is suppressed; releasing hands control
   *  back to the pattern on its next event. */
  holdParam?: (synth: string, name: string, value: number) => void
  releaseParam?: (synth: string, name: string) => void
  /** A project-wide macro: one move reaches EVERY site at once (see
   *  Session.holdMacro). Separate from holdParam because a macro has no single
   *  synth to address — that is the whole point of it. */
  /** What the engine will actually use for a written voice option — injected
   *  so this module never imports the engine (docs eager-graph boundary, the
   *  same reason wavetableBank is injected). Absent = no clamp chips. */
  voiceOptEffective?: EffectiveOpt
  holdMacro?: (name: string, value: number) => void
  releaseMacro?: (name: string) => void
  /** GRID PREVIEW: sound one note now (tapping a piano-roll cell while the
   *  transport is stopped previews what you just placed). */
  previewNote?: (synth: string, midi: number) => void
  isPlaying?: () => boolean
  /** current tempo (cycles/sec) — lets the read-only query roll map an
   *  event's absolute time to its phase within the cycle. */
  cps?: () => number
  /** wavetable bank lookup (engine getWavetableBank), INJECTED because this
   *  module sits in the docs page's eager graph and must not statically pull
   *  the audio engine — see wavetable.ts's module doc. Absent, the ribbon
   *  still draws tables defined by the doc's own wavedef lines. */
  wavetableBank?: (name: string) => Float32Array[][] | undefined
}

/** A tiny haptic tick on widget interactions (Android; a silent no-op where
 *  the Vibration API is missing, e.g. iOS Safari). */
export const buzz = (ms = 8): void => {
  try {
    ;(navigator as { vibrate?: (ms: number) => void }).vibrate?.(ms)
  } catch {
    // vibration is a garnish — never let it throw
  }
}

/** Resolve a grid degree to a MIDI note through a SHORT scale name
 *  ('a-min'). Returns undefined when there is no scale (a scale-less degree
 *  pattern is silent anyway) or the name doesn't parse. */
export function rollPreviewMidi(scaleShort: string | undefined, degree: number): number | undefined {
  if (scaleShort === undefined) return undefined
  try {
    const { root, intervals, period } = parseScaleName(expandScale(scaleShort))
    return root + scaleDegree(intervals, degree, period)
  } catch {
    return undefined
  }
}

/** SchedulerEvents → the reduced NoteEv shape widgets animate from (shared by
 *  the main editor and the docs page so the two feeds can't drift). */
export function toNoteEvs(
  evs: readonly { loc?: { src?: string; start: number }; timeSec: number; durSec: number; controls: Record<string, unknown> }[],
): NoteEv[] {
  const out: NoteEv[] = []
  for (const e of evs) {
    if (e.loc === undefined) continue
    const ev: NoteEv = { start: e.loc.start, timeSec: e.timeSec, durSec: e.durSec, controls: e.controls }
    if (e.loc.src !== undefined) ev.src = e.loc.src
    const sound = e.controls['sound']
    if (typeof sound === 'string') ev.sound = sound
    out.push(ev)
  }
  return out
}

/** Bound how long a note keeps a widget lit. */
const LIT_MIN_MS = 120
const LIT_MAX_MS = 1200
const MAX_PENDING = 64

/** Small per-widget timer pool: schedule audio-clock-aligned UI, drop cleanly
 *  on destroy (widgets die on every rebuild — leaks would pile up fast). */
class Timers {
  private readonly pending = new Set<ReturnType<typeof setTimeout>>()
  at(delayMs: number, fn: () => void): void {
    if (this.pending.size >= MAX_PENDING) return
    const h = setTimeout(() => { this.pending.delete(h); fn() }, Math.max(0, delayMs))
    this.pending.add(h)
  }
  clear(): void {
    for (const h of this.pending) clearTimeout(h)
    this.pending.clear()
  }
}
// Drag state + the gesture protocol live in ./gesture (shared by all widgets).

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

/** value → normalized 0..1 position on the knob (log or linear). */
export function toNorm(v: number, lo: number, hi: number, log: boolean): number {
  if (log && lo > 0 && hi > 0) return clamp(Math.log(v / lo) / Math.log(hi / lo), 0, 1)
  return clamp((v - lo) / (hi - lo || 1), 0, 1)
}
/** normalized 0..1 → value. */
export function fromNorm(t: number, lo: number, hi: number, log: boolean): number {
  return log && lo > 0 && hi > 0 ? lo * Math.pow(hi / lo, t) : lo + t * (hi - lo)
}

export interface KnobMatch {
  /** char offset of the DEF value within the scanned text. */
  defFrom: number
  defTo: number
  value: number
  lo: number
  hi: number
  log: boolean
  /** the binding name (`cutoff = knob …`) — the param a `.ctrl` drives. */
  name?: string
  /** the enclosing `synth NAME` block, for routing live events. */
  synth?: string
  /** a project-wide `macro` declaration rather than a synth-local `knob`: the
   *  drag fans out to every site instead of holding one synth's param. */
  macro?: true
}

/** Iterate a doc's CODE lines: the text before any rondo `#` comment, with the
 *  line's absolute offset. Widgets must not match inside comments (a knob in a
 *  comment would render live and drags would rewrite the comment), and per-line
 *  scanning keeps `\s+` in the regexes from crossing newlines. */
function codeLines(text: string): { line: string; off: number; synth?: string }[] {
  const out: { line: string; off: number; synth?: string }[] = []
  let off = 0
  let synth: string | undefined
  for (const raw of text.split('\n')) {
    const cm = /(^|\s)#/.exec(raw)
    const line = cm ? raw.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : raw
    // track block context: a top-level `synth NAME` opens a synth; any other
    // top-level header (play/cps/js) closes it — bindings inside a synth then
    // know which channel's events drive them
    const header = /^(synth|play|cps|js)\b(?:[ \t]+([a-zA-Z_]\w*))?/.exec(line)
    if (header) synth = header[1] === 'synth' ? header[2] : undefined
    out.push({ line, off, synth })
    off += raw.length + 1
  }
  return out
}

/** Find every `knob DEF lo..hi [curve]` in `text` (pure — unit tested). */
export function scanKnobs(text: string): KnobMatch[] {
  const out: KnobMatch[] = []
  for (const { line, off, synth } of codeLines(text)) {
    // a `macro` declaration IS a knob — the same dial, the same drag, but it
    // holds every site of the macro instead of one synth's param
    for (const d of scanMacroDecls(line)) {
      out.push({
        defFrom: off + d.defFrom, defTo: off + d.defTo, value: d.value,
        lo: d.lo, hi: d.hi, log: d.log, name: d.name, macro: true,
      })
    }
    KNOB_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = KNOB_RE.exec(line)) !== null) {
      const value = Number(m[2]), lo = Number(m[3]), hi = Number(m[4])
      if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi)) continue
      const defFrom = off + m.index + m[1]!.length
      const name = /^[ \t]*([a-zA-Z_]\w*)[ \t]*=/.exec(line)?.[1]
      out.push({ defFrom, defTo: defFrom + m[2]!.length, value, lo, hi, log: m[5] === 'log', name, synth })
    }
  }
  return out
}

/** `adsr A D S R` — groups: 1=prefix(`adsr `), 2..5 = a,d,s,r. Spaces only
 *  ([ \t]) so a match can never span lines. */
const ENV_RE = /\b(adsr[ \t]+)(-?\d*\.?\d+)[ \t]+(-?\d*\.?\d+)[ \t]+(-?\d*\.?\d+)[ \t]+(-?\d*\.?\d+)/g

export interface EnvMatch {
  /** char offset of the first value (A) within the scanned text. */
  from: number
  /** char offset just past the last value (R). */
  to: number
  a: number
  d: number
  s: number
  r: number
  /** the enclosing `synth NAME` block — its notes fire the curve's marker. */
  synth?: string
  /** the four VALUE spans, in a/d/s/r order. A drag rewrites only the fields
   *  it touched, in place — which is what lets one writer serve both
   *  languages: rondo's `adsr .003 .2 .3 .1` and JS's
   *  `adsr(gate, { a: 0.003, ... })` differ in everything BUT these four. */
  ranges?: { from: number; to: number }[]
}

/** The four value spans inside an `adsr A D S R` match, walked out of the
 *  matched text so repeated values (`adsr .1 .1 .1 .1`) can't alias. */
function envRanges(m: RegExpExecArray, base: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let pos = m[1]!.length
  for (let g = 2; g <= 5; g++) {
    while (pos < m[0].length && (m[0][pos] === ' ' || m[0][pos] === '\t')) pos++
    out.push({ from: base + pos, to: base + pos + m[g]!.length })
    pos += m[g]!.length
  }
  return out
}

/** Find every `adsr A D S R` in `text` (pure — unit tested). */
export function scanEnvs(text: string): EnvMatch[] {
  const out: EnvMatch[] = []
  for (const { line, off, synth } of codeLines(text)) {
    ENV_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ENV_RE.exec(line)) !== null) {
      const a = Number(m[2]), d = Number(m[3]), s = Number(m[4]), r = Number(m[5])
      if (![a, d, s, r].every((n) => Number.isFinite(n))) continue
      const from = off + m.index + m[1]!.length
      out.push({
        from, to: off + m.index + m[0].length, a, d, s, r, synth,
        ranges: envRanges(m, off + m.index),
      })
    }
  }
  return out
}

export interface PlayRoll {
  /** char range of the notation string in the source (what a tap rewrites). */
  from: number
  to: number
  /** the play block's synth (preview routes a tapped note to it). */
  synth?: string
  /** short scale name from an inline `scale:a-min`, for degree→pitch preview. */
  scale?: string
  /** the notation text itself — a play event's `loc.src` equals this, which is
   *  how the grid recognizes its own notes for playhead lighting. */
  content: string
  /** one entry per step: a scale degree, or null for a rest (`~`). */
  steps: (number | null)[]
  /** POLYMETER figure: the grid edits only the inside of `{…}%n`, so events
   *  match the FULL notation and locs shift by the figure's offset in it. */
  srcFull?: string
  srcOffset?: number
}

/** Char offset of each step token within a notation string — a note event's
 *  `loc.start` equals one of these, mapping the event to its grid column. */
export function stepStarts(notation: string): number[] {
  const out: number[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(notation)) !== null) out.push(m.index)
  return out
}

/** Find each `play` block's notation line when it's a SIMPLE flat sequence of
 *  degrees / rests (`0 0 3 5 ~ 7`) — the grid-editable case. Notation with
 *  richer mini-notation (`<> [] * @`, note names) is left as plain text. Pure. */
export function scanPlays(text: string): PlayRoll[] {
  const out: PlayRoll[] = []
  const lines = text.split('\n')
  const offs: number[] = []
  let o = 0
  for (const l of lines) { offs.push(o); o += l.length + 1 }
  for (let i = 0; i < lines.length; i++) {
    const ph = /^([ \t]*)play\s+([a-zA-Z_]\w*)(?:\s+synth:([a-zA-Z_]\w*))?/.exec(lines[i]!)
    if (!ph) continue // a play header (top-level OR nested in a section)
    const playIndent = ph[1]!.length
    const nx = lines[i + 1]
    if (nx === undefined) continue
    const indent = /^[ \t]*/.exec(nx)![0].length
    if (indent <= playIndent) continue // next line isn't a body line
    // strip a trailing `# comment`, then an inline `scale:…`
    const cm = /(^|\s)#/.exec(nx)
    const noComment = cm ? nx.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : nx
    const scale = /\bscale:[a-gA-G][a-z0-9#-]*/.exec(noComment)
    const notation = noComment.slice(indent, scale ? scale.index : noComment.length).replace(/\s+$/, '')
    const lineFrom = offs[i + 1]! + indent
    // a PURE POLYMETER figure `{0 3 5}%8` is a flat sequence inside braces —
    // it gets the full editable grid, scoped to the braces' interior (the
    // stepping %n stays a scrubbable number in the text)
    const pm = /^\{([-0-9~ \t]+)\}%\d+$/.exec(notation)
    if (pm) {
      const inner = pm[1]!.replace(/\s+$/, '')
      const innerStart = notation.indexOf(inner)
      const ptoks = inner.trim().split(/\s+/).filter(Boolean)
      if (ptoks.length > 0 && ptoks.every((tk) => tk === '~' || /^-?\d+$/.test(tk))) {
        const roll: PlayRoll = {
          from: lineFrom + innerStart,
          to: lineFrom + innerStart + inner.length,
          content: inner,
          steps: ptoks.map((tk) => (tk === '~' ? null : Number(tk))),
          srcFull: notation,
          srcOffset: innerStart,
        }
        roll.synth = ph[3] ?? ph[2]!
        if (scale) roll.scale = scale[0]!.slice('scale:'.length)
        out.push(roll)
        continue
      }
    }
    const toks = notation.trim().split(/\s+/).filter(Boolean)
    if (toks.length === 0) continue
    // NEGATIVE degrees are legal — they reach below the scale root, and
    // .overChord documents them reaching below the chord. Rejecting them made
    // the whole widget vanish from a line that was perfectly valid.
    if (!toks.every((tk) => tk === '~' || /^-?\d+$/.test(tk))) continue // simple degrees/rests only
    const from = lineFrom
    const roll: PlayRoll = { from, to: from + notation.length, content: notation, steps: toks.map((tk) => (tk === '~' ? null : Number(tk))) }
    roll.synth = ph[3] ?? ph[2]!
    if (scale) roll.scale = scale[0]!.slice('scale:'.length)
    out.push(roll)
  }
  return out
}

export interface BeatRow {
  /** char range of the notation line in the source (what a tap rewrites). */
  from: number
  to: number
  /** the notation with `:v` velocity suffixes STRIPPED — the compiler emits
   *  this string into s(), so a beat event's `loc.src` equals it. */
  content: string
  /** the row's single instrument word — also the synth a tap previews. */
  word: string
  /** one entry per step: a velocity (plain word = 1), or null for a rest. */
  steps: (number | null)[]
  /** the line already ends in a `# …` comment — the widget must not add its
   *  own word-keeper comment after erasing the row. */
  hadComment: boolean
}

export interface BeatBlock {
  /** the block's qualifying rows, in source order — ONE widget renders them
   *  all with shared (time-proportional) column alignment. */
  rows: BeatRow[]
}

/** Find each `beat` block's SIMPLE rows: flat word/rest lines with ONE
 *  distinct word (`kick ~ kick ~`), plus all-rest lines whose trailing
 *  `# word` comment names the instrument (how an erased row keeps its word).
 *  Mixed words, mini-notation (`kick*4`, `[..]`), and modifier lines are left
 *  as plain text. Pure. */
export function scanBeats(text: string): BeatBlock[] {
  const out: BeatBlock[] = []
  const lines = text.split('\n')
  const offs: number[] = []
  let o = 0
  for (const l of lines) { offs.push(o); o += l.length + 1 }
  for (let i = 0; i < lines.length; i++) {
    const bh = /^([ \t]*)beat(\s+[a-zA-Z_]\w*)?[ \t]*(#.*)?$/.exec(lines[i]!)
    if (!bh) continue // a beat header (top-level OR nested in a section)
    const beatIndent = bh[1]!.length
    const rows: BeatRow[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j]!
      if (/^[ \t]*$/.test(ln) || /^[ \t]*#/.test(ln)) continue // blank/comment
      const indent = /^[ \t]*/.exec(ln)![0].length
      if (indent <= beatIndent) break // dedent — the block ended
      const cm = /(^|\s)#/.exec(ln)
      const comment = cm ? ln.slice(cm.index + (cm[1] ? cm[1].length : 0)) : undefined
      const noComment = cm ? ln.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : ln
      const notation = noComment.slice(indent).replace(/\s+$/, '')
      const toks = notation.split(/\s+/).filter(Boolean)
      if (toks.length < 2) continue // a 1-step row isn't a sequencer
      // a token is a rest, a word, or a word with a `:v` velocity suffix
      const parsed = toks.map((tk) => tk === '~' ? null : /^([a-zA-Z_]\w*)(?::(\d*\.?\d+))?$/.exec(tk))
      if (parsed.some((p, i) => p === null && toks[i] !== '~')) continue
      const words = new Set(parsed.filter((p) => p !== null).map((p) => p![1]!))
      let word = words.size === 1 ? [...words][0]! : undefined
      if (words.size === 0) {
        // an ALL-REST row: its `# word` comment is the instrument's memory
        const cw = comment !== undefined ? /^#[ \t]*([a-zA-Z_]\w*)[ \t]*$/.exec(comment) : null
        word = cw?.[1] ?? undefined
      }
      if (word === undefined) continue // no single instrument to label the row
      const from = offs[j]! + indent
      rows.push({
        from, to: from + notation.length,
        content: splitBeatVelocities(notation).notes, word,
        steps: parsed.map((p) => (p === null ? null : p[2] !== undefined ? Number(p[2]) : 1)),
        hadComment: comment !== undefined,
      })
    }
    if (rows.length > 0) out.push({ rows })
  }
  return out
}

export interface RichCell {
  /** cycle-fraction span of the note (0..1). */
  x0: number
  x1: number
  /** row index from the bottom (rows = distinct degrees, ascending). */
  row: number
  deg: number
}

/** Query cycle 0 of a rich degree-mini notation (euclid, polymeter,
 *  subdivision, alternation…) into time-proportional roll cells, or null when
 *  it doesn't parse / has no numeric notes. Pure. */
export function richRollCells(notation: string): { cells: RichCell[]; rows: number } | null {
  try {
    const haps = miniParse(notation).pattern.query(new TimeSpan(F(0), F(1)))
    const raw: { x0: number; x1: number; deg: number }[] = []
    for (const h of haps) {
      const whole = (h as { whole?: { begin: { n: number; d: number }; end: { n: number; d: number } } }).whole
      if (whole === undefined) continue
      const v = (h.value as { value?: unknown })?.value ?? h.value
      const deg = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(deg)) continue
      const x0 = whole.begin.n / whole.begin.d
      const x1 = whole.end.n / whole.end.d
      if (!(x1 > x0) || x0 < 0 || x0 >= 1) continue
      raw.push({ x0, x1: Math.min(x1, 1), deg })
    }
    if (raw.length === 0) return null
    raw.sort((a, b) => a.x0 - b.x0 || a.deg - b.deg) // time order (queries aren't)
    const degs = [...new Set(raw.map((c) => c.deg))].sort((a, b) => a - b)
    const rowOf = new Map(degs.map((d, i) => [d, i]))
    return { cells: raw.map((c) => ({ ...c, row: rowOf.get(c.deg)! })), rows: degs.length }
  } catch {
    return null
  }
}

/** Probe cap for the whole-period overview: an alternation with more arms
 *  than this never repeats within the probe, and rendering a PARTIAL view
 *  would lie — the widget renders nothing instead. */
export const MAX_OVERVIEW_BARS = 8
/** Cell budget across the WHOLE overview — past this the roll is soup, and a
 *  soup view is worse than none (nothing renders). */
export const MAX_OVERVIEW_CELLS = 256

export interface RollOverviewData {
  /** bars in the repeating period (1 = a true single-cycle figure). */
  period: number
  /** cells in WHOLE-PERIOD x units: bar b spans [b, b+1). */
  cells: RichCell[]
  rows: number
}

/** Query a rich notation cycle by cycle until it repeats (cap
 *  MAX_OVERVIEW_BARS) and lay the whole period out as roll cells — bar b's
 *  cells sit at x in [b, b+1). This is the HONESTY layer over richRollCells'
 *  cycle-0-only view: a multi-cycle pattern (`<…>` alternation) reports its
 *  real period so the widget can show every bar; a pattern that does NOT
 *  repeat within the cap (`?` degrade, 9+ arms) or would exceed the cell
 *  budget returns null — no widget, never a misleading partial. Pure. */
export function rollOverviewData(
  notation: string,
  cap = MAX_OVERVIEW_BARS,
  budget = MAX_OVERVIEW_CELLS,
): RollOverviewData | null {
  try {
    const pattern = miniParse(notation).pattern
    const perCycle: { x0: number; x1: number; deg: number }[][] = []
    const keys: string[] = []
    // probe TWO periods' worth of cycles: a candidate period p is only real
    // when a full second period repeats it (probing exactly `cap` cycles
    // would accept p = cap vacuously — a 9-arm alternation's first 8 bars
    // look period-8 until cycle 8 arrives)
    const probe = cap * 2
    for (let k = 0; k < probe; k++) {
      const haps = pattern.query(new TimeSpan(F(k), F(k + 1)))
      const raw: { x0: number; x1: number; deg: number }[] = []
      for (const h of haps) {
        const whole = (h as { whole?: { begin: { n: number; d: number }; end: { n: number; d: number } } }).whole
        if (whole === undefined) continue
        const v = (h.value as { value?: unknown })?.value ?? h.value
        const deg = typeof v === 'number' ? v : Number(v)
        if (!Number.isFinite(deg)) continue
        const x0 = whole.begin.n / whole.begin.d - k
        const x1 = whole.end.n / whole.end.d - k
        // onsets in THIS cycle only (the cycle-0 filter, generalized)
        if (!(x1 > x0) || x0 < -1e-9 || x0 >= 1 - 1e-9) continue
        raw.push({ x0: Math.max(x0, 0), x1: Math.min(x1, 1), deg })
      }
      raw.sort((a, b) => a.x0 - b.x0 || a.deg - b.deg)
      perCycle.push(raw)
      keys.push(raw.map((c) => `${c.x0.toFixed(6)},${c.x1.toFixed(6)},${c.deg}`).join('|'))
    }
    // smallest period P where every probed cycle equals cycle (k mod P)
    let period = 0
    for (let p = 1; p <= cap; p++) {
      let ok = true
      for (let k = p; k < probe; k++) {
        if (keys[k] !== keys[k % p]) { ok = false; break }
      }
      if (ok) { period = p; break }
    }
    if (period === 0) return null // never repeats within the cap: no honest view
    const bars = perCycle.slice(0, period)
    const total = bars.reduce((n, b) => n + b.length, 0)
    if (total === 0 || total > budget) return null
    const degs = [...new Set(bars.flat().map((c) => c.deg))].sort((a, b) => a - b)
    const rowOf = new Map(degs.map((d, i) => [d, i]))
    const cells: RichCell[] = []
    for (let b = 0; b < period; b++) {
      for (const c of bars[b]!) cells.push({ x0: b + c.x0, x1: b + c.x1, row: rowOf.get(c.deg)!, deg: c.deg })
    }
    return { period, cells, rows: degs.length }
  } catch {
    return null
  }
}

/** One roll row = one degree step: quantize a vertical drag (px up from the
 *  gesture start) to whole transpose steps. Pure. */
export function transposeSteps(dyUp: number, rowH: number): number {
  return Math.round(dyUp / Math.max(rowH, 1))
}

/** The cell layer's y offset while previewing a transpose of `steps` degrees
 *  (up is negative y — pitch climbs the screen). Pure. */
export function transposePreviewShift(steps: number, rowH: number): number {
  return steps === 0 ? 0 : -steps * rowH
}

export interface AddTarget {
  /** the block's current `add N` (0 when the line does not exist yet). */
  base: number
  /** an EXISTING add line: the N literal's absolute range (update in place). */
  numFrom?: number
  numTo?: number
  /** a MISSING add line: insert `insertPrefix + N` at this offset. */
  insertAt?: number
  insertPrefix?: string
}

/** Locate the `add N` modifier line of the play block whose notation starts
 *  at `notationFrom` — the whole-roll transpose handle's write target. Null
 *  when the enclosing block isn't a play block or its add line is too rich
 *  for the handle to own (`add .5`, `add <0 7>`). When the line is missing,
 *  reports the insertion point after the block's LAST notation line (the
 *  established modifier position). Pure. */
export function findAddTarget(text: string, notationFrom: number): AddTarget | null {
  const lines = text.split('\n')
  const offs: number[] = []
  let o = 0
  for (const l of lines) { offs.push(o); o += l.length + 1 }
  let li = -1
  for (let i = 0; i < lines.length; i++) {
    if (notationFrom >= offs[i]! && notationFrom <= offs[i]! + lines[i]!.length) { li = i; break }
  }
  if (li < 0) return null
  const stripCm = (raw: string): string => {
    const cm = /(^|\s)#/.exec(raw)
    return cm ? raw.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : raw
  }
  const indent = /^[ \t]*/.exec(lines[li]!)![0]
  // the enclosing header: nearest code line above with LESS indent — must be
  // a play header, else the handle has no `add` idiom to write
  let head = -1
  let headIndent = -1
  for (let i = li - 1; i >= 0; i--) {
    const ln = lines[i]!
    if (/^[ \t]*$/.test(ln) || /^[ \t]*#/.test(ln)) continue
    const ind = /^[ \t]*/.exec(ln)![0].length
    if (ind >= indent.length) continue
    if (!/^[ \t]*play\b/.test(stripCm(ln))) return null
    head = i
    headIndent = ind
    break
  }
  if (head < 0) return null
  // walk the block body (deeper-indented lines; blanks/comments don't end it)
  let lastNotation = li
  for (let j = head + 1; j < lines.length; j++) {
    const raw = lines[j]!
    if (/^[ \t]*$/.test(raw) || /^[ \t]*#/.test(raw)) continue
    const ind = /^[ \t]*/.exec(raw)![0].length
    if (ind <= headIndent) break // dedent — the block ended
    const code = stripCm(raw)
    const body = code.slice(ind).replace(/[ \t]+$/, '')
    const am = /^(add[ \t]+)(-?\d+)$/.exec(body)
    if (am) {
      const numFrom = offs[j]! + ind + am[1]!.length
      return { base: Number(am[2]!), numFrom, numTo: numFrom + am[2]!.length }
    }
    if (/^add\b/.test(body)) return null // an add line the handle can't own
    // a degree-notation line (the charset scanRichPlays/scanPlays accept,
    // scale suffix aside) — the insert point trails the last of these
    const noScale = body.replace(/\bscale:[a-gA-G][a-zA-Z0-9#_-]*/, '').replace(/[ \t]+$/, '')
    if (j > li && /^[0-9~\s<>[\]{}%*/!@?,.()-]+$/.test(noScale) && noScale.length > 0) lastNotation = j
  }
  return { base: 0, insertAt: offs[lastNotation]! + lines[lastNotation]!.length, insertPrefix: `\n${indent}add ` }
}

/** The doc edit setting the block's transpose to `n` — an in-place literal
 *  update, or a whole-line insert when the block has no add line yet. Null
 *  when nothing would change (n equals the current value). Pure. */
export function addLineEdit(t: AddTarget, n: number): { from: number; to: number; insert: string } | null {
  if (n === t.base) return null
  if (t.numFrom !== undefined && t.numTo !== undefined) {
    return { from: t.numFrom, to: t.numTo, insert: String(n) }
  }
  if (t.insertAt === undefined) return null
  return { from: t.insertAt, to: t.insertAt, insert: `${t.insertPrefix ?? '\nadd '}${n}` }
}

export interface RichPlay {
  /** the notation text — a play event's `loc.src` equals this. */
  content: string
  /** char range of the notation in the source (euclid drags rewrite into it). */
  from: number
  to: number
  synth?: string
}

/** Find play-block notation lines TOO RICH for the editable grid (euclid,
 *  polymeter, brackets, alternation…) but still pure degree-mini — they get a
 *  READ-ONLY query roll. Letters (note names, chords, irand) stay text. Pure. */
export function scanRichPlays(text: string): RichPlay[] {
  const out: RichPlay[] = []
  const lines = text.split('\n')
  const offs: number[] = []
  let o = 0
  for (const l of lines) { offs.push(o); o += l.length + 1 }
  for (let i = 0; i < lines.length; i++) {
    const ph = /^([ \t]*)play\s+([a-zA-Z_]\w*)(?:\s+synth:([a-zA-Z_]\w*))?/.exec(lines[i]!)
    if (!ph) continue
    const nx = lines[i + 1]
    if (nx === undefined) continue
    const indent = /^[ \t]*/.exec(nx)![0].length
    if (indent <= ph[1]!.length) continue
    const cm = /(^|\s)#/.exec(nx)
    const noComment = cm ? nx.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : nx
    const scale = /\bscale:[a-gA-G][a-z0-9#-]*/.exec(noComment)
    const notation = noComment.slice(indent, scale ? scale.index : noComment.length).replace(/\s+$/, '')
    if (notation.length === 0) continue
    // pure degree-mini with structure: digits + mini punctuation, at least one
    // structural char (otherwise the editable flat grid already handles it)
    if (!/^[0-9~\s<>[\]{}%*/!@?,.()-]+$/.test(notation)) continue
    if (!/[<>[\]{}%*/!@?,()]/.test(notation)) continue
    if (/^\{[0-9~ \t]+\}%\d+$/.test(notation)) continue // editable polymeter grid owns it
    const from = offs[i + 1]! + indent
    out.push({ content: notation, from, to: from + notation.length, synth: ph[3] ?? ph[2]! })
  }
  return out
}

/** The SINGLE euclid group in a notation, or null (none, or 2+ — ambiguous).
 *  This is what makes a query roll DRAGGABLE: vertical adjusts pulses,
 *  horizontal adjusts rotation. */
export function euclidGroup(notation: string): { p: number; s: number; r: number; from: number; to: number } | null {
  const ms = [...notation.matchAll(/\((\d+),(\d+)(?:,(-?\d+))?\)/g)]
  if (ms.length !== 1) return null
  const m = ms[0]!
  const p = Number(m[1]), st = Number(m[2])
  if (!(p >= 1) || !(st >= 1)) return null
  return { p, s: st, r: m[3] !== undefined ? Number(m[3]) : 0, from: m.index!, to: m.index! + m[0].length }
}

/** Serialize a euclid group (omit a zero rotation). */
export function euclidText(p: number, s: number, r: number): string {
  return r !== 0 ? `(${p},${s},${r})` : `(${p},${s})`
}

/** The whole-roll TRANSPOSE grab strip: a narrow left-edge handle (44px
 *  touch target via its CSS bleed) drawn as a subtle double chevron. */
function makeGrabStrip(): HTMLElement {
  const grab = document.createElement('span')
  grab.className = 'qr-grab'
  grab.title = 'drag up/down: transpose the whole pattern (add N)'
  grab.setAttribute('role', 'slider')
  grab.setAttribute('aria-label', 'transpose the whole pattern')
  grab.innerHTML =
    '<svg width="10" height="18" viewBox="0 0 10 18">' +
    '<path d="M1.5 6.5 L5 3 L8.5 6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M1.5 11.5 L5 15 L8.5 11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>'
  return grab
}

/** Wire a roll's grab strip: a vertical drag transposes the whole pattern by
 *  rewriting the play block's `add N` modifier (scale-aware — degrees resolve
 *  through the scale downstream), one roll row per step. An EXISTING add
 *  line is live-rewritten per move (LiveWriter, write-verify): the edit is on
 *  a DIFFERENT line than the widget's anchor, so neither roll form shifts
 *  under the pointer. A MISSING line is inserted after the notation lines at
 *  gesture end only (a line-count-changing write defers per the widget
 *  rules). `preview` shifts the cell layer so the transpose is visible while
 *  dragging; the sounding preview comes free on the next eval. */
function attachTransposeGesture(
  grab: HTMLElement,
  view: EditorView,
  drag: Drag,
  hooks: Hooks,
  opts: { srcFrom: number; content: string; rowH: number; preview: (steps: number) => void },
): void {
  attachGesture(grab, drag, 'window', (e) => {
    // gesture-time verify: the notation must still sit where the widget
    // believes (any external edit rebuilds widgets, but never trust a race)
    const doc = view.state.doc.toString()
    if (doc.slice(opts.srcFrom, opts.srcFrom + opts.content.length) !== opts.content) return null
    const target = findAddTarget(doc, opts.srcFrom)
    if (target === null) return null
    buzz()
    grab.classList.add('active')
    // the add line often sits screens below a wrapped mega-notation - float
    // the pending value above the finger so the edit is visible AT the drag
    scrubLens.show(e.clientX, e.clientY, `add ${target.base}`)
    const y0 = e.clientY
    let steps = 0
    let wrote = false
    const writer = target.numFrom !== undefined && target.numTo !== undefined
      ? new LiveWriter(view, target.numFrom, target.numTo)
      : null
    return {
      onMove: (ev) => {
        scrubLens.move(ev.clientX, ev.clientY)
        const s = transposeSteps(y0 - ev.clientY, opts.rowH)
        if (s === steps) return
        steps = s
        scrubLens.update(`add ${target.base + steps}`)
        buzz()
        if (writer !== null) {
          if (!writer.write(String(target.base + steps))) return // aborted: go quiet
          wrote = true
          hooks.requestEval(false)
        }
        opts.preview(steps)
      },
      onEnd: () => {
        scrubLens.hide()
        grab.classList.remove('active')
        opts.preview(0)
        if (writer !== null) {
          if (!wrote) return // never moved a step — nothing to resync
          drag.ended = true
          view.dispatch({}) // empty transaction → ONE rebuild (fresh ranges)
          hooks.requestEval(false)
          return
        }
        if (steps === 0) return
        // deferred INSERT: derive the edit from the doc AS IT IS NOW, then
        // write-verify (an insert's expected slice is the empty string)
        const now = view.state.doc.toString()
        if (now.slice(opts.srcFrom, opts.srcFrom + opts.content.length) !== opts.content) {
          view.dispatch({}) // edited under the gesture — resync, no write
          return
        }
        const t2 = findAddTarget(now, opts.srcFrom)
        const edit = t2 === null ? null : addLineEdit(t2, t2.base + steps)
        if (edit === null) {
          view.dispatch({})
          return
        }
        drag.ended = true
        const ok = verifiedChanges(view, [{
          from: edit.from, to: edit.to,
          expected: now.slice(edit.from, edit.to),
          insert: edit.insert,
        }])
        if (!ok) {
          view.dispatch({})
          return
        }
        hooks.requestEval(false)
      },
    }
  })
}

/** READ-ONLY roll for rich notation: cycle 0's events on a time-proportional
 *  lane (row = degree), a sweeping playhead line, and cells that bloom as
 *  their notes sound. No editing — the text stays the only write surface. */
class QueryRollWidget extends WidgetType {
  private unsub?: () => void
  private raf = 0
  private readonly timers = new Timers()

  constructor(
    readonly content: string,
    /** notation start in the source (euclid drags rewrite into it). */
    readonly srcFrom: number,
    readonly cellData: { cells: RichCell[]; rows: number },
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: QueryRollWidget): boolean {
    return o.content === this.content && o.srcFrom === this.srcFrom
  }

  toDOM(view: EditorView): HTMLElement {
    const { cells, rows } = this.cellData
    const outer = document.createElement('span')
    outer.className = 'rondo-qwrap'
    const grab = makeGrabStrip()
    outer.appendChild(grab)
    const wrap = document.createElement('span')
    wrap.className = 'rondo-qroll'
    wrap.setAttribute('role', 'img')
    wrap.setAttribute('aria-label', 'pattern preview (cycle 1)')
    outer.appendChild(wrap)
    const rowH = rows > 4 ? 8 : 12
    wrap.style.height = `${Math.max(rows * rowH + 6, 22)}px`
    // cells live on their own layer so a transpose drag can shift every row
    // at once (translateY preview) without touching the playhead
    const layer = document.createElement('span')
    layer.className = 'qr-layer'
    wrap.appendChild(layer)
    let cellEls: { el: HTMLElement; c: RichCell }[] = []
    const renderCells = (cs: RichCell[]): void => {
      for (const { el } of cellEls) el.remove()
      cellEls = []
      for (const c of cs) {
        const el = document.createElement('span')
        el.className = 'qr-cell'
        el.style.left = `${(c.x0 * 100).toFixed(2)}%`
        el.style.width = `calc(${((c.x1 - c.x0) * 100).toFixed(2)}% - 1px)`
        el.style.bottom = `${3 + c.row * rowH}px`
        el.style.height = `${rowH - 2}px`
        cellEls.push({ el, c })
        layer.appendChild(el)
      }
    }
    renderCells(cells)
    const head = document.createElement('span')
    head.className = 'qr-head'
    wrap.appendChild(head)

    // WHOLE-ROLL TRANSPOSE: the left grab strip writes the block's `add N`
    attachTransposeGesture(grab, view, this.drag, this.hooks, {
      srcFrom: this.srcFrom,
      content: this.content,
      rowH,
      preview: (steps) => {
        layer.style.transform = steps === 0 ? '' : `translateY(${transposePreviewShift(steps, rowH)}px)`
      },
    })

    // playhead: an event on THIS notation reveals the current cycle phase
    // (phase = timeSec·cps mod 1); a rAF sweep rides from there until the
    // feed goes quiet, blooming each cell as the line crosses its onset
    if (this.hooks.onNoteEvents && this.hooks.now && this.hooks.cps) {
      const now = this.hooks.now
      const cps = this.hooks.cps
      let anchor: { t: number; phase: number } | null = null
      let lastEv = 0
      /** Park the sweep: hide the head AND unlight every cell. Clearing the
       *  cells matters — a stopped roll that keeps a row lit reads as still
       *  playing. */
      const stopSweep = (): void => {
        head.style.opacity = '0'
        for (const { el } of cellEls) el.classList.remove('on')
        anchor = null
        this.raf = 0
      }
      const frame = (): void => {
        if (anchor === null) { this.raf = 0; return }
        const tNow = now()
        // STOP is immediate: the head free-runs on the audio clock, which
        // keeps ticking after the transport halts.
        if (this.hooks.isPlaying?.() === false) { stopSweep(); return }
        // feed quiet for ~2 cycles (a paused feed rather than a stop)
        if (tNow - lastEv > 2 / Math.max(cps(), 0.05)) { stopSweep(); return }
        const phase = (anchor.phase + (tNow - anchor.t) * cps()) % 1
        head.style.opacity = '1'
        head.style.left = `${(phase * 100).toFixed(2)}%`
        for (const { el, c } of cellEls) {
          el.classList.toggle('on', phase >= c.x0 && phase < c.x1)
        }
        this.raf = requestAnimationFrame(frame)
      }
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          if (ev.src !== this.content) continue
          this.timers.at((ev.timeSec - now()) * 1000, () => {
            const at = this.hooks.cycleAt?.(ev.timeSec) ?? ev.timeSec * cps()
            anchor = { t: ev.timeSec, phase: at % 1 }
            lastEv = now()
            if (this.raf === 0) this.raf = requestAnimationFrame(frame)
          })
        }
      })
    }

    // EUCLID DRAG: with exactly one (pulses,steps[,rot]) group in the line,
    // the roll is a control surface — drag UP/DOWN for pulses, SIDEWAYS for
    // rotation (hits follow the finger: +rotation shifts hits left, so a
    // rightward drag DECREMENTS it). Cells preview live from a re-query; the
    // doc write is deferred to gesture end (the group's text length changes).
    const g0 = euclidGroup(this.content)
    if (g0 !== null) {
      wrap.classList.add('editable')
      wrap.title = 'drag: up/down = pulses · sideways = rotate'
      wrap.style.pointerEvents = 'auto'
      let cur = { p: g0.p, r: g0.r }
      const preview = (p: number, r: number): void => {
        const notation = this.content.slice(0, g0.from) + euclidText(p, s0(r), r) + this.content.slice(g0.to)
        const data = richRollCells(notation)
        if (data !== null) renderCells(data.cells)
      }
      const s0 = (_: number): number => g0.s // steps never change by drag
      attachGesture(wrap, this.drag, 'window', (e) => {
        buzz()
        const x0 = e.clientX, y0 = e.clientY
        const cellW = Math.max(wrap.getBoundingClientRect().width / g0.s, 8)
        return {
          onMove: (ev) => {
            const p = clamp(g0.p + Math.round((y0 - ev.clientY) / 16), 1, g0.s)
            const rRaw = g0.r - Math.round((ev.clientX - x0) / cellW)
            const r = ((rRaw % g0.s) + g0.s) % g0.s
            if (p === cur.p && r === cur.r) return
            cur = { p, r }
            buzz()
            preview(p, r)
          },
          onEnd: () => {
            if (cur.p === g0.p && cur.r === g0.r) return // unchanged — no write
            this.drag.ended = true
            const from = this.srcFrom + g0.from
            const to = this.srcFrom + g0.to
            const ok = verifiedChanges(view, [{
              from, to,
              expected: this.content.slice(g0.from, g0.to),
              insert: euclidText(cur.p, g0.s, cur.r),
            }])
            if (!ok) {
              view.dispatch({}) // someone edited under the gesture — resync
              return
            }
            this.hooks.requestEval(false)
          },
        }
      })
    }
    return outer
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
    cancelAnimationFrame(this.raf)
  }

  ignoreEvent(): boolean { return true }
}

/** FULL-WIDTH clip overview for a MULTI-CYCLE rich notation: the whole
 *  repeating period (a top-level `<…>` alternation's bars) side by side
 *  below the line — bar separators, rows = degrees, time-proportional cells,
 *  a playhead that traverses the correct BAR as the alternation advances,
 *  and the left transpose strip. A DAW-style clip view; read-only otherwise.
 *  Served as a BLOCK decoration by blockWidgetField (the #107 wavedef
 *  lifecycle: map while drag.active, rebuild once on drag.ended) — an inline
 *  widget after a soft-wrapped mega-line floats at a weird mid-wrap position,
 *  which was the shipped complaint. */
export class RollOverviewWidget extends WidgetType {
  private unsub?: () => void
  private raf = 0
  private readonly timers = new Timers()

  constructor(
    readonly content: string,
    /** notation start in the source (the transpose gesture's block anchor). */
    readonly srcFrom: number,
    readonly data: RollOverviewData,
    /** measured content width — part of eq() (resize swaps in fresh DOM). */
    readonly width: number,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: RollOverviewWidget): boolean {
    // cells/rows derive from content, so content + srcFrom + width identify
    // the DOM (srcFrom keeps captured offsets fresh across edits above)
    return o.content === this.content && o.srcFrom === this.srcFrom && o.width === this.width
  }

  private get rowH(): number {
    return this.data.rows > 8 ? 6 : this.data.rows > 4 ? 8 : 12
  }

  private get bodyH(): number {
    return Math.max(this.data.rows * this.rowH + 6, 30)
  }

  get estimatedHeight(): number {
    return this.bodyH + 10 // + the wrap's padding (see rondo-ui.css)
  }

  toDOM(view: EditorView): HTMLElement {
    const { period, cells, rows } = this.data
    const rowH = this.rowH
    const outer = document.createElement('div')
    outer.className = 'rondo-rollov'
    outer.style.width = `${this.width}px`
    outer.setAttribute('role', 'img')
    outer.setAttribute('aria-label', `pattern overview (${period} bars)`)
    const grab = makeGrabStrip()
    outer.appendChild(grab)
    const body = document.createElement('div')
    body.className = 'ro-body'
    body.style.height = `${this.bodyH}px`
    outer.appendChild(body)
    // subtle bar separators between the period's bars
    for (let b = 1; b < period; b++) {
      const sep = document.createElement('span')
      sep.className = 'ro-bar'
      sep.style.left = `${((b / period) * 100).toFixed(3)}%`
      body.appendChild(sep)
    }
    const layer = document.createElement('span')
    layer.className = 'qr-layer'
    body.appendChild(layer)
    const cellEls: { el: HTMLElement; c: RichCell }[] = []
    for (const c of cells) {
      const el = document.createElement('span')
      el.className = 'qr-cell'
      el.style.left = `${((c.x0 / period) * 100).toFixed(3)}%`
      el.style.width = `calc(${(((c.x1 - c.x0) / period) * 100).toFixed(3)}% - 1px)`
      el.style.bottom = `${3 + c.row * rowH}px`
      el.style.height = `${rowH - 2}px`
      cellEls.push({ el, c })
      layer.appendChild(el)
    }
    const head = document.createElement('span')
    head.className = 'qr-head'
    body.appendChild(head)

    // PLAYHEAD across the WHOLE period: an event on this notation anchors the
    // absolute cycle position (timeSec·cps mod period — the inline roll's
    // phase anchor, generalized), so the sweep rides through the correct bar
    // as the alternation advances, blooming cells as it crosses their onsets.
    if (this.hooks.onNoteEvents && this.hooks.now && this.hooks.cps) {
      const now = this.hooks.now
      const cps = this.hooks.cps
      let anchor: { t: number; pos: number } | null = null
      let lastEv = 0
      const stopSweep = (): void => {
        head.style.opacity = '0'
        for (const { el } of cellEls) el.classList.remove('on')
        anchor = null
        this.raf = 0
      }
      const frame = (): void => {
        if (anchor === null) { this.raf = 0; return }
        const tNow = now()
        // STOP is immediate: the head free-runs on the audio clock, which
        // keeps ticking after the transport halts.
        if (this.hooks.isPlaying?.() === false) { stopSweep(); return }
        if (tNow - lastEv > 2 / Math.max(cps(), 0.05)) { stopSweep(); return }
        const pos = (anchor.pos + (tNow - anchor.t) * cps()) % period
        head.style.opacity = '1'
        head.style.left = `${((pos / period) * 100).toFixed(2)}%`
        for (const { el, c } of cellEls) {
          el.classList.toggle('on', pos >= c.x0 && pos < c.x1)
        }
        this.raf = requestAnimationFrame(frame)
      }
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          if (ev.src !== this.content) continue
          this.timers.at((ev.timeSec - now()) * 1000, () => {
            const at = this.hooks.cycleAt?.(ev.timeSec) ?? ev.timeSec * cps()
            anchor = { t: ev.timeSec, pos: at % period }
            lastEv = now()
            if (this.raf === 0) this.raf = requestAnimationFrame(frame)
          })
        }
      })
    }

    // WHOLE-ROLL TRANSPOSE: the left grab strip writes the block's `add N`
    attachTransposeGesture(grab, view, this.drag, this.hooks, {
      srcFrom: this.srcFrom,
      content: this.content,
      rowH,
      preview: (steps) => {
        layer.style.transform = steps === 0 ? '' : `translateY(${transposePreviewShift(steps, rowH)}px)`
      },
    })
    return outer
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
    cancelAnimationFrame(this.raf)
  }

  ignoreEvent(): boolean { return true }
}

/** BLOCK decorations for every MULTI-CYCLE rich play line: the overview
 *  renders below the notation line (side 1 at the line end, like the wavedef
 *  editor) so it can never float mid-wrap in a soft-wrapped mega-line.
 *  Single-cycle figures stay with the compact inline roll (build()); a
 *  pattern with no honest overview (never repeats within the cap, or over
 *  the cell budget) gets NOTHING here AND nothing inline — the cycle-0-only
 *  thumbnail must never appear for a multi-cycle pattern. Exported for
 *  blockWidgetField and the contract tests. */
export function rollOverviewBlockDecos(
  text: string,
  width: number,
  hooks: Hooks,
  drag: Drag,
  scan: WidgetScan = RONDO_SCAN,
): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  for (const rp of scan.richPlays(text)) {
    const data = rollOverviewData(rp.content)
    if (data === null || data.period < 2) continue
    const nl = text.indexOf('\n', rp.to)
    const lineEnd = nl === -1 ? text.length : nl
    out.push(Decoration.widget({
      widget: new RollOverviewWidget(rp.content, rp.from, data, width, hooks, drag),
      side: 1,
      block: true,
    }).range(lineEnd))
  }
  return out
}

/* ------------------------------------------------------------------------- *
 * The macro live env.
 *
 * A macro's destinations have no literal to rewrite — they are expressions
 * (`bright * 0.5`), which is exactly what lets one knob drive several things
 * at different ratios. So while the knob moves, each destination's CHIP is
 * recomputed from its own formula against the dragged value.
 *
 * It has to be pushed rather than rebuilt: decoration rebuilds are suppressed
 * mid-drag (so the dial's DOM and its pointer capture survive), which would
 * otherwise leave every chip frozen at its pre-drag number until the drag
 * ended. Per view, because the values belong to that document.
 * ------------------------------------------------------------------------- */
interface MacroEnv {
  /** live overrides, while a knob is held; empty at rest (the doc is truth). */
  values: Record<string, number>
  text: string
  decls: MacroDecl[]
  subs: Set<(byAt: ReadonlyMap<number, number>) => void>
}

const macroEnvs = new WeakMap<EditorView, MacroEnv>()

function macroEnv(view: EditorView): MacroEnv {
  let e = macroEnvs.get(view)
  if (e === undefined) {
    e = { values: {}, text: '', decls: [], subs: new Set() }
    macroEnvs.set(view, e)
  }
  return e
}

/** Re-scan on every decoration rebuild: the document is the truth at rest, so
 *  the live overrides are dropped here. */
function refreshMacroEnv(view: EditorView, text: string, decls: MacroDecl[]): void {
  const e = macroEnv(view)
  e.text = text
  e.decls = decls
  e.values = {}
}

/** A macro moved: recompute every destination and push the results to the
 *  chips. Each chip evaluates ITS OWN formula, so the ratios (and any binding
 *  cascade between them) come out right without the chips knowing about each
 *  other. */
function setMacroLive(view: EditorView, name: string, value: number): void {
  const e = macroEnv(view)
  e.values[name] = value
  if (e.subs.size === 0) return
  const byAt = new Map<number, number>()
  for (const r of macroReadouts(e.text, e.decls, e.values)) byAt.set(r.at, r.value)
  for (const fn of e.subs) fn(byAt)
}

/** Compact display for a destination value: enough digits to see it move,
 *  never so many that the line reflows. */
export function formatMacroValue(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000) return String(Math.round(v))
  if (a >= 10) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

/** "You wrote 32; the engine is using 9."
 *
 *  Shown only where the two DIFFER, so a header of sensible values stays
 *  clean and a clamped one cannot be missed. Read-only: the number to change
 *  is the one right before it. */
class ClampChipWidget extends WidgetType {
  constructor(readonly name: string, readonly written: number, readonly effective: number) { super() }

  eq(o: ClampChipWidget): boolean {
    return o.name === this.name && o.written === this.written && o.effective === this.effective
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'rondo-clamp-chip'
    el.textContent = `→ ${formatMacroValue(this.effective)}`
    el.title = `${this.name}: ${this.written} is out of range — the engine uses ${this.effective}`
    el.setAttribute('aria-label', el.title)
    return el
  }

  ignoreEvent(): boolean { return true }
}

/** What one destination is currently receiving, shown at the end of its line.
 *  Read-only on purpose: the number is DERIVED, so the only honest place to
 *  change it is the macro declaration (or the formula itself). */
class MacroChipWidget extends WidgetType {
  private unsub?: () => void

  constructor(readonly at: number, readonly label: string, readonly value: number) { super() }

  eq(o: MacroChipWidget): boolean {
    return o.at === this.at && o.label === this.label && o.value === this.value
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = 'rondo-macro-chip'
    el.setAttribute('aria-hidden', 'true') // decorative: the formula is the content
    el.title = `${this.label}: driven by a macro`
    el.textContent = formatMacroValue(this.value)
    const env = macroEnv(view)
    const fn = (byAt: ReadonlyMap<number, number>): void => {
      const v = byAt.get(this.at)
      if (v === undefined) return
      el.textContent = formatMacroValue(v)
      el.classList.add('live')
    }
    env.subs.add(fn)
    this.unsub = () => env.subs.delete(fn)
    return el
  }

  destroy(): void {
    this.unsub?.()
  }

  ignoreEvent(): boolean { return true }
}

class KnobWidget extends WidgetType {
  private unsub?: () => void
  private readonly timers = new Timers()
  private raf = 0
  /** true while a drag holds the param (touch-to-override) — released in
   *  end(), and defensively in destroy() so a mid-drag teardown (dispose,
   *  language switch) can never leave the pattern drive suppressed forever. */
  private holding = false

  constructor(
    readonly defFrom: number,
    /** end of the DEF literal IN THE SOURCE — must come from scanKnobs, never
     *  re-derived from the value (String(0.35) is "0.35" but the source may
     *  spell it ".35"; a length mismatch would eat the char after the value). */
    readonly defTo: number,
    readonly value: number,
    readonly lo: number,
    readonly hi: number,
    readonly log: boolean,
    readonly name: string | undefined,
    readonly synth: string | undefined,
    readonly hooks: Hooks,
    readonly drag: Drag,
    /** Every declaration of this same param (same synth + name), including
     *  this one. A param declared in both the synth body and its post chain is
     *  ONE control at runtime, so a drag has to move all of them or the
     *  declarations drift and the two halves scale the value differently. */
    readonly siblings: readonly { from: number; to: number }[] = [],
    /** a macro declaration: hold every site, not one synth's param. */
    readonly isMacro = false,
  ) { super() }

  eq(o: KnobWidget): boolean {
    return o.defFrom === this.defFrom && o.defTo === this.defTo && o.value === this.value &&
      o.lo === this.lo && o.hi === this.hi && o.log === this.log &&
      o.name === this.name && o.synth === this.synth &&
      // stale sibling ranges would splice the wrong characters
      o.siblings.length === this.siblings.length &&
      o.siblings.every((r, i) => r.from === this.siblings[i]!.from && r.to === this.siblings[i]!.to)
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'rondo-knob'
    wrap.setAttribute('role', 'slider')
    wrap.setAttribute('aria-label', 'knob')
    wrap.title = 'drag to set'
    wrap.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2" opacity="0.35"/>' +
      '<line class="ptr" x1="12" y1="12" x2="12" y2="4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
      '</svg><span class="kv"></span>'
    const ptr = wrap.querySelector('.ptr') as SVGLineElement
    const kv = wrap.querySelector('.kv') as HTMLElement
    // the readout ALWAYS shows the current value: the DEF at rest, the driven
    // value during a .ctrl sweep (live), the hand value during a drag —
    // always-on so appearing/disappearing never shifts the layout
    const kvStep = niceStep(Math.abs(this.hi - this.lo) / 200)
    const showValue = (v: number): void => { kv.textContent = formatNumber(v, { step: kvStep, min: Math.min(this.lo, this.hi) }) }
    const setDial = (t: number): void => { ptr.setAttribute('transform', `rotate(${-135 + 270 * t} 12 12)`) }
    // HOLD THE DIAL STILL. The widget sits immediately after the DEF literal,
    // and a drag rewrites that literal to widths that differ by characters
    // (`0` -> `0.02` -> `0.355`) — so without this the dial slides sideways
    // under the finger holding it. Reserve the widest literal the range can
    // produce and give back exactly what the number takes.
    const maxW = literalWidth(this.lo, this.hi, kvStep)
    const reserve = (len: number): void => {
      wrap.style.marginLeft = `calc(2px + ${Math.max(0, maxW - len)}ch)`
    }
    reserve(this.defTo - this.defFrom) // the literal AS WRITTEN, not as we would print it
    // the readout is inside the widget, so its width shifts everything after
    // it on the line — pin it to the same reserve
    kv.style.minWidth = `${maxW}ch`
    const baseT = toNorm(this.value, this.lo, this.hi, this.log)
    setDial(baseT)
    showValue(this.value)

    // LIVE DRIVE: when a pattern's `.ctrl` sweeps this param, each note event
    // carries the driven value — the dial follows it (amber "live" state) and
    // settles back to the source DEF after the last note. The prototype's
    // "LFO turns the knob" made real. Dragging always wins over the drive.
    if (this.hooks.onNoteEvents && this.hooks.now && this.name !== undefined) {
      const name = this.name
      const now = this.hooks.now
      // FRAME-DRIVEN GLIDE: the drive is a continuous signal sampled once
      // per note, and events arrive AHEAD of the audio clock — so a rAF loop
      // can interpolate between the bracketing samples every frame, moving
      // the dial (and the readout) exactly on the clock. Runs only while
      // samples are pending; a gap after the last sample settles back to DEF.
      const queue: { t: number; v: number }[] = []
      let prev: { t: number; v: number } | null = null
      const HOLD_SEC = 0.35 // hold the last value this long before settling
      const frame = (): void => {
        const tNow = now()
        while (queue.length > 0 && queue[0]!.t <= tNow) prev = queue.shift()!
        const nxt = queue[0]
        if (this.drag.active) {
          // the finger owns the dial; keep ticking so the drive resumes
          this.raf = requestAnimationFrame(frame)
          return
        }
        if (prev !== null && nxt !== undefined && nxt.t - prev.t < 4) {
          // between two known samples: linear in VALUE (what the signal does)
          const u = (tNow - prev.t) / (nxt.t - prev.t || 1e-6)
          const v = prev.v + (nxt.v - prev.v) * Math.min(Math.max(u, 0), 1)
          wrap.classList.add('live')
          setDial(toNorm(v, this.lo, this.hi, this.log))
          showValue(v)
        } else if (prev !== null && tNow - prev.t <= HOLD_SEC) {
          wrap.classList.add('live')
          setDial(toNorm(prev.v, this.lo, this.hi, this.log))
          showValue(prev.v)
        } else if (prev !== null) {
          // drive went quiet: settle to the DEF and stop the loop
          prev = null
          wrap.classList.remove('live')
          setDial(baseT)
          showValue(this.value)
        }
        if (prev !== null || queue.length > 0) this.raf = requestAnimationFrame(frame)
        else this.raf = 0
      }
      this.unsub = this.hooks.onNoteEvents((evs) => {
        let queued = false
        for (const ev of evs) {
          if (this.synth !== undefined && ev.sound !== this.synth) continue
          const v = ev.controls?.[name]
          if (typeof v !== 'number' || !Number.isFinite(v)) continue
          queue.push({ t: ev.timeSec, v })
          queued = true
        }
        if (queued) {
          queue.sort((a, b) => a.t - b.t)
          if (queue.length > 64) queue.splice(0, queue.length - 64)
          if (this.raf === 0) this.raf = requestAnimationFrame(frame)
        }
      })
    }

    attachGesture(wrap, this.drag, 'window', (e) => {
      wrap.classList.add('active')
      buzz()
      wrap.classList.remove('live') // grabbing overrides the pattern drive
      const startY = e.clientY
      const t0 = toNorm(this.value, this.lo, this.hi, this.log)
      const step = niceStep(Math.abs(this.hi - this.lo) / 200)
      // DEF only — and every sibling declaration of the same param at once
      const writer = new MultiLiveWriter(
        view,
        this.siblings.length > 0 ? this.siblings : [{ from: this.defFrom, to: this.defTo }],
      )
      // TOUCH-TO-OVERRIDE: while held, the exact hand value plays NOW (engine
      // param, no eval round-trip) and the pattern drive is suppressed; the
      // text rewrite below still records the value (text stays the truth).
      const canHold = this.hooks.holdParam !== undefined &&
        this.name !== undefined && this.synth !== undefined
      const canHoldMacro = this.isMacro && this.name !== undefined
      return {
        onMove: (ev) => {
          const t = clamp(t0 + (startY - ev.clientY) / 170, 0, 1)
          const v = fromNorm(t, this.lo, this.hi, this.log)
          if (canHold) { this.holding = true; this.hooks.holdParam!(this.synth!, this.name!, v) }
          // A macro moves every destination at once — the sound through
          // holdMacro, and the on-screen numbers through the live env, which
          // recomputes each chip's own formula. Decoration rebuilds are
          // suppressed mid-drag, so the chips are updated in place.
          if (canHoldMacro) {
            this.holding = true
            this.hooks.holdMacro?.(this.name!, v)
            setMacroLive(view, this.name!, v)
          }
          const text = formatNumber(v, { step, min: Math.min(this.lo, this.hi) })
          if (!writer.write(text)) return // a concurrent edit aborted the gesture
          reserve(text.length)
          setDial(t)
          kv.textContent = text
          this.hooks.requestEval(false)
        },
        onEnd: () => {
          this.drag.ended = true
          wrap.classList.remove('active')
          // hand off the knob: the pattern drive resumes on its next event
          if (this.holding) {
            this.holding = false
            if (canHoldMacro) this.hooks.releaseMacro?.(this.name!)
            else this.hooks.releaseParam?.(this.synth!, this.name!)
          }
          view.dispatch({}) // empty transaction → plugin rebuilds (fresh ranges)
          this.hooks.requestEval(false)
        },
      }
    })
    return wrap
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
    cancelAnimationFrame(this.raf)
    if (this.holding && this.name !== undefined) {
      this.holding = false
      if (this.isMacro) this.hooks.releaseMacro?.(this.name)
      else if (this.synth !== undefined) this.hooks.releaseParam?.(this.synth, this.name)
    }
  }

  ignoreEvent(): boolean { return true }
}

// envelope handle mapping maxes (seconds); values beyond clamp visually
const AMAX = 1, DMAX = 1, RMAX = 2

class EnvWidget extends WidgetType {
  private unsub?: () => void
  private readonly timers = new Timers()
  private raf = 0

  constructor(
    readonly regionFrom: number,
    readonly regionTo: number,
    readonly a: number,
    readonly d: number,
    readonly s: number,
    readonly r: number,
    readonly synth: string | undefined,
    /** render width, measured by build() — part of eq() so a width change
     *  produces a FRESH DOM instead of reusing the old geometry. */
    readonly width: number,
    readonly hooks: Hooks,
    readonly drag: Drag,
    /** the four value spans (a/d/s/r), ascending — what a drag rewrites. */
    readonly ranges: readonly { from: number; to: number }[] = [],
  ) { super() }

  eq(o: EnvWidget): boolean {
    // regionTo matters: `.2` → `0.2` keeps the same VALUES but shifts the end;
    // reusing the old DOM would leave its closures rewriting a too-short range
    return o.regionFrom === this.regionFrom && o.regionTo === this.regionTo &&
      o.a === this.a && o.d === this.d && o.s === this.s && o.r === this.r &&
      o.synth === this.synth && o.width === this.width
  }

  toDOM(view: EditorView): HTMLElement {
    // FULL-WIDTH: the curve spans the editor's content width (capped) — line
    // wrapping puts it on its own visual row with big drag targets. All the
    // pointer math normalizes through the rect, so scale is free; the plugin
    // rebuilds when the editor width changes (geometryChanged + width check).
    const W = this.width
    const H = W >= 340 ? 76 : 58
    const pad = 5, base = H - pad, peak = pad
    const HOLD_MIN = 26
    const seg = (W - 2 * pad - HOLD_MIN) / 3
    // sqrt time→x mapping: musical envelope times cluster near 0, so a linear
    // scale crams every handle into the left edge at full width — sqrt gives
    // fine drag resolution exactly where the values live (invertible: t = u²)
    const tx = (t: number, max: number): number => Math.sqrt(clamp(t / max, 0, 1)) * seg
    const xt = (x: number, max: number): number => clamp(x / seg, 0, 1) ** 2 * max
    const wrap = document.createElement('span')
    wrap.className = 'rondo-env'
    wrap.title = 'drag the handles: attack · decay/sustain · release'
    wrap.innerHTML =
      `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      '<line class="base" x1="0" y1="0" x2="0" y2="0"/>' +
      '<path class="fill"/><path class="line" fill="none" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle class="emark" r="4"/>' +
      '<circle class="h ha" r="5"/><circle class="h hd" r="5"/><circle class="h hr" r="5"/></svg>'
    const line = wrap.querySelector('.line') as SVGPathElement
    const fill = wrap.querySelector('.fill') as SVGPathElement
    // the floor: a fixed reference so a low sustain reads as low rather than
    // as a curve floating somewhere in an unmarked box
    const baseLine = wrap.querySelector('.base') as SVGLineElement
    baseLine.setAttribute('x1', String(pad))
    baseLine.setAttribute('x2', String(W - pad))
    baseLine.setAttribute('y1', String(base))
    baseLine.setAttribute('y2', String(base))
    const ha = wrap.querySelector('.ha') as SVGCircleElement
    const hd = wrap.querySelector('.hd') as SVGCircleElement
    const hr = wrap.querySelector('.hr') as SVGCircleElement
    const geom = (a: number, d: number, s: number, r: number, holdOverride?: number) => {
      const ax = pad + tx(a, AMAX)
      const dx = ax + tx(d, DMAX)
      const sy = base - clamp(s, 0, 1) * (base - peak)
      // the sustain plateau ABSORBS the leftover width so the curve always
      // spans the full editor width. During a gesture the hold is FROZEN
      // (holdOverride): recomputing it per move would shift hx under the
      // finger and feed back into the release inverse.
      const rw = tx(r, RMAX)
      const hold = holdOverride ?? Math.max(HOLD_MIN, W - pad - rw - dx)
      const hx = dx + hold
      const rx = hx + rw
      return { ax, dx, sy, hx, rx, hold }
    }
    const render = (a: number, d: number, s: number, r: number, holdOverride?: number): void => {
      const g = geom(a, d, s, r, holdOverride)
      const p = `M ${pad} ${base} L ${g.ax.toFixed(1)} ${peak} L ${g.dx.toFixed(1)} ${g.sy.toFixed(1)} ` +
        `L ${g.hx.toFixed(1)} ${g.sy.toFixed(1)} L ${g.rx.toFixed(1)} ${base}`
      line.setAttribute('d', p)
      fill.setAttribute('d', `${p} L ${g.rx.toFixed(1)} ${base} L ${pad} ${base} Z`)
      ha.setAttribute('cx', String(g.ax)); ha.setAttribute('cy', String(peak))
      hd.setAttribute('cx', String(g.dx)); hd.setAttribute('cy', String(g.sy))
      hr.setAttribute('cx', String(g.rx)); hr.setAttribute('cy', String(base))
    }
    render(this.a, this.d, this.s, this.r)

    // FIRE on each of this synth's notes: a marker rides the curve — up the
    // attack, down the decay, holding at sustain for the note's duration, then
    // out the release — while the curve flashes "firing". Watching the shape
    // shape the sound, per note, like the prototype.
    const mark = wrap.querySelector('.emark') as SVGCircleElement
    if (this.hooks.onNoteEvents && this.hooks.now) {
      const now = this.hooks.now
      const animate = (durSec: number): void => {
        cancelAnimationFrame(this.raf)
        const { a, d, s, r } = this
        const g = geom(a, d, s, r)
        const holdSec = Math.max(durSec - a - d, 0.05)
        const total = a + d + holdSec + r
        const t0 = performance.now()
        wrap.classList.add('firing')
        const frame = (nowMs: number): void => {
          const t = (nowMs - t0) / 1000
          if (t >= total || this.drag.active) {
            wrap.classList.remove('firing')
            mark.style.opacity = '0'
            return
          }
          let x: number, y: number
          if (t < a) { const u = t / a; x = pad + (g.ax - pad) * u; y = base + (peak - base) * u }
          else if (t < a + d) { const u = (t - a) / (d || 1e-6); x = g.ax + (g.dx - g.ax) * u; y = peak + (g.sy - peak) * u }
          else if (t < a + d + holdSec) { const u = (t - a - d) / holdSec; x = g.dx + (g.hx - g.dx) * u; y = g.sy }
          else { const u = (t - a - d - holdSec) / (r || 1e-6); x = g.hx + (g.rx - g.hx) * u; y = g.sy + (base - g.sy) * u }
          mark.setAttribute('cx', x.toFixed(1))
          mark.setAttribute('cy', y.toFixed(1))
          mark.style.opacity = '1'
          this.raf = requestAnimationFrame(frame)
        }
        this.raf = requestAnimationFrame(frame)
      }
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          if (this.synth !== undefined && ev.sound !== this.synth) continue
          this.timers.at((ev.timeSec - now()) * 1000, () => { if (!this.drag.active) animate(ev.durSec) })
          break // one fire per batch — the marker is monophonic
        }
      })
    }

    const svg = wrap.querySelector('svg') as SVGSVGElement
    attachGesture(wrap, this.drag, 'window', (e) => {
      buzz()
      wrap.classList.add('active')
      const rect = svg.getBoundingClientRect()
      const sx = (e.clientX - rect.left) * (W / rect.width)
      const sy = (e.clientY - rect.top) * (H / rect.height)
      let a = this.a, d = this.d, s = this.s, r = this.r
      const g0 = geom(a, d, s, r)
      const holdFrozen = g0.hold // stable geometry for the whole gesture
      // pick the nearest handle
      const dist = (x: number, y: number): number => (sx - x) ** 2 + (sy - y) ** 2
      const which = [
        ['a', dist(g0.ax, peak)] as const,
        ['ds', dist(g0.dx, g0.sy)] as const,
        ['r', dist(g0.rx, base)] as const,
      ].sort((p, q) => p[1] - q[1])[0]![0]
      const tStep = 0.001, sStep = 0.01
      // Write the four VALUES in place, never the region: the text around them
      // is `.003 .2` in rondo and `a: 0.003, d: 0.2` in JS, and only the
      // numbers are common to both. Rewriting just the dragged field also
      // preserves the SOURCE spelling of the others — otherwise touching
      // release would silently re-quantize a `.003` attack onto the step grid.
      const writer = new MultiLiveWriter(view, this.ranges)
      const fmt = (): string[] => {
        const t = writer.texts.slice() // a/d/s/r, ascending — untouched stay as written
        if (which === 'a') t[0] = formatNumber(a, { step: tStep })
        else if (which === 'ds') { t[1] = formatNumber(d, { step: tStep }); t[2] = formatNumber(s, { step: sStep }) }
        else t[3] = formatNumber(r, { step: tStep })
        return t
      }
      return {
        onMove: (ev) => {
          const mx = (ev.clientX - rect.left) * (W / rect.width)
          const my = (ev.clientY - rect.top) * (H / rect.height)
          if (which === 'a') a = xt(mx - pad, AMAX)
          else if (which === 'ds') {
            const ax = pad + tx(a, AMAX)
            d = xt(mx - ax, DMAX)
            s = clamp((base - my) / (base - peak), 0, 1)
          } else {
            const hx = pad + tx(a, AMAX) + tx(d, DMAX) + holdFrozen
            r = xt(mx - hx, RMAX)
          }
          if (!writer.writeEach(fmt())) return // a concurrent edit aborted the gesture
          render(a, d, s, r, holdFrozen)
          this.hooks.requestEval(false)
        },
        onEnd: () => {
          this.drag.ended = true
          wrap.classList.remove('active')
          view.dispatch({}) // empty transaction → plugin rebuilds (fresh ranges)
          this.hooks.requestEval(false)
        },
      }
    })
    return wrap
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
    cancelAnimationFrame(this.raf)
  }

  ignoreEvent(): boolean { return true }
}

/* ------------------------------------------------------------------------- *
 * The BREAKPOINT editor: `env t l t l …` as a draggable shape.
 *
 * adsr has four values in fixed roles, so its widget has three handles in
 * known places. env has as many points as you type — so the handles come from
 * the source, and a drag rewrites ONE point's two numbers and leaves every
 * other spelled exactly as it was. That is what MultiLiveWriter.writeEach is
 * for: both numbers in one dispatch, so a drag is one undo step and the two
 * halves of a point can never land in the document separately.
 * ------------------------------------------------------------------------- */
const EP_H = 40
const EP_PAD = 4
/** Shortest breakpoint a drag will write. Zero is legal in the ENGINE (an
 *  instant segment) but a handle you cannot get back off the left edge is
 *  not; type a 0 if you want one. */
const EP_MIN_TIME = 0.001

class EnvPointsWidget extends WidgetType {
  constructor(
    readonly scan: EnvPointsScan,
    /** the source text of the whole call — part of eq(), so an edit anywhere
     *  in it produces fresh DOM rather than stale spans in live closures. */
    readonly key: string,
    readonly width: number,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: EnvPointsWidget): boolean {
    return o.key === this.key && o.width === this.width && o.scan.at === this.scan.at
  }

  toDOM(view: EditorView): HTMLElement {
    const W = Math.max(90, Math.min(this.width, 320))
    const pts = this.scan.points
    const wrap = document.createElement('span')
    wrap.className = 'rondo-envpts'
    wrap.setAttribute('role', 'group')
    wrap.setAttribute('aria-label', `${pts.length}-point envelope`)
    wrap.title = 'drag a point: sideways for time, up and down for level'
    const svg = `<svg width="${W}" height="${EP_H}" viewBox="0 0 ${W} ${EP_H}">` +
      `<line class="base" x1="${EP_PAD}" y1="${EP_H - EP_PAD}" x2="${W - EP_PAD}" y2="${EP_H - EP_PAD}"/>` +
      '<path class="fill"/><path class="line" fill="none" stroke-linejoin="round" stroke-linecap="round"/>' +
      pts.map((_, i) => `<circle class="h" data-i="${i}" r="4.5"/>`).join('') +
      '</svg>'
    wrap.innerHTML = svg
    const line = wrap.querySelector('.line') as SVGPathElement
    const fill = wrap.querySelector('.fill') as SVGPathElement
    const handles = Array.from(wrap.querySelectorAll('.h')) as SVGCircleElement[]

    // live copies: the doc is rewritten in step, but the geometry has to move
    // per frame without waiting for a rescan
    const times = pts.map((p) => p.time)
    const levels = pts.map((p) => p.level)

    const render = (): void => {
      const g = envGeometry(pts.map((p, i) => ({ ...p, time: times[i]!, level: levels[i]! })), W, EP_H, EP_PAD)
      const d = g.map((q, i) => `${i === 0 ? 'M' : 'L'} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' ')
      line.setAttribute('d', d)
      fill.setAttribute('d', `${d} L ${g[g.length - 1]!.x.toFixed(1)} ${EP_H - EP_PAD} L ${EP_PAD} ${EP_H - EP_PAD} Z`)
      // g[0] is the origin, so handle i sits on g[i + 1]
      handles.forEach((h, i) => {
        h.setAttribute('cx', String(g[i + 1]!.x))
        h.setAttribute('cy', String(g[i + 1]!.y))
      })
    }
    render()

    attachGesture(wrap, this.drag, 'window', (e) => {
      const target = e.target as HTMLElement | null
      const hit = target?.closest?.('.h') as SVGCircleElement | null
      if (hit === null) return null
      const i = Number(hit.dataset['i'])
      const p = pts[i]
      if (p === undefined) return null
      buzz()
      wrap.classList.add('active')
      const rect = wrap.getBoundingClientRect()
      const total = times.reduce((n, t) => n + Math.max(0, t), 0) || 1
      const span = W - EP_PAD * 2
      const t0 = times[i]!
      const startX = e.clientX
      // ONE writer over this point's two numbers: both land in a single
      // dispatch, so a drag is one undo step and the pair cannot split
      const writer = new MultiLiveWriter(view, [p.timeSpan, p.levelSpan])
      const tStep = niceStep(total / 200)
      return {
        onMove: (ev) => {
          const dx = (ev.clientX - startX) * (W / Math.max(1, rect.width))
          const t = Math.max(EP_MIN_TIME, t0 + (dx / span) * total)
          const y = (ev.clientY - rect.top) * (EP_H / Math.max(1, rect.height))
          const lv = clamp((EP_H - EP_PAD - y) / (EP_H - EP_PAD * 2), 0, 1)
          const texts = [
            formatNumber(t, { step: tStep, min: 0 }),
            formatNumber(lv, { step: 0.01, min: 0 }),
          ]
          if (!writer.writeEach(texts)) return // a concurrent edit aborted it
          times[i] = t
          levels[i] = lv
          render()
          this.hooks.requestEval(false)
        },
        onEnd: () => {
          this.drag.ended = true
          wrap.classList.remove('active')
          view.dispatch({}) // one rebuild, fresh spans
          this.hooks.requestEval(false)
        },
      }
    })
    return wrap
  }

  ignoreEvent(): boolean { return true }
}

class PianoRollWidget extends WidgetType {
  private unsub?: () => void
  private readonly timers = new Timers()

  constructor(
    readonly from: number,
    readonly to: number,
    readonly content: string,
    readonly steps: (number | null)[],
    readonly synth: string | undefined,
    readonly scale: string | undefined,
    readonly hooks: Hooks,
    readonly drag: Drag,
    /** polymeter figure: events carry the FULL notation as loc.src, and the
     *  figure's atoms sit srcOffset chars into it. */
    readonly srcFull?: string,
    readonly srcOffset?: number,
  ) { super() }

  eq(o: PianoRollWidget): boolean {
    // `to`/`content` matter: respacing `0 3 5` → `0  3  5` keeps the same
    // STEPS but shifts offsets; a reused DOM would rewrite a too-short range
    return o.from === this.from && o.to === this.to && o.content === this.content &&
      o.srcFull === this.srcFull && o.srcOffset === this.srcOffset &&
      o.steps.length === this.steps.length && o.steps.every((v, i) => v === this.steps[i])
  }

  toDOM(view: EditorView): HTMLElement {
    const cols = this.steps.length
    // The grid spans minDeg..maxDeg, not 0..maxDeg: a degree used to BE its
    // row index, which silently had no room for a negative one. The default
    // floor stays 0 so an ordinary line looks exactly as it did.
    let maxDeg = 7
    let minDeg = 0
    for (const s of this.steps) {
      if (s === null) continue
      if (s > maxDeg) maxDeg = s
      if (s < minDeg) minDeg = s
    }
    const rows = maxDeg - minDeg + 1
    const grid = document.createElement('span')
    grid.className = 'rondo-roll'
    grid.setAttribute('role', 'group')
    grid.setAttribute('aria-label', 'notation grid: tap or drag to write the melody')
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
    const steps = this.steps.slice()
    const cellEls: HTMLElement[][] = Array.from({ length: rows }, () => [])
    // rows top (high degree) → bottom (low), so pitch goes up the screen
    for (let dr = rows - 1; dr >= 0; dr--) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('span')
        // every 4th column reads brighter — the beat grid, like the prototype
        cell.className = 'rc' + (steps[c] !== null && steps[c]! - minDeg === dr ? ' on' : '') + (c % 4 === 0 ? ' beat' : '')
        cell.dataset.r = String(dr)
        cell.dataset.c = String(c)
        cellEls[dr]![c] = cell
        grid.appendChild(cell)
      }
    }

    // PLAYHEAD: this grid's notes carry loc.src === the notation text, and
    // loc.start maps to a column via stepStarts — light the column + bloom the
    // sounding cell as the scheduler sweeps, exactly like the prototype.
    if (this.hooks.onNoteEvents && this.hooks.now) {
      const now = this.hooks.now
      const starts = stepStarts(this.content)
      const matchSrc = this.srcFull ?? this.content
      const locOff = this.srcOffset ?? 0
      const lightCol = (c: number, litMs: number): void => {
        for (let r = 0; r < rows; r++) {
          const cell = cellEls[r]?.[c]
          if (!cell) continue
          cell.classList.add('play')
          if (cell.classList.contains('on')) cell.classList.add('trig')
        }
        this.timers.at(litMs, () => {
          for (let r = 0; r < rows; r++) cellEls[r]?.[c]?.classList.remove('play', 'trig')
        })
      }
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          if (ev.src !== matchSrc) continue
          const col = starts.indexOf(ev.start - locOff)
          if (col < 0) continue
          const litMs = Math.min(Math.max(ev.durSec * 1000, LIT_MIN_MS), LIT_MAX_MS)
          this.timers.at((ev.timeSec - now()) * 1000, () => lightCol(col, litMs))
        }
      })
    }
    const refresh = (c: number): void => {
      for (let r = 0; r < rows; r++) cellEls[r]?.[c]?.classList.toggle('on', steps[c] !== null && steps[c]! - minDeg === r)
    }
    attachGesture(grid, this.drag, 'element', (e) => {
      const el0 = (e.target as HTMLElement).closest?.('.rc') as HTMLElement | null
      if (!el0) return null
      const writer = new LiveWriter(view, this.from, this.to)
      let mode: 'draw' | 'erase' = 'draw'
      const set = (r: number, c: number): void => {
        // r is a ROW; the degree it stands for is offset by the grid's floor
        const next = mode === 'draw' ? r + minDeg : null
        if (steps[c] === next) return // no-op: don't spam identical rewrites/evals mid-drag
        steps[c] = next
        refresh(c)
        if (writer.write(steps.map((v) => (v === null ? '~' : String(v))).join(' '))) {
          this.hooks.requestEval(false)
        }
        buzz()
        // preview the placed note while the transport is stopped — instant
        // feedback while composing (playing back, the playhead sounds it anyway)
        if (next !== null && this.synth !== undefined && this.hooks.previewNote !== undefined &&
            !(this.hooks.isPlaying?.() ?? false)) {
          const midi = rollPreviewMidi(this.scale, next)
          if (midi !== undefined) this.hooks.previewNote(this.synth, midi)
        }
      }
      const r0 = Number(el0.dataset.r), c0 = Number(el0.dataset.c)
      mode = steps[c0] === r0 ? 'erase' : 'draw' // tap an active note to clear it
      set(r0, c0)
      return {
        onMove: (ev) => {
          const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
          const cell = el?.closest?.('.rc') as HTMLElement | null
          if (cell && grid.contains(cell)) set(Number(cell.dataset.r), Number(cell.dataset.c))
        },
        onEnd: () => {
          this.drag.ended = true
          view.dispatch({}) // empty transaction → plugin rebuilds (fresh ranges)
          this.hooks.requestEval(false)
        },
      }
    })
    return grid
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
  }

  ignoreEvent(): boolean { return true }
}

/** Tap-cycle on an active step: full → accent-soft → ghost → off. Any
 *  text-authored velocity joins at the nearest lower tier. */
export function nextVelocity(v: number): number | null {
  if (v > 0.75) return 0.6
  if (v > 0.45) return 0.3
  return null
}

/** A velocity's cell intensity (0..1 opacity share for the ON look). */
const velOpacity = (v: number): string => String(Math.min(1, 0.3 + 0.7 * v))

/** Serialize one row's steps back to tokens (`kick`, `kick:0.6`, `~`). */
export function beatTokens(steps: (number | null)[], word: string): string {
  return steps.map((v) => (v === null ? '~' : v === 1 ? word : `${word}:${Number(v)}`)).join(' ')
}

/** Vertical velocity scrub: dy pixels up from the gesture start maps onto the
 *  starting velocity, full range over ~80px, snapped to 2 decimals (keeps the
 *  written `word:v` suffixes tidy). Floor .05 — a scrub thins a hit, it never
 *  silently deletes it (drop a step by tapping through to off instead). */
export function scrubVelocity(v0: number, dyUp: number): number {
  const v = clamp(v0 + dyUp / 80, 0.05, 1)
  return Math.round(v * 100) / 100
}

/** ONE step sequencer per beat block: a labeled row per simple line, columns
 *  aligned in musical time (every row spans the same width, so a 4-step row's
 *  cells are twice as wide as an 8-step row's). Tap places a hit; tapping an
 *  active step cycles its velocity (full → soft → ghost → off); drag paints —
 *  across rows too — the playhead lights the sweeping cells, and a placed
 *  step previews its drum. */
class BeatBlockWidget extends WidgetType {
  private unsub?: () => void
  private readonly timers = new Timers()

  constructor(
    readonly rows: BeatRow[],
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: BeatBlockWidget): boolean {
    // from/to/content matter: respacing keeps the same STEPS but shifts
    // offsets; a reused DOM would rewrite too-short ranges
    return o.rows.length === this.rows.length && o.rows.every((r, i) => {
      const m = this.rows[i]!
      return r.from === m.from && r.to === m.to && r.content === m.content &&
        r.word === m.word && r.hadComment === m.hadComment &&
        r.steps.length === m.steps.length && r.steps.every((v, k) => v === m.steps[k])
    })
  }

  toDOM(view: EditorView): HTMLElement {
    const maxCols = Math.max(...this.rows.map((r) => r.steps.length))
    const wrap = document.createElement('span')
    wrap.className = 'rondo-beatgrid'
    wrap.setAttribute('role', 'group')
    wrap.setAttribute('aria-label', 'step sequencer: tap or drag to place hits')
    const steps = this.rows.map((r) => r.steps.slice())
    const cellEls: HTMLElement[][] = []
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r]!
      const label = document.createElement('span')
      label.className = 'bl'
      label.textContent = row.word
      wrap.appendChild(label)
      const lane = document.createElement('span')
      lane.className = 'rondo-roll lane'
      // shared TIME alignment: every lane spans maxCols worth of width; a
      // row with fewer steps gets proportionally wider cells
      lane.style.gridTemplateColumns = `repeat(${row.steps.length}, 1fr)`
      lane.style.width = `calc(${maxCols} * var(--beat-cell, 18px))`
      const cells: HTMLElement[] = []
      const beatEvery = row.steps.length % 4 === 0 ? row.steps.length / 4 : 4
      for (let c = 0; c < row.steps.length; c++) {
        const cell = document.createElement('span')
        const v = steps[r]![c]
        cell.className = 'rc' + (v !== null ? ' on' : '') + (c % beatEvery === 0 ? ' beat' : '')
        if (v !== null) cell.style.opacity = velOpacity(v!)
        cell.dataset.r = String(r)
        cell.dataset.c = String(c)
        cells.push(cell)
        lane.appendChild(cell)
      }
      cellEls.push(cells)
      wrap.appendChild(lane)
    }

    // PLAYHEAD: a row's events carry loc.src === its notation text, and
    // loc.start maps to a column via stepStarts.
    if (this.hooks.onNoteEvents && this.hooks.now) {
      const now = this.hooks.now
      const starts = this.rows.map((r) => stepStarts(r.content))
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          for (let r = 0; r < this.rows.length; r++) {
            if (ev.src !== this.rows[r]!.content) continue
            const col = starts[r]!.indexOf(ev.start)
            if (col < 0) continue
            const litMs = Math.min(Math.max(ev.durSec * 1000, LIT_MIN_MS), LIT_MAX_MS)
            this.timers.at((ev.timeSec - now()) * 1000, () => {
              const cell = cellEls[r]?.[col]
              if (!cell) return
              cell.classList.add('play')
              if (cell.classList.contains('on')) cell.classList.add('trig')
              this.timers.at(litMs, () => cell.classList.remove('play', 'trig'))
            })
          }
        }
      })
    }
    // The doc write is DEFERRED to gesture end: toggling `kick` ↔ `~` changes
    // LINE LENGTHS, so a mid-gesture write would shift this widget under the
    // stationary pointer and the next pointermove would paint a neighbor.
    // (The piano-roll writes live safely — its tokens are all one char.)
    const dirty = new Set<number>()
    const paint = (cell: HTMLElement | null, v: number | null): void => {
      if (cell === null) return
      cell.classList.toggle('on', v !== null)
      cell.style.opacity = v !== null ? velOpacity(v) : ''
    }
    // WRITE-VERIFY: the original text of every row, captured at build — if a
    // row's slice differs at commit time (any concurrent edit), the whole
    // write is dropped and a rebuild resyncs the cells from the text
    const raw0 = this.rows.map((row) => view.state.doc.sliceString(row.from, row.to))
    attachGesture(wrap, this.drag, 'element', (e) => {
      const el0 = (e.target as HTMLElement).closest?.('.rc') as HTMLElement | null
      if (!el0) return null
      let mode: 'draw' | 'erase' = 'draw'
      // a down on an ACTIVE cell is ambiguous: released in place it's a
      // velocity-cycle TAP; dragged VERTICALLY it scrubs that step's velocity;
      // dragged HORIZONTALLY it starts an erase PAINT — the action is deferred
      // until the first move past the slop picks a direction
      let pendingTap: { r: number; c: number; x0: number; y0: number } | null = null
      let scrub: { r: number; c: number; v0: number; y0: number } | null = null
      const set = (r: number, c: number, vel?: number | null): void => {
        const row = this.rows[r]
        if (row === undefined || c < 0 || c >= row.steps.length) return
        const next = vel !== undefined ? vel : mode === 'draw' ? 1 : null
        if (steps[r]![c] === next) return
        steps[r]![c] = next
        dirty.add(r)
        paint(cellEls[r]?.[c] ?? null, next)
        buzz()
        // preview the placed hit while the transport is stopped — beat events
        // carry the sound() default note (60); drums ignore the pitch anyway
        if (next !== null && this.hooks.previewNote !== undefined && !(this.hooks.isPlaying?.() ?? false)) {
          this.hooks.previewNote(row.word, 60)
        }
      }
      const applyScrub = (y: number): void => {
        // per-pixel updates: no buzz/preview spam, just the value + the cell
        const { r, c } = scrub!
        const v = scrubVelocity(scrub!.v0, scrub!.y0 - y)
        if (steps[r]![c] === v) return
        steps[r]![c] = v
        dirty.add(r)
        paint(cellEls[r]?.[c] ?? null, v)
      }
      const r0 = Number(el0.dataset.r), c0 = Number(el0.dataset.c)
      if (steps[r0]?.[c0] != null) {
        mode = 'erase' // moving off this cell (horizontally) paints an erase
        pendingTap = { r: r0, c: c0, x0: e.clientX, y0: e.clientY }
      } else {
        set(r0, c0)
      }
      return {
        onMove: (ev) => {
          if (scrub !== null) {
            // VELOCITY SCRUB: vertical drag on an active step — up is louder
            applyScrub(ev.clientY)
            return
          }
          if (pendingTap !== null) {
            const dx = ev.clientX - pendingTap.x0
            const dy = ev.clientY - pendingTap.y0
            if (dx * dx + dy * dy < 36) return // inside the slop: still a tap
            if (Math.abs(dy) > Math.abs(dx)) {
              // vertical wins: scrub this step's velocity for the rest of the drag
              scrub = { r: pendingTap.r, c: pendingTap.c, v0: steps[pendingTap.r]![pendingTap.c] ?? 1, y0: pendingTap.y0 }
              pendingTap = null
              buzz()
              applyScrub(ev.clientY)
              return
            }
            set(pendingTap.r, pendingTap.c) // horizontal: an erase drag after all
            pendingTap = null
          }
          const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
          const cell = el?.closest?.('.rc') as HTMLElement | null
          if (!cell || !wrap.contains(cell)) return
          set(Number(cell.dataset.r), Number(cell.dataset.c))
        },
        onEnd: () => {
          if (pendingTap !== null) {
            // released on the down cell: cycle its velocity (full → soft → ghost → off)
            const { r, c } = pendingTap
            pendingTap = null
            set(r, c, nextVelocity(steps[r]![c] ?? 0))
          }
          if (dirty.size === 0) return // nothing changed — ranges are still valid
          this.drag.ended = true // the write's own transaction triggers ONE rebuild
          const changes = [...dirty].map((r) => {
            const row = this.rows[r]!
            let insert = beatTokens(steps[r]!, row.word)
            // an erased row keeps its instrument as a `# word` comment — that's
            // what lets the scanner (and the next session) rebuild this row
            if (!steps[r]!.some((v) => v !== null) && !row.hadComment) insert += `  # ${row.word}`
            return { from: row.from, to: row.to, expected: raw0[r]!, insert }
          })
          dirty.clear()
          if (!verifiedChanges(view, changes)) {
            // someone edited under the gesture — drop the write, resync
            view.dispatch({})
            return
          }
          this.hooks.requestEval(false)
        },
      }
    })
    return wrap
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
  }

  ignoreEvent(): boolean { return true }
}

/** Unison fan glyph geometry (px). One stroke per sub-voice. */
const FAN = { voiceGap: 7, pad: 6, h: 22, minStroke: 6 }

/** DISPLAY-ONLY glyph on a `synth … unison:N` header: one vertical stroke
 *  per sub-voice at its detune position through the curve exponent, stroke
 *  height = the voice's blend gain, octave voices tinted. The header numbers
 *  already scrub — this is the read-back, not a control (see unison.ts). */
class UnisonFanWidget extends WidgetType {
  constructor(readonly scan: UnisonScan) { super() }

  eq(o: UnisonFanWidget): boolean {
    const s = this.scan, t = o.scan
    return s.at === t.at && s.unison === t.unison && s.detune === t.detune &&
      s.curve === t.curve && s.blend === t.blend && s.octaves === t.octaves
  }

  toDOM(): HTMLElement {
    const strokes = unisonFan(this.scan.unison, this.scan.curve, this.scan.blend, this.scan.octaves)
    const W = 2 * FAN.pad + (strokes.length - 1) * FAN.voiceGap + 2
    const H = FAN.h
    const wrap = document.createElement('span')
    wrap.className = 'rondo-ufan'
    wrap.setAttribute('role', 'img')
    wrap.setAttribute('aria-label', `unison ${strokes.length} voices`)
    wrap.title = `unison ${strokes.length} · ±${this.scan.detune} cents` +
      (this.scan.curve !== 1 ? ` · curve ${this.scan.curve}` : '') +
      (this.scan.octaves >= 2 ? ` · every ${this.scan.octaves}th voice +12` : '')
    const mid = W / 2
    const span = (W - 2 * FAN.pad) / 2 // x is -1..1
    let body = ''
    for (const s of strokes) {
      const x = (mid + s.x * span).toFixed(1)
      const len = FAN.minStroke + s.h * (H - 4 - FAN.minStroke)
      const y0 = (H - 2 - len).toFixed(1)
      body += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${H - 2}"` +
        (s.octave ? ' class="oct"' : '') + '/>'
    }
    wrap.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`
    return wrap
  }

  ignoreEvent(): boolean { return true }
}

/** The envelope's render width for this editor: full content width, capped. */
function envWidth(view: EditorView): number {
  return Math.max(200, Math.min(640, view.contentDOM.clientWidth - 48))
}

/** The enum tap-cycler's mark (see enums.ts — a tap on the word cycles it). */
const enumMark = Decoration.mark({ class: 'cm-rondo-enum' })

/** Scan the doc for knob + envelope + play-notation bindings → inline widgets. */
/* ------------------------------------------------------------------------- *
 * The scanner seam.
 *
 * Every widget below is language-agnostic: it is handed absolute source
 * offsets and values, and (for the editable ones) writes back through
 * LiveWriter at those offsets. The only rondo-specific part was ever the
 * SCAN — turning source text into those descriptors. Parameterise that and
 * the same widgets serve JavaScript, which has a real syntax tree and is if
 * anything an easier thing to scan than rondo's line regexes.
 * ------------------------------------------------------------------------- */
export interface WidgetScan {
  knobs(text: string): KnobMatch[]
  envs(text: string): EnvMatch[]
  /** `env t l t l …` breakpoint lists — the n-handle editor. */
  envPoints(text: string): EnvPointsScan[]
  plays(text: string): PlayRoll[]
  richPlays(text: string): RichPlay[]
  beats(text: string): BeatBlock[]
  wavedefs(text: string): WavedefScan[]
  /** how the wavedef bar editor WRITES in this language (separator + rescan). */
  wavedefDialect: WavedefDialect
  wavetableCalls(text: string): WavetableCallScan[]
  unisonHeaders(text: string): UnisonScan[]
  filters(text: string, knobs: KnobMatch[]): FilterScan[]
  enumSpans(text: string): EnumSpan[]
}

/** The rondo scanners — the original set, unchanged. */
export const RONDO_SCAN: WidgetScan = {
  knobs: scanKnobs,
  envs: scanEnvs,
  envPoints: scanEnvPoints,
  plays: scanPlays,
  richPlays: scanRichPlays,
  beats: scanBeats,
  wavedefs: scanWavedefs,
  wavedefDialect: RONDO_WAVEDEF,
  wavetableCalls: scanWavetableCalls,
  unisonHeaders: scanUnisonHeaders,
  filters: scanFilters,
  enumSpans: scanEnumSpans,
}

function build(view: EditorView, hooks: Hooks, drag: Drag, scan: WidgetScan): DecorationSet {
  const items: Range<Decoration>[] = []
  // Docs are tiny (<10 KB); scan the whole thing so widgets past the viewport
  // (and the line-oriented play scan) work without slicing bookkeeping.
  const text = view.state.doc.toString()
  const knobs = scan.knobs(text)
  // Declarations of the SAME param (same synth + name) are one control, so
  // each widget is handed the whole family and a drag rewrites all of them.
  const family = new Map<string, { from: number; to: number }[]>()
  for (const k of knobs) {
    if (k.name === undefined) continue
    const key = `${k.synth ?? ''}\u0000${k.name}`
    family.set(key, [...(family.get(key) ?? []), { from: k.defFrom, to: k.defTo }])
  }
  for (const k of knobs) {
    const sibs = k.name === undefined ? [] : (family.get(`${k.synth ?? ''}\u0000${k.name}`) ?? [])
    items.push(Decoration.widget({
      widget: new KnobWidget(k.defFrom, k.defTo, k.value, k.lo, k.hi, k.log, k.name, k.synth, hooks, drag, sibs, k.macro === true),
      side: 1,
    }).range(k.defTo))
  }
  // Every destination a macro reaches, with the value ITS formula produces.
  const macroDecls = scanMacroDecls(text)
  refreshMacroEnv(view, text, macroDecls)
  for (const r of macroReadouts(text, macroDecls)) {
    items.push(Decoration.widget({ widget: new MacroChipWidget(r.at, r.label, r.value), side: 1 }).range(r.at))
  }
  // Voice options the engine will not use as written (unison:32 -> 9, …).
  for (const c of hooks.voiceOptEffective !== undefined ? scanClampedOpts(text, hooks.voiceOptEffective) : []) {
    items.push(Decoration.widget({ widget: new ClampChipWidget(c.name, c.written, c.effective), side: 1 }).range(c.at))
  }
  // env breakpoint editors — as many handles as the source has points
  for (const ep of scan.envPoints(text)) {
    const key = text.slice(ep.points[0]!.timeSpan.from, ep.at)
    items.push(Decoration.widget({
      widget: new EnvPointsWidget(ep, key, envWidth(view), hooks, drag), side: 1,
    }).range(ep.at))
  }
  const envW = envWidth(view)
  for (const e of scan.envs(text)) {
    // a scanner that cannot point at the four values cannot write them — skip
    // rather than render a dial that silently does nothing
    if (e.ranges === undefined || e.ranges.length !== 4) continue
    items.push(Decoration.widget({ widget: new EnvWidget(e.from, e.to, e.a, e.d, e.s, e.r, e.synth, envW, hooks, drag, e.ranges), side: 1 }).range(e.to))
  }
  for (const p of scan.plays(text)) {
    items.push(Decoration.widget({ widget: new PianoRollWidget(p.from, p.to, p.content, p.steps, p.synth, p.scale, hooks, drag, p.srcFull, p.srcOffset), side: 1 }).range(p.to))
  }
  for (const rp of scanRichPlays(text)) {
    // HONESTY: only a TRUE single-cycle figure earns the compact inline roll.
    // Multi-cycle patterns get the full-width block overview instead (served
    // by blockWidgetField); patterns with no honest view at all — never
    // repeating within the probe cap, or over the cell budget — get NOTHING.
    // The old cycle-0-only thumbnail must never appear for a multi-cycle
    // pattern in any fallback path.
    const data = rollOverviewData(rp.content)
    if (data === null || data.period !== 1) continue
    items.push(Decoration.widget({
      widget: new QueryRollWidget(rp.content, rp.from, { cells: data.cells, rows: data.rows }, hooks, drag),
      side: 1,
    }).range(rp.to))
  }
  for (const b of scan.beats(text)) {
    // one sequencer per block, hanging off the LAST qualifying row's line
    const pos = b.rows[b.rows.length - 1]!.to
    items.push(Decoration.widget({ widget: new BeatBlockWidget(b.rows, hooks, drag), side: 1 }).range(pos))
  }
  // wavetable widgets: v1 RIBBON on synth-body wavetable calls (the v2
  // wavedef EDITOR is a BLOCK widget — served by blockWidgetField below, since
  // block decorations may not come from a view plugin). The doc's own
  // wavedefs feed the ribbon fresh while typing; built-ins and last-eval
  // registry tables fill in the rest.
  const wavedefs = scan.wavedefs(text)
  for (const call of scan.wavetableCalls(text)) {
    let frames = previewFrames(call.table, wavedefs, hooks.wavetableBank)
    if (frames === null) continue // unknown table: the eval diagnostic tells that story
    // a line carrying warp args renders every frame through the kernel's
    // phase map (warp commutes with the morph blend, so pre-warping the
    // frames is exactly the warped read — see wavetable.ts warpWave)
    if (call.warp !== undefined) {
      frames = frames.map((f) => warpWave(f, call.warp!, call.warpAmt ?? 0.5))
    }
    const def = wavedefs.find((d) => d.name === call.table)
    const framesKey = `${call.table}:${def !== undefined ? JSON.stringify(def.frames) : 'bank'}` +
      (call.warp !== undefined ? `:${call.warp}:${call.warpAmt}` : '')
    items.push(
      Decoration.widget({
        widget: new WavetableRibbonWidget(call.table, call.posLiteral, call.synth, framesKey, frames, hooks, drag),
        side: 1,
      }).range(call.at),
    )
  }
  // unison fan glyphs on `synth … unison:N` headers (display-only)
  for (const u of scan.unisonHeaders(text)) {
    items.push(Decoration.widget({ widget: new UnisonFanWidget(u), side: 1 }).range(u.at))
  }
  // filter response curves under svf/ladder/dualsvf/eq lines (static values
  // only — see filtercurve.ts's honesty rules)
  const fcW = Math.min(envWidth(view), 420)
  for (const fs of scan.filters(text, knobs)) {
    items.push(
      Decoration.widget({
        widget: new FilterCurveWidget(fs, `${JSON.stringify(fs)}`, fcW, hooks, drag),
        side: 1,
      }).range(fs.at),
    )
  }
  // enum words carry the tap-cycler mark (the tap handler lives on the plugin)
  for (const sp of scan.enumSpans(text)) items.push(enumMark.range(sp.from, sp.to))
  return Decoration.set(items, true)
}

/** Movement slop that still counts as a TAP on an enum word (px²). */
const ENUM_TAP_SLOP_SQ = 64

/** Width refresh for the block widgets (resize/rotation). */
const setBlockWidth = StateEffect.define<number>()

/** The BLOCK widgets — the wavedef editor and the multi-cycle roll overview
 *  — as a StateField of block decorations. CodeMirror forbids
 *  layout-affecting (block) decorations from view plugins, so they cannot
 *  ride the main plugin — and they must NOT be inline: an inline widget
 *  after the line's text shifts with every live rewrite that changes the
 *  line's length (the shipped wavedef drag bug), and it floats mid-wrap on a
 *  soft-wrapped mega-line (the shipped query-roll complaint).
 *
 *  The field follows the same drag lifecycle as the plugin: map (never
 *  rebuild) while a gesture is live so the dragged DOM survives, rebuild
 *  ONCE on the gesture's end dispatch, rebuild on any other doc change, and
 *  rebuild when the measured width actually changes (the companion watcher
 *  plugin dispatches setBlockWidth outside the update cycle).
 *
 *  Exported for the contract tests (wavetable-widget.test.ts and
 *  roll-overview.test.ts pin the map-mid-drag / rebuild-once-at-end
 *  lifecycle headlessly). */
export function blockWidgetField(hooks: Hooks, drag: Drag, scan: WidgetScan = RONDO_SCAN): Extension {
  // measured content width; a sane pre-measure default, corrected by the
  // watcher's first dispatch (eq() includes width, so the correction swaps
  // in fresh DOM once)
  let width = 360
  const build = (state: EditorState): DecorationSet => {
    const text = state.doc.toString()
    return Decoration.set([
      ...wavedefBlockDecos(text, width, hooks, drag, scan.wavedefDialect),
      ...rollOverviewBlockDecos(text, width, hooks, drag, scan),
    ], true)
  }
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state),
    update: (decos, tr) => {
      let w: number | null = null
      for (const e of tr.effects) if (e.is(setBlockWidth)) w = e.value
      if (w !== null && w !== width) { width = w; return build(tr.state) }
      // a live gesture: map our own edits through — rebuilding would destroy
      // the dragged element (and its pointer stream) mid-gesture
      if (drag.active) return tr.docChanged ? decos.map(tr.changes) : decos
      // the gesture's end dispatch (possibly empty) or any real edit: rebuild
      // with fresh scans. drag.ended is NOT consumed here — the plugin resets
      // it after its own rebuild (fields update before plugins).
      if (tr.docChanged || drag.ended) return build(tr.state)
      return decos
    },
    provide: (f) => EditorView.decorations.from(f),
  })
  const watcher = ViewPlugin.fromClass(
    class {
      pending = false
      dead = false
      constructor(readonly view: EditorView) { this.sync(view) }
      update(u: ViewUpdate): void { if (u.geometryChanged) this.sync(u.view) }
      destroy(): void { this.dead = true }
      sync(view: EditorView): void {
        const w = envWidth(view)
        if (w === width || this.pending) return
        this.pending = true // one in flight; re-measured on the next geometry change
        setTimeout(() => {
          this.pending = false
          if (this.dead) return // dispatch on a destroyed view throws
          const now = envWidth(view)
          if (now !== width) view.dispatch({ effects: setBlockWidth.of(now) })
        }, 0)
      }
    },
  )
  return [field, watcher]
}

/** The rondo widget set — the original entry point. A hoisted DECLARATION on
 *  purpose: as a `const` arrow at the end of the module it sat in the temporal
 *  dead zone for anything that imported it through this file's cycle, and the
 *  failure was silent (a scanner captured undefined and mis-classified) rather
 *  than a crash. */
export function rondoWidgets(hooks: Hooks): Extension {
  return codeWidgets(hooks, RONDO_SCAN)
}

/** The inline-widget extension (knob · envelope · piano-roll · filter curve ·
 *  enum tap-cycler), over whichever language the scanner set reads. */
export function codeWidgets(hooks: Hooks, scan: WidgetScan): Extension {
  const drag: Drag = { active: false, ended: false }
  // ENUM TAP-CYCLER state: a pointerdown on an enum word arms; a pointerup
  // that hasn't traveled (a TAP, not a drag/selection) cycles the word to
  // its next legal value. The edit is recomputed FROM THE CURRENT DOC at
  // release (a rescan, the write-verify analog for taps), so a doc change
  // between down and up can never splice a stale range. The down is NOT
  // claimed — caret placement and drag-selection keep working normally.
  let enumArm: { pointerId: number; x: number; y: number; pos: number } | null = null
  const plugin = ViewPlugin.fromClass(
    class {
      decos: DecorationSet
      lastEnvW: number
      constructor(view: EditorView) {
        this.decos = build(view, hooks, drag, scan)
        this.lastEnvW = envWidth(view)
      }
      update(u: ViewUpdate): void {
        // Keep the dragged widget's DOM stable: map our own edits through
        // instead of rebuilding (which would destroy the element mid-gesture)…
        if (drag.active) { this.decos = this.decos.map(u.changes); return }
        // …then rebuild ONCE when the gesture ends (each end() dispatches an
        // empty transaction): surviving instances hold stale ranges/values, and
        // a second drag seeded from them would rewrite the wrong chars.
        if (drag.ended) { drag.ended = false; this.decos = build(u.view, hooks, drag, scan); return }
        // The full-width envelope tracks the editor width (rotation, resize).
        // Read the width ONLY when geometry actually changed: clientWidth
        // forces a synchronous layout, and this update() runs on EVERY
        // transaction -- including the one the flasher dispatches per note.
        // Reading it unconditionally meant a forced reflow per note event,
        // which stalls the main thread and makes the visualizer's rAF and the
        // roll's playhead run visibly behind the audio (reported: "visuals and
        // piano roll lagging behind realtime" while playing).
        let widthChanged = false
        if (u.geometryChanged) {
          const envW = envWidth(u.view)
          widthChanged = envW !== this.lastEnvW
          this.lastEnvW = envW
        }
        if (u.docChanged || u.viewportChanged || widthChanged) this.decos = build(u.view, hooks, drag, scan)
      }
    },
    {
      decorations: (v) => v.decos,
      eventHandlers: {
        pointerdown(e: PointerEvent, view: EditorView): boolean {
          try {
            if (e.button !== 0 || drag.active) return false
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
            if (pos === null) return false
            const span = scan.enumSpans(view.state.doc.toString()).find((sp) => pos >= sp.from && pos <= sp.to)
            if (span === undefined) { enumArm = null; return false }
            enumArm = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, pos }
          } catch {
            enumArm = null // the cycler must never break pointer handling
          }
          return false
        },
        pointerup(e: PointerEvent, view: EditorView): boolean {
          const a = enumArm
          enumArm = null
          if (a === null || e.pointerId !== a.pointerId || drag.active) return false
          const dx = e.clientX - a.x
          const dy = e.clientY - a.y
          if (dx * dx + dy * dy > ENUM_TAP_SLOP_SQ) return false // traveled: not a tap
          try {
            const edit = cycleEnumEdit(view.state.doc.toString(), a.pos)
            if (edit === null) return false
            buzz()
            view.dispatch({ changes: edit })
            hooks.requestEval(false)
            return true
          } catch {
            return false
          }
        },
        pointercancel(): boolean {
          enumArm = null
          return false
        },
      },
    },
  )
  return [plugin, blockWidgetField(hooks, drag, scan)]
}

