/* Wavetable widgets — seeing (and drawing) the morph.
 *
 * Two widgets, one module:
 *
 * v1 RIBBON (visualize): under any synth-body line calling `wavetable`, the
 * table's frames render stacked front-to-back on a canvas, and a bright
 * "current" wave rides through the stack: parked at `pos` when pos is a
 * literal number, swept 0→1 over each of the enclosing synth's notes when it
 * plays. When pos is an arbitrary signal (an envelope binding, an lfo) the
 * sweep-on-notes is an HONEST APPROXIMATION — we render the note's time
 * axis, not the signal's actual value (which only the audio thread knows).
 *
 * v2 EDITOR (author): on a `wavedef NAME p p / p p` line the ribbon becomes
 * a touch editor — tap a frame to select it, the selected frame expands to
 * vertical partial bars (one per harmonic), dragging a bar LIVE-REWRITES that
 * number in the source (LiveWriter, write-verify — audible mid-gesture), [+]
 * appends a 0 partial and [x] removes the last one (line-length-changing
 * writes are deferred to gesture end per the widget rules). Every edit is a
 * doc rewrite: the text stays the whole truth, and undo/redo work for free.
 *
 * The editor is a BLOCK widget below its wavedef line (wavedefBlockDecos,
 * served by a StateField in widgets.ts — CodeMirror forbids block decorations
 * from view plugins). It used to be an inline widget after the line's text,
 * and every live rewrite that changed a number's LENGTH ('.3' → '0.55')
 * reflowed the line and shifted the editor under the pointer — the shipped
 * "position keeps glitching / drags feel broken" bug. A block widget cannot
 * move when its line's text reflows; belt-and-braces, the drag also
 * re-measures the bar's rect per move and re-scans its source ranges at
 * gesture start (rescanWavedef) instead of trusting build-time offsets.
 *
 * All scanning/geometry lives in PURE exported functions (unit tested); the
 * widget classes keep only DOM + gesture glue and obey ./gesture's protocol.
 */

import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import { formatNumber } from '../widgets/rewrite'
import { LiveWriter, attachGesture, verifiedChanges } from './gesture'
import type { Drag } from './gesture'
import { buzz } from './widgets'
import type { Hooks } from './widgets'
import { inkOf, paintOnAttach } from './paint'

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

/** Partial cap per frame. MUST equal the engine's WAVETABLE_MAX_PARTIALS —
 *  pinned by a test — but duplicated here because this module must not
 *  STATICALLY import @rondocode/engine: widgets.ts is in the docs page's
 *  eager graph, and the audio engine only loads there on the first play
 *  (the code-splitting boundary in eager-graph.test.ts). Engine-backed bank
 *  lookups arrive via the injectable Hooks.wavetableBank instead. */
export const MAX_PARTIALS = 32

/* ------------------------------- scanning --------------------------------- */

const NUM_RE = /-?\d*\.?\d+/y

/** Strip a rondo ` # comment` (line start or whitespace-preceded '#'). */
const stripComment = (raw: string): string => {
  const cm = /(^|\s)#/.exec(raw)
  return cm ? raw.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : raw
}

export interface WavedefScan {
  name: string
  /** frame partial values, frames[f][i] = harmonic i+1. */
  frames: number[][]
  /** absolute [from, to) source range of each number token, per frame. */
  ranges: { from: number; to: number }[][]
  /** absolute end of the line's code part — where the widget anchors. */
  at: number
}

/** Find every top-level `wavedef NAME nums / nums …` line whose body is pure
 *  number/'/' tokens (the editable case). Pure — unit tested. */
export function scanWavedefs(text: string): WavedefScan[] {
  const out: WavedefScan[] = []
  let off = 0
  for (const raw of text.split('\n')) {
    const line = stripComment(raw)
    const m = /^wavedef[ \t]+([a-zA-Z_]\w*)[ \t]+/.exec(line)
    if (m !== null) {
      const body = line.slice(m[0].length).replace(/[ \t]+$/, '')
      const bodyOff = off + m[0].length
      const frames: number[][] = [[]]
      const ranges: { from: number; to: number }[][] = [[]]
      let okLine = body.length > 0
      const tok = /[^ \t]+/g
      let t: RegExpExecArray | null
      while (okLine && (t = tok.exec(body)) !== null) {
        if (t[0] === '/') {
          if (frames[frames.length - 1]!.length === 0) { okLine = false; break }
          frames.push([])
          ranges.push([])
          continue
        }
        NUM_RE.lastIndex = 0
        const isNum = NUM_RE.test(t[0]) && NUM_RE.lastIndex === t[0].length
        const v = Number(t[0])
        if (!isNum || !Number.isFinite(v)) { okLine = false; break }
        if (frames[frames.length - 1]!.length >= MAX_PARTIALS) { okLine = false; break }
        frames[frames.length - 1]!.push(v)
        ranges[ranges.length - 1]!.push({ from: bodyOff + t.index, to: bodyOff + t.index + t[0].length })
      }
      if (okLine && frames.every((f) => f.length > 0)) {
        out.push({ name: m[1]!, frames, ranges, at: bodyOff + body.length })
      }
    }
    off += raw.length + 1
  }
  return out
}

