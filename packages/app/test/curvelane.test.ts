import { describe, expect, it } from 'vitest'
import {
  curveHandles,
  curveLanePath,
  clampCurveLevel,
  curveLevelAt,
  fmtCurveNum,
  insertPointEdit,
  removePointEdit,
  scanCurveLanes,
} from '../src/editor/rondo/curvelane'

/* ------------------------------------------------------------------------- *
 * `curve` was the one shape in this editor with no picture.
 *
 * The ADSR, the LFO, the filter response, the compressor transfer curve and
 * the sidechain duck are all drawn. Automation — the thing measured in BARS,
 * where a wrong number costs you a whole section — was eight numbers in a row.
 * It stayed invisible enough that it was reported as a missing feature while
 * it was shipping.
 *
 * The scan has to agree with the compiler about what a lane IS, or the picture
 * describes a program that is not running.
 * ------------------------------------------------------------------------- */

const doc = [
  'synth pad',
  '  saw note',
  '  svf cut res:.3',
  '  cut = knob 500 200..9000 log',
  '',
  'curvedef swell .25 1 .75 .2',
  '',
  'play pad',
  '  0 3 5',
  '  cut: curve 8 1 8 .35 400..7000',
  '  gain: curve 4 1:3 4 .5',
  '',
  'cps .5',
].join('\n')

describe('scanCurveLanes', () => {
  const lanes = scanCurveLanes(doc)

  it('finds a modifier lane, a curvedef, and nothing else', () => {
    expect(lanes.map((l) => l.name ?? `def:${l.def}`)).toEqual(['def:swell', 'cut', 'gain'])
  })

  it('keeps the RANGE suffix out of the breakpoints', () => {
    /* The bug this caught: matching a number pattern inside each token ate the
     * `400` of `400..7000`, leaving an odd count, and the whole lane was
     * discarded — so the line WITH a range, which is the normal way to write
     * one, was the only line that drew nothing. */
    const cut = lanes.find((l) => l.name === 'cut')!
    expect(cut.points).toHaveLength(2)
    expect(cut.range).toEqual([400, 7000])
    expect(cut.cycles).toBe(16)
  })

  it('reads per-leg easing from the `level:curve` form', () => {
    const gain = lanes.find((l) => l.name === 'gain')!
    expect(gain.points[0]!.curve).toBe(3)
    expect(gain.points[0]!.level).toBe(1)
    expect(gain.points[1]!.curve).toBeUndefined()
  })

  it('points at the exact numbers in the source, so a drag rewrites one', () => {
    const cut = lanes.find((l) => l.name === 'cut')!
    for (const p of cut.points) {
      expect(Number(doc.slice(p.tFrom, p.tTo))).toBe(p.cycles)
      expect(Number(doc.slice(p.lFrom, p.lTo))).toBe(p.level)
    }
    // the level range must EXCLUDE any `:curve`, or a drag would eat the easing
    const g = scanCurveLanes(doc).find((l) => l.name === 'gain')!
    expect(doc.slice(g.points[0]!.lFrom, g.points[0]!.lTo)).toBe('1')
  })

  it('tracks the enclosing synth, and a curvedef has none', () => {
    expect(lanes.find((l) => l.name === 'cut')!.synth).toBeUndefined()
    expect(scanCurveLanes('synth p\n  cut: curve 4 1\n')[0]!.synth).toBe('p')
  })

  it('refuses HALF a breakpoint rather than drawing a program that will not run', () => {
    // the compiler falls through to a diagnostic on an odd count
    expect(scanCurveLanes('play x\n  cut: curve 8 1 8\n')).toEqual([])
  })

  it('ignores a lane inside a comment', () => {
    expect(scanCurveLanes('play x\n  # cut: curve 8 1 8 .2\n')).toEqual([])
  })

  it('a lane with no pairs at all is not a lane', () => {
    expect(scanCurveLanes('play x\n  cut: curve\n')).toEqual([])
    expect(scanCurveLanes('play x\n  cut: curve sine\n')).toEqual([])
  })
})

