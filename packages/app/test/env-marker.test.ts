import { describe, expect, it } from 'vitest'
import { envMarkerAt } from '../src/editor/rondo/envpoints'
import type { EnvGeom } from '../src/editor/rondo/envpoints'

/* ------------------------------------------------------------------------- *
 * THE ADSR MARKER USED TO FLY OFF THE WIDGET.
 *
 * The decay ramp was run through the SUSTAIN HOLD as well — one branch guarded
 * by `t < a + d + holdSec` but interpolating x with `(t - a) / d`. Past the
 * decay the fraction keeps climbing above 1, so the marker sailed past the
 * decay handle and out of the box, then reappeared when the release began.
 *
 * A LONG RELEASE is what made it obvious, which is good misdirection: the
 * sustain plateau absorbs whatever width the other three segments leave, so a
 * long release squeezes it to its 26px minimum — and a marker moving at the
 * decay ramp's much wider rate crosses those 26px almost immediately.
 *
 * So the load-bearing test is not "does it look right at one moment". It is:
 * across the WHOLE note, for a wide range of settings, the marker never leaves
 * the box it is drawn in.
 * ------------------------------------------------------------------------- */

/** The widget's own geometry, at its real proportions. */
const W = 420
const H = 40
const pad = 5
const base = H - pad
const peak = pad
const HOLD_MIN = 26
const seg = (W - 2 * pad - HOLD_MIN) / 3
const AMAX = 1, DMAX = 1, RMAX = 2
const tx = (t: number, max: number): number => Math.sqrt(Math.min(Math.max(t / max, 0), 1)) * seg

function geom(a: number, d: number, s: number, r: number): EnvGeom {
  const ax = pad + tx(a, AMAX)
  const dx = ax + tx(d, DMAX)
  const sy = base - Math.min(Math.max(s, 0), 1) * (base - peak)
  const rw = tx(r, RMAX)
  const hold = Math.max(HOLD_MIN, W - pad - rw - dx)
  const hx = dx + hold
  return { ax, dx, sy, hx, rx: hx + rw }
}

const BOX = { pad, peak, base }

/* The settings a reader would actually type, including the pathological
 * combinations: a long release with a short decay is the reported case. */
const CASES: [string, number, number, number, number, number][] = [
  // label, a, d, s, r, note duration
  ['reported: long release, short decay', 0.01, 0.05, 0.8, 2, 4],
  ['very long release', 0.005, 0.02, 0.9, 2, 8],
  ['long note, tiny decay', 0.01, 0.01, 0.7, 0.2, 12],
  ['percussive, no sustain', 0.001, 0.08, 0, 0.05, 0.5],
  ['slow pad', 0.5, 0.4, 0.8, 1.5, 6],
  ['zero attack', 0, 0.2, 0.5, 0.3, 2],
  ['zero decay', 0.05, 0, 0.6, 0.4, 2],
  ['zero release', 0.05, 0.2, 0.6, 0, 2],
  ['everything zero', 0, 0, 0, 0, 1],
  ['note shorter than attack', 0.8, 0.2, 0.7, 0.4, 0.1],
]

describe('the marker never leaves the widget', () => {
  for (const [label, a, d, s, r, dur] of CASES) {
    it(label, () => {
      const g = geom(a, d, s, r)
      const holdSec = Math.max(dur - a - d, 0.05)
      const total = a + d + holdSec + r
      let worstX = 0
      for (let i = 0; i <= 600; i++) {
        const t = (i / 600) * total * 0.999
        const at = envMarkerAt(t, { a, d, holdSec, r }, g, BOX)
        if (at === null) continue
        worstX = Math.max(worstX, at.x)
        expect(at.x, `t=${t.toFixed(3)}s ran off the LEFT`).toBeGreaterThanOrEqual(pad - 0.01)
        expect(at.x, `t=${t.toFixed(3)}s ran off the RIGHT (x=${at.x.toFixed(1)}, box ends ${W - pad})`)
          .toBeLessThanOrEqual(W - pad + 0.01)
        expect(at.y, `t=${t.toFixed(3)}s left the box vertically`).toBeGreaterThanOrEqual(peak - 0.01)
        expect(at.y).toBeLessThanOrEqual(base + 0.01)
      }
      // and it really did travel — a marker pinned at the origin would pass
      // every bound above
      expect(worstX, 'the marker never moved').toBeGreaterThan(pad + 10)
    })
  }
})

