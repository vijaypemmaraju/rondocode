import { describe, expect, it } from 'vitest'
import { lensClampX, scrubSpeedFactor, scrubStep, scrubText, scrubValue, speedSuffix } from '../src/editor/widgets/scrub'

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

describe('lensClampX (the scrub lens never leaves the viewport)', () => {
  it('centers on the finger when there is room', () => {
    expect(lensClampX(200, 80, 400)).toBe(200)
  })
  it('clamps at the left and right edges', () => {
    expect(lensClampX(0, 80, 400)).toBe(44)
    expect(lensClampX(400, 80, 400)).toBe(356)
  })
  it('a pill wider than the viewport pins to the left rule', () => {
    expect(lensClampX(10, 500, 400)).toBe(254)
  })
})

describe('scrubSpeedFactor (directional speed tiers)', () => {
  it('near the row: full speed', () => {
    expect(scrubSpeedFactor(0)).toBe(1)
    expect(scrubSpeedFactor(47)).toBe(1)
    expect(scrubSpeedFactor(-47)).toBe(1)
  })
  it('DOWN goes fine: x.1 then x.01', () => {
    expect(scrubSpeedFactor(48)).toBe(0.1)
    expect(scrubSpeedFactor(119)).toBe(0.1)
    expect(scrubSpeedFactor(120)).toBe(0.01)
    expect(scrubSpeedFactor(500)).toBe(0.01)
  })
  it('UP goes coarse: x10 then x100', () => {
    expect(scrubSpeedFactor(-48)).toBe(10)
    expect(scrubSpeedFactor(-119)).toBe(10)
    expect(scrubSpeedFactor(-120)).toBe(100)
    expect(scrubSpeedFactor(-500)).toBe(100)
  })
  it('lens suffixes', () => {
    expect(speedSuffix(1)).toBe('')
    expect(speedSuffix(10)).toBe('  x10')
    expect(speedSuffix(100)).toBe('  x100')
    expect(speedSuffix(0.1)).toBe('  x.1')
    expect(speedSuffix(0.01)).toBe('  x.01')
  })
  it('accumulating through tiers refines instead of jumping', () => {
    // 100px at full speed then 100px at x.1 ≈ 110 virtual px - the fine
    // segment contributes a tenth of what the coarse one did
    let vdx = 0
    let lastX = 0
    for (const [x, dy] of [[50, 0], [100, 0], [150, 60], [200, 60]] as const) {
      vdx += (x - lastX) * scrubSpeedFactor(dy)
      lastX = x
    }
    expect(vdx).toBeCloseTo(100 + 100 * 0.1)
  })
})
