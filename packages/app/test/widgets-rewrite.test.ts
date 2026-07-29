import { describe, expect, it } from 'vitest'
import {
  formatBoolean,
  formatNumber,
  literalChange,
  literalWidth,
  niceStep,
  numberChange,
} from '../src/editor/widgets/rewrite'

describe('niceStep', () => {
  it('snaps to the largest 1/2/5 step not above the raw step', () => {
    expect(niceStep(39.6)).toBe(20)
    expect(niceStep(0.005)).toBe(0.005)
    expect(niceStep(0.03)).toBe(0.02)
    expect(niceStep(1)).toBe(1)
    expect(niceStep(7)).toBe(5)
    expect(niceStep(100)).toBe(100)
  })

  it('degrades safely on nonsense input', () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(-3)).toBe(1)
    expect(niceStep(Infinity)).toBe(1)
  })
})

describe('formatNumber', () => {
  it('defaults: 3 significant figures, integers exact', () => {
    expect(formatNumber(0.75)).toBe('0.75')
    expect(formatNumber(0.123456)).toBe('0.123')
    expect(formatNumber(800)).toBe('800')
    expect(formatNumber(-0.5)).toBe('-0.5')
  })

  it('step-aware: quantizes to the grid anchored at min, exact decimals', () => {
    expect(formatNumber(831.4, { step: 20, min: 80 })).toBe('840')
    expect(formatNumber(0.7521, { step: 0.005 })).toBe('0.75')
    expect(formatNumber(0.7549, { step: 0.005 })).toBe('0.755')
  })

  it('never emits float noise or dangling zeros', () => {
    expect(formatNumber(0.1 + 0.2, { step: 0.05 })).toBe('0.3')
    expect(formatNumber(0.75, { step: 0.001 })).toBe('0.75')
  })

  it('negative values survive step rounding', () => {
    expect(formatNumber(-0.52, { step: 0.05 })).toBe('-0.5')
  })
})

describe('literal changes', () => {
  it('replacing 0.5 with 0.75 targets the exact range', () => {
    const doc = `.gain(0.5).dur(0.5)`
    const from = doc.indexOf('0.5')
    const change = numberChange({ from, to: from + 3 }, 0.75)
    expect(change).toEqual({ from: 6, to: 9, insert: '0.75' })
    // applying it touches only the first 0.5
    const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
    expect(next).toBe('.gain(0.75).dur(0.5)')
  })

  it('booleans and raw strings pass through literalChange', () => {
    expect(formatBoolean(true)).toBe('true')
    expect(formatBoolean(false)).toBe('false')
    expect(literalChange({ from: 3, to: 12 }, `"c major"`)).toEqual({
      from: 3,
      to: 12,
      insert: `"c major"`,
    })
  })
})

/* ------------------------------------------------------------------------- *
 * Reserved literal width.
 *
 * A knob sits immediately after its DEF literal, and a drag rewrites that
 * literal to widths that differ by whole characters. Without a reservation the
 * dial slides sideways under the finger holding it, which is what this is for.
 * ------------------------------------------------------------------------- */
describe('literalWidth', () => {
  const widest = (lo: number, hi: number, step: number): number => {
    // the true answer, by brute force over the step grid the drag walks
    let w = 0
    for (let v = Math.min(lo, hi); v <= Math.max(lo, hi) + step / 2; v += step) {
      w = Math.max(w, formatNumber(v, { step, min: Math.min(lo, hi) }).length)
    }
    return w
  }

  it('is never NARROWER than the widest literal a drag can write', () => {
    // under-reserving is the jiggle, so this is the assertion that matters
    for (const [lo, hi] of [[0, 1], [500, 7300], [80, 8000], [0, 0.5], [20, 20000], [-12, 12]]) {
      const step = niceStep(Math.abs(hi! - lo!) / 200)
      expect(literalWidth(lo!, hi!, step), `${lo}..${hi}`).toBeGreaterThanOrEqual(widest(lo!, hi!, step))
    }
  })

  it('stays tight — it is a reservation, not a gutter', () => {
    expect(literalWidth(500, 7300, 20)).toBe(4)   // "7300"
    expect(literalWidth(0, 1, 0.005)).toBe(5)     // "0.005"
    expect(literalWidth(-12, 12, 0.1)).toBe(5)    // "-12.1"
  })

  it('caps a pathological range rather than reserving half the line', () => {
    expect(literalWidth(0, 1e-9, 1e-12)).toBeLessThanOrEqual(12)
  })

  it('a padded knob holds still: literal + reserve is constant across the sweep', () => {
    const [lo, hi] = [0, 1]
    const step = niceStep(1 / 200)
    const max = literalWidth(lo, hi, step)
    const widths = new Set<number>()
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const text = formatNumber(lo + (hi - lo) * t, { step, min: lo })
      widths.add(text.length + Math.max(0, max - text.length))
    }
    expect([...widths]).toEqual([max]) // one width, whatever the value
  })
})
