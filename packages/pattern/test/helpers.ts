import { expect } from 'vitest'
import { Fraction, TimeSpan } from '../src/index'
import type { Hap, Pattern } from '../src/index'

export const toFr = (x: number | Fraction): Fraction =>
  x instanceof Fraction ? x : Fraction.fromNumber(x)

export const span = (b: number | Fraction, e: number | Fraction) =>
  new TimeSpan(toFr(b), toFr(e))

/** Every hap must satisfy part ⊆ query span, and part ⊆ whole when whole exists. */
export const checkInvariants = <T>(haps: Hap<T>[], qs: TimeSpan): void => {
  for (const h of haps) {
    expect(h.part.begin.gte(qs.begin), `part ${h.part} starts before query ${qs}`).toBe(true)
    expect(h.part.end.lte(qs.end), `part ${h.part} ends after query ${qs}`).toBe(true)
    if (h.whole) {
      expect(h.part.begin.gte(h.whole.begin), `part ${h.part} starts before whole ${h.whole}`).toBe(true)
      expect(h.part.end.lte(h.whole.end), `part ${h.part} ends after whole ${h.whole}`).toBe(true)
    }
  }
}

/**
 * Deterministic order: (part.begin, part.end, whole.begin, stringified
 * value). Stack order is not semantic; the whole-begin tie-break keeps
 * shapes like stack(p, p.late(1)) — identical parts, different wholes —
 * stable regardless of query order.
 */
export const sortHaps = <T>(haps: Hap<T>[]): Hap<T>[] =>
  [...haps].sort((a, b) => {
    const b1 = a.part.begin.valueOf() - b.part.begin.valueOf()
    if (b1 !== 0) return b1
    const e1 = a.part.end.valueOf() - b.part.end.valueOf()
    if (e1 !== 0) return e1
    // continuous haps (no whole) sort before discrete ones at the same part
    const w1 =
      (a.whole?.begin.valueOf() ?? -Infinity) - (b.whole?.begin.valueOf() ?? -Infinity)
    if (w1 !== 0) return w1
    const va = JSON.stringify(a.value)
    const vb = JSON.stringify(b.value)
    return va < vb ? -1 : va > vb ? 1 : 0
  })

/** Drop the parser-stamped `loc.src` so offset-focused assertions stay concise
 *  ({ start, end }). The src field itself is covered by dedicated tests
 *  (mini.test's loc suite and app/test/flash.test.ts). */
const dropLocSrc = <T>(v: T): T => {
  const val = v as { loc?: Record<string, unknown> } | null
  if (val && typeof val === 'object' && val.loc && typeof val.loc === 'object' && 'src' in val.loc) {
    const { src: _drop, ...loc } = val.loc
    return { ...(v as object), loc } as T
  }
  return v
}

/** Query [b, e) → sorted [partBegin, partEnd, value] float triples (invariants checked). */
export const q = <T>(
  p: Pattern<T>,
  b: number | Fraction,
  e: number | Fraction,
): [number, number, T][] => {
  const s = span(b, e)
  const haps = p.query(s)
  checkInvariants(haps, s)
  return sortHaps(haps).map((h) => [h.part.begin.valueOf(), h.part.end.valueOf(), dropLocSrc(h.value)])
}

/** Like q but including wholes (null = continuous). */
export const qw = <T>(p: Pattern<T>, b: number | Fraction, e: number | Fraction) => {
  const s = span(b, e)
  const haps = p.query(s)
  checkInvariants(haps, s)
  return sortHaps(haps).map((h) => ({
    whole: h.whole ? [h.whole.begin.valueOf(), h.whole.end.valueOf()] : null,
    part: [h.part.begin.valueOf(), h.part.end.valueOf()],
    value: dropLocSrc(h.value),
  }))
}

/** Sample a continuous pattern at a single instant (zero-width query). */
export const at = (p: Pattern<number>, t: number | Fraction): number => {
  const haps = p.query(span(t, t))
  expect(haps.length).toBe(1)
  return haps[0]!.value
}
