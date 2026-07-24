import { describe, expect, it } from 'vitest'
import { scanKnobs, scanEnvs, toNorm, fromNorm } from '../src/editor/rondo/widgets'
import { scanNumbersText } from '../src/editor/widgets/detect'

/* The pure parts of the inline rondo knob widget: finding knob bindings in the
 * source (and pinpointing the DEF value's range so a drag rewrites the right
 * chars) + the log/linear value↔position mapping. */

describe('scanKnobs', () => {
  it('finds a knob and pinpoints the DEF value range', () => {
    const src = 'cutoff = knob 800 80..8000 log'
    const [k] = scanKnobs(src)
    expect(k).toBeDefined()
    expect(src.slice(k!.defFrom, k!.defTo)).toBe('800') // the drag edits exactly this
    expect(k).toMatchObject({ value: 800, lo: 80, hi: 8000, log: true })
  })

  it('defaults to linear when no curve is given, and handles decimals', () => {
    const [k] = scanKnobs('wet = knob .35 0..0.7')
    expect(k).toMatchObject({ value: 0.35, lo: 0, hi: 0.7, log: false })
  })

  it('finds multiple knobs on multiple lines', () => {
    expect(scanKnobs('a = knob 1 0..2\nb = knob 3 0..5 lin')).toHaveLength(2)
  })
})

describe('scanEnvs', () => {
  it('finds an adsr and its four values + region', () => {
    const src = 'env = adsr .003 .2 .3 .1'
    const [e] = scanEnvs(src)
    expect(e).toBeDefined()
    expect(src.slice(e!.from, e!.to)).toBe('.003 .2 .3 .1') // the region a drag rewrites
    expect(e).toMatchObject({ a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
  })
  it('does not match adsr with fewer than four values', () => {
    expect(scanEnvs('env = adsr .003 .2')).toHaveLength(0)
  })
})

describe('scanNumbersText (language-agnostic scrub fallback — every number in rondo)', () => {
  it('finds standalone numbers, skipping a range second-operand', () => {
    const vals = scanNumbersText('cutoff = knob 800 80..8000 log').map((n) => n.value)
    expect(vals).toContain(800)
    expect(vals).toContain(80)
  })
  it('handles decimals and flags non-integers', () => {
    const nums = scanNumbersText('adsr .003 .2 .3 .1')
    expect(nums.map((n) => n.value)).toEqual([0.003, 0.2, 0.3, 0.1])
    expect(nums.every((n) => !n.isInt)).toBe(true)
  })
  it('folds a unary minus and detects integers', () => {
    const [n] = scanNumbersText('add -12')
    expect(n).toMatchObject({ value: -12, isInt: true })
  })
})

describe('knob value ↔ position mapping', () => {
  it('linear round-trips', () => {
    expect(fromNorm(toNorm(50, 0, 100, false), 0, 100, false)).toBeCloseTo(50)
    expect(toNorm(0, 0, 100, false)).toBe(0)
    expect(toNorm(100, 0, 100, false)).toBe(1)
  })
  it('log round-trips and puts the geometric mean at the middle', () => {
    expect(fromNorm(toNorm(800, 80, 8000, true), 80, 8000, true)).toBeCloseTo(800)
    // geometric mean of 80 and 8000 is 800 → dead centre on a log knob
    expect(toNorm(800, 80, 8000, true)).toBeCloseTo(0.5)
  })
})
