import { describe, expect, it } from 'vitest'
import { DUCK_DEFAULTS, duckGain, scanDucks } from '../src/editor/rondo/duckcurve'

/* `sidechain kick depth:.7 release:.2 lead:.99 sub:.8` hides two things: the
 * SHAPE (how far it drops, how fast it returns — the pump you actually tune)
 * and the SPREAD (`lead` and `sub` duck by different amounts, and nothing said
 * so). This pins both, away from any canvas. */

describe('duckGain', () => {
  it('is fully ducked at the trigger and open long after', () => {
    expect(duckGain(0, 0.7, 0.2)).toBeCloseTo(0.3)
    expect(duckGain(5, 0.7, 0.2)).toBeCloseTo(1, 3)
  })

  it('recovers MONOTONICALLY — a pump that dipped twice is not a pump', () => {
    let prev = -1
    for (let t = 0; t <= 1; t += 0.02) {
      const g = duckGain(t, 0.8, 0.25)
      expect(g).toBeGreaterThanOrEqual(prev)
      prev = g
    }
  })

  it('recovers FASTEST just after the hit, which is what makes it a pump', () => {
    /* Exponential, not linear: a linear ramp back reads as a fade.
     *
     * This used to sample two points — 0..0.05 against 0.5..0.55 — and a
     * LINEAR ramp passed it, because by 0.5s a linear recovery has already
     * finished and its late delta is exactly 0, which any positive early
     * delta beats. The contract is the SHAPE, so assert the shape: each
     * increment strictly smaller than the one before it, the whole way up.
     * A straight line has constant increments and fails on the first pair. */
    const step = 0.02
    let prevDelta = Infinity
    for (let t = 0; t < 0.6; t += step) {
      const delta = duckGain(t + step, 0.7, 0.3) - duckGain(t, 0.7, 0.3)
      expect(delta, `increment at t=${t.toFixed(2)} did not shrink`).toBeLessThan(prevDelta)
      prevDelta = delta
    }
  })

  it('a longer release holds the duck down longer', () => {
    expect(duckGain(0.2, 0.7, 0.5)).toBeLessThan(duckGain(0.2, 0.7, 0.1))
  })

  it('depth 0 never ducks; depth 1 ducks to silence', () => {
    expect(duckGain(0, 0, 0.2)).toBeCloseTo(1)
    expect(duckGain(0, 1, 0.2)).toBeCloseTo(0)
  })

  it('is 1 before the trigger, and safe at release 0', () => {
    expect(duckGain(-0.1, 0.7, 0.2)).toBe(1)
    expect(duckGain(0.1, 0.7, 0)).toBe(1)
  })
})

describe('scanDucks', () => {
  it('reads the trigger, the shape, and the per-channel SPREAD', () => {
    const [d] = scanDucks('sidechain kick depth:.7 release:.2 lead:.99 sub:.8\n')
    expect(d!.trigger).toBe('kick')
    expect(d!.depth).toBe(0.7)
    expect(d!.release).toBe(0.2)
    // anything that is not depth/release is a CHANNEL being ducked
    expect(d!.channels).toEqual([{ name: 'lead', amount: 0.99 }, { name: 'sub', amount: 0.8 }])
  })

  it('fills an omitted shape arg from the engine default, not from zero', () => {
    const [d] = scanDucks('sidechain kick lead:.5\n')
    expect(d!.depth).toBe(DUCK_DEFAULTS.depth)
    expect(d!.release).toBe(DUCK_DEFAULTS.release)
    expect(d!.channels).toEqual([{ name: 'lead', amount: 0.5 }])
  })

  /* The test above compares the scanner against DUCK_DEFAULTS, so it says
   * nothing about whether DUCK_DEFAULTS is RIGHT — and it wasn't. The widget
   * shipped at 0.7 / 0.2 while a bare `sidechain kick` actually ducks 0.6 and
   * recovers over 180 ms, so the drawn pump was deeper and slower than the
   * one playing. Three copies of these two numbers exist; this is the seam
   * that holds them together. */
  it('and DUCK_DEFAULTS is what an omitted arg REALLY does, all three copies', async () => {
    const [{ DEFAULT_SIDECHAIN_DEPTH, DEFAULT_SIDECHAIN_RELEASE_SEC }, engine] = await Promise.all([
      import('../src/session/evalCode'),
      import('@rondocode/engine'),
    ])
    // the DSL layer is what a bare `sidechain('kick')` hits
    expect(DUCK_DEFAULTS.depth, 'widget vs the DSL default').toBe(DEFAULT_SIDECHAIN_DEPTH)
    expect(DUCK_DEFAULTS.release, 'widget vs the DSL default').toBe(DEFAULT_SIDECHAIN_RELEASE_SEC)
    // and the DSL layer must agree with the engine it is defaulting FOR
    expect(DEFAULT_SIDECHAIN_DEPTH, 'DSL vs engine').toBe(engine.DEFAULT_DUCK_DEPTH)
    expect(DEFAULT_SIDECHAIN_RELEASE_SEC * 1000, 'DSL vs engine (sec -> ms)')
      .toBeCloseTo(engine.DEFAULT_DUCK_RELEASE_MS, 6)
  })

  it('a bare sidechain still draws — the trigger is the only required part', () => {
    const [d] = scanDucks('sidechain kick\n')
    expect(d!.trigger).toBe('kick')
    expect(d!.channels).toEqual([])
  })

  it('anchors at the end of the line, past a trailing comment', () => {
    const doc = 'sidechain kick depth:.7 # the pump\n'
    const [d] = scanDucks(doc)
    expect(doc.slice(d!.at - 2, d!.at), 'anchors past the stripped comment').toBe('.7')
  })

  it('finds nothing where there is no sidechain', () => {
    expect(scanDucks('synth q\n  saw\n\ncps .5\n')).toEqual([])
  })

  it('handles a depth that names a MACRO rather than a number', () => {
    // `depth:drums` is a macro reference — not a number, so the default holds
    // rather than the scan producing NaN and drawing a curve made of holes
    const [d] = scanDucks('sidechain kick depth:drums release:.2\n')
    expect(Number.isFinite(d!.depth)).toBe(true)
    expect(d!.depth).toBe(DUCK_DEFAULTS.depth)
  })
})
