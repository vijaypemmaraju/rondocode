import { describe, it, expect } from 'vitest'
import { DelayKernel } from '../src/dsp/delay'
import { NoiseKernel } from '../src/dsp/osc'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

/** Run a delay over `input` with constant time/feedback, in `block`-sized
 *  chunks. */
const runDelay = (
  k: DelayKernel,
  input: Float32Array,
  time: number,
  feedback: number,
  block = input.length,
): Float32Array => {
  const n = input.length
  const out = new Float32Array(n)
  const t = new Float32Array(n).fill(time)
  const fb = new Float32Array(n).fill(feedback)
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    k.process(
      m,
      { in: input.subarray(i, i + m), time: t.subarray(i, i + m), feedback: fb.subarray(i, i + m) },
      out.subarray(i, i + m),
      ctx,
    )
  }
  return out
}

const impulse = (n: number): Float32Array => {
  const x = new Float32Array(n)
  x[0] = 1
  return x
}

const maxAbs = (out: Float32Array): number => {
  let peak = 0
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]!)
    if (a > peak) peak = a
  }
  return peak
}

const argMaxAbs = (out: Float32Array): number => {
  let peak = 0
  let at = 0
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]!)
    if (a > peak) {
      peak = a
      at = i
    }
  }
  return at
}

describe('DelayKernel', () => {
  it('delays an impulse by time seconds (4800 +/- 1 samples at 0.1s)', () => {
    const out = runDelay(new DelayKernel(), impulse(6000), 0.1, 0)
    const at = argMaxAbs(out)
    expect(Math.abs(at - 4800)).toBeLessThanOrEqual(1)
    expect(out[at]!).toBeGreaterThan(0.9)
    // Wet-only: nothing before the first echo.
    expect(maxAbs(out.subarray(0, 4799))).toBe(0)
  })

  it('feedback 0.5 produces echoes at 2x and 3x with ~0.5 and ~0.25 amplitude', () => {
    const out = runDelay(new DelayKernel(), impulse(3 * 4800 + 100), 0.1, 0.5)
    const near = (center: number): number => maxAbs(out.subarray(center - 2, center + 3))
    expect(near(4800)).toBeGreaterThan(0.95)
    expect(near(9600)).toBeGreaterThan(0.45)
    expect(near(9600)).toBeLessThan(0.55)
    expect(near(14400)).toBeGreaterThan(0.2)
    expect(near(14400)).toBeLessThan(0.3)
  })

  it('time modulation stays bounded (sweep 0.05 -> 0.15 over one second)', () => {
    const n = sr
    const input = new Float32Array(n)
    new NoiseKernel(99).process(n, {}, input, ctx)
    const t = new Float32Array(n)
    for (let i = 0; i < n; i++) t[i] = 0.05 + (0.1 * i) / (n - 1)
    const fb = new Float32Array(n).fill(0.3)
    const out = new Float32Array(n)
    new DelayKernel().process(n, { in: input, time: t, feedback: fb }, out, ctx)
    for (let i = 0; i < n; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    expect(maxAbs(out)).toBeLessThan(10)
  })

  it('feedback 1.5 is clamped: 3s of runaway stays bounded', () => {
    const out = runDelay(new DelayKernel(), impulse(3 * sr), 0.05, 1.5, 512)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    // fb clamps to 0.99 and the soft knee bounds every write below 2.
    expect(maxAbs(out)).toBeLessThanOrEqual(2)
    // The echo train must actually persist (0.99^60 ~ 0.55 after 3s).
    expect(maxAbs(out.subarray(out.length - 4800))).toBeGreaterThan(0.3)
  })

  it('write bound is continuous: no crackle when the signal rides across |1|', () => {
    // 220Hz sine ramping 0 -> 1.3 over 1s, fb=0.9, 10ms delay: writes cross
    // the |v|=1 knee every cycle once the ramp passes 1. A discontinuous
    // bound (the old tanh-only-above-1) steps ~0.24 between adjacent writes
    // there, re-emerging every delay period as crackle; a slope-matched knee
    // keeps the output as smooth as the input. Max |first difference| of the
    // input is ~0.04; the old bound produced output diffs of ~0.24.
    const n = sr
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      input[i] = ((1.3 * i) / (n - 1)) * Math.sin((2 * Math.PI * 220 * i) / sr)
    }
    const out = runDelay(new DelayKernel(), input, 0.01, 0.9)
    const maxDiff = (x: Float32Array): number => {
      let m = 0
      for (let i = 1; i < x.length; i++) {
        const d = Math.abs(x[i]! - x[i - 1]!)
        if (d > m) m = d
      }
      return m
    }
    expect(maxDiff(input)).toBeLessThan(0.1) // the input itself is smooth
    expect(maxDiff(out)).toBeLessThan(0.15)
  })

  it('time is clamped to maxTime', () => {
    // time=5 on a maxTime=0.2 delay behaves as a 0.2s delay.
    const out = runDelay(new DelayKernel({ maxTime: 0.2 }), impulse(sr / 2), 5, 0)
    expect(Math.abs(argMaxAbs(out) - 0.2 * sr)).toBeLessThanOrEqual(2)
  })

  it('reset() clears the delay line', () => {
    const k = new DelayKernel()
    runDelay(k, impulse(1000), 0.1, 0.9)
    k.reset()
    const out = runDelay(k, new Float32Array(sr), 0.1, 0.9)
    expect(maxAbs(out)).toBe(0)
  })
})
