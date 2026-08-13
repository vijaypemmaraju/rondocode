import { WidgetType } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'
import { LiveWriter, attachGesture } from './gesture'
import type { Drag } from './gesture'

/* ------------------------------------------------------------------------- *
 * THE CURVE LANE: a drawn, draggable picture of `curve` automation.
 *
 * `curve` is the one automation source measured against the TRANSPORT rather
 * than per-cycle: `cutoff: curve 8 1 8 .35 400..7000` opens over eight bars,
 * eases back over eight, and then holds. Every other modulator here loops.
 *
 * It also had no picture. A filter sweep across a section was eight numbers in
 * a row, and the only way to see the shape was to play the section — which is
 * how it stayed invisible enough that I reported it as a MISSING FEATURE while
 * it was shipping. Every other shape in this editor is drawn: the ADSR, the
 * LFO, the filter response, the compressor transfer curve, the sidechain duck.
 * This was the automation lane, and it was the one you had to imagine.
 *
 * The scan and the geometry are pure so they can be tested without a DOM, and
 * so the drag has exactly one idea of where a breakpoint sits.
 * ------------------------------------------------------------------------- */

/** One breakpoint: a leg of `cycles` reaching `level`, with the char ranges of
 *  both numbers so a drag can rewrite the one it moved and nothing else. */
export interface CurvePoint {
  cycles: number
  level: number
  /** Per-leg easing from the `level:curve` form (`8 1:3`). */
  curve?: number
  /** Absolute char range of the cycles number. */
  tFrom: number
  tTo: number
  /** Absolute char range of the level number (excluding any `:curve`). */
  lFrom: number
  lTo: number
}

export interface CurveLane {
  /** The control being automated (`cutoff`), or undefined for a `curvedef`. */
  name?: string
  /** A `curvedef NAME` shape rather than a play-block modifier. */
  def?: string
  points: CurvePoint[]
  /** Sum of the legs: the lane's length in cycles. */
  cycles: number
  /** The `lo..hi` the 0..1 shape is mapped through, when written. */
  range?: [number, number]
  /** Where the widget hangs: the end of the line. */
  at: number
  /** The enclosing `synth NAME`, for routing live values. */
  synth?: string
}

const NUM = String.raw`-?\d*\.?\d+`

/**
 * Every `curve` lane in a rondo doc: `name: curve t l t l …` on a modifier
 * line, and `curvedef NAME t l t l …` at the top level.
 *
 * Pairs are eaten while they look like numbers, which is what the compiler
 * does, so the `lo..hi`, `slow:` and `fast:` suffixes are left alone. An ODD
 * number of them is half a breakpoint and yields no lane at all rather than a
 * lane that disagrees with the program.
 */
export function scanCurveLanes(text: string): CurveLane[] {
  const out: CurveLane[] = []
  let off = 0
  let synth: string | undefined
  for (const raw of text.split('\n')) {
    const cm = /(^|\s)#/.exec(raw)
    const line = cm === null ? raw : raw.slice(0, cm.index + (cm[1] ?? '').length)
    const header = /^(synth|play|beat|cps|js)\b(?:[ \t]+([a-zA-Z_]\w*))?/.exec(line)
    if (header !== null) synth = header[1] === 'synth' ? header[2] : undefined

    const m = /^\s*(?:([a-zA-Z_]\w*)\s*:\s*curve|curvedef\s+([a-zA-Z_]\w*))\s+/.exec(line)
    if (m === null) {
      off += raw.length + 1
      continue
    }
    const lane = readPairs(line, m[0].length, off)
    if (lane !== null) {
      const entry: CurveLane = {
        points: lane.points,
        cycles: lane.points.reduce((n, p) => n + p.cycles, 0),
        at: off + line.replace(/\s+$/, '').length,
      }
      if (m[1] !== undefined) entry.name = m[1]
      if (m[2] !== undefined) entry.def = m[2]
      if (lane.range !== undefined) entry.range = lane.range
      if (synth !== undefined) entry.synth = synth
      out.push(entry)
    }
    off += raw.length + 1
  }
  return out
}

