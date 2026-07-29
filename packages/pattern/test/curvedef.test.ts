import { afterEach, describe, expect, it } from 'vitest'
import { clearCurveShapes, curvedef, getCurveShapes, restoreCurveShapes, shape, snapshotCurveShapes } from '../src/curvedef'
import { curve } from '../src/curve'
import { F } from '../src/fraction'
import { TimeSpan } from '../src/types'

/* ------------------------------------------------------------------------- *
 * Named shapes, stored NORMALISED.
 *
 * That is the decision the whole thing rests on: `env` measures in seconds and
 * `curve()` in cycles, so a shape carrying real durations would mean two
 * different things depending on where you spent it. Storing fractions and
 * scaling at the point of use is what lets ONE definition serve both.
 * ------------------------------------------------------------------------- */

afterEach(() => clearCurveShapes())

describe('curvedef + shape', () => {
  it('scales the SAME definition into seconds or cycles', () => {
    curvedef('swell', [[0.25, 1], [0.75, 0.2]])
    expect(shape('swell', 0.8)).toEqual([[0.2, 1], [0.6000000000000001, 0.2]])
    expect(shape('swell', 16)).toEqual([[4, 1], [12, 0.2]])
  })

  it('fractions are RELATIVE, so editing one segment is not editing them all', () => {
    curvedef('a', [[0.25, 1], [0.75, 0.2]])
    curvedef('b', [[1, 1], [3, 0.2]])
    expect(shape('b', 0.8)).toEqual(shape('a', 0.8))
  })

  it('carries a per-segment curve through the scaling', () => {
    curvedef('c', [[1, 1, 4], [1, 0]])
    expect(shape('c', 2)).toEqual([[1, 1, 4], [1, 0]])
  })

  it('feeds a timeline lane, which is the point of normalising', () => {
    curvedef('swell', [[0.25, 1], [0.75, 0.2]])
    const p = curve(shape('swell', 16))
    const at = (c: number): number =>
      Number(p.query(new TimeSpan(F(c * 1000, 1000), F(c * 1000 + 1, 1000)))[0]!.value.toFixed(3))
    expect(at(2)).toBeCloseTo(0.5, 2)   // halfway up the 4-cycle rise
    expect(at(4)).toBeCloseTo(1, 2)
    expect(at(16)).toBeCloseTo(0.2, 2)
  })

  it('an unknown name THROWS, and says what it has', () => {
    // a silent [] would be a synth that makes no sound with nothing to look at
    curvedef('swell', [[1, 1]])
    expect(() => shape('nope', 1)).toThrow(/no curvedef by that name.*swell/)
  })

  it('refuses a definition that could never be scaled', () => {
    expect(() => curvedef('x', [])).toThrow(/at least one/)
    expect(() => curvedef('x', [[0, 1]])).toThrow(/length above 0/)
    expect(() => curvedef('two words', [[1, 1]])).toThrow(/identifier/)
    curvedef('ok', [[1, 1]])
    expect(() => shape('ok', 0)).toThrow(/positive number/)
  })

  it('redefining replaces, because an eval re-runs the whole program', () => {
    curvedef('x', [[1, 1]])
    curvedef('x', [[1, 0.5]])
    expect(shape('x', 1)).toEqual([[1, 0.5]])
  })

  it('snapshot/restore gives the eval layer all-or-nothing staging', () => {
    curvedef('kept', [[1, 1]])
    const snap = snapshotCurveShapes()
    curvedef('added', [[1, 1]])
    expect(getCurveShapes().size).toBe(2)
    restoreCurveShapes(snap)
    expect([...getCurveShapes().keys()]).toEqual(['kept'])
  })
})