export interface WavetableCallScan {
  /** the enclosing `synth NAME` block (note events route by this). */
  synth?: string
  /** table name (default 'basic'). */
  table: string
  /** pos when it is statically a literal number in the SIMPLE line shapes
   *  (`wavetable note .3`, `wavetable`, `wavetable 220 .5`); undefined when
   *  pos is a binding/signal or the line is too rich to read positionally. */
  posLiteral?: number
  /** warp mode when the line carries a KNOWN `warp:` word — the ribbon then
   *  renders every frame through the kernel's phase map. */
  warp?: WarpMode
  /** warp amount: the `warpamt:` literal, else the kernel's 0.5 default
   *  (a signal-driven warpamt renders at the default — honest approximation,
   *  like the pos sweep). Only meaningful when `warp` is set. */
  warpAmt?: number
  /** absolute end of the line's code part — where the ribbon anchors. */
  at: number
}

/** Find synth-body lines whose head calls `wavetable` (spine lines and
 *  `name = wavetable …` bindings). Pure — unit tested. */
export function scanWavetableCalls(text: string): WavetableCallScan[] {
  const out: WavetableCallScan[] = []
  let off = 0
  let synth: string | undefined
  for (const raw of text.split('\n')) {
    const line = stripComment(raw)
    const header = /^(synth|play|beat|cps|js|bus|sing|section|song|sidechain|master|scaledef|wavedef|visual)\b(?:[ \t]+([a-zA-Z_]\w*))?/.exec(line)
    if (header !== null) synth = header[1] === 'synth' ? header[2] : undefined
    const m = /^[ \t]+(?:[a-zA-Z_]\w*[ \t]*=[ \t]*)?wavetable\b(.*)$/.exec(line)
    if (m !== null && synth !== undefined) {
      const args = m[1]!.replace(/[ \t]+$/, '')
      const table = /\btable:[ \t]*([a-zA-Z_]\w*)/.exec(args)?.[1] ?? 'basic'
      // warp args: a KNOWN warp word arms the phase-map rendering; amt is the
      // warpamt literal or the kernel's 0.5 default (signals sweep at runtime
      // — the ribbon shows the default, same honesty as the pos sweep)
      const warpWord = /\bwarp:[ \t]*([a-zA-Z_]\w*)/.exec(args)?.[1]
      const warp = warpWord !== undefined && isWarpMode(warpWord) ? warpWord : undefined
      const amtLit = /\bwarpamt:[ \t]*(-?\d*\.?\d+)/.exec(args)?.[1]
      // positional args: named `k:v` pairs removed; only SIMPLE atom lists
      // (numbers/idents) are read — anything richer leaves pos "a signal"
      const positional = args.replace(/[a-zA-Z_]\w*[ \t]*:[ \t]*\S+/g, ' ').trim()
      const scan: WavetableCallScan = { table, at: off + line.replace(/[ \t]+$/, '').length }
      scan.synth = synth
      if (warp !== undefined) {
        scan.warp = warp
        scan.warpAmt = amtLit !== undefined ? clamp(Number(amtLit), 0, 1) : 0.5
      }
      if (positional === '') {
        scan.posLiteral = 0 // bare `wavetable` — pos defaults to 0
      } else {
        const toks = positional.split(/[ \t]+/)
        const simple = toks.every((tk) => /^(-?\d*\.?\d+|[a-zA-Z_]\w*)$/.test(tk))
        if (simple && toks.length === 1) scan.posLiteral = 0 // freq only
        else if (simple && toks.length === 2 && /^-?\d*\.?\d+$/.test(toks[1]!)) {
          scan.posLiteral = clamp(Number(toks[1]!), 0, 1)
        }
        // else: pos is a binding/signal (or the line is rich) — sweep on notes
      }
      out.push(scan)
    }
    off += raw.length + 1
  }
  return out
}

