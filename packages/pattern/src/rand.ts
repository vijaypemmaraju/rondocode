import type { Fraction } from './fraction'

/**
 * Deterministic randomness for the pattern engine.
 *
 * Patterns must be pure functions of the query span — the scheduler
 * re-queries freely — so "random" combinators (degradeBy, sometimes, rand)
 * cannot touch Math.random. Instead every stochastic decision hashes the
 * exact rational time it concerns: same time + seed always gives the same
 * draw, across queries, runs, and machines.
 */

/** One round of xorshift-multiply mixing (murmur3-finalizer style). */
const mix = (h: number, x: number): number => {
  h = (h ^ x) >>> 0
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/** Split a non-negative safe integer into (lo32, hi32) words. */
const words = (x: number): [number, number] => [x >>> 0, Math.floor(x / 0x100000000) >>> 0]

/**
 * Hash an exact rational time (and an integer seed) to a float in [0, 1).
 *
 * Pure and stable: the same (t, seed) always yields the same value — this
 * is the entire randomness substrate of the pattern engine. The hash mixes
 * the fraction's reduced numerator/denominator (canonical form makes equal
 * times hash equally) plus sign and seed, so draws vary per cycle AND per
 * position within the cycle.
 *
 * Seeding contract, by design: DIFFERENT seeds give independent streams;
 * the SAME seed at the same time always yields the identical draw. The
 * latter is what makes queries re-runnable by the scheduler — and it means
 * every stochastic combinator left at the default seed shares one
 * time-locked stream (Tidal/Strudel behave the same way; see the degradeBy
 * doc for the audible consequences).
 *
 * Not cryptographic — just well-scrambled xorshift/multiply rounds.
 */
export function timeHash(t: Fraction, seed = 0): number {
  const s = Math.trunc(seed)
  const [sLo, sHi] = words(Math.abs(s))
  const [nLo, nHi] = words(Math.abs(t.n))
  const [dLo, dHi] = words(t.d)
  let h = 0x9e3779b9
  h = mix(h, sLo)
  h = mix(h, sHi ^ (s < 0 ? 0x55555555 : 0))
  h = mix(h, nLo)
  h = mix(h, nHi ^ (t.n < 0 ? 0xaaaaaaaa : 0))
  h = mix(h, dLo)
  h = mix(h, dHi)
  h = mix(h, 0x2545f491)
  return h / 0x100000000
}
