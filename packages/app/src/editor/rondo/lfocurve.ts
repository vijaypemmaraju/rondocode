import { EditorView, WidgetType } from '@codemirror/view'
import type { Hooks } from './widgets'
import { activate } from './activation'
import { liveTransport } from './transport'

/* ------------------------------------------------------------------------- *
 * THE LFO, DRAWN.
 *
 * `lfo` is the one modulation source with nothing to look at. A filter has a
 * response curve, a compressor has its transfer curve, the sidechain has its
 * pump — and the LFO, which is what MOVES all of them, was five characters of
 * text. You could not see its shape, you could not see where in the cycle it
 * was, and with `sync:1` you could not even tell how fast it was going without
 * doing cps arithmetic in your head.
 *
 * WHAT IS DRAWN IS THE ENGINE'S OWN MATH, not an impression of it. The shape
 * functions here are the same expressions LfoKernel evaluates, including the
 * detail that every shape is UNIPOLAR [0, 1] — a `sine` lfo never goes
 * negative, which surprises people who expect an oscillator to swing about
 * zero, and a drawing that showed it centred would teach the wrong thing.
 *
 * `rand` is the interesting case. Its steps come from a seeded xorshift32 that
 * no argument can change, so the widget reproduces the SEQUENCE exactly rather
 * than drawing a plausible staircase. If the kernel's seed or generator ever
 * changes, lfocurve.test.ts fails rather than the picture quietly becoming
 * fiction.
 * ------------------------------------------------------------------------- */

export type LfoShape = 'sine' | 'tri' | 'square' | 'saw' | 'rand'

const SHAPES: readonly LfoShape[] = ['sine', 'tri', 'square', 'saw', 'rand']

/** The kernel's default seed. Nothing in the language can change it, which is
 *  what lets the picture be exact. */
const LFO_SEED = 0x2545f491

/** One step of the kernel's xorshift32, returning the next held level and the
 *  next state. Mirrors LfoKernel.latch(). */
export function shStep(state: number): { level: number; state: number } {
  let x = state
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  x >>>= 0
  return { level: x / 4294967296, state: x }
}

/** The sample-and-hold levels for the first `n` steps, in order — the actual
 *  sequence the kernel produces from a fresh reset. */
export function shLevels(n: number): number[] {
  let state = LFO_SEED >>> 0 || 1
  const out: number[] = []
  // the kernel latches ONCE at construction before any wrap, so the first
  // level a listener hears is the first draw, not the seed itself
  for (let i = 0; i < n; i++) {
    const s = shStep(state)
    state = s.state
    out.push(s.level)
  }
  return out
}

/** The LFO's output at `phase` (0..1) for a continuous shape. UNIPOLAR: every
 *  shape returns 0..1, exactly as LfoKernel does. */
export function lfoValue(shape: LfoShape, phase: number): number {
  const p = phase - Math.floor(phase)
  switch (shape) {
    case 'sine': return 0.5 + 0.5 * Math.sin(2 * Math.PI * p)
    case 'tri': return 1 - Math.abs(2 * p - 1)
    case 'square': return p < 0.5 ? 1 : 0
    case 'saw': return p
    case 'rand': return shLevels(1)[0]!
  }
}

/** One `lfo` call found in the source. */
export interface LfoScan {
  /** doc offset the widget attaches after (end of the line). */
  at: number
  shape: LfoShape
  /** The literal rate: Hz, or a length in transport cycles when `sync`. */
  rate: number
  sync: boolean
  /** `-> lo..hi` on the same line, if the reader wrote one. */
  lo?: number
  hi?: number
}

/* `lfo <rate> [shape] [sync:1]`, plus an optional `-> lo..hi` anywhere after
 * it on the same line. A NON-LITERAL rate (a knob, a macro, another signal) is
 * skipped rather than guessed at — the same honesty rule filtercurve.ts
 * follows, because a curve drawn from a number the program does not use is
 * worse than no curve. */
const LFO_RE = /\blfo\s+(-?\d*\.?\d+)((?:\s+[a-z]+(?![:\w]))?)((?:\s+\w+:\S+)*)/g
const RANGE_RE = /->\s*(-?\d*\.?\d+)\s*\.\.\s*(-?\d*\.?\d+)/

