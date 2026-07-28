import { describe, expect, it } from 'vitest'
import { Math2Kernel, MathKernel } from '../src/dsp/math'
import type { Math2Op, MathOp } from '../src/dsp/math'
import type { DspContext } from '../src/dsp/types'

/* Elementary math on signals. The interesting part is not that abs() is abs,
 * it is that the ops which CAN produce a NaN or an Infinity refuse to: a graph
 * has no way to report a bad sample, so one would spread downstream and
 * silence the voice with nothing visible to debug. */

const ctx: DspContext = { sampleRate: 48000 }

const run1 = (op: MathOp, xs: number[]): number[] => {
  const input = Float32Array.from(xs)
  const out = new Float32Array(xs.length)
  new MathKernel({ op }).process(xs.length, { in: input }, out, ctx)
  return [...out]
}

const run2 = (op: Math2Op, as: number[], bs: number[]): number[] => {
  const out = new Float32Array(as.length)
  new Math2Kernel({ op }).process(as.length, { a: Float32Array.from(as), b: Float32Array.from(bs) }, out, ctx)
  return [...out]
}

describe('unary math', () => {
  it('abs rectifies', () => {
    expect(run1('abs', [-1, -0.5, 0, 0.5, 1])).toEqual([1, 0.5, 0, 0.5, 1])
  })

  it('floor / ceil / round step the right way, including negatives', () => {
    const xs = [-1.5, -0.5, 0.4, 0.5, 1.5]
    expect(run1('floor', xs)).toEqual([-2, -1, 0, 0, 1])
    expect(run1('ceil', xs)).toEqual([-1, -0, 1, 1, 2])
    // JS rounds halves toward +Infinity: -0.5 -> -0, 0.5 -> 1
    expect(run1('round', xs)).toEqual([-1, -0, 0, 1, 2])
  })

  it('sign is -1/0/+1', () => {
    expect(run1('sign', [-3, -0.001, 0, 0.001, 3])).toEqual([-1, -1, 0, 1, 1])
  })

  it('sqrt of a negative is 0, never NaN', () => {
    const out = run1('sqrt', [4, 1, 0.25, 0, -1, -100])
    expect(out.slice(0, 4)).toEqual([2, 1, 0.5, 0])
    expect(out.slice(4)).toEqual([0, 0])
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('log of 0 or a negative is finite, not -Infinity', () => {
    const out = run1('log', [Math.E, 1, 0, -5])
    expect(out[0]).toBeCloseTo(1, 5)
    expect(out[1]).toBe(0)
    // floored at 1e-9
    expect(out[2]).toBeCloseTo(Math.log(1e-9), 3)
    expect(out[3]).toBeCloseTo(Math.log(1e-9), 3)
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('exp cannot overflow to Infinity', () => {
    const out = run1('exp', [0, 1, 1000, -1000])
    expect(out[0]).toBe(1)
    expect(out[1]).toBeCloseTo(Math.E, 5)
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
    expect(out[2]!).toBeGreaterThan(0)
    expect(out[3]!).toBeGreaterThanOrEqual(0)
  })

  it('exp and log invert each other over a musical range', () => {
    for (const x of [0.001, 0.5, 1, 10, 60]) {
      const back = run1('exp', run1('log', [x]))[0]!
      expect(back).toBeCloseTo(x, 2)
    }
  })

  it('sin and cos take radians', () => {
    const s = run1('sin', [0, Math.PI / 2, Math.PI])
    expect(s[0]).toBeCloseTo(0, 5)
    expect(s[1]).toBeCloseTo(1, 5)
    expect(s[2]).toBeCloseTo(0, 5)
    const c = run1('cos', [0, Math.PI])
    expect(c[0]).toBeCloseTo(1, 5)
    expect(c[1]).toBeCloseTo(-1, 5)
  })

  it('an unknown op falls back rather than crashing the voice', () => {
    const out = new Float32Array(2)
    new MathKernel({ op: 'nope' as MathOp }).process(2, { in: Float32Array.from([-1, 2]) }, out, ctx)
    expect([...out].every((v) => Number.isFinite(v))).toBe(true)
  })
})

describe('binary math', () => {
  it('min and max work per sample', () => {
    expect(run2('min', [1, -1, 0.5], [0.5, 0.5, 0.5])).toEqual([0.5, -1, 0.5])
    expect(run2('max', [1, -1, 0.5], [0.5, 0.5, 0.5])).toEqual([1, 0.5, 0.5])
  })

  it('max(0) is half-wave rectification', () => {
    // float32 round-trip, so compare per element rather than deep-equal
    const out = run2('max', [-1, -0.2, 0.2, 1], [0, 0, 0, 0])
    const want = [0, 0, 0.2, 1]
    out.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6))
  })

  it('mod is FLOORED, so a negative phase wraps forward', () => {
    // the whole reason this exists: JS % would give -0.1 and the phase would
    // run backwards off the end of a ramp
    const out = run2('mod', [-0.1, 0.25, 1.25, 2], [1, 1, 1, 1])
    expect(out[0]).toBeCloseTo(0.9, 5)
    expect(out[1]).toBeCloseTo(0.25, 5)
    expect(out[2]).toBeCloseTo(0.25, 5)
    expect(out[3]).toBeCloseTo(0, 5)
  })

  it('mod by 0 is 0, not NaN', () => {
    const out = run2('mod', [1, -1], [0, 0])
    expect(out).toEqual([0, 0])
  })

  it('mod takes the divisor sign (floored, not truncated)', () => {
    expect(run2('mod', [5], [-3])[0]).toBeCloseTo(-1, 5)
    expect(run2('mod', [-5], [3])[0]).toBeCloseTo(1, 5)
  })
})

describe('no op can emit a non-finite sample from finite input', () => {
  const UNARY: MathOp[] = ['abs', 'floor', 'ceil', 'round', 'sign', 'sqrt', 'exp', 'log', 'sin', 'cos']
  const xs = [-1e9, -100, -1, -1e-12, 0, 1e-12, 1, 100, 1e9]

  it.each(UNARY)('%s stays finite', (op) => {
    expect(run1(op, xs).every((v) => Number.isFinite(v))).toBe(true)
  })

  const BINARY: Math2Op[] = ['min', 'max', 'mod']
  it.each(BINARY)('%s stays finite (including a zero operand)', (op) => {
    const out = run2(op, xs, xs.map((_, i) => (i % 2 === 0 ? 0 : 1e9)))
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })
})
