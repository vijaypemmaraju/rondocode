import { describe, expect, it } from 'vitest'
import {
  formatBoolean,
  formatNumber,
  literalChange,
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
