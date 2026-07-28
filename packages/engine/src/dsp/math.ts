import type { DspContext, Kernel } from './types'
import { clamp } from './util'

/** All math kernels are stateless per-sample maps — reset() is a no-op and
 *  block-boundary continuity holds trivially. */

/** Multiply: out = a * b. Inputs 'a', 'b' (audio-rate). */
export class MulKernel implements Kernel {
  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const a = inputs['a']!
    const b = inputs['b']!
    for (let i = 0; i < n; i++) out[i] = a[i]! * b[i]!
  }

  reset(): void {}
}

/** Add: out = a + b. Inputs 'a', 'b' (audio-rate). */
export class AddKernel implements Kernel {
  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const a = inputs['a']!
    const b = inputs['b']!
    for (let i = 0; i < n; i++) out[i] = a[i]! + b[i]!
  }

  reset(): void {}
}

/** Subtract: out = a - b. Inputs 'a', 'b' (audio-rate). */
export class SubKernel implements Kernel {
  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const a = inputs['a']!
    const b = inputs['b']!
    for (let i = 0; i < n; i++) out[i] = a[i]! - b[i]!
  }

  reset(): void {}
}

/** Divide: out = a / b, with |b| < 1e-6 guarded to 0 (no Inf/NaN from a
 *  silent or near-zero divisor). Inputs 'a', 'b' (audio-rate). */
export class DivKernel implements Kernel {
  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const a = inputs['a']!
    const b = inputs['b']!
    for (let i = 0; i < n; i++) {
      const d = b[i]!
      out[i] = d < 1e-6 && d > -1e-6 ? 0 : a[i]! / d
    }
  }

  reset(): void {}
}

/** Sign-preserving power: out = sign(a) * |a|^b. Inputs 'a', 'b' (audio-rate).
 *  Unlike Math.pow this is well-defined for negative bases at any exponent,
 *  so it curves bipolar signals symmetrically — the musical use is waveshaping
 *  and envelope/LFO curve bending (b < 1 expands, b > 1 compresses toward 0),
 *  e.g. pow(-0.5, 2) = -0.25, not +0.25. A zero base yields 0 for ANY
 *  exponent (unguarded, 0^negative would be 0 * Infinity = NaN). */
export class PowKernel implements Kernel {
  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const a = inputs['a']!
    const b = inputs['b']!
    for (let i = 0; i < n; i++) {
      const x = a[i]!
      out[i] = x === 0 ? 0 : Math.sign(x) * Math.pow(Math.abs(x), b[i]!)
    }
  }

  reset(): void {}
}

/** Hard clamp: out = clamp(in, lo, hi). Inputs 'in', 'lo', 'hi' (audio-rate). */
export class ClipKernel implements Kernel {
  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const input = inputs['in']!
    const lo = inputs['lo']!
    const hi = inputs['hi']!
    for (let i = 0; i < n; i++) out[i] = clamp(input[i]!, lo[i]!, hi[i]!)
  }

  reset(): void {}
}

/** Triangle wavefolder: reflects 'in' back into [-1, 1] (values beyond a
 *  boundary fold inward, repeatedly for large excursions), via
 *  fold(x) = 4*|x/4 + 0.25 - round(x/4 + 0.25)| - 1. Identity on [-1, 1]. */
export class FoldKernel implements Kernel {
  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const input = inputs['in']!
    for (let i = 0; i < n; i++) {
      const t = input[i]! / 4 + 0.25
      out[i] = 4 * Math.abs(t - Math.round(t)) - 1
    }
  }

  reset(): void {}
}

/** Linear crossfade: out = a*(1-t) + b*t. Inputs 'a', 'b', 't' (audio-rate).
 *  t = 0 is all a, t = 1 is all b. t is NOT clamped — values outside [0, 1]
 *  extrapolate linearly (occasionally useful; clip upstream if unwanted). */