/* ------------------------------- geometry --------------------------------- */

/** Partial-bar layout: aim for 44px touch columns, floor 20px; when even the
 *  floor overflows the viewport width, the strip scrolls. Pure. */
export function barLayout(count: number, width: number): { barW: number; totalW: number; scroll: boolean } {
  const fit = Math.floor(width / Math.max(count, 1))
  const barW = Math.max(20, Math.min(44, fit))
  const totalW = barW * count
  return { barW, totalW, scroll: totalW > width }
}

/** Map a pointer's y inside a bar column to an amplitude 0..1 (top = 1),
 *  snapped to 2 decimals so the written numbers stay tidy. Pure. */
export function barValue(y: number, top: number, height: number): number {
  const v = clamp((top + height - y) / Math.max(height, 1), 0, 1)
  return Math.round(v * 100) / 100
}

/** The doc edit appending a 0-amplitude partial to frame `f` (or null when
 *  the frame is already at the partial cap). Pure. */
/** What separates two partials in the source. rondo writes them space-joined
 *  (`1 .5 .3`), JavaScript as array elements (`[1, 0.5, 0.3]`). This is the
 *  ONLY syntax the bar editor emits — removePartialEdit spans from the end of
 *  the previous number to the end of the last, so it swallows either
 *  separator without being told which. */
export interface WavedefDialect {
  /** inserted before a new partial's value. */
  sep: string
  /** re-find the table in the CURRENT doc (the language's own scanner). */
  scan: (text: string) => WavedefScan[]
}

export const RONDO_WAVEDEF: WavedefDialect = { sep: ' ', scan: scanWavedefs }

export function appendPartialEdit(
  scan: WavedefScan,
  f: number,
  dialect: WavedefDialect = RONDO_WAVEDEF,
): { from: number; to: number; insert: string } | null {
  const frame = scan.ranges[f]
  if (frame === undefined || frame.length >= MAX_PARTIALS) return null
  const last = frame[frame.length - 1]!
  return { from: last.to, to: last.to, insert: `${dialect.sep}0` }
}

/** The doc edit removing frame `f`'s LAST partial (null when it is the only
 *  one — a frame can never be emptied from the widget). Pure. */
export function removePartialEdit(scan: WavedefScan, f: number): { from: number; to: number; insert: string } | null {
  const frame = scan.ranges[f]
  if (frame === undefined || frame.length < 2) return null
  const prev = frame[frame.length - 2]!
  const last = frame[frame.length - 1]!
  return { from: prev.to, to: last.to, insert: '' }
}

/** Re-find this widget's wavedef in the CURRENT doc at gesture time. The
 *  widget's DOM survives edits that don't change its name/values/width (see
 *  WavedefWidget.eq), so build-time ranges can be stale — a gesture must
 *  derive its write ranges from a fresh scan, never from the captured one.
 *  Matched by name AND exact current values: a rename, a mid-flight value
 *  edit, or a same-name doppelganger all return null (the gesture aborts
 *  instead of writing through the wrong line). Pure. */
export function rescanWavedef(
  text: string,
  name: string,
  values: readonly (readonly number[])[],
  dialect: WavedefDialect = RONDO_WAVEDEF,
): WavedefScan | null {
  for (const d of dialect.scan(text)) {
    if (d.name !== name) continue
    const same = d.frames.length === values.length &&
      d.frames.every((f, fi) => f.length === values[fi]!.length && f.every((v, i) => v === values[fi]![i]))
    if (same) return d
  }
  return null
}

/* ------------------------------ waveform math ------------------------------ */

/** Warp modes — MUST match the engine's WAVETABLE_WARPS (pinned by test;
 *  duplicated here for the same no-static-engine-import reason as
 *  MAX_PARTIALS above). */
export const WARP_MODES = ['sync', 'bend', 'mirror'] as const
export type WarpMode = (typeof WARP_MODES)[number]

const isWarpMode = (w: string): w is WarpMode => (WARP_MODES as readonly string[]).includes(w)

