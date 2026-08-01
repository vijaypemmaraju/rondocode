import { describe, expect, it } from 'vitest'
import { envGeometry, envPath, scanEnvPoints, BEND_LIMIT, BEND_TRAVEL, bendCurve, bendPixels, POLE, poleAt, poleLeg } from '../src/editor/rondo/envpoints'
import type { EnvPoint } from '../src/editor/rondo/envpoints'

/* ------------------------------------------------------------------------- *
 * The breakpoint editor's scan.
 *
 * adsr has four values in fixed roles; env has as many as you type. So the
 * shape is read out of the source, and EVERY number needs its own span —
 * because a drag rewrites one point and must leave the others spelled exactly
 * as they were. A span that points at the wrong number silently edits the
 * wrong part of somebody's envelope, which is what these pin.
 * ------------------------------------------------------------------------- */

const SRC = [
  'synth bell',
  '  saw note',
  '  * e',
  '  e = env .005 1 .15 .4 .5 .6 release:.3',
  '  f = env .005 1:3 .15 .4:-2 curve:1',
  '  g = env .005 1 .15',
  '  h = env .005 1  # a comment .9 .9',
].join('\n')

const at = (s: { from: number; to: number }): string => SRC.slice(s.from, s.to)

describe('scanEnvPoints', () => {
  it('reads every breakpoint, with a span on each number', () => {
    const [e] = scanEnvPoints(SRC)
    expect(e!.points.map((p) => [p.time, p.level])).toEqual([[0.005, 1], [0.15, 0.4], [0.5, 0.6]])
    expect(e!.points.map((p) => at(p.timeSpan))).toEqual(['.005', '.15', '.5'])
    expect(e!.points.map((p) => at(p.levelSpan))).toEqual(['1', '.4', '.6'])
  })

  it('keeps the SOURCE spelling addressable, so untouched points stay as written', () => {
    // `.005` must not be rewritten as `0.005` because a different point moved
    const [e] = scanEnvPoints(SRC)
    expect(at(e!.points[0]!.timeSpan)).toBe('.005')
  })

  it('carries a per-point curve and its span', () => {
    const f = scanEnvPoints(SRC)[1]!
    expect(f.points.map((p) => p.curve)).toEqual([3, -2])
    expect(f.points.map((p) => (p.curveSpan ? at(p.curveSpan) : null))).toEqual(['3', '-2'])
  })

  it('stops at a named argument rather than eating it as a breakpoint', () => {
    expect(scanEnvPoints(SRC)[0]!.points).toHaveLength(3) // release:.3 is not a point
    expect(scanEnvPoints(SRC)[1]!.curve).toBe(1)          // ...but is reported
  })

  it('SKIPS an odd list — half a breakpoint has no handle position', () => {
    // mid-typing, or a compile error; drawing it would put a handle somewhere
    // the source cannot represent. NOTE an odd list of VALUES, not of points:
    // one point is two numbers and is perfectly valid.
    expect(scanEnvPoints('  e = env .005 1 .15\n')).toEqual([])
    expect(scanEnvPoints('  e = env .005\n')).toEqual([])
    expect(scanEnvPoints('  e = env .005 1\n')[0]!.points).toHaveLength(1)
    // the three-value line in SRC produced nothing
    expect(scanEnvPoints(SRC).map((e) => e.points.length)).toEqual([3, 2, 1])
  })

  it('does not read past a comment', () => {
    const h = scanEnvPoints(SRC).at(-1)!
    expect(h.points).toHaveLength(1)
    expect(h.points[0]!.level).toBe(1)
  })

  it('knows which synth it is in, for the note marker', () => {
    expect(scanEnvPoints(SRC)[0]!.synth).toBe('bell')
  })

  it('anchors after the last breakpoint, before the named args', () => {
    const [e] = scanEnvPoints(SRC)
    expect(SRC.slice(0, e!.at).endsWith('.5 .6 ')).toBe(true)
  })
})

