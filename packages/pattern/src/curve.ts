/* ------------------------------------------------------------------------- *
 * Automation over the TIMELINE.
 *
 * `env` shapes a note: breakpoints in seconds, retriggered by the gate. This
 * is the same idea measured in CYCLES and running against the transport, for
 * the thing a DAW calls an automation lane — "over 32 bars, open from nothing
 * to full, sag, then come back".
 *
 * Until now that meant gluing `rise`/`fall` together with `cat` and hoping,
 * because those are only linear ramps (`saw.slow(n)` and `isaw.slow(n)`).
 *
 * Deliberately the SAME shape as an env breakpoint — `[cycles, level]` or
 * `[cycles, level, curve]` — and deliberately the same warp, imported from the
 * engine's kernel rather than rewritten here. Two implementations of "what
 * does curve 3 look like" would drift, and then the same number would mean two
 * things depending on which layer you wrote it in.
 *
 * Sampled per event, like every pattern signal: `.ctrl('cutoff', curve(…))`
 * takes the value at each onset. A control that has to move WITHIN one note
 * belongs inside the synth, where `env` and `lfo` run per sample.
 * ------------------------------------------------------------------------- */

import { signal } from './signal'
import type { Pattern } from './pattern'

/** One breakpoint: `[cycles, level]`, or `[cycles, level, curve]` to give that
 *  leg its own shape. Same tuple as the engine's EnvPoint, in cycles. */
export type CurvePoint = [number, number] | [number, number, number]

export interface CurveOpts {
  /** Shape applied to every leg that does not carry its own. 0 = linear,
   *  > 0 fast-then-slow, < 0 slow-then-fast. Default 0. */
  curve?: number
  /** Level before the first breakpoint. Default 0 — a lane starts somewhere,
   *  and 0 is the only honest guess when nothing has said otherwise. */
  from?: number
  /** Loop the whole shape instead of holding the last level. Default false:
   *  an automation lane that silently restarted would be a surprise, and
   *  `.slow()` on the result is the usual way to stretch one. */
  loop?: boolean
}

/** Warp a 0..1 fraction by a curve exponent — the engine's own easing, so a
 *  given number means the same thing in a synth and on the timeline. */
const shape = (f: number, curve: number): number =>
  curve === 0 ? f : (1 - Math.exp(-curve * f)) / (1 - Math.exp(-curve))

/**
 * A breakpoint automation lane, in cycles.
 *
 *   curve([[8, 1], [4, 0.3], [16, 1]])      // up over 8, sag over 4, back over 16
 *   curve([[16, 1, 3]], { from: 0.2 })      // one eased 16-bar rise from 0.2
 *
 * Legs run in order and the total length is their sum; past the end the last
 * level holds (or the shape repeats with `loop`). A leg of zero or negative
 * length is a JUMP to its level rather than an error — a step is a legitimate
 * automation move, and dropping it would silently change the timing of every
 * leg after it.
 */
export function curve(points: readonly CurvePoint[], opts: CurveOpts = {}): Pattern<number> {
  const legs = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  const start = Number.isFinite(opts.from) ? (opts.from as number) : 0
  const globalCurve = Number.isFinite(opts.curve) ? (opts.curve as number) : 0
  const total = legs.reduce((n, p) => n + Math.max(0, p[0]), 0)
  const last = legs.length > 0 ? legs[legs.length - 1]![1] : start

  return signal((t) => {
    if (legs.length === 0) return start
    let pos = t.valueOf()
    if (opts.loop === true && total > 0) pos = ((pos % total) + total) % total
    if (pos >= total) return last
    let from = start
    let acc = 0
    for (const leg of legs) {
      const len = Math.max(0, leg[0])
      const to = leg[1]
      if (pos < acc + len) {
        const f = len <= 0 ? 1 : (pos - acc) / len
        const c = leg.length > 2 && Number.isFinite(leg[2]) ? (leg[2] as number) : globalCurve
        return from + (to - from) * shape(f, c)
      }
      acc += len
      from = to
    }
    return last
  })
}
