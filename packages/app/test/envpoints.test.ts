import { describe, expect, it } from 'vitest'
import { envGeometry, envPath, scanEnvPoints } from '../src/editor/rondo/envpoints'
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