/** The kernel's phase-transfer curve at phase `p` (0..1) — the EXACT math
 *  WavetableKernel applies before its table read (sync re-runs the cycle
 *  (1+3*amt)x faster and wraps; bend bows p^(1+3*amt); mirror blends toward
 *  the reflected ramp). ribbon-warp.test.ts pins this against the kernel's
 *  actual output, so the drawn warp cannot drift from the heard one. Pure. */
export function warpPhase(warp: WarpMode, amt: number, p: number): number {
  const a = clamp(Number.isFinite(amt) ? amt : 0, 0, 1)
  if (a === 0) return p
  if (warp === 'sync') {
    const w = p * (1 + 3 * a)
    return w - Math.floor(w)
  }
  if (warp === 'bend') return Math.pow(p, 1 + 3 * a)
  const refl = 1 - Math.abs(2 * p - 1)
  return p + a * (refl - p)
}

/** A single-cycle preview wave read through the warp's phase map (linear
 *  interpolation, wrapping — the same read the kernel performs). Because a
 *  phase remap commutes with the samplewise morph blend, warping each frame
 *  and then morphing equals the kernel's warp of the morphed read. Pure. */
export function warpWave(wave: Float32Array, warp: WarpMode, amt: number): Float32Array {
  const n = wave.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const ph = warpPhase(warp, amt, i / n)
    const posf = ph * n
    const i0 = Math.floor(posf) % n
    const i1 = (i0 + 1) % n
    const frac = posf - Math.floor(posf)
    out[i] = wave[i0]! + frac * (wave[i1]! - wave[i0]!)
  }
  return out
}

/** Additive preview of a partial frame: sum of sin(2π·h·t) at `points`
 *  samples, peak-normalized (matches the engine's per-frame normalization
 *  closely enough for display). Pure. */
export function partialWave(partials: readonly number[], points = 96): Float32Array {
  const out = new Float32Array(points)
  let peak = 0
  for (let i = 0; i < points; i++) {
    let s = 0
    for (let h = 1; h <= partials.length; h++) {
      s += partials[h - 1]! * Math.sin((2 * Math.PI * h * i) / points)
    }
    out[i] = s
    const a = Math.abs(s)
    if (a > peak) peak = a
  }
  if (peak > 0) for (let i = 0; i < points; i++) out[i] = out[i]! / peak
  return out
}

/** Downsample a single-cycle frame to `points` samples (nearest). Pure. */
export function downsampleWave(frame: Float32Array, points = 96): Float32Array {
  const out = new Float32Array(points)
  for (let i = 0; i < points; i++) out[i] = frame[Math.floor((i * frame.length) / points)]!
  return out
}

/** Sample-wise linear morph between adjacent preview frames at t (0..1). */
export function morphWave(frames: readonly Float32Array[], t: number): Float32Array {
  const last = frames.length - 1
  const fp = clamp(t, 0, 1) * last
  const f0 = Math.min(Math.floor(fp), last)
  const f1 = Math.min(f0 + 1, last)
  const frac = fp - f0
  const a = frames[f0]!
  const b = frames[f1]!
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + frac * (b[i]! - a[i]!)
  return out
}

/** Preview waveforms for `table`: the doc's own wavedef lines FIRST (fresh
 *  while typing, before any eval), then `bank` — the injected engine lookup
 *  (built-ins + the last successful eval's registry; see Hooks.wavetableBank).
 *  Null when the name resolves nowhere. */
export function previewFrames(
  table: string,
  docDefs: readonly WavedefScan[],
  bank?: (name: string) => Float32Array[][] | undefined,
  points = 96,
): Float32Array[] | null {
  const def = docDefs.find((d) => d.name === table)
  if (def !== undefined) return def.frames.map((f) => partialWave(f, points))
  const mips = bank?.(table)
  if (mips !== undefined) return mips.map((m) => downsampleWave(m[0]!, points))
  return null
}

/* ------------------------------- rendering -------------------------------- */

/** Stacked-frame ribbon geometry: frame i draws in a wave box offset along
 *  the stack diagonal; t (0..1) rides the same diagonal. */
const RIBBON = { w: 200, h: 56, waveW: 132, waveH: 26, pad: 4 }