/** Read `t l t l …` from `at`, then look for a `lo..hi` after them. */
function readPairs(
  line: string,
  at: number,
  off: number,
): { points: CurvePoint[]; range?: [number, number] } | null {
  /* WHOLE TOKENS, tested as a unit. Matching a number pattern inside the
   * token would eat the `400` of a `400..7000` range suffix and leave an odd
   * count, which threw the lane away — `cut: curve 8 1 8 .35 400..7000` found
   * nothing while the same line without a range worked. */
  const tok = /\S+/g
  tok.lastIndex = at
  const pair = new RegExp(String.raw`^(${NUM})(?::(${NUM}))?$`)
  const nums: { v: number; curve?: number; from: number; to: number }[] = []
  let rest = line.length
  let m: RegExpExecArray | null
  while ((m = tok.exec(line)) !== null) {
    const pm = pair.exec(m[0])
    if (pm === null) {
      rest = m.index
      break
    }
    const e: { v: number; curve?: number; from: number; to: number } = {
      v: Number(pm[1]),
      from: off + m.index,
      to: off + m.index + pm[1]!.length,
    }
    if (pm[2] !== undefined) e.curve = Number(pm[2])
    nums.push(e)
  }
  // an odd count is half a breakpoint: the compiler falls through to a
  // diagnostic there, and a picture of a program that will not run is worse
  // than no picture
  if (nums.length < 2 || nums.length % 2 !== 0) return null
  const points: CurvePoint[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const t = nums[i]!
    const l = nums[i + 1]!
    if (!Number.isFinite(t.v) || !Number.isFinite(l.v) || t.v < 0) return null
    const p: CurvePoint = { cycles: t.v, level: l.v, tFrom: t.from, tTo: t.to, lFrom: l.from, lTo: l.to }
    if (l.curve !== undefined) p.curve = l.curve
    points.push(p)
  }
  const rangeM = new RegExp(String.raw`(${NUM})\.\.(${NUM})`).exec(line.slice(rest))
  const range: [number, number] | undefined = rangeM !== null
    ? [Number(rangeM[1]), Number(rangeM[2])]
    : undefined
  return range === undefined ? { points } : { points, range }
}

/** Level of the lane at `cycle`, easing each leg the way `curve` does: 0 is
 *  linear, positive is fast-then-slow. Holds the last level past the end,
 *  which is the behaviour that makes this a lane and not an oscillator. */
export function curveLevelAt(points: readonly CurvePoint[], cycle: number, from = 0): number {
  let t = 0
  let prev = from
  for (const p of points) {
    if (cycle <= t + p.cycles) {
      if (p.cycles <= 0) return p.level
      const x = (cycle - t) / p.cycles
      const c = p.curve ?? 0
      const e = c === 0 ? x : (1 - Math.exp(-c * x)) / (1 - Math.exp(-c))
      return prev + (p.level - prev) * e
    }
    t += p.cycles
    prev = p.level
  }
  return prev
}

/**
 * The vertical extent the box shows.
 *
 * A RANGED lane is pinned to 0..1, because that is the shape the `lo..hi`
 * maps: it does not move when a level does. Deriving the axis from the current
 * levels instead makes the highest point pin itself to the top of the box —
 * so dragging it DOWN rescales the axis and the handle does not move, while
 * the number underneath changes. Reported exactly that way, and measured:
 * `curve 0 0.7 4 1 0..20000` held its handle at y=0 the whole way from 1 to
 * 0.7.
 *
 * An unranged lane has no declared extent, so it still has to be derived —
 * there the levels ARE the values and no fixed axis would be honest.
 */
export function curveAxis(
  points: readonly CurvePoint[],
  from: number,
  ranged: boolean,
): { lo: number; span: number } {
  if (ranged) return { lo: 0, span: 1 }
  const lo = Math.min(from, ...points.map((p) => p.level))
  const hi = Math.max(from, ...points.map((p) => p.level))
  return { lo, span: hi - lo || 1 }
}

/** An SVG polyline for the lane in a `w` by `h` box, sampled so an eased leg
 *  reads as a curve rather than a straight line between its ends. */