describe('curveLevelAt', () => {
  const pts = scanCurveLanes(doc).find((l) => l.name === 'cut')!.points

  it('ramps from 0 to the first level over the first leg', () => {
    expect(curveLevelAt(pts, 0)).toBeCloseTo(0, 6)
    expect(curveLevelAt(pts, 4)).toBeCloseTo(0.5, 6)
    expect(curveLevelAt(pts, 8)).toBeCloseTo(1, 6)
  })

  it('HOLDS the last level instead of looping', () => {
    /* The property that makes this a lane and not an oscillator, and the one
     * that makes it usable across a section. */
    expect(curveLevelAt(pts, 16)).toBeCloseTo(0.35, 6)
    expect(curveLevelAt(pts, 30)).toBeCloseTo(0.35, 6)
    expect(curveLevelAt(pts, 1000)).toBeCloseTo(0.35, 6)
  })

  it('eases a leg that asks for it, and stays monotonic', () => {
    const eased = [{ cycles: 4, level: 1, curve: 3, tFrom: 0, tTo: 0, lFrom: 0, lTo: 0 }]
    const mid = curveLevelAt(eased, 2)
    expect(mid, 'a positive curve is fast-then-slow').toBeGreaterThan(0.5)
    let prev = -1
    for (let i = 0; i <= 20; i++) {
      const v = curveLevelAt(eased, (i / 20) * 4)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('a zero-length leg is a step, not a divide by zero', () => {
    const step = [{ cycles: 0, level: 0.7, tFrom: 0, tTo: 0, lFrom: 0, lTo: 0 }]
    expect(curveLevelAt(step, 0)).toBe(0.7)
    expect(Number.isFinite(curveLevelAt(step, 5))).toBe(true)
  })
})

describe('drawing', () => {
  const pts = scanCurveLanes(doc).find((l) => l.name === 'cut')!.points

  it('spans the box and never leaves it', () => {
    const xs = curveLanePath(pts, 100, 20).split(' ').map((p) => Number(p.split(',')[0]))
    const ys = curveLanePath(pts, 100, 20).split(' ').map((p) => Number(p.split(',')[1]))
    expect(Math.min(...xs)).toBe(0)
    expect(Math.max(...xs)).toBe(100)
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(-0.01)
      expect(y).toBeLessThanOrEqual(20.01)
    }
  })

  it('SAMPLES the shape, so an eased leg is a curve and not a straight line', () => {
    const eased = [{ cycles: 4, level: 1, curve: 4, tFrom: 0, tTo: 0, lFrom: 0, lTo: 0 }]
    const ys = curveLanePath(eased, 100, 20).split(' ').map((p) => Number(p.split(',')[1]))
    const mid = ys[Math.floor(ys.length / 2)]!
    const straight = (ys[0]! + ys[ys.length - 1]!) / 2
    expect(Math.abs(mid - straight), 'drawn as a straight line').toBeGreaterThan(1)
  })

  it('puts a handle at the END of each leg', () => {
    const h = curveHandles(pts, 100, 20)
    expect(h.map((x) => Math.round(x.x))).toEqual([50, 100])
    // the first breakpoint is the peak, so it sits at the top of the box
    expect(h[0]!.y).toBeLessThan(h[1]!.y)
  })

  it('an empty lane draws a flat line rather than nothing', () => {
    expect(curveLanePath([], 100, 20)).toBe('0,10 100,10')
    expect(curveHandles([], 100, 20)).toEqual([])
  })
})

describe('fmtCurveNum', () => {
  it('writes numbers the way the source does', () => {
    expect(fmtCurveNum(0.35)).toBe('.35')
    expect(fmtCurveNum(8)).toBe('8')
    expect(fmtCurveNum(-0.5)).toBe('-.5')
  })

  it('drops the float noise a drag produces', () => {
    expect(fmtCurveNum(0.30000000000000004)).toBe('.3')
    expect(fmtCurveNum(2.0000001)).toBe('2')
  })
})

describe('clampCurveLevel', () => {
  it('holds a RANGED lane inside 0..1, because the range does the mapping', () => {
    /* Measured: one upward drag on `curve 8 1 8 .35 400..7000` wrote `1.192`,
     * which asks for a cutoff above the top of its own range. */
    expect(clampCurveLevel(1.192, true)).toBe(1)
    expect(clampCurveLevel(-0.4, true)).toBe(0)
    expect(clampCurveLevel(0.35, true)).toBe(0.35)
  })

  it('leaves an UNRANGED lane alone, where the levels are the values', () => {
    // clamping there would be the widget overruling the program
    expect(clampCurveLevel(1.192, false)).toBe(1.192)
    expect(clampCurveLevel(-3, false)).toBe(-3)
  })
})

describe('the axis does not follow the value', () => {
  const at = (level: string): number[] => {
    const l = scanCurveLanes(`play x\n  cutoff: curve 0 0.7 4 ${level} 0..20000\n`)[0]!
    return curveHandles(l.points, 200, 38, 0, l.range !== undefined).map((h) => Number(h.y.toFixed(1)))
  }

  it('a dragged handle MOVES as its number changes', () => {
    /* Reported as "it barely moves when the number changes due to the scale of
     * the range". The axis was derived from the current levels, so the highest
     * point pinned itself to the top of the box: dragging it from 1 down to
     * 0.7 rescaled the axis and left the handle at y=0 the whole way. */
    const ys = ['1', '0.9', '0.8', '0.7'].map((v) => at(v)[1]!)
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]!, `level ${i} did not move`).toBeGreaterThan(ys[i - 1]!)
    }
    expect(ys[ys.length - 1]! - ys[0]!, 'the handle barely moved').toBeGreaterThan(8)
  })

  it('and the OTHER handles stay where they are', () => {
    // the giveaway that the axis was moving: everything shifted at once
    expect(at('1')[0]).toBe(at('0.7')[0])
  })

  it('an UNRANGED lane still derives its axis, because it has no declared one', () => {
    const l = scanCurveLanes('play x\n  cut: curve 4 400 4 7000\n')[0]!
    const h = curveHandles(l.points, 200, 38, 0, false)
    expect(h[1]!.y).toBeCloseTo(0, 5)
    expect(h[0]!.y).toBeGreaterThan(30)
  })
})