const drawWave = (
  g: CanvasRenderingContext2D,
  wave: Float32Array,
  x0: number,
  yMid: number,
  w: number,
  h: number,
): void => {
  g.beginPath()
  for (let i = 0; i < wave.length; i++) {
    const x = x0 + (i / (wave.length - 1)) * w
    const y = yMid - wave[i]! * (h / 2)
    if (i === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  }
  g.stroke()
}

/** Draw the full ribbon: dim stacked frames back-to-front, then (when t is
 *  given) the bright interpolated wave riding the diagonal at t. */
const drawRibbon = (
  canvas: HTMLCanvasElement,
  frames: readonly Float32Array[],
  t: number | undefined,
): void => {
  const g = canvas.getContext('2d')
  if (g === null) return
  const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio ?? 1))
  if (canvas.width !== RIBBON.w * dpr) {
    canvas.width = RIBBON.w * dpr
    canvas.height = RIBBON.h * dpr
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, RIBBON.w, RIBBON.h)
  const color = inkOf(canvas)
  const last = Math.max(frames.length - 1, 1)
  const dx = (RIBBON.w - RIBBON.waveW - 2 * RIBBON.pad) / last
  const dy = (RIBBON.h - RIBBON.waveH - 2 * RIBBON.pad) / last
  g.lineWidth = 1.1
  g.strokeStyle = color
  // back of the stack = the LAST frame (up-right); front = frame 0
  for (let i = frames.length - 1; i >= 0; i--) {
    const x0 = RIBBON.pad + dx * i
    const yMid = RIBBON.h - RIBBON.pad - RIBBON.waveH / 2 - dy * i
    g.globalAlpha = 0.28 + 0.14 * (1 - i / Math.max(frames.length - 1, 1))
    drawWave(g, frames[i]!, x0, yMid, RIBBON.waveW, RIBBON.waveH)
  }
  if (t !== undefined && frames.length > 0) {
    const wave = morphWave(frames, t)
    const x0 = RIBBON.pad + dx * t * (frames.length - 1)
    const yMid = RIBBON.h - RIBBON.pad - RIBBON.waveH / 2 - dy * t * (frames.length - 1)
    g.globalAlpha = 1
    g.lineWidth = 1.6
    drawWave(g, wave, x0, yMid, RIBBON.waveW, RIBBON.waveH)
  }
  g.globalAlpha = 1
}

/* ------------------------------ v1: the ribbon ----------------------------- */

const MAX_PENDING = 64

/** Tiny audio-clock-aligned timer pool (mirrors widgets.ts's Timers; kept
 *  local so this module's import of ./widgets stays function-level only). */
class Pending {
  private readonly set = new Set<ReturnType<typeof setTimeout>>()
  at(delayMs: number, fn: () => void): void {
    if (this.set.size >= MAX_PENDING) return
    const h = setTimeout(() => { this.set.delete(h); fn() }, Math.max(0, delayMs))
    this.set.add(h)
  }
  clear(): void {
    for (const h of this.set) clearTimeout(h)
    this.set.clear()
  }
}

export class WavetableRibbonWidget extends WidgetType {
  private unsub?: () => void
  private raf = 0
  private readonly timers = new Pending()

  constructor(
    readonly table: string,
    readonly posLiteral: number | undefined,
    readonly synth: string | undefined,
    /** identity of the frame CONTENT (table name + doc wavedef values), so a
     *  partial edit rebuilds the DOM with fresh waves. */
    readonly framesKey: string,
    readonly frames: readonly Float32Array[],
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  override eq(o: WavetableRibbonWidget): boolean {
    return o.table === this.table && o.posLiteral === this.posLiteral &&
      o.synth === this.synth && o.framesKey === this.framesKey
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'rondo-wt'
    wrap.setAttribute('role', 'img')
    wrap.setAttribute('aria-label', `wavetable '${this.table}' morph preview`)
    wrap.title = this.posLiteral !== undefined
      ? `wavetable '${this.table}' — cursor parked at pos ${this.posLiteral}`
      : `wavetable '${this.table}' — cursor sweeps the morph on each note`
    const canvas = document.createElement('canvas')
    canvas.className = 'wt-canvas'
    canvas.style.width = `${RIBBON.w}px`
    canvas.style.height = `${RIBBON.h}px`
    wrap.appendChild(canvas)
    const idle = (): void => drawRibbon(canvas, this.frames, this.posLiteral)
    // detached at toDOM time, so the first paint would be black — see paint.ts
    paintOnAttach(idle)

    // LIVE SCAN CURSOR: each of this synth's notes sweeps the bright morph
    // wave across the stack over the note's duration. For a literal pos the
    // idle state parks the cursor there; for a signal-driven pos this sweep
    // is the whole story (honest approximation — see module doc).
    if (this.hooks.onNoteEvents && this.hooks.now) {
      const now = this.hooks.now
      const sweep = (durSec: number): void => {
        cancelAnimationFrame(this.raf)
        const total = clamp(durSec, 0.1, 4) * 1000
        const t0 = performance.now()
        const frame = (nowMs: number): void => {
          const u = (nowMs - t0) / total
          if (u >= 1) {
            this.raf = 0
            idle()
            return
          }
          drawRibbon(canvas, this.frames, u)
          this.raf = requestAnimationFrame(frame)
        }
        this.raf = requestAnimationFrame(frame)
      }
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          if (this.synth !== undefined && ev.sound !== this.synth) continue
          this.timers.at((ev.timeSec - now()) * 1000, () => sweep(ev.durSec))
          break // one sweep per batch — the cursor is monophonic
        }
      }, wrap)
    }
    return wrap
  }

  override destroy(): void {
    this.unsub?.()
    this.timers.clear()
    cancelAnimationFrame(this.raf)
  }

  override ignoreEvent(): boolean { return true }
}

