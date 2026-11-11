import { describe, expect, it } from 'vitest'
import { nextBoundary } from '../src/session/quantize'

/* 120 bpm in 4/4 is 0.5 cps: one bar lasts two seconds. */
const CPS = 0.5

describe('nextBoundary', () => {
  it('lands on the next multiple of the phrase length, not merely the next bar', () => {
    expect(nextBoundary(9.25, CPS, 8, 0).cycle).toBe(16)
    expect(nextBoundary(9.25, CPS, 4, 0).cycle).toBe(12)
    expect(nextBoundary(9.25, CPS, 1, 0).cycle).toBe(10)
  })

  it('waits exactly the time left to the boundary when there is no lead', () => {
    // three quarters of a bar to go, at two seconds a bar
    expect(nextBoundary(9.25, CPS, 1, 0).waitMs).toBeCloseTo(1500, 6)
  })

  it('applies a swap the lead time BEFORE the boundary, so its downbeat is already queued', () => {
    const b = nextBoundary(9.25, CPS, 1, 150)
    expect(b.cycle).toBe(10)
    expect(b.waitMs).toBeCloseTo(1350, 6)
  })

  it('skips a boundary it is already inside the lead of, rather than landing late', () => {
    // 100 ms before bar 10 with a 150 ms lead: bar 10 cannot be made
    const b = nextBoundary(10 - 0.1 * CPS, CPS, 1, 150)
    expect(b.cycle).toBe(11)
    expect(b.waitMs).toBeCloseTo(100 + 2000 - 150, 6)
  })

  it('treats sitting exactly on a boundary as having missed it', () => {
    expect(nextBoundary(8, CPS, 8, 0).cycle).toBe(16)
  })

  it('never asks for a negative wait', () => {
    expect(nextBoundary(9.999999, CPS, 1, 0).waitMs).toBeGreaterThanOrEqual(0)
  })
})
