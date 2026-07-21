import { describe, expect, it } from 'vitest'
import { scrubStep, scrubText, scrubValue } from '../src/editor/widgets/scrub'

/* Pure scrub math: pixels → value. Per-100px delta is 10% of |start|
 * (floor 0.01; floor 1 for integer literals), quantized to a nice step. */

describe('scrubValue', () => {
  it('100px moves a float by 10% of its magnitude', () => {
    expect(scrubValue(0.5, 100, false)).toBeCloseTo(0.55, 10)
    expect(scrubValue(0.5, -100, false)).toBeCloseTo(0.45, 10)
  })

  it('floors the rate at 0.01 per 100px near zero', () => {
    expect(scrubValue(0, 100, false)).toBeCloseTo(0.01, 10)
    expect(scrubValue(0.003, 10, false)).toBeCloseTo(0.004, 10)
  })

  it('integer literals stay integers at a usable rate', () => {
    const v = scrubValue(5, 50, true)
    expect(Number.isInteger(v)).toBe(true)
    expect(v).toBe(6) // 1 per 100px floor → +0.5 rounds up
    expect(scrubValue(2, 10, true)).toBe(2)
    expect(Number.isInteger(scrubValue(800, 137, true))).toBe(true)
  })

  it('large values scrub proportionally', () => {
    expect(scrubValue(800, 100, true)).toBe(880)
  })

  it('negative deltas cross zero cleanly', () => {
    expect(scrubValue(0.01, -100, false)).toBeCloseTo(-0.0, 10)
  })
})

describe('scrubText', () => {
  it('emits clean literals (no float noise)', () => {
    expect(scrubText(0.1, 30, false)).toBe('0.103')
    expect(scrubText(0.1, 15, false)).toBe('0.102')
    expect(scrubText(5, 50, true)).toBe('6')
  })

  it('unmoved drag reproduces a clean spelling of the start value', () => {
    expect(scrubText(0.5, 0, false)).toBe('0.5')
    expect(scrubText(800, 0, true)).toBe('800')
  })
})

describe('scrubStep', () => {
  it('quantum is nice and proportionate', () => {
    expect(scrubStep(0.5, false).quantum).toBe(0.005)
    expect(scrubStep(800, true).quantum).toBe(5)
    expect(scrubStep(5, true).quantum).toBe(1)
  })
})
