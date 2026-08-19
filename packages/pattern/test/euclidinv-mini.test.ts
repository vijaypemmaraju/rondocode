import { describe, expect, it } from 'vitest'
import { Fraction, TimeSpan, miniParse } from '../src/index'

/* ------------------------------------------------------------------------- *
 * A NEGATIVE pulse count in mini-notation is the COMPLEMENT.
 *
 * `a(-3,8)` used to fall through to `euclid`, where bjorklund's documented
 * rule is "pulses <= 0 yields all rests" -- so the line went silent with no
 * error and no clue beyond nothing playing. The combinator for it
 * (`euclidInv`) already existed; the notation simply never reached it.
 *
 * Strudel reads `(-3,8)` the same way, measured at five hits per cycle, so
 * this is parity as well as a fix.
 * ------------------------------------------------------------------------- */

/** Which sixteenth... eighth slots a pattern lands on, in one cycle. */
const slots = (src: string, div = 8): number[] => {
  const { pattern } = miniParse(src)
  return pattern.query(new TimeSpan(new Fraction(0), new Fraction(1)))
    .map((h) => Math.round(h.whole!.begin.valueOf() * div))
    .sort((a, b) => a - b)
}

describe('a negative pulse count', () => {
  it('plays exactly the slots the positive one leaves empty', () => {
    expect(slots('a(3,8)')).toEqual([0, 3, 6])
    expect(slots('a(-3,8)')).toEqual([1, 2, 4, 5, 7])
  })

  it('covers every slot exactly once, between the pair', () => {
    /* The point of the notation: kick on (3,8), shaker on (-3,8), and the
     * groove interlocks without either line knowing where the other sits. */
    const all = [...slots('a(3,8)'), ...slots('a(-3,8)')].sort((x, y) => x - y)
    expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('is not silence, which is what it used to be', () => {
    expect(slots('a(-3,8)').length).toBeGreaterThan(0)
    expect(slots('a(-5,8)').length).toBe(3)
  })

  it('takes the rotation argument too', () => {
    expect(slots('a(-3,8,2)').length).toBe(5)
    expect(slots('a(-3,8,2)')).not.toEqual(slots('a(-3,8)'))
  })

  it('leaves zero alone: no pulses is still silence', () => {
    // only NEGATIVE means complement; 0 keeps bjorklund's own rule
    expect(slots('a(0,8)')).toEqual([])
  })

  it('and a patterned pulse count can go negative mid-flight', () => {
    const { pattern } = miniParse('a(<3 -3>,8)')
    const at = (c: number): number =>
      pattern.query(new TimeSpan(new Fraction(c), new Fraction(c + 1))).length
    expect(at(0)).toBe(3)
    expect(at(1)).toBe(5)
  })
})
