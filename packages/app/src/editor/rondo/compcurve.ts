/* ------------------------------------------------------------------------- *
 * COMPRESSOR TRANSFER CURVES — seeing what four numbers actually do.
 *
 * `master threshold:-14 ratio:2.6 attack:12 release:150 makeup:2` renders as
 * five bare numbers, and nothing in the editor says what shape they make. A
 * compressor HAS an obvious picture — input dB against output dB, flat 1:1
 * until the threshold, then bending to the ratio's slope — and it was the one
 * node with no widget at all.
 *
 * THE DOT IS THE POINT. A static curve already beats five loose numbers, but
 * the number a compressor user actually wants is the GAIN REDUCTION, and that
 * is invisible today. Put a dot at the current input level and the drop from
 * the unity diagonal to the curve IS the reduction, in the units it is
 * measured in.
 *
 * SAME HONESTY RULE as the filter curve: this draws the written values. The
 * dot needs a real input level, which the engine already measures per channel
 * for the visualizer — where there is no level to read, the curve simply sits
 * still rather than animating something invented.
 * ------------------------------------------------------------------------- */

/** dB range the curve is drawn over — a compressor's working span. */
export const DB_MIN = -60
export const DB_MAX = 0

export interface CompSpec {
  threshold: number
  ratio: number
  knee: number
  makeup: number
}

/** What the engine defaults to when an arg is omitted. Kept beside the curve
 *  because a curve drawn at the wrong default lies exactly as loudly as one
 *  drawn at the wrong value. */
export const COMP_DEFAULTS: CompSpec = { threshold: -24, ratio: 4, knee: 6, makeup: 0 }

export interface CompScan {
  /** `master` (whole mix) or `compress` (the running signal on this line). */
  kind: 'master' | 'compress'
  /** absolute end of the line's code part — where the widget anchors. */
  at: number
  /** the enclosing `synth NAME`, so the dot can follow that channel. */
  synth?: string
  spec: CompSpec
}

/**
 * Output level in dB for an input level in dB.
 *
 * Soft knee: over a `knee`-wide band centred on the threshold the ratio eases
 * in quadratically rather than cornering, which is what "knee" means and what
 * makes a glue compressor sound like glue. Below the band it is 1:1; above it
 * the slope is 1/ratio. Makeup shifts the whole thing up.
 */
export function compResponse(db: number, s: CompSpec): number {
  const ratio = Math.max(1, s.ratio)
  const knee = Math.max(0, s.knee)
  const over = db - s.threshold
  let out: number
  if (knee > 0 && over > -knee / 2 && over < knee / 2) {
    // quadratic blend across the knee: slope 1 at the bottom, 1/ratio at the top
    const x = over + knee / 2
    out = db + ((1 / ratio - 1) * x * x) / (2 * knee)
  } else if (over <= 0) {
    out = db
  } else {
    out = s.threshold + over / ratio
  }
  return out + s.makeup
}

/** How much this compressor is pulling down at `db` in, in dB. The distance
 *  from the unity diagonal — which is what the widget draws. */
export const gainReduction = (db: number, s: CompSpec): number =>
  db + s.makeup - compResponse(db, s)

/** dB → x across a width, over the drawn range. */
export const dbToX = (db: number, w: number): number =>
  ((Math.min(Math.max(db, DB_MIN), DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN)) * w
/** dB → y down a height (louder is higher). */
export const dbToYc = (db: number, h: number): number =>
  h - ((Math.min(Math.max(db, DB_MIN), DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN)) * h

/** A linear 0..1 meter level as dB, floored at the drawn range. */
export const levelToDb = (lvl: number): number =>
  lvl <= 0 ? DB_MIN : Math.max(DB_MIN, 20 * Math.log10(Math.min(1, lvl)))

const NUM = /^-?\d*\.?\d+$/

/**
 * Find every `master …` / `compress …` line, with the args it names.
 *
 * Args are `name:number` pairs in both spellings, and an omitted one takes the
 * engine's default rather than dropping the curve — unlike a filter cutoff,
 * every field here HAS a meaningful default, so there is always an honest
 * curve to draw. Pure, so the parsing is testable without an editor.
 */
export function scanCompressors(text: string): CompScan[] {
  const out: CompScan[] = []
  let at = 0
  let synth: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '')
    const text0 = line.trim()
    if (/^\S/.test(line) && text0 !== '') {
      const h = /^([a-zA-Z_]\w*)(?:[ \t]+([a-zA-Z_]\w*))?/.exec(text0)
      synth = h?.[1] === 'synth' ? h[2] : undefined
    }
    const m = /^(master|compress)\b(.*)$/.exec(text0)
    if (m !== null) {
      const spec: CompSpec = { ...COMP_DEFAULTS }
      for (const pair of m[2]!.matchAll(/([a-zA-Z_]\w*)[ \t]*:[ \t]*(-?[\d.]+)/g)) {
        const k = pair[1]!
        if (!NUM.test(pair[2]!)) continue
        const v = Number(pair[2])
        if (k === 'threshold') spec.threshold = v
        else if (k === 'ratio') spec.ratio = v
        else if (k === 'knee') spec.knee = v
        else if (k === 'makeup') spec.makeup = v
      }
      const scan: CompScan = { kind: m[1] as 'master' | 'compress', at: at + line.length, spec }
      // `master` is the whole mix; `compress` inside a synth is that channel
      if (m[1] === 'compress' && synth !== undefined) scan.synth = synth
      out.push(scan)
    }
    at += raw.length + 1
  }
  return out
}