describe('it moves FORWARD, and reaches each stage', () => {
  const a = 0.05, d = 0.1, s = 0.7, r = 1.2, dur = 3
  const g = geom(a, d, s, r)
  const holdSec = Math.max(dur - a - d, 0.05)

  it('x never goes backwards', () => {
    let prev = -Infinity
    for (let i = 0; i <= 800; i++) {
      const t = (i / 800) * (a + d + holdSec + r) * 0.999
      const at = envMarkerAt(t, { a, d, holdSec, r }, g, BOX)
      if (at === null) continue
      expect(at.x + 0.01, `went backwards at t=${t.toFixed(3)}`).toBeGreaterThanOrEqual(prev)
      prev = at.x
    }
  })

  it('hands off cleanly at each stage boundary', () => {
    // the marker must be AT the handle when the stage ends, not past it.
    // The epsilon has to be small relative to the RAMP RATE, not just small:
    // 1e-4 into a 50 ms attack is already 0.06px off the handle.
    const eps = 1e-9
    expect(envMarkerAt(a - eps, { a, d, holdSec, r }, g, BOX)!.x).toBeCloseTo(g.ax, 2)
    expect(envMarkerAt(a + d - eps, { a, d, holdSec, r }, g, BOX)!.x).toBeCloseTo(g.dx, 2)
    expect(envMarkerAt(a + d + holdSec - eps, { a, d, holdSec, r }, g, BOX)!.x).toBeCloseTo(g.hx, 2)
  })

  it('crosses the sustain plateau over the HOLD, not at the decay rate', () => {
    /* The actual bug, stated directly. Halfway through the hold the marker
     * must be halfway across the plateau — the old code put it wherever the
     * decay ramp had reached by then, which for a long note was off the box. */
    const mid = envMarkerAt(a + d + holdSec / 2, { a, d, holdSec, r }, g, BOX)!
    expect(mid.x).toBeCloseTo((g.dx + g.hx) / 2, 1)
  })

  it('is finished after the release and says so', () => {
    expect(envMarkerAt(a + d + holdSec + r + 0.001, { a, d, holdSec, r }, g, BOX)).toBeNull()
    expect(envMarkerAt(-0.1, { a, d, holdSec, r }, g, BOX)).toBeNull()
  })
})

describe('the level follows the curve it rides', () => {
  const a = 0.02, d = 0.15, s = 0.5, r = 0.5, dur = 2
  const g = geom(a, d, s, r)
  const holdSec = dur - a - d

  it('starts at the base and reaches the peak at the end of the attack', () => {
    expect(envMarkerAt(0, { a, d, holdSec, r }, g, BOX)!.y).toBeCloseTo(base, 4)
    expect(envMarkerAt(a - 1e-9, { a, d, holdSec, r }, g, BOX)!.y).toBeCloseTo(peak, 2)
  })

  it('is still converging toward sustain during the hold, not snapped to it', () => {
    // decay and release are TIME CONSTANTS, so one of them is 63.2% of the way
    const atHandle = envMarkerAt(a + d - 1e-9, { a, d, holdSec, r }, g, BOX)!.y
    const late = envMarkerAt(a + d + holdSec - 1e-9, { a, d, holdSec, r }, g, BOX)!.y
    expect(Math.abs(late - g.sy), 'never got close to sustain').toBeLessThan(Math.abs(atHandle - g.sy))
    expect(late).not.toBe(g.sy)
  })

  it('ends at the base after the release', () => {
    const end = envMarkerAt(a + d + holdSec + r - 1e-4, { a, d, holdSec, r }, g, BOX)!
    expect(end.y).toBeGreaterThan(g.sy)
    expect(end.y).toBeLessThanOrEqual(base + 0.01)
  })
})
