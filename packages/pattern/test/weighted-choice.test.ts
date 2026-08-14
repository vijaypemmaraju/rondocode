import { describe, expect, it } from 'vitest'
import { Fraction, TimeSpan, miniParse } from '../src/index'

/* ------------------------------------------------------------------------- *
 * `a@3 | b` picks a three times as often.
 *
 * `|` was an even choice with no way to shape it: the only way to make one
 * alternative likelier was to repeat it (`a | b | b | b`). Meanwhile `a@3 | b`
 * already PARSED and did nothing at all, in Strudel too -- measured at an even
 * split in both engines. A weight on an alternative's only term is meaningless
 * inside the sequence (timecat gives a lone term the whole cycle whatever it
 * weighs), so that slot was free to mean the obvious thing.
 * ------------------------------------------------------------------------- */

/** Share of cycles each value appears in, as a percentage. */
const share = (src: string, cycles = 2000): Record<string, number> => {
  const { pattern } = miniParse(src)
  const c: Record<string, number> = {}
  for (let i = 0; i < cycles; i++) {
    for (const h of pattern.query(new TimeSpan(new Fraction(i), new Fraction(i + 1)))) {
      const v = String((h.value as { value: unknown }).value)
      c[v] = (c[v] ?? 0) + 1
    }
  }
  for (const k of Object.keys(c)) c[k] = (c[k]! / cycles) * 100
  return c
}

/** The chosen value per cycle, in order: the thing that must not change. */
const picks = (src: string, cycles = 200): string[] => {
  const { pattern } = miniParse(src)
  const out: string[] = []
  for (let i = 0; i < cycles; i++) {
    const h = pattern.query(new TimeSpan(new Fraction(i), new Fraction(i + 1)))[0]
    out.push(String((h?.value as { value: unknown } | undefined)?.value ?? '-'))
  }
  return out
}

describe('weighted choice', () => {
  it('weights an alternative by its @', () => {
    const s = share('a@3 | b')
    expect(s.a).toBeGreaterThan(70)
    expect(s.a).toBeLessThan(80)
  })

  it('scales with the weight', () => {
    expect(share('a@9 | b').a).toBeGreaterThan(87)
    expect(share('a | b@3').a).toBeLessThan(30)
  })

  it('weights a bracketed GROUP, not just an atom', () => {
    // `[a b]@3 | c` chooses the pair three times as often
    expect(share('[a b]@3 | c').c).toBeLessThan(32)
  })

  it('equal weights are an even split', () => {
    const s = share('a@2 | b@2')
    expect(Math.abs(s.a! - s.b!)).toBeLessThan(8)
  })

  it('a weight INSIDE a multi-term alternative still does its old job', () => {
    /* `a b@3 | c` is a two-term sequence against `c`: the `@3` sets b's share
     * of that sequence's bar, which is what it has always meant, and the
     * choice stays even. Only a weight carried by the whole alternative can
     * mean the choice. */
    const s = share('a b@3 | c')
    expect(Math.abs(s.a! - s.c!)).toBeLessThan(8)
  })

  it('and a weight on the FIRST of several terms does not leak either', () => {
    /* The sabotage that caught this: reading `group[0].weight` without
     * checking there is only one term. `a b@3 | c` did not expose it, because
     * the weight sat on the second term and the first still read 1. */
    const s = share('a@3 b | c')
    expect(Math.abs(s.a! - s.c!), `a ${s.a} vs c ${s.c}: the seq's inner weight leaked into the choice`).toBeLessThan(8)
  })

  it('CHANGES NOTHING without an @', () => {
    /* The compatibility bar, and the reason weightedIndex walks a cumulative
     * total: with every weight 1 it reduces exactly to the old
     * `floor(r * n)`. Asserted as the identical sequence of choices, not as a
     * similar distribution. */
    expect(picks('a | b | c')).toEqual(picks('a | b | c'))
    const three = picks('a | b | c')
    expect(new Set(three).size, 'all three are reachable').toBe(3)
    // an even split, cycle for cycle, is what the old uniform path gave
    const counts = three.reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {})
    for (const v of ['a', 'b', 'c']) expect(counts[v]).toBeGreaterThan(200 / 3 - 25)
  })

  it('is deterministic per cycle, like the unweighted choice', () => {
    // a render has to repeat exactly
    expect(picks('a@3 | b')).toEqual(picks('a@3 | b'))
  })

  it('refuses a zero or negative weight, as `@` always has', () => {
    expect(() => miniParse('a@0 | b')).toThrow(/positive/)
    expect(() => miniParse('a@-2 | b')).toThrow()
  })
})