export function scanLfos(text: string): LfoScan[] {
  const out: LfoScan[] = []
  let lineStart = 0
  for (const line of text.split('\n')) {
    const lineEnd = lineStart + line.length
    // a comment is not code
    const code = line.split('#')[0] ?? ''
    LFO_RE.lastIndex = 0
    for (let m = LFO_RE.exec(code); m !== null; m = LFO_RE.exec(code)) {
      const rate = Number(m[1])
      if (!Number.isFinite(rate) || rate <= 0) continue
      const word = (m[2] ?? '').trim()
      const shape: LfoShape = SHAPES.includes(word as LfoShape) ? (word as LfoShape) : 'sine'
      const named = m[3] ?? ''
      const sync = /\bsync:\s*(1|true)\b/.test(named)
      const scan: LfoScan = { at: lineEnd, shape, rate, sync }
      const r = RANGE_RE.exec(code)
      if (r !== null) {
        const lo = Number(r[1])
        const hi = Number(r[2])
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
          scan.lo = lo
          scan.hi = hi
        }
      }
      out.push(scan)
    }
    lineStart = lineEnd + 1
  }
  return out
}

/** Where the LFO is RIGHT NOW, 0..1, or null when the transport cannot say.
 *
 *  A synced LFO's rate is a length in transport CYCLES, so its phase comes
 *  from the transport position and not from wall-clock seconds. Getting that
 *  backwards is the bug the whole `cycleAt` hook exists to prevent: a
 *  wall-clock phase lands wherever the audio clock happens to be after a stop,
 *  which is exactly when the marker would be most obviously wrong. */
export function lfoPhase(
  s: Pick<LfoScan, 'rate' | 'sync'>,
  nowSec: number | undefined,
  cycle: number | undefined,
): number | null {
  if (s.rate <= 0 || !Number.isFinite(s.rate)) return null
  if (s.sync) {
    if (cycle === undefined || !Number.isFinite(cycle)) return null
    const p = (cycle / s.rate) % 1
    return p < 0 ? p + 1 : p
  }
  if (nowSec === undefined || !Number.isFinite(nowSec)) return null
  const p = (nowSec * s.rate) % 1
  return p < 0 ? p + 1 : p
}

/** A number the way this widget prints it: short, and never `0.30000000004`. */
const num = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  return Number.isInteger(r) ? String(r) : String(r)
}

/** The SVG path for one full cycle across `w` x `h`. */
export function lfoPath(shape: LfoShape, w: number, h: number): string {
  const y = (v: number): number => h - v * h
  if (shape === 'square') {
    // drawn as the discontinuity it is, not a ramp between the two levels
    return `M0 ${y(1)} L${w / 2} ${y(1)} L${w / 2} ${y(0)} L${w} ${y(0)}`
  }
  if (shape === 'saw') return `M0 ${y(0)} L${w} ${y(1)}`
  if (shape === 'rand') {
    const STEPS = 8
    const levels = shLevels(STEPS)
    let d = ''
    for (let i = 0; i < STEPS; i++) {
      const x0 = (i * w) / STEPS
      const x1 = ((i + 1) * w) / STEPS
      const yy = y(levels[i]!)
      d += `${i === 0 ? 'M' : 'L'}${num(x0)} ${num(yy)} L${num(x1)} ${num(yy)} `
    }
    return d.trim()
  }
  const N = 64
  let d = ''
  for (let i = 0; i <= N; i++) {
    const p = i / N
    d += `${i === 0 ? 'M' : 'L'}${num((p * w))} ${num(y(lfoValue(shape, p)))} `
  }
  return d.trim()
}

const H = 34

export class LfoCurveWidget extends WidgetType {
  private unsub: (() => void) | undefined
  private raf = 0

  constructor(
    readonly scan: LfoScan,
    readonly key: string,
    readonly width: number,
    readonly hooks: Hooks,
  ) { super() }

  override eq(o: LfoCurveWidget): boolean {
    return o.key === this.key && o.width === this.width
  }

