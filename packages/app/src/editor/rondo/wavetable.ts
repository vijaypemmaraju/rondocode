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
 * vertical partial bars (one per harmonic), dragging a bar REWRITES that
 * number in the source (LiveWriter, write-verify), [+] appends a 0 partial
 * and [x] removes the last one (line-length-changing writes are deferred to
 * gesture end per the widget rules). Every edit is a doc rewrite: the text
 * stays the whole truth, and undo/redo work for free.
 *
 * All scanning/geometry lives in PURE exported functions (unit tested); the
 * widget classes keep only DOM + gesture glue and obey ./gesture's protocol.
 */

import { EditorView, WidgetType } from '@codemirror/view'
import { getWavetableBank, WAVETABLE_MAX_PARTIALS } from '@rondocode/engine'
import { formatNumber } from '../widgets/rewrite'
import { LiveWriter, attachGesture, verifiedChanges } from './gesture'
import type { Drag } from './gesture'
import { buzz } from './widgets'
import type { Hooks } from './widgets'

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

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
        if (frames[frames.length - 1]!.length >= WAVETABLE_MAX_PARTIALS) { okLine = false; break }
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
      // positional args: named `k:v` pairs removed; only SIMPLE atom lists
      // (numbers/idents) are read — anything richer leaves pos "a signal"
      const positional = args.replace(/[a-zA-Z_]\w*[ \t]*:[ \t]*\S+/g, ' ').trim()
      const scan: WavetableCallScan = { table, at: off + line.replace(/[ \t]+$/, '').length }
      scan.synth = synth
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
export function appendPartialEdit(scan: WavedefScan, f: number): { from: number; to: number; insert: string } | null {
  const frame = scan.ranges[f]
  if (frame === undefined || frame.length >= WAVETABLE_MAX_PARTIALS) return null
  const last = frame[frame.length - 1]!
  return { from: last.to, to: last.to, insert: ' 0' }
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

/* ------------------------------ waveform math ------------------------------ */

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
 *  while typing, before any eval), then the engine bank (built-ins + the
 *  last successful eval's registry). Null when the name resolves nowhere. */
export function previewFrames(table: string, docDefs: readonly WavedefScan[], points = 96): Float32Array[] | null {
  const def = docDefs.find((d) => d.name === table)
  if (def !== undefined) return def.frames.map((f) => partialWave(f, points))
  const bank = getWavetableBank(table)
  if (bank !== undefined) return bank.map((mips) => downsampleWave(mips[0]!, points))
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
  const color = getComputedStyle(canvas).color
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
    idle()

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
      })
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
    /** available content width, measured by build() — part of eq(). */
    readonly width: number,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  override eq(o: WavedefWidget): boolean {
    return o.width === this.width && o.scan.name === this.scan.name && o.scan.at === this.scan.at &&
      JSON.stringify(o.scan.frames) === JSON.stringify(this.scan.frames) &&
      JSON.stringify(o.scan.ranges) === JSON.stringify(this.scan.ranges)
  }

  override toDOM(view: EditorView): HTMLElement {
    const scan = this.scan
    const wrap = document.createElement('span')
    wrap.className = 'rondo-wavedef'
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
      g.strokeStyle = getComputedStyle(c).color
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
      const layout = barLayout(frame.length + 1, this.width) // +1: the +/x rail
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

    // bar drags: LIVE rewrite of that one number (LiveWriter, write-verify).
    // The value text's LENGTH may change mid-drag ('.5' → '0.55') — that is
    // safe here exactly like the knob: only this number is written, the
    // decoration plugin maps ranges through our own edits while drag.active,
    // and ONE rebuild at gesture end refreshes every stale range.
    attachGesture(bars, this.drag, 'window', (e) => {
      const target = e.target as HTMLElement
      const addEl = target.closest?.('.wd-add') as HTMLElement | null
      const delEl = target.closest?.('.wd-del') as HTMLElement | null
      if (addEl !== null || delEl !== null) {
        // [+]/[x] change the LINE LENGTH → deferred to gesture end
        return {
          onEnd: () => {
            const edit = addEl !== null ? appendPartialEdit(scan, sel) : removePartialEdit(scan, sel)
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
      const i = Number(col.dataset['i'])
      const range = scan.ranges[sel]?.[i]
      if (range === undefined) return null
      buzz()
      wrap.classList.add('active')
      const rect = col.getBoundingClientRect()
      const writer = new LiveWriter(view, range.from, range.to)
      const fill = col.querySelector('.wd-fill') as HTMLElement
      const apply = (ev: PointerEvent): void => {
        const v = barValue(ev.clientY, rect.top, rect.height)
        if (values[sel]![i] === v) return
        values[sel]![i] = v
        if (!writer.write(formatNumber(v, { step: 0.01, min: 0 }))) return
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
          view.dispatch({}) // empty transaction → plugin rebuilds (fresh ranges)
          this.hooks.requestEval(false)
        },
      }
    })
    return wrap
  }

  override ignoreEvent(): boolean { return true }
}