export function curveLanePath(
  points: readonly CurvePoint[],
  w: number,
  h: number,
  from = 0,
  ranged = false,
): string {
  const total = points.reduce((n, p) => n + p.cycles, 0)
  if (total <= 0 || points.length === 0) return `0,${h / 2} ${w},${h / 2}`
  const { lo, span } = curveAxis(points, from, ranged)
  const y = (v: number): number => h - ((v - lo) / span) * h
  const N = Math.max(24, Math.min(160, Math.round(w)))
  const out: string[] = []
  for (let i = 0; i <= N; i++) {
    const cyc = (i / N) * total
    out.push(`${((i / N) * w).toFixed(1)},${y(curveLevelAt(points, cyc, from)).toFixed(2)}`)
  }
  return out.join(' ')
}

/** Where each breakpoint sits in the box, for drawing handles and hit-testing
 *  a drag. x is the END of that leg. */
export function curveHandles(
  points: readonly CurvePoint[],
  w: number,
  h: number,
  from = 0,
  ranged = false,
): { x: number; y: number; i: number }[] {
  const total = points.reduce((n, p) => n + p.cycles, 0)
  if (total <= 0) return []
  const { lo, span } = curveAxis(points, from, ranged)
  const out: { x: number; y: number; i: number }[] = []
  let t = 0
  points.forEach((p, i) => {
    t += p.cycles
    out.push({ x: (t / total) * w, y: h - ((p.level - lo) / span) * h, i })
  })
  return out
}

/** Where a dragged level is allowed to land.
 *
 *  A lane written with a `lo..hi` range is a 0..1 SHAPE that gets mapped
 *  through it, so a drag past 1 asks for a cutoff above the top of its own
 *  range — measured: one drag upward wrote `1.192` into a `400..7000` lane.
 *  Without a range the levels ARE the values and clamping them would be the
 *  widget overruling the program. */