  override get estimatedHeight(): number {
    // block widgets that do not declare a height are ESTIMATED and corrected
    // when scrolled into view, which moves everything below them
    return H + 10
  }

  override toDOM(_view: EditorView): HTMLElement {
    const s = this.scan
    const w = Math.max(120, this.width)
    const wrap = document.createElement('div')
    wrap.className = 'rondo-lfocurve'
    wrap.setAttribute('role', 'img')

    const hz = s.sync ? null : s.rate
    const label = s.sync
      ? `lfo ${s.shape}, one cycle every ${num(s.rate)} bar${s.rate === 1 ? '' : 's'}`
      : `lfo ${s.shape} at ${num(s.rate)} Hz (${num(1 / s.rate)} s per cycle)`
    const ranged = s.lo !== undefined && s.hi !== undefined
      ? `${label}, output ${num(s.lo)} to ${num(s.hi)}`
      : `${label}, output 0 to 1`
    wrap.setAttribute('aria-label', ranged)

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', `0 0 ${w} ${H}`)
    /* An explicit width, like the duck curve's canvas. `width: 100%` plus
     * preserveAspectRatio:none stretched a 420-wide viewBox across the whole
     * editor — measured at 1413px, which flattens a sine into a nearly
     * straight line and makes the shape unreadable. That is the entire point
     * of the widget, so it cannot be left to the container. */
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.style.width = `${w}px`
    svg.style.height = `${H}px`
    wrap.appendChild(svg)

    const mk = (tag: string, attrs: Record<string, string>): SVGElement => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      svg.appendChild(el)
      return el
    }

    // the midpoint, so a unipolar shape reads as unipolar
    mk('line', { class: 'lc-mid', x1: '0', y1: String(H / 2), x2: String(w), y2: String(H / 2) })
    mk('path', { class: 'lc-curve', d: lfoPath(s.shape, w, H) })

    const text = document.createElement('span')
    text.className = 'lc-label'
    text.textContent = s.sync
      ? `${s.shape} · ${num(s.rate)} bar${s.rate === 1 ? '' : 's'}`
      : `${s.shape} · ${num(hz!)} Hz`
    if (s.lo !== undefined && s.hi !== undefined) text.textContent += ` · ${num(s.lo)}..${num(s.hi)}`
    wrap.appendChild(text)

    /* A DOT ALONE LOSES AT SPEED. At 8 Hz the phase crosses the whole box in
     * 125 ms — about seven frames at 60fps — so a small circle is a few
     * scattered dots and reads as a flicker rather than motion. A full-height
     * PLAYHEAD is visible whatever the rate, the same reason every DAW draws
     * one, and the dot on the curve then says the VALUE rather than having to
     * carry the position too. */
    const head = mk('line', { class: 'lc-head', x1: '0', y1: '0', x2: '0', y2: String(H) })
    const dot = mk('circle', { class: 'lc-dot', r: '4.5', cx: '0', cy: String(H / 2) })
    head.setAttribute('opacity', '0')
    dot.setAttribute('opacity', '0')

    /* LIVE POSITION. Without it this is a picture of a waveform, which the
     * reader could already imagine; with it, it says where the modulation IS,
     * which is the thing you cannot get from the text. */
    const tick = (): void => {
      /* Through liveTransport, so a STOPPED transport hides the marker: the
       * audio clock never stops and cycleAt never freezes, so reading them
       * raw kept the dot sweeping in a stopped editor (see transport.ts). */
      const t = liveTransport(this.hooks)
      const p = t === null ? null : lfoPhase(s, t.sec, t.cycle)
      if (p === null) {
        dot.setAttribute('opacity', '0')
        head.setAttribute('opacity', '0')
      } else {
        const x = num(p * w)
        dot.setAttribute('opacity', '1')
        dot.setAttribute('cx', x)
        dot.setAttribute('cy', num(H - lfoValue(s.shape, p) * H))
        head.setAttribute('opacity', '1')
        head.setAttribute('x1', x)
        head.setAttribute('x2', x)
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
    this.unsub = activate(wrap, this.hooks, {})
    return wrap
  }

  override destroy(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.unsub?.()
    this.unsub = undefined
  }
}