describe('adding and removing breakpoints', () => {
  const doc = 'play x\n  cutoff: curve 0 0.7 4 1 0..20000\n'
  const lane = scanCurveLanes(doc)[0]!
  const apply = (e: { from: number; to: number; insert: string } | null): string =>
    e === null ? '(refused)' : (doc.slice(0, e.from) + e.insert + doc.slice(e.to)).split('\n')[1]!

  it('splits a leg, PRESERVING the lane length', () => {
    /* Adding a point should change where the curve bends, never how long the
     * automation runs — a lane that got longer every time you shaped it would
     * drift out of its section. */
    const out = apply(insertPointEdit(lane, 1, 0.5, curveLevelAt(lane.points, 2)))
    expect(out).toBe('  cutoff: curve 0 0.7 2 .85 2 1 0..20000')
    const after = scanCurveLanes(`play x\n${out}\n`)[0]!
    expect(after.cycles).toBe(lane.cycles)
    expect(after.points).toHaveLength(3)
  })

  it('the new point sits ON the curve it split', () => {
    const out = apply(insertPointEdit(lane, 1, 0.5, curveLevelAt(lane.points, 2)))
    const after = scanCurveLanes(`play x\n${out}\n`)[0]!
    expect(curveLevelAt(after.points, 2)).toBeCloseTo(curveLevelAt(lane.points, 2), 2)
  })

  it('removes a breakpoint without leaving a gap in the line', () => {
    expect(apply(removePointEdit(lane, 1))).toBe('  cutoff: curve 0 0.7 0..20000')
    expect(apply(removePointEdit(lane, 0))).toBe('  cutoff: curve 4 1 0..20000')
  })

  it('and what is left still SCANS, which is the real test of an edit', () => {
    for (const i of [0, 1]) {
      const out = apply(removePointEdit(lane, i))
      expect(scanCurveLanes(`play x\n${out}\n`), `removing ${i} broke the lane`).toHaveLength(1)
    }
  })

  it('REFUSES to remove the last one', () => {
    /* A lane with no breakpoints is not a shorter lane, it is a syntax error:
     * `curve` with no pairs does not compile. A widget that can delete its own
     * program is worse than one that cannot delete at all. */
    const one = scanCurveLanes('play x\n  cutoff: curve 4 1\n')[0]!
    expect(removePointEdit(one, 0)).toBeNull()
  })

  it('clamps a split at the very edge, so a zero-length leg is not created', () => {
    const e = insertPointEdit(lane, 1, 0, 0.5)!
    expect(e.insert.startsWith('0 ')).toBe(false)
  })

  it('an out-of-range index edits nothing', () => {
    expect(insertPointEdit(lane, 9, 0.5, 0.5)).toBeNull()
    expect(removePointEdit(lane, 9)).toBeNull()
  })
})

