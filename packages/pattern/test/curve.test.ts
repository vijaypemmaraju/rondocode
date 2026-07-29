import { describe, expect, it } from 'vitest'
import { curve } from '../src/curve'
import { F } from '../src/fraction'
import { TimeSpan } from '../src/types'
import { rise } from '../src/arrange'

/* ------------------------------------------------------------------------- *
 * Automation over the timeline.
 *
 * `env` shapes a note; this shapes a section. The contract worth pinning is
 * that a given curve number means the SAME THING in both — the easing is
 * imported from the engine's kernel rather than rewritten, and if that ever
 * stopped being true the same patch would sound different depending on which
 * layer you wrote the modulation in.
 * ------------------------------------------------------------------------- */

/** Value at cycle `c`, over a hair-thin span (the signal samples its midpoint). */
const at = (p: ReturnType<typeof curve>, c: number): number =>
  Number(p.query(new TimeSpan(F(c * 1000, 1000), F(c * 1000 + 1, 1000)))[0]!.value.toFixed(3))

describe('curve: breakpoints in cycles', () => {
  const lane = curve([[8, 1], [4, 0.3], [16, 1]])

  it('runs the legs in order, each from where the last ended', () => {
    expect(at(lane, 0)).toBeCloseTo(0, 2)
    expect(at(lane, 4)).toBeCloseTo(0.5, 2)   // halfway up the 8-cycle rise
    expect(at(lane, 8)).toBeCloseTo(1, 2)
    expect(at(lane, 10)).toBeCloseTo(0.65, 2) // halfway down the sag
    expect(at(lane, 12)).toBeCloseTo(0.3, 2)
    expect(at(lane, 20)).toBeCloseTo(0.65, 2) // halfway back up
  })

  it('HOLDS the last level past the end rather than resetting', () => {
    expect(at(lane, 28)).toBeCloseTo(1, 2)
    expect(at(lane, 200)).toBeCloseTo(1, 2)
  })

  it('loops when asked, so it can be an LFO of any shape', () => {
    const l = curve([[4, 1], [4, 0]], { loop: true })
    expect(at(l, 2)).toBeCloseTo(0.5, 2)
    expect(at(l, 6)).toBeCloseTo(0.5, 2)
    expect(at(l, 10)).toBeCloseTo(0.5, 2) // second time round
  })

  it('starts where `from` says, not always at zero', () => {
    expect(at(curve([[8, 1]], { from: 0.5 }), 4)).toBeCloseTo(0.75, 2)
  })

  it('a zero-length leg is a STEP, not an error', () => {
    // a jump is a legitimate automation move, and dropping the leg would
    // silently retime every leg after it
    const stepped = curve([[0, 1], [4, 0]])
    expect(at(stepped, 0.5)).toBeGreaterThan(0.8)
    expect(at(stepped, 4)).toBeCloseTo(0, 2)
  })

  it('no points is the `from` level, not a crash', () => {
    expect(at(curve([]), 3)).toBe(0)
    expect(at(curve([], { from: 0.4 }), 3)).toBeCloseTo(0.4, 2)
  })
})

describe('curve: shape', () => {
  it('a per-leg curve overrides the lane-wide one', () => {
    const l = curve([[8, 1, 4], [8, 0]], { curve: 0 })
    expect(at(l, 2)).toBeGreaterThan(0.6)     // eased leg: well past a quarter
    expect(at(l, 12)).toBeCloseTo(0.5, 2)     // second leg still linear
  })

  it('means the SAME as the engine: curve 4 eases identically to env', () => {
    // env's own test measures .644/.881/.968 at 1/4, 1/2, 3/4 of a segment
    const l = curve([[8, 1, 4]])
    expect(at(l, 2)).toBeCloseTo(0.644, 2)
    expect(at(l, 4)).toBeCloseTo(0.881, 2)
    expect(at(l, 6)).toBeCloseTo(0.968, 2)
  })

  it('a linear two-point lane IS rise(), which it generalises', () => {
    const l = curve([[8, 1]])
    for (const c of [1, 3, 5, 7]) {
      const r = Number(rise(8).query(new TimeSpan(F(c * 1000, 1000), F(c * 1000 + 1, 1000)))[0]!.value.toFixed(3))
      expect(at(l, c)).toBeCloseTo(r, 2)
    }
  })
})
