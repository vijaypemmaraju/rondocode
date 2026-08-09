/* ------------------------------------------------------------------------- *
 * THE SIDECHAIN DUCK, drawn.
 *
 * `sidechain kick depth:.7 release:200 lead:.99 sub:.8` is a trigger name and a
 * pile of amounts, and two things about it are invisible:
 *
 *   the SHAPE — how far the gain drops and how fast it comes back, which is
 *     the pump, and the thing you actually tune
 *   the SPREAD — `lead:.99 sub:.8` means those two duck by DIFFERENT amounts,
 *     and nothing in the editor ever said so
 *
 * This is not a compressor transfer curve, and calling it one was a mistake I
 * made before checking. A compressor maps level to level; a duck maps TIME to
 * gain. So the x axis here is time, not input dB, and the picture is the
 * envelope: drop on the trigger, recover over `release`.
 *
 * Same honesty rule as the other curves: the shape is drawn from the written
 * values, and the live dot only moves where a real duck value exists — the
 * engine reports one on its meter events, which is the same number the shader
 * visualizer reads.
 * ------------------------------------------------------------------------- */

import { WidgetType } from '@codemirror/view'
import { inkOf, paintOnAttach } from './paint'
import { activate } from './activation'
import type { Hooks } from './widgets'

/** Engine defaults for an omitted arg. A curve drawn at the wrong default lies
 *  exactly as loudly as one drawn at the wrong value — and this shipped at
 *  0.7 / 0.2 against the real 0.6 / 0.18, so `sidechain kick` drew a deeper,
 *  slower pump than it played. The test that was supposed to catch that
 *  compared the scanner against THIS constant, which is no comparison at all;
 *  duckcurve.test.ts now pins it against the DSL layer that applies it. */
export const DUCK_DEFAULTS = { depth: 0.6, release: 180 }

export interface DuckScan {
  /** the synth whose onsets trigger the duck. */
  trigger: string
  depth: number
  release: number
  /** per-channel duck amounts, in source order — the spread. */
  channels: { name: string; amount: number }[]
  /** absolute end of the line's code part — where the widget anchors. */
  at: number
}

/**
 * Gain at `t` seconds after a trigger, for a duck of `depth` recovering over
 * `release`.
 *
 * Exponential recovery, not linear: a linear ramp back reads as a fade, and
 * the whole character of a pump is that it moves fastest just after the hit.
 */
export function duckGain(t: number, depth: number, releaseMs: number): number {
  const release = releaseMs / 1000
  if (t < 0) return 1
  const d = Math.min(1, Math.max(0, depth))
  if (release <= 0) return 1
  return 1 - d * Math.exp(-t / (release / 3))
}

const NUM = /^\d*\.?\d+$/

/** Find every `sidechain` line with its trigger, shape and per-channel spread. */
export function scanDucks(text: string): DuckScan[] {
  const out: DuckScan[] = []
  let at = 0
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '')
    const t = line.trim()
    const m = /^sidechain[ \t]+([a-zA-Z_]\w*)(.*)$/.exec(t)
    if (m !== null) {
      const scan: DuckScan = {
        trigger: m[1]!,
        depth: DUCK_DEFAULTS.depth,
        release: DUCK_DEFAULTS.release,
        channels: [],
        at: at + line.length,
      }
      for (const pair of m[2]!.matchAll(/([a-zA-Z_]\w*)[ \t]*:[ \t]*([\d.]+)/g)) {
        const k = pair[1]!
        if (!NUM.test(pair[2]!)) continue
        const v = Number(pair[2])
        // `depth:` and `release:` shape the duck; ANY other name:amount pair is
        // a channel being ducked by that amount, which is the whole spread
        if (k === 'depth') scan.depth = v
        else if (k === 'release') scan.release = v
        else scan.channels.push({ name: k, amount: v })
      }
      out.push(scan)
    }
    at += raw.length + 1
  }
  return out
}

const DW = { h: 42, samples: 64, secs: 0.75 }

export class DuckCurveWidget extends WidgetType {
  private unsub: (() => void) | null = null
  private raf = 0

  constructor(
    readonly scan: DuckScan,
    readonly key: string,
    readonly width: number,
    readonly hooks: Hooks,
  ) { super() }

  override eq(o: DuckCurveWidget): boolean {
    return o.key === this.key && o.width === this.width
  }

  override toDOM(): HTMLElement {
    const s = this.scan
    const W = Math.max(90, Math.min(this.width, 220))
    const H = DW.h
    const wrap = document.createElement('span')
    wrap.className = 'rondo-dcurve'
    wrap.setAttribute('role', 'img')
    wrap.setAttribute('aria-label', `sidechain: ${s.trigger} ducks by ${s.depth}, recovering over ${s.release}s`)
    wrap.title =
      `${s.trigger} ducks by ${s.depth} over ${s.release}s` +
      (s.channels.length > 0 ? ` — ${s.channels.map((c) => `${c.name} ${c.amount}`).join(', ')}` : '')
    const canvas = document.createElement('canvas')
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    wrap.appendChild(canvas)

    /** live duck value, 1 = open. */
    let duck = 1

    const yOf = (gain: number): number => H - Math.min(1, Math.max(0, gain)) * (H - 2) - 1

    const draw = (): void => {
      const g = canvas.getContext('2d')
      if (g === null) return
      const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio ?? 1))
      if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const color = inkOf(canvas)
      // unity: the gain the duck departs from
      g.strokeStyle = color
      g.globalAlpha = 0.22
      g.beginPath(); g.moveTo(0, yOf(1)); g.lineTo(W, yOf(1)); g.stroke()
      /* THE SPREAD. `lead:.99 sub:.8` duck by different amounts and nothing
       * ever showed it — one faint curve per channel, scaled by its own
       * amount, under the master shape. */
      g.lineWidth = 1
      for (const c of s.channels) {
        g.globalAlpha = 0.3
        g.beginPath()
        for (let i = 0; i <= DW.samples; i++) {
          const t = (DW.secs * i) / DW.samples
          const y = yOf(1 - (1 - duckGain(t, s.depth, s.release)) * c.amount)
          if (i === 0) g.moveTo(0, y)
          else g.lineTo((i / DW.samples) * W, y)
        }
        g.stroke()
      }
      // the duck itself
      g.globalAlpha = 1
      g.lineWidth = 1.8
      g.beginPath()
      for (let i = 0; i <= DW.samples; i++) {
        const t = (DW.secs * i) / DW.samples
        const y = yOf(duckGain(t, s.depth, s.release))
        if (i === 0) g.moveTo(0, y)
        else g.lineTo((i / DW.samples) * W, y)
      }
      g.stroke()
      // where the duck is RIGHT NOW — a bar, because the x axis is time and
      // "now" is a level rather than a position along it
      if (duck < 0.995) {
        g.globalAlpha = 0.85
        g.fillStyle = color
        g.fillRect(0, yOf(duck) - 1, W, 2)
      }
    }
    paintOnAttach(draw)

    const readDuck = this.hooks.duckLevel
    if (readDuck !== undefined) {
      const follow = (): void => {
        const next = readDuck()
        if (Math.abs(next - duck) > 0.01) { duck = next; draw() }
        this.raf = requestAnimationFrame(follow)
      }
      this.raf = requestAnimationFrame(follow)
    }
    this.unsub = activate(wrap, this.hooks, { synth: s.trigger })
    return wrap
  }

  override ignoreEvent(): boolean { return true }

  override destroy(): void {
    this.unsub?.()
    this.unsub = null
    cancelAnimationFrame(this.raf)
  }
}