describe('envGeometry', () => {
  const pt = (time: number, level: number): EnvPoint =>
    ({ time, level, timeSpan: { from: 0, to: 0 }, levelSpan: { from: 0, to: 0 } })

  it('spaces points by DURATION, so a long decay looks long', () => {
    const g = envGeometry([pt(0.1, 1), pt(0.3, 0.5)], 100, 40, 4)
    expect(g[0]).toEqual({ x: 4, y: 36 })      // the origin, on the floor
    expect(g[1]!.x).toBeCloseTo(4 + 0.25 * 92, 1)  // a quarter of the total
    expect(g[2]!.x).toBeCloseTo(96, 1)             // the end
  })

  it('draws levels against a fixed 0..1, not the envelope’s own maximum', () => {
    // otherwise raising one point silently rescales every other one under the
    // cursor mid-drag
    const low = envGeometry([pt(1, 0.5)], 100, 40, 4)
    const high = envGeometry([pt(1, 0.5), pt(1, 1)], 100, 40, 4)
    expect(low[1]!.y).toBeCloseTo(high[1]!.y, 5)
  })

  it('survives a zero-length envelope without dividing by zero', () => {
    const g = envGeometry([pt(0, 1)], 100, 40, 4)
    expect(g.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * Bending a segment.
 *
 * The gesture lives on the SEGMENT rather than behind a modifier, because that
 * is where the bend visually is — and a modifier key is not reachable with a
 * thumb. What makes it work across both languages is that the SCANNER supplies
 * the punctuation: rondo spells a curve `1:3` and JS `[0.1, 1, 3]`, the same
 * number with different glue.
 * ------------------------------------------------------------------------- */
describe('curve insertion points', () => {
  it('rondo inserts `:3` right after the level', () => {
    const src = '  e = env .1 1 .3 .2\n'
    const [s] = scanEnvPoints(src)
    const ins = s!.points[0]!.curveInsert!
    expect(ins.prefix).toBe(':')
    expect(src.slice(0, ins.at) + `${ins.prefix}3` + src.slice(ins.at)).toBe('  e = env .1 1:3 .3 .2\n')
  })

  it('a point that ALREADY has one is rewritten, not re-inserted', () => {
    const [s] = scanEnvPoints('  e = env .1 1:4 .3 .2\n')
    expect(s!.points[0]!.curveSpan).toBeDefined()
    expect(s!.points[0]!.curveInsert).toBeUndefined()
  })
})

describe('envPath: a curve you can drag is a curve you can see', () => {
  const pt = (time: number, level: number, curve?: number): EnvPoint =>
    ({ time, level, ...(curve !== undefined ? { curve } : {}), timeSpan: { from: 0, to: 0 }, levelSpan: { from: 0, to: 0 } })

  it('emits ONE line per straight segment, so an ordinary envelope is unchanged', () => {
    expect(envPath([pt(0.1, 1), pt(0.3, 0.2)], 100, 40)).toBe('M 4.0 36.0 L 27.0 4.0 L 96.0 29.6')
  })

  it('samples a bent segment, and bends it the right way', () => {
    const d = envPath([pt(0.1, 1, 4), pt(0.3, 0.2)], 100, 40)
    expect(d.split(' L ').length).toBeGreaterThan(5) // sampled, not a straight L
    // a positive curve rises FAST: a quarter of the way along, well past half
    // way up (y counts down from the floor at 36 to the ceiling at 4)
    const first = d.split(' L ')[3]!.split(' ').map(Number)
    expect(first[1]!).toBeLessThan(20)
  })

  it('falls back to the envelope-wide curve for points without their own', () => {
    const bent = envPath([pt(0.1, 1)], 100, 40, 4, 4)
    const flat = envPath([pt(0.1, 1)], 100, 40, 4, 0)
    expect(bent).not.toBe(flat)
    expect(flat).toBe('M 4.0 36.0 L 96.0 4.0')
  })
})

/* ------------------------------------------------------------------------- *
 * The bend gesture's pixel law.
 *
 * A curve exponent is not perceptually linear — the first two units carry
 * half the visible change and the last six carry the other half — so a
 * straight px/unit drag spent most of itself on differences you cannot see.
 * The total reach is about what it was; the pixels are distributed better.
 * ------------------------------------------------------------------------- */
describe('bendCurve / bendPixels', () => {
  /** The engine's easing, sampled at the segment midpoint: the one number that
   *  says how bent a segment LOOKS. */
  const mid = (c: number): number =>
    c === 0 ? 0.5 : (1 - Math.exp(-c * 0.5)) / (1 - Math.exp(-c))

  it('is flat at rest and hits the limit at exactly one travel', () => {
    expect(bendCurve(0)).toBe(0)
    expect(bendCurve(BEND_TRAVEL)).toBeCloseTo(BEND_LIMIT, 10)
    expect(bendCurve(-BEND_TRAVEL)).toBeCloseTo(-BEND_LIMIT, 10)
  })

  it('clamps past the ends instead of running away', () => {
    expect(bendCurve(BEND_TRAVEL * 4)).toBe(BEND_LIMIT)
    expect(bendCurve(-BEND_TRAVEL * 4)).toBe(-BEND_LIMIT)
  })

  it('round-trips, which is what makes the gesture absolute', () => {
    // drag up then back down has to land on the curve you started from
    for (const c of [-8, -3.4, -0.5, 0, 0.1, 1, 2.5, 6, 8]) {
      expect(bendCurve(bendPixels(c))).toBeCloseTo(c, 10)
    }
  })

  it('is symmetric — a downward drag bends by as much as an upward one', () => {
    for (const px of [10, 37, 80, 119]) expect(bendCurve(-px)).toBeCloseTo(-bendCurve(px), 10)
  })

  it('tracks the VISIBLE bend far better than a linear px/unit law would', () => {
    // the property that motivated the change: equal pixel fractions should
    // produce equal fractions of the visible travel
    const span = mid(BEND_LIMIT) - mid(0)
    const seen = (c: number): number => (mid(c) - mid(0)) / span
    const linear = (x: number): number => BEND_LIMIT * x // the old law, normalised
    let warped = 0
    let straight = 0
    for (const x of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
      warped = Math.max(warped, Math.abs(seen(bendCurve(x * BEND_TRAVEL)) - x))
      straight = Math.max(straight, Math.abs(seen(linear(x)) - x))
    }
    expect(straight).toBeGreaterThan(0.28) // the old law was off by ~0.29
    expect(warped).toBeLessThan(0.13)
    expect(warped).toBeLessThan(straight / 2)
  })

  it('reaches full bend in about the same drag as the law it replaced', () => {
    // NOT a reachability fix: 8 units at the old 14 px/unit was 112 px and
    // this is 120. Claiming otherwise would be claiming a benefit that is not
    // there — the benefit is entirely in the distribution, checked below.
    expect(Math.abs(bendPixels(BEND_LIMIT) - 8 * 14)).toBeLessThan(16)
  })

  it('hands the useful 0..3 region most of the drag, where the old law gave it a third', () => {
    expect(bendPixels(3) / bendPixels(BEND_LIMIT)).toBeGreaterThan(0.6) // 74 of 120 px
    expect(3 / BEND_LIMIT).toBeLessThan(0.4) // the old law: 42 of 112 px
  })
})

/* ------------------------------------------------------------------------- *
 * The ADSR widget must draw the envelope the ENGINE produces.
 *
 * It drew straight lines. The engine's decay and release are one-pole
 * (`gD = 1 - exp(-1/(d*sr))`), so `d` is a time constant, not a duration:
 * measured on the real kernel with a .05 d .2 s .4, the level at a+d is 0.620,
 * not the sustain 0.4. The widget was claiming sustain arrived there.
 *
 * These pin the drawing against that measurement.
 * ------------------------------------------------------------------------- */
describe('poleAt matches the measured kernel', () => {
  it('is 63.2% of the way after ONE time constant', () => {
    // measured on the real kernel: peak 1.0, sustain 0.4, level at a+d =
    // 0.6200. The analytic value is 0.62073; the measurement is sampled at a
    // block boundary rather than exactly at a+d, hence the last digit.
    expect(poleAt(1, 0.4, 1)).toBeCloseTo(0.6207, 4)
    expect(Math.abs(poleAt(1, 0.4, 1) - 0.62)).toBeLessThan(0.001)
  })

  it('tracks the measured decay at 2, 3 and 6 time constants', () => {
    expect(poleAt(1, 0.4, 2)).toBeCloseTo(0.4812, 3) // measured 0.4809
    expect(poleAt(1, 0.4, 3)).toBeCloseTo(0.4299, 3) // measured 0.4298
    expect(poleAt(1, 0.4, 6)).toBeCloseTo(0.4015, 3) // measured 0.4015
  })

  it('starts at the start and never reaches the target', () => {
    expect(poleAt(1, 0.4, 0)).toBe(1)
    expect(poleAt(1, 0.4, 30)).toBeGreaterThan(0.4)
  })
})

describe('poleLeg', () => {
  it('is still short of the target at one time constant', () => {
    // y grows downward in the widget: peak=5, sustain=35
    const d = poleLeg(10, 5, 30, 35, 30, 20)
    const pts = [...d.matchAll(/L ([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
    const atHandle = pts.find(([x]) => Math.abs(x! - 30) < 0.6)!
    expect(atHandle[1]).toBeCloseTo(5 + (35 - 5) * (1 - Math.exp(-1)), 0)
    expect(atHandle[1]).toBeLessThan(35) // has NOT arrived
  })

  it('keeps converging past the handle, which is the point', () => {
    const d = poleLeg(10, 5, 30, 35, 70, 20)
    const pts = [...d.matchAll(/L ([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]))
    expect(pts[pts.length - 1]).toBeGreaterThan(pts[Math.floor(pts.length / 2)]!)
    expect(pts[pts.length - 1]).toBeLessThan(35)
  })

  it('is monotonic, so the drawn curve never doubles back', () => {
    const ys = [...poleLeg(0, 5, 20, 35, 60).matchAll(/L [\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]))
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThanOrEqual(ys[i - 1]!)
  })

  it('survives a zero-width first constant without producing NaN', () => {
    expect(poleLeg(10, 5, 10, 35, 40)).not.toContain('NaN')
  })
})

describe('the sustain drag inverts the handle position', () => {
  it('round-trips: the y a sustain puts the handle at maps back to it', () => {
    const base = 45, peak = 5
    for (const s of [0, 0.25, 0.5, 0.75, 1]) {
      const sy = base - s * (base - peak)
      const handleY = poleAt(peak, sy, 1) // where the widget draws it
      const wantSy = (handleY - peak * POLE) / (1 - POLE) // the widget's inverse
      expect((base - wantSy) / (base - peak)).toBeCloseTo(s, 6)
    }
  })
})