export class MixKernel implements Kernel {
  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const a = inputs['a']!
    const b = inputs['b']!
    const t = inputs['t']!
    for (let i = 0; i < n; i++) {
      const m = t[i]!
      out[i] = a[i]! * (1 - m) + b[i]! * m
    }
  }

  reset(): void {}
}

/** Soft saturator: out = tanh(in). Input 'in' (audio-rate); output (-1, 1). */
export class TanhKernel implements Kernel {
  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const input = inputs['in']!
    for (let i = 0; i < n; i++) out[i] = Math.tanh(input[i]!)
  }

  reset(): void {}
}

/* --------------------------------------------------------------------------
 * Elementary math on a signal.
 *
 * One kernel per ARITY rather than per operation: these are all "apply f per
 * sample", they never change at runtime, and thirteen near-identical six-line
 * classes would be thirteen places to forget a NaN guard.
 *
 * The guards are the point. A synth graph has no way to report a bad sample —
 * one NaN or Infinity spreads through every downstream node and the voice goes
 * silent with nothing to see. So the ops that CAN produce one don't:
 *   sqrt of a negative  -> 0        (rectify first if you meant |x|)
 *   log of <= 0         -> log(1e-9), about -20.7, not -Infinity
 *   exp of a big number -> clamped to +-80 in, which stays finite in float32
 *   mod by 0            -> 0
 * NaN that arrives on the INPUT still passes through: that is someone else's
 * bug and hiding it would only move the mystery.
 * -------------------------------------------------------------------------- */

export type MathOp = 'abs' | 'floor' | 'ceil' | 'round' | 'sign' | 'sqrt' | 'exp' | 'log' | 'sin' | 'cos'
export type Math2Op = 'min' | 'max' | 'mod'

export interface MathConfig {
  op?: MathOp
}
export interface Math2Config {
  op?: Math2Op
}

/** Natural log floor: log(0) is -Infinity, which poisons everything after it. */
const LOG_FLOOR = 1e-9
/** exp overflows float32 near 88; 80 leaves headroom and stays finite. */
const EXP_LIMIT = 80

const UNARY: Record<MathOp, (x: number) => number> = {
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  sqrt: (x) => (x > 0 ? Math.sqrt(x) : 0),
  exp: (x) => Math.exp(x > EXP_LIMIT ? EXP_LIMIT : x < -EXP_LIMIT ? -EXP_LIMIT : x),
  log: (x) => Math.log(x > LOG_FLOOR ? x : LOG_FLOOR),
  sin: Math.sin,
  cos: Math.cos,
}

/** FLOORED modulo: the result takes the sign of `b`, so `mod(-0.1, 1)` is 0.9.
 *  JS `%` is truncated (`-0.1 % 1` is -0.1), which is wrong for wrapping a
 *  phase or a ramp -- the one thing this is mostly used for. */
const floorMod = (a: number, b: number): number => (b === 0 ? 0 : a - Math.floor(a / b) * b)

const BINARY: Record<Math2Op, (a: number, b: number) => number> = {
  min: (a, b) => (a < b ? a : b),
  max: (a, b) => (a > b ? a : b),
  mod: floorMod,
}

/** Unary math on 'in'. `op` is config (build-time); the operand is a signal. */
export class MathKernel implements Kernel {
  private readonly f: (x: number) => number

  constructor(config: MathConfig = {}) {
    this.f = UNARY[config.op ?? 'abs'] ?? UNARY.abs
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const input = inputs['in']!
    const f = this.f
    for (let i = 0; i < n; i++) out[i] = f(input[i]!)
  }

  reset(): void {}
}

/** Binary math on 'a' and 'b'. Both operands are signals. */
export class Math2Kernel implements Kernel {
  private readonly f: (a: number, b: number) => number

  constructor(config: Math2Config = {}) {
    this.f = BINARY[config.op ?? 'min'] ?? BINARY.min
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const a = inputs['a']!
    const b = inputs['b']!
    const f = this.f
    for (let i = 0; i < n; i++) out[i] = f(a[i]!, b[i]!)
  }

  reset(): void {}
}
