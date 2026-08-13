import { describe, expect, it } from 'vitest'
import {
  curveHandles,
  curveLanePath,
  clampCurveLevel,
  curveLevelAt,
  fmtCurveNum,
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