/* ------------------------------ v2: the editor ----------------------------- */

/** Selected frame per (editor view, table name): widget instances die on
 *  every rebuild, so the selection lives outside them. */
const selections = new WeakMap<EditorView, Map<string, number>>()

const selFor = (view: EditorView, name: string, max: number): number => {
  const m = selections.get(view)
  const sel = m?.get(name) ?? 0
  return clamp(sel, 0, max)
}

const setSel = (view: EditorView, name: string, f: number): void => {
  let m = selections.get(view)
  if (m === undefined) {
    m = new Map()
    selections.set(view, m)
  }
  m.set(name, f)
}

const THUMB = { w: 46, h: 30 }

export class WavedefWidget extends WidgetType {
  constructor(
    readonly scan: WavedefScan,
    /** available content width, measured by the width watcher — part of
     *  eq(), so a resize/rotation produces a FRESH DOM with fresh geometry. */
    readonly width: number,
    readonly hooks: Hooks,
    readonly drag: Drag,
    /** the source dialect this table is written in (see WavedefDialect).
     *  LAST and defaulted: the widget reads identically in both languages, so
     *  only the write path needs telling. */
    readonly dialect: WavedefDialect = RONDO_WAVEDEF,
  ) { super() }

  override eq(o: WavedefWidget): boolean {
    // deliberately OFFSET-FREE: edits elsewhere in the doc shift scan.at and
    // every range, but the editor's CONTENT is unchanged — keep the DOM (no
    // flicker, no canvas redraws). Gestures never trust the captured ranges
    // anyway: they re-scan the current doc when they begin (rescanWavedef).
    return o.width === this.width && o.scan.name === this.scan.name &&
      JSON.stringify(o.scan.frames) === JSON.stringify(this.scan.frames)
  }

  override get estimatedHeight(): number {
    // padding + thumbnails row + gap + bars strip (see rondo-ui.css) — keeps
    // the first layout pass close so the rebuild after a gesture cannot make
    // the viewport jump
    return 10 + (THUMB.h + 6) + 4 + 96
  }