/* ------------------------------------------------------------------------- *
 * The widget. Kept below the maths so the maths stays testable on its own.
 * ------------------------------------------------------------------------- */

import { WidgetType } from '@codemirror/view'
import { inkOf, paintOnAttach } from './paint'
import { activate } from './activation'
import type { Hooks } from './widgets'

const CW = { h: 54, samples: 72 }

export class CompCurveWidget extends WidgetType {
  private unsub: (() => void) | null = null
  private raf = 0

  constructor(
    readonly scan: CompScan,
    readonly key: string,
    readonly width: number,
    readonly hooks: Hooks,
  ) { super() }

  override eq(o: CompCurveWidget): boolean {
    return o.key === this.key && o.width === this.width
  }

  override toDOM(): HTMLElement {
    const s = this.scan.spec
    const W = Math.max(90, Math.min(this.width, 220))
    const H = CW.h
    const wrap = document.createElement('span')
    wrap.className = 'rondo-ccurve'
    wrap.setAttribute('role', 'img')
    wrap.setAttribute('aria-label', `${this.scan.kind}: ${s.ratio}:1 above ${s.threshold} dB`)
    wrap.title = `${this.scan.kind}: ${s.ratio}:1 above ${s.threshold} dB, knee ${s.knee}, makeup ${s.makeup}`
    const canvas = document.createElement('canvas')
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    wrap.appendChild(canvas)

    /** current input level in dB, or null when nothing is sounding. */
    let inDb: number | null = null

    const draw = (): void => {
      const g = canvas.getContext('2d')
      if (g === null) return
      const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio ?? 1))
      if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const color = inkOf(canvas)
      // UNITY, dashed: the curve means nothing without the line it departs
      // from — the gap between them IS the gain reduction.
      g.strokeStyle = color
      g.globalAlpha = 0.22
      g.setLineDash([3, 3])
      g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke()
      g.setLineDash([])
      // the threshold, so the bend has a labelled cause
      const tx = dbToX(s.threshold, W)
      g.beginPath(); g.moveTo(tx, 0); g.lineTo(tx, H); g.stroke()
      // the transfer curve
      g.globalAlpha = 1
      g.lineWidth = 1.8
      g.beginPath()
      for (let i = 0; i <= CW.samples; i++) {
        const db = DB_MIN + ((DB_MAX - DB_MIN) * i) / CW.samples
        const y = dbToYc(compResponse(db, s), H)
        if (i === 0) g.moveTo(0, y)
        else g.lineTo((i / CW.samples) * W, y)
      }
      g.stroke()
      /* THE DOT, and the reduction it reads off. A static curve already beats
       * five bare numbers, but the number a compressor user wants is how much
       * it is pulling down RIGHT NOW, and nothing in the editor said. */
      if (inDb !== null && inDb > DB_MIN) {
        const x = dbToX(inDb, W)
        const yOut = dbToYc(compResponse(inDb, s), H)
        const yUnity = dbToYc(inDb + s.makeup, H)
        const gr = gainReduction(inDb, s)
        if (gr > 0.15) {
          // the drop itself, drawn: unity down to the curve
          g.globalAlpha = 0.5
          g.lineWidth = 3
          g.beginPath(); g.moveTo(x, yUnity); g.lineTo(x, yOut); g.stroke()
          g.globalAlpha = 1
        }
        g.lineWidth = 1.8
        g.beginPath()
        g.arc(x, Math.max(3, Math.min(H - 3, yOut)), 3.5, 0, 2 * Math.PI)
        g.fillStyle = color
        g.fill()
      }
    }
    paintOnAttach(draw)

    /* `master` is the whole mix, which the engine reports as its OWN field
     * beside the per-channel meters — not as a channel — so it needs its own
     * hook. A `compress` line reads its enclosing synth's channel. Where
     * neither is available the curve simply sits still: no dot is better than
     * a dot at an invented level. */
    const chan = this.scan.synth
    const readLevel = chan === undefined ? this.hooks.masterLevel : (): number => this.hooks.level?.(chan) ?? 0
    if (readLevel !== undefined) {
      const follow = (): void => {
        const lvl = readLevel()
        const next = lvl > 0 ? levelToDb(lvl) : null
        // redraw only on a visible move: this is a canvas repaint
        if (next === null ? inDb !== null : inDb === null || Math.abs(next - inDb) > 0.4) {
          inDb = next
          draw()
        }
        this.raf = requestAnimationFrame(follow)
      }
      this.raf = requestAnimationFrame(follow)
    }
    this.unsub = activate(wrap, this.hooks, this.scan.synth !== undefined ? { synth: this.scan.synth } : {})
    return wrap
  }

  override ignoreEvent(): boolean { return true }

  override destroy(): void {
    this.unsub?.()
    this.unsub = null
    cancelAnimationFrame(this.raf)
  }
}