describe('the picture follows the numbers during a drag', () => {
  /* The decoration is deliberately NOT rebuilt while a drag is in flight —
   * that would destroy the element the pointer is captured on — so the widget
   * has to move its own geometry. It did not, and the source updated under a
   * picture sitting perfectly still. Measured mid-drag before the fix: source
   * `1` -> `.474`, handle y unchanged at 4.
   *
   * The redraw is DOM work, so what is testable here is the geometry it is
   * driven by: the same inputs the live path and handles are computed from
   * have to move when a level does. */
  const lane = scanCurveLanes('play x\n  cut: curve 0 0.7 4 1 0..20000\n')[0]!

  it('a live level change moves the handle and the path', () => {
    const live = lane.points.map((q, k) => (k === 1 ? { ...q, level: 0.474 } : q))
    const before = curveHandles(lane.points, 200, 38, 0, true)[1]!.y
    const after = curveHandles(live, 200, 38, 0, true)[1]!.y
    expect(after, 'the handle did not move').toBeGreaterThan(before + 5)
    expect(curveLanePath(live, 200, 38, 0, true)).not.toBe(curveLanePath(lane.points, 200, 38, 0, true))
  })

  it('a live CYCLES change moves the bend sideways', () => {
    /* Needs THREE points. The x axis is normalised to the lane's total, so
     * stretching the only meaningful leg changes the duration and nothing
     * about the shape — my first version of this test asserted otherwise and
     * was simply wrong. */
    const three = scanCurveLanes('play x\n  cut: curve 2 1 2 .5 2 1 0..20000\n')[0]!
    const live = three.points.map((q, k) => (k === 0 ? { ...q, cycles: 4 } : q))
    const before = curveHandles(three.points, 200, 38, 0, true)[0]!.x
    const after = curveHandles(live, 200, 38, 0, true)[0]!.x
    expect(after, 'the bend did not move').toBeGreaterThan(before + 5)
  })
})

describe('successive edits stay correct, which needs a RE-SCAN each time', () => {
  /* The reported corruption. The widget holds a snapshot of the lane taken
   * when it was built, and one edit that changes the line's length invalidates
   * every offset in it. A stale offset does not fail — it splices into the
   * middle of a neighbour:
   *
   *   start     curve 2 1:3 2 .5 2 1 200..9000
   *   drag pt0  curve 2.146 1:3 2 .5 2 1 …        (fine)
   *   drag pt1  curve 2.146 1.913:.1842 .5 2 1 …  (wrote over the easing)
   *   drag pt2  curve 2.146 1.9132.218.1842 …     (wrote over that)
   *
   * The gesture re-reads the line now. This is that property in the pure
   * layer: edits composed through a re-scan stay right. */
  const apply = (doc: string, e: { from: number; to: number; insert: string } | null): string =>
    e === null ? doc : doc.slice(0, e.from) + e.insert + doc.slice(e.to)

  it('three edits in a row, each re-scanned, land where they should', () => {
    let doc = 'play x\n  cut: curve 2 1:3 2 .5 2 1 200..9000\n'
    for (const i of [0, 1, 2]) {
      const lane = scanCurveLanes(doc)[0]!
      const p = lane.points[i]!
      // the drag's edit: rewrite the whole pair as one range
      doc = apply(doc, { from: p.tFrom, to: p.lTo, insert: `${fmtCurveNum(p.cycles + 0.5)} ${fmtCurveNum(p.level)}` })
    }
    expect(doc.split('\n')[1]).toBe('  cut: curve 2.5 1:3 2.5 .5 2.5 1 200..9000')
  })

  it('a STALE offset is what corrupts it — the same edits without re-scanning', () => {
    /* Kept as the counter-example, because "re-scan each time" reads like
     * defensive boilerplate until you see what skipping it does. */
    const doc0 = 'play x\n  cut: curve 2 1:3 2 .5 2 1 200..9000\n'
    const stale = scanCurveLanes(doc0)[0]!
    let doc = doc0
    for (const i of [0, 1, 2]) {
      const p = stale.points[i]!
      doc = apply(doc, { from: p.tFrom, to: p.lTo, insert: `${fmtCurveNum(p.cycles + 0.5)} ${fmtCurveNum(p.level)}` })
    }
    expect(doc.split('\n')[1], 'stale offsets should mangle it').not.toBe('  cut: curve 2.5 1:3 2.5 .5 2.5 1 200..9000')
  })

  it('the per-leg easing survives an edit to its own pair', () => {
    const doc = 'play x\n  cut: curve 2 1:3 2 .5\n'
    const p = scanCurveLanes(doc)[0]!.points[0]!
    const out = apply(doc, { from: p.tFrom, to: p.lTo, insert: '2.146 1' })
    expect(out.split('\n')[1]).toBe('  cut: curve 2.146 1:3 2 .5')
    expect(scanCurveLanes(out)[0]!.points[0]!.curve, 'the easing was eaten').toBe(3)
  })
})