  override toDOM(view: EditorView): HTMLElement {
    const scan = this.scan
    const wrap = document.createElement('div')
    wrap.className = 'rondo-wavedef'
    wrap.style.width = `${this.width}px`
    wrap.setAttribute('role', 'group')
    wrap.setAttribute('aria-label', `wavetable '${scan.name}' editor: tap a frame, drag the partial bars`)

    // ---- frame thumbnails (tap to select) --------------------------------
    const thumbs = document.createElement('span')
    thumbs.className = 'wd-frames'
    const thumbCanvases: HTMLCanvasElement[] = []
    for (let f = 0; f < scan.frames.length; f++) {
      const th = document.createElement('span')
      th.className = 'wd-frame'
      th.dataset['f'] = String(f)
      const c = document.createElement('canvas')
      c.style.width = `${THUMB.w}px`
      c.style.height = `${THUMB.h}px`
      th.appendChild(c)
      const lbl = document.createElement('span')
      lbl.className = 'wd-flabel'
      lbl.textContent = String(f + 1)
      th.appendChild(lbl)
      thumbs.appendChild(th)
      thumbCanvases.push(c)
    }
    wrap.appendChild(thumbs)

    const drawThumb = (f: number, values: readonly number[]): void => {
      const c = thumbCanvases[f]!
      const g = c.getContext('2d')
      if (g === null) return
      const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio ?? 1))
      if (c.width !== THUMB.w * dpr) { c.width = THUMB.w * dpr; c.height = THUMB.h * dpr }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, THUMB.w, THUMB.h)
      g.strokeStyle = inkOf(c)
      g.lineWidth = 1.2
      drawWave(g, partialWave(values, 64), 2, THUMB.h / 2, THUMB.w - 4, THUMB.h - 6)
    }

    // ---- partial bars for the selected frame ------------------------------
    const strip = document.createElement('span')
    strip.className = 'wd-bars-strip'
    const bars = document.createElement('span')
    bars.className = 'wd-bars'
    strip.appendChild(bars)
    wrap.appendChild(strip)

    // live-edited copy of the frame values (the doc is rewritten in step)
    const values = scan.frames.map((f) => [...f])
    let sel = selFor(view, scan.name, scan.frames.length - 1)

    const renderBars = (): void => {
      bars.replaceChildren()
      const frame = values[sel]!
      // +1: the +/x rail; -12: the wrap's padding/border (box-sizing border-box)
      const layout = barLayout(frame.length + 1, this.width - 12)
      bars.style.setProperty('--wd-bar-w', `${layout.barW}px`)
      for (let i = 0; i < frame.length; i++) {
        const col = document.createElement('span')
        col.className = 'wd-bar'
        col.dataset['i'] = String(i)
        const fill = document.createElement('span')
        fill.className = 'wd-fill'
        fill.style.height = `${clamp(frame[i]!, 0, 1) * 100}%`
        col.appendChild(fill)
        const hn = document.createElement('span')
        hn.className = 'wd-h'
        hn.textContent = String(i + 1)
        col.appendChild(hn)
        bars.appendChild(col)
      }
      // the +/x rail: append a 0 partial, drop the last one
      const rail = document.createElement('span')
      rail.className = 'wd-rail'
      const add = document.createElement('span')
      add.className = 'wd-add'
      add.textContent = '+'
      add.title = 'add a partial (0)'
      rail.appendChild(add)
      const del = document.createElement('span')
      del.className = 'wd-del'
      del.textContent = '×'
      del.title = 'remove the last partial'
      if (frame.length < 2) del.classList.add('off')
      rail.appendChild(del)
      bars.appendChild(rail)
    }

    const select = (f: number): void => {
      sel = clamp(f, 0, scan.frames.length - 1)
      setSel(view, scan.name, sel)
      for (let i = 0; i < thumbs.children.length; i++) {
        thumbs.children[i]!.classList.toggle('sel', i === sel)
      }
      renderBars()
    }
    for (let f = 0; f < scan.frames.length; f++) drawThumb(f, values[f]!)
    select(sel)

    // frame taps: a gesture that acts on END (release on the same thumb)
    attachGesture(thumbs, this.drag, 'element', (e) => {
      const th = (e.target as HTMLElement).closest?.('.wd-frame') as HTMLElement | null
      if (!th) return null
      return {
        onEnd: () => {
          buzz()
          select(Number(th.dataset['f']))
        },
      }
    })

    // bar drags: LIVE rewrite of that one number (LiveWriter, write-verify),
    // audible mid-gesture (per-block bank re-resolution picks the new value
    // up on the next eval). The value text's LENGTH may change mid-drag
    // ('.5' → '0.55') — safe now that the widget is a BLOCK below the line:
    // the reflow cannot shift the bars under the pointer. Write ranges come
    // from a FRESH scan at gesture start (the DOM may have outlived edits
    // elsewhere — see eq()); the bar rect is re-measured per move so even a
    // legitimate reflow (the line growing a wrap row) keeps the mapping true.
    attachGesture(bars, this.drag, 'window', (e) => {
      const target = e.target as HTMLElement
      const addEl = target.closest?.('.wd-add') as HTMLElement | null
      const delEl = target.closest?.('.wd-del') as HTMLElement | null
      if (addEl !== null || delEl !== null) {
        // [+]/[x] change the LINE LENGTH structurally → deferred to gesture
        // end (the beat-grid rule), and derived from the doc AS IT IS THEN
        return {
          onEnd: () => {
            const cur = rescanWavedef(view.state.doc.toString(), scan.name, values, this.dialect)
            if (cur === null) return // renamed/edited under us: refuse quietly
            const edit = addEl !== null ? appendPartialEdit(cur, sel, this.dialect) : removePartialEdit(cur, sel)
            if (edit === null) return
            buzz()
            this.drag.ended = true
            const ok = verifiedChanges(view, [{
              from: edit.from, to: edit.to,
              expected: view.state.doc.sliceString(edit.from, edit.to),
              insert: edit.insert,
            }])
            if (!ok) { view.dispatch({}); return }
            this.hooks.requestEval(false)
          },
        }
      }
      const col = target.closest?.('.wd-bar') as HTMLElement | null
      if (!col) return null
      const startI = Number(col.dataset['i'])
      const cur = rescanWavedef(view.state.doc.toString(), scan.name, values, this.dialect)
      const range = cur?.ranges[sel]?.[startI]
      if (range === undefined) return null
      buzz()
      wrap.classList.add('active')
      // PAINT ACROSS. The bar is re-hit-tested on every move rather than
      // captured at pointerdown: a table is a CURVE, and setting eight
      // partials as eight separate press-drag-release gestures is what made
      // this feel like eight controls instead of one instrument.
      let bar = col
      let i = startI
      let writer = new LiveWriter(view, range.from, range.to)
      let fill = col.querySelector('.wd-fill') as HTMLElement

      /** Move the gesture onto `next`. The ranges must be RESCANNED, not
       *  reused: the bars already painted were rewritten to different widths
       *  (`0.5` -> `1`), which shifts every offset after them. */
      const retarget = (next: HTMLElement): void => {
        const ni = Number(next.dataset['i'])
        if (!Number.isFinite(ni) || ni === i) return
        const re = rescanWavedef(view.state.doc.toString(), scan.name, values, this.dialect)
        const r = re?.ranges[sel]?.[ni]
        if (r === undefined) return // the doc moved under us: stay where we are
        bar = next
        i = ni
        writer = new LiveWriter(view, r.from, r.to)
        fill = next.querySelector('.wd-fill') as HTMLElement
      }

      const apply = (ev: PointerEvent): void => {
        // pointer capture keeps events coming to the ORIGINAL element, so the
        // bar under the finger has to be found by coordinate
        const under = document.elementFromPoint(ev.clientX, ev.clientY)
        const hit = (under as HTMLElement | null)?.closest?.('.wd-bar') as HTMLElement | null
        if (hit !== null && hit !== bar && wrap.contains(hit)) retarget(hit)
        const rect = bar.getBoundingClientRect() // fresh: reflow-proof mapping
        const v = barValue(ev.clientY, rect.top, rect.height)
        if (values[sel]![i] === v) return
        // write FIRST, sync the local copy only on success: an aborted writer
        // (external edit) must not leave `values` disagreeing with the doc —
        // rescanWavedef matches by values, and a drifted copy would quietly
        // refuse every later gesture on this surviving DOM
        if (!writer.write(formatNumber(v, { step: 0.01, min: 0 }))) return
        values[sel]![i] = v
        fill.style.height = `${v * 100}%`
        drawThumb(sel, values[sel]!)
        this.hooks.requestEval(false)
      }
      apply(e)
      return {
        onMove: apply,
        onEnd: () => {
          this.drag.ended = true
          wrap.classList.remove('active')
          view.dispatch({}) // empty transaction → ONE rebuild (fresh ranges)
          this.hooks.requestEval(false)
        },
      }
    })
    return wrap
  }

  override ignoreEvent(): boolean { return true }
}

/** BLOCK decorations for every editable wavedef line: the editor renders as
 *  its own block BELOW the line (side 1 at the line end), so live rewrites
 *  that change the line's text length can never shift it under the pointer.
 *  Block decorations may not come from a view plugin (CodeMirror forbids
 *  layout-affecting plugin decorations) — widgets.ts serves these from a
 *  StateField. Exported for that field and for the contract tests. */
export function wavedefBlockDecos(
  text: string,
  width: number,
  hooks: Hooks,
  drag: Drag,
  dialect: WavedefDialect = RONDO_WAVEDEF,
): Range<Decoration>[] {
  return dialect.scan(text).map((wd) => {
    const nl = text.indexOf('\n', wd.at)
    const lineEnd = nl === -1 ? text.length : nl
    return Decoration.widget({
      widget: new WavedefWidget(wd, width, hooks, drag, dialect),
      side: 1,
      block: true,
    }).range(lineEnd)
  })
}