export function clampCurveLevel(v: number, hasRange: boolean): number {
  if (!hasRange) return v
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Format a number the way the source writes them: no trailing zeros, and a
 *  bare `.5` rather than `0.5`, so a drag does not reformat the line. */
export function fmtCurveNum(v: number, decimals = 3): string {
  const r = Number(v.toFixed(decimals))
  const s = String(r)
  return s.startsWith('0.') ? s.slice(1) : s.startsWith('-0.') ? `-${s.slice(2)}` : s
}

/** A single text edit: what to replace, and with what. */
export interface CurveEdit {
  from: number
  to: number
  insert: string
}

/**
 * Split the leg ending at `i` at fraction `f`, giving a new breakpoint there.
 *
 * ONE edit, not two. The new pair and the shortened leg both touch the same
 * cycles number, and two changes at one offset is the shape CodeMirror rejects
 * as overlapping — so this rewrites that number to `newT newLevel restT` in a
 * single replacement.
 *
 * The leg's total length is PRESERVED: adding a point should change where the
 * curve bends, never how long the lane is.
 */
export function insertPointEdit(lane: CurveLane, i: number, f: number, level: number): CurveEdit | null {
  const p = lane.points[i]
  if (p === undefined) return null
  const frac = f < 0.02 ? 0.02 : f > 0.98 ? 0.98 : f
  const first = p.cycles * frac
  const rest = p.cycles - first
  const lv = clampCurveLevel(level, lane.range !== undefined)
  return {
    from: p.tFrom,
    to: p.tTo,
    insert: `${fmtCurveNum(first)} ${fmtCurveNum(lv)} ${fmtCurveNum(rest)}`,
  }
}

/**
 * Remove breakpoint `i`, taking one separating space with it so the line does
 * not collect gaps.
 *
 * REFUSES THE LAST ONE: a lane with no breakpoints is not a shorter lane, it
 * is a syntax error — `curve` with no pairs does not compile, and a widget
 * that can delete its own program is worse than one that cannot delete at all.
 */
export function removePointEdit(lane: CurveLane, i: number): CurveEdit | null {
  const p = lane.points[i]
  if (p === undefined || lane.points.length <= 1) return null
  // eat the space BEFORE it, except on the first, where the one after goes
  const prev = lane.points[i - 1]
  const next = lane.points[i + 1]
  if (prev !== undefined) return { from: prev.lTo, to: p.lTo, insert: '' }
  return { from: p.tFrom, to: next !== undefined ? next.tFrom : p.lTo, insert: '' }
}

// --------------------------------------------------------------- the widget

const H = 46
const PAD = 4

/** Hooks the widget needs: the transport clock, and the doc for a drag. */
export interface CurveHooks {
  now?: () => number
  cycleAt?: (sec: number) => number
}

/**
 * A drawn, draggable automation lane.
 *
 * DRAG A BREAKPOINT: sideways changes its leg length in bars, up and down its
 * level, and each writes back the ONE number it moved. The alternative is
 * retyping bar counts until a sweep lands where the section does, which is the
 * thing nobody does more than twice — so a curve tends to be written once and
 * left, however wrong it sounds.
 *
 * The playhead is the other half. A picture of a shape is something a reader
 * could already imagine from four numbers; a picture with the transport on it
 * says where the automation IS, which the text cannot.
 */
export class CurveLaneWidget extends WidgetType {
  private raf = 0

  constructor(
    readonly lane: CurveLane,
    readonly key: string,
    readonly width: number,
    readonly hooks: CurveHooks,
    readonly drag: Drag,
  ) { super() }

  override eq(o: CurveLaneWidget): boolean {
    return o.key === this.key && o.width === this.width
  }

  override get estimatedHeight(): number {
    return H + 8
  }

  override toDOM(view: EditorView): HTMLElement {
    const l = this.lane
    const w = Math.max(140, this.width)
    const iw = w - PAD * 2
    const ih = H - PAD * 2
    const wrap = document.createElement('div')
    wrap.className = 'rondo-curvelane'
    wrap.setAttribute('role', 'img')
    const bars = `${fmtCurveNum(l.cycles)} bar${l.cycles === 1 ? '' : 's'}`
    const mapped = l.range !== undefined ? `, mapped ${l.range[0]} to ${l.range[1]}` : ''
    wrap.setAttribute('aria-label', `${l.name ?? l.def ?? 'curve'} automation over ${bars}${mapped}`)

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', `0 0 ${w} ${H}`)
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(H))

    const mk = <K extends keyof SVGElementTagNameMap>(t: K): SVGElementTagNameMap[K] =>
      document.createElementNS('http://www.w3.org/2000/svg', t)

    // a bar grid, so "eight bars" is countable rather than a length
    for (let b = 1; b < l.cycles && l.cycles <= 32; b++) {
      const g = mk('line')
      const x = PAD + (b / l.cycles) * iw
      g.setAttribute('class', 'cl-bar')
      g.setAttribute('x1', String(x))
      g.setAttribute('x2', String(x))
      g.setAttribute('y1', String(PAD))
      g.setAttribute('y2', String(H - PAD))
      svg.append(g)
    }

    const line = mk('polyline')
    line.setAttribute('class', 'cl-line')
    line.setAttribute('points', shift(curveLanePath(l.points, iw, ih, 0, l.range !== undefined), PAD, PAD))
    svg.append(line)

    const head = mk('line')
    head.setAttribute('class', 'cl-head')
    head.setAttribute('y1', String(PAD))
    head.setAttribute('y2', String(H - PAD))
    head.setAttribute('opacity', '0')
    svg.append(head)

    for (const hnd of curveHandles(l.points, iw, ih, 0, l.range !== undefined)) {
      const c = mk('circle')
      c.setAttribute('class', 'cl-pt')
      c.setAttribute('cx', String(PAD + hnd.x))
      c.setAttribute('cy', String(PAD + hnd.y))
      c.setAttribute('r', '4.5')
      c.dataset['i'] = String(hnd.i)
      svg.append(c)
      this.grab(c, hnd.i, view, iw, ih)
    }

    /* ADD AND REMOVE. Double-click the lane to put a breakpoint where you
     * clicked, double-click a breakpoint to take it away. Without this the
     * shape is fixed at whatever was typed and the widget can only nudge it,
     * which is most of the way to not being an editor. */
    svg.addEventListener('dblclick', (e) => {
      const ev = e as MouseEvent
      ev.preventDefault()
      const box = svg.getBoundingClientRect()
      const target = ev.target as Element | null
      const hit = target?.classList.contains('cl-pt') === true
        ? Number((target as SVGElement).dataset['i'])
        : -1
      const edit = hit >= 0
        ? removePointEdit(l, hit)
        : addAt(l, ((ev.clientX - box.left) / box.width) * (w / iw) - PAD / iw)
      if (edit !== null) view.dispatch({ changes: edit })
    })
    wrap.append(svg)

    /* LIVE POSITION, in the lane's own bars. `cycleAt` is the transport's
     * cycle, and the lane starts at song zero, so the playhead is simply that
     * — and it walks off the end and stays there, which is what the automation
     * does too. */
    const tick = (): void => {
      const nowFn = this.hooks.now
      const cycFn = this.hooks.cycleAt
      const sec = nowFn?.()
      const cyc = cycFn !== undefined && sec !== undefined ? cycFn(sec) : undefined
      if (cyc === undefined || l.cycles <= 0) {
        head.setAttribute('opacity', '0')
      } else {
        const x = PAD + Math.min(1, Math.max(0, cyc / l.cycles)) * iw
        head.setAttribute('opacity', '1')
        head.setAttribute('x1', String(x))
        head.setAttribute('x2', String(x))
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
    return wrap
  }

  /** Drag one breakpoint: x is its leg in bars, y is its level. */
  private grab(el: SVGElement, i: number, view: EditorView, iw: number, ih: number): void {
    const p = this.lane.points[i]
    if (p === undefined) return
    attachGesture(el as unknown as HTMLElement, this.drag, 'window', (e) => {
      const x0 = e.clientX
      const y0 = e.clientY
      // the SAME axis the drawing uses, or the handle would not track the
      // pointer it is being dragged by
      const { span } = curveAxis(this.lane.points, 0, this.lane.range !== undefined)
      const total = this.lane.cycles || 1
      /* Two writers, because the two numbers are separate ranges and a drag
       * usually moves both. Level first: it sits AFTER the cycles number, so
       * rewriting it cannot shift the offsets of the one still to be written. */
      const lw = new LiveWriter(view, p.lFrom, p.lTo)
      const tw = new LiveWriter(view, p.tFrom, p.tTo)
      return {
        onMove: (ev) => {
          const dv = -((ev.clientY - y0) / ih) * span
          const dt = ((ev.clientX - x0) / iw) * total
          lw.write(fmtCurveNum(clampCurveLevel(p.level + dv, this.lane.range !== undefined)))
          tw.write(fmtCurveNum(Math.max(0, p.cycles + dt)))
        },
      }
    })
  }

  override destroy(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /* TRUE, like every other draggable widget here (the filter curve, the bend
   * lane, the roll). It means the EDITOR ignores the event and leaves it to
   * the widget; returning false let CodeMirror take the pointerdown and the
   * handles did not move at all. */
  override ignoreEvent(): boolean {
    return true
  }
}

/** Which leg an x fraction falls in, and the insert that splits it there. */
function addAt(lane: CurveLane, xFrac: number): CurveEdit | null {
  const total = lane.cycles
  if (total <= 0) return null
  const cyc = Math.min(total, Math.max(0, xFrac)) * total
  let t = 0
  for (let i = 0; i < lane.points.length; i++) {
    const p = lane.points[i]!
    if (cyc <= t + p.cycles && p.cycles > 0) {
      return insertPointEdit(lane, i, (cyc - t) / p.cycles, curveLevelAt(lane.points, cyc))
    }
    t += p.cycles
  }
  return null
}

/** Offset a polyline's points, so the drawing math can ignore the padding. */
function shift(points: string, dx: number, dy: number): string {
  return points
    .split(' ')
    .map((pt) => {
      const [x, y] = pt.split(',')
      return `${(Number(x) + dx).toFixed(1)},${(Number(y) + dy).toFixed(2)}`
    })
    .join(' ')
}
