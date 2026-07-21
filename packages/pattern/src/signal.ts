import { Fraction } from './fraction'
import { hap } from './types'
import { Pattern } from './pattern'
import { timeHash } from './rand'

/**
 * Continuous signals: patterns with no discrete events, just a value at
 * every instant. Querying a signal returns exactly one hap whose part is
 * the query span, whose whole is undefined (no onset — a scheduler never
 * fires a signal directly; see hasOnset), and whose value is the signal
 * sampled at the MIDPOINT of the query part — the Strudel convention. A
 * zero-width query samples the point itself, so signals are meaningfully
 * queryable at instants. Discretize with `.segment(n)` (which samples each
 * step at its midpoint because app* combinators query the signal over the
 * structural whole).
 */

/**
 * Build a continuous pattern from a function of exact time. `f` receives
 * the midpoint of each query span as a Fraction; periodic signals should
 * use `t.cyclePos()` so huge cycle numbers cost no float precision.
 */
export function signal(f: (t: Fraction) => number): Pattern<number> {
  return new Pattern((span) => [
    hap(undefined, span, f(span.begin.add(span.end).div(2))),
  ])
}

const TAU = 2 * Math.PI

/** Cycle position of t as a float in [0, 1) — exact until the final division. */
const pos = (t: Fraction): number => t.cyclePos().valueOf()

/** Map a unipolar [0,1] signal to bipolar [-1,1]. */
const bipolar = (p: Pattern<number>): Pattern<number> => p.withValue((v) => 2 * v - 1)

/** Rising ramp 0→1 over each cycle. */
export const saw = signal(pos)
/** Falling ramp 1→0 over each cycle. */
export const isaw = signal((t) => 1 - pos(t))
/** Unipolar sine in [0,1], period one cycle, 1/2 at t=0, peak at t=1/4. */
export const sine = signal((t) => 0.5 + 0.5 * Math.sin(TAU * pos(t)))
/** Unipolar cosine in [0,1]: peak at t=0. */
export const cosine = signal((t) => 0.5 + 0.5 * Math.cos(TAU * pos(t)))
/** Triangle 0→1 over the first half cycle, 1→0 over the second. */
export const tri = signal((t) => 1 - Math.abs(2 * pos(t) - 1))
/**
 * Square wave: 0 for the first half of each cycle, 1 for the second —
 * Strudel's convention (`Math.floor((t * 2) % 2)`), pinned in tests.
 */
export const square = signal((t) => (pos(t) < 0.5 ? 0 : 1))

/** Bipolar [-1,1] variants of the waveforms above. */
export const saw2 = bipolar(saw)
export const isaw2 = bipolar(isaw)
export const sine2 = bipolar(sine)
export const cosine2 = bipolar(cosine)
export const tri2 = bipolar(tri)
export const square2 = bipolar(square)

/**
 * Deterministic noise in [0,1): the {@link timeHash} of the sample's exact
 * midpoint time. Same query, same values — always (no Math.random anywhere
 * in the engine).
 */
export const rand = signal((t) => timeHash(t))

/**
 * Deterministic integer noise: floor(rand * n), values in 0..n-1.
 * n must be a positive integer.
 */
export function irand(n: number): Pattern<number> {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`irand requires a positive integer, got ${n}`)
  }
  return rand.withValue((v) => Math.floor(v * n))
}

/** Distinct stream for perlin's lattice so it does not shadow `rand`. */
const PERLIN_SEED = 0x51d7

/**
 * Smooth noise in [0,1): deterministic values at integer-cycle lattice
 * points, smoothstep-interpolated in between (C1-continuous everywhere).
 *
 * Named `perlin` for Strudel parity, but strictly speaking this is VALUE
 * noise, not gradient (Perlin) noise — for one-dimensional musical
 * modulation the difference is inaudible and value noise is simpler.
 */
export const perlin = signal((t) => {
  const i = t.floor()
  const v0 = timeHash(i, PERLIN_SEED)
  const v1 = timeHash(i.add(Fraction.ONE), PERLIN_SEED)
  const u = t.sub(i).valueOf()
  const s = u * u * (3 - 2 * u) // smoothstep
  return v0 + (v1 - v0) * s
})
