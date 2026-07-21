import { describe, it, expect } from 'vitest'
import { Fraction, F } from '../src/fraction'

describe('Fraction construction', () => {
  it('reduces to lowest terms', () => {
    const f = new Fraction(2, 4)
    expect(f.n).toBe(1)
    expect(f.d).toBe(2)
  })

  it('defaults denominator to 1', () => {
    const f = new Fraction(5)
    expect(f.n).toBe(5)
    expect(f.d).toBe(1)
  })

  it('normalizes sign to the numerator: -1/-2 -> 1/2', () => {
    const f = new Fraction(-1, -2)
    expect(f.n).toBe(1)
    expect(f.d).toBe(2)
  })

  it('normalizes sign to the numerator: 3/-4 -> -3/4', () => {
    const f = new Fraction(3, -4)
    expect(f.n).toBe(-3)
    expect(f.d).toBe(4)
  })

  it('normalizes zero to 0/1', () => {
    const f = new Fraction(0, -7)
    expect(f.n).toBe(0)
    expect(f.d).toBe(1)
  })

  it('throws RangeError on zero denominator', () => {
    expect(() => new Fraction(1, 0)).toThrow(RangeError)
  })

  it('throws on non-integer arguments (no silent float conversion)', () => {
    expect(() => new Fraction(0.5)).toThrow()
    expect(() => new Fraction(1, 2.5)).toThrow()
    expect(() => new Fraction(NaN)).toThrow()
    expect(() => new Fraction(Infinity)).toThrow()
  })

  it('F helper and Fraction.of construct fractions', () => {
    expect(F(3, 4).eq(new Fraction(3, 4))).toBe(true)
    expect(Fraction.of(3, 4).eq(F(3, 4))).toBe(true)
    expect(Fraction.of(7).eq(F(7, 1))).toBe(true)
  })
})

describe('Fraction arithmetic', () => {
  it('adds exactly: 1/3 + 1/3 + 1/3 === 1 (the float-drift case)', () => {
    expect(F(1, 3).add(F(1, 3)).add(F(1, 3)).eq(F(1))).toBe(true)
  })

  it('adds with reduction', () => {
    expect(F(1, 6).add(F(1, 3)).eq(F(1, 2))).toBe(true)
  })

  it('accepts plain number operands', () => {
    expect(F(1, 2).add(1).eq(F(3, 2))).toBe(true)
    expect(F(1, 2).mul(2).eq(F(1))).toBe(true)
    expect(F(3, 2).sub(1).eq(F(1, 2))).toBe(true)
    expect(F(1).div(4).eq(F(1, 4))).toBe(true)
  })

  it('subtracts', () => {
    expect(F(3, 4).sub(F(1, 4)).eq(F(1, 2))).toBe(true)
    expect(F(1, 4).sub(F(3, 4)).eq(F(-1, 2))).toBe(true)
  })

  it('multiplies', () => {
    expect(F(2, 3).mul(F(3, 4)).eq(F(1, 2))).toBe(true)
    expect(F(-2, 3).mul(F(3, 2)).eq(F(-1))).toBe(true)
  })

  it('divides', () => {
    expect(F(1, 2).div(F(1, 4)).eq(F(2))).toBe(true)
    expect(F(1, 2).div(F(-1, 4)).eq(F(-2))).toBe(true)
  })

  it('throws RangeError on division by zero', () => {
    expect(() => F(1, 2).div(F(0))).toThrow(RangeError)
    expect(() => F(1, 2).div(0)).toThrow(RangeError)
  })

  it('negates', () => {
    expect(F(1, 2).neg().eq(F(-1, 2))).toBe(true)
    expect(F(-1, 2).neg().eq(F(1, 2))).toBe(true)
    expect(F(0).neg().eq(F(0))).toBe(true)
  })

  it('never stores negative zero', () => {
    expect(Object.is(F(0).neg().n, 0)).toBe(true)
    expect(Object.is(new Fraction(0, -7).n, 0)).toBe(true)
    expect(Object.is(F(1, 2).sub(F(1, 2)).n, 0)).toBe(true)
  })

  it('holds arithmetic identities', () => {
    const a = F(3, 7)
    expect(a.add(F(0)).eq(a)).toBe(true)
    expect(a.mul(F(1)).eq(a)).toBe(true)
    expect(a.sub(a).eq(F(0))).toBe(true)
    expect(a.div(a).eq(F(1))).toBe(true)
    expect(a.add(a.neg()).eq(F(0))).toBe(true)
  })

  it('is immutable: operations do not mutate operands', () => {
    const a = F(1, 3)
    a.add(F(1, 3))
    a.neg()
    expect(a.n).toBe(1)
    expect(a.d).toBe(3)
  })
})

describe('Fraction Euclidean mod', () => {
  it('behaves like remainder for positive operands', () => {
    expect(F(5, 4).mod(1).eq(F(1, 4))).toBe(true)
    expect(F(7).mod(3).eq(F(1))).toBe(true)
  })

  it('is Euclidean for negative values: -1/4 mod 1 = 3/4', () => {
    expect(F(-1, 4).mod(1).eq(F(3, 4))).toBe(true)
  })

  it('stays non-negative for negative values and fractional modulus', () => {
    expect(F(-5, 4).mod(1).eq(F(3, 4))).toBe(true)
    expect(F(-1, 4).mod(F(1, 2)).eq(F(1, 4))).toBe(true)
    expect(F(-3).mod(2).eq(F(1))).toBe(true)
  })

  it('returns non-negative result for negative modulus (result in [0, |m|))', () => {
    expect(F(-1, 4).mod(-1).eq(F(3, 4))).toBe(true)
    expect(F(1, 4).mod(-1).eq(F(1, 4))).toBe(true)
  })

  it('throws RangeError on zero modulus', () => {
    expect(() => F(1, 2).mod(0)).toThrow(RangeError)
  })
})

describe('Fraction floor/ceil', () => {
  it('floors positives and negatives', () => {
    expect(F(7, 2).floor().eq(F(3))).toBe(true)
    expect(F(-7, 2).floor().eq(F(-4))).toBe(true)
    expect(F(-1, 4).floor().eq(F(-1))).toBe(true)
    expect(F(3).floor().eq(F(3))).toBe(true)
    expect(F(-3).floor().eq(F(-3))).toBe(true)
  })

  it('ceils positives and negatives', () => {
    expect(F(7, 2).ceil().eq(F(4))).toBe(true)
    expect(F(-7, 2).ceil().eq(F(-3))).toBe(true)
    expect(F(-1, 4).ceil().eq(F(0))).toBe(true)
    expect(F(3).ceil().eq(F(3))).toBe(true)
  })
})

describe('Fraction cycle helpers', () => {
  it('sam is the start of the containing cycle', () => {
    expect(F(5, 4).sam().eq(F(1))).toBe(true)
    expect(F(-1, 4).sam().eq(F(-1))).toBe(true)
    expect(F(2).sam().eq(F(2))).toBe(true)
  })

  it('nextSam is sam + 1', () => {
    expect(F(5, 4).nextSam().eq(F(2))).toBe(true)
    expect(F(-1, 4).nextSam().eq(F(0))).toBe(true)
    expect(F(2).nextSam().eq(F(3))).toBe(true)
  })

  it('cyclePos is position within the cycle, in [0, 1)', () => {
    expect(F(5, 4).cyclePos().eq(F(1, 4))).toBe(true)
    expect(F(-1, 4).cyclePos().eq(F(3, 4))).toBe(true)
    expect(F(2).cyclePos().eq(F(0))).toBe(true)
  })
})

describe('Fraction comparison', () => {
  it('eq / lt / lte / gt / gte', () => {
    expect(F(1, 2).eq(F(2, 4))).toBe(true)
    expect(F(1, 2).eq(F(1, 3))).toBe(false)
    expect(F(1, 3).lt(F(1, 2))).toBe(true)
    expect(F(1, 2).lt(F(1, 2))).toBe(false)
    expect(F(1, 2).lte(F(1, 2))).toBe(true)
    expect(F(1, 2).gt(F(1, 3))).toBe(true)
    expect(F(1, 2).gte(F(1, 2))).toBe(true)
    expect(F(-1, 2).lt(F(1, 3))).toBe(true)
  })

  it('rejects non-integer number operands (same rule as the constructor)', () => {
    expect(() => F(1, 2).eq(0.5)).toThrow()
    expect(() => F(1, 2).add(0.5)).toThrow()
  })

  it('compares against plain integer numbers', () => {
    expect(F(3, 2).lt(2)).toBe(true)
    expect(F(2).eq(2)).toBe(true)
    expect(F(5, 2).gt(2)).toBe(true)
  })

  it('min / max', () => {
    expect(F(1, 3).min(F(1, 2)).eq(F(1, 3))).toBe(true)
    expect(F(1, 3).max(F(1, 2)).eq(F(1, 2))).toBe(true)
    expect(F(-1).min(0).eq(F(-1))).toBe(true)
    expect(F(-1).max(0).eq(F(0))).toBe(true)
  })
})

describe('Fraction.fromNumber', () => {
  it('converts exact dyadic floats', () => {
    expect(Fraction.fromNumber(0.5).eq(F(1, 2))).toBe(true)
    expect(Fraction.fromNumber(0.75).eq(F(3, 4))).toBe(true)
    expect(Fraction.fromNumber(-0.25).eq(F(-1, 4))).toBe(true)
    expect(Fraction.fromNumber(3).eq(F(3))).toBe(true)
    expect(Fraction.fromNumber(0).eq(F(0))).toBe(true)
  })

  it('recovers simple rationals from their float approximations', () => {
    expect(Fraction.fromNumber(1 / 3).eq(F(1, 3))).toBe(true)
    expect(Fraction.fromNumber(2 / 3).eq(F(2, 3))).toBe(true)
    expect(Fraction.fromNumber(-1 / 3).eq(F(-1, 3))).toBe(true)
    expect(Fraction.fromNumber(1 / 7).eq(F(1, 7))).toBe(true)
  })

  it('caps the denominator at 1e6 and stays within the precision contract', () => {
    const pi = Fraction.fromNumber(Math.PI)
    expect(pi.d).toBeLessThanOrEqual(1e6)
    expect(Math.abs(pi.valueOf() - Math.PI)).toBeLessThan(1e-6)
  })

  it('throws on non-finite input', () => {
    expect(() => Fraction.fromNumber(NaN)).toThrow(RangeError)
    expect(() => Fraction.fromNumber(Infinity)).toThrow(RangeError)
  })

  it('throws RangeError with a clear message for huge finite input', () => {
    expect(() => Fraction.fromNumber(1e300)).toThrow(RangeError)
    expect(() => Fraction.fromNumber(1e300)).toThrow(/overflow/)
  })
})

describe('Fraction overflow guard', () => {
  it('throws RangeError instead of silently corrupting on huge components', () => {
    let f = F(1_000_000_000) // 1e9
    expect(() => {
      // 1e9 -> 1e18 -> ... exceeds Number.MAX_SAFE_INTEGER (~9e15)
      for (let i = 0; i < 5; i++) f = f.mul(1_000_000_000)
    }).toThrow(RangeError)
  })

  it('throws when a denominator grows past MAX_SAFE_INTEGER', () => {
    let f = F(1, 1_000_000_000)
    expect(() => {
      for (let i = 0; i < 5; i++) f = f.div(1_000_000_000)
    }).toThrow(RangeError)
  })

  it('comparison throws RangeError when cross-multiplication would overflow', () => {
    // Coprime ~1e8-scale components: cross products ~1e16 > MAX_SAFE_INTEGER.
    // Pins the guarded-exact contract: comparisons must fail loudly, never
    // silently degrade to float comparison.
    const a = F(99999989, 100000007)
    const b = F(99999990, 100000019)
    expect(() => a.lt(b)).toThrow(RangeError)
    expect(() => a.gt(b)).toThrow(RangeError)
    expect(() => a.lte(b)).toThrow(RangeError)
    expect(() => a.gte(b)).toThrow(RangeError)
  })

  it('survives deep but reasonable subdivision', () => {
    // 2^40 is large but safe: 128 nested halvings of a triplet grid stay exact
    let f = F(1, 3)
    for (let i = 0; i < 40; i++) f = f.div(2)
    for (let i = 0; i < 40; i++) f = f.mul(2)
    expect(f.eq(F(1, 3))).toBe(true)
  })
})

describe('Fraction cached constants', () => {
  it('ZERO and ONE are canonical', () => {
    expect(Fraction.ZERO.eq(F(0))).toBe(true)
    expect(Fraction.ONE.eq(F(1))).toBe(true)
    expect(Fraction.ZERO.n).toBe(0)
    expect(Fraction.ZERO.d).toBe(1)
    expect(Fraction.ONE.n).toBe(1)
    expect(Fraction.ONE.d).toBe(1)
  })
})

describe('Fraction valueOf / toString', () => {
  it('valueOf returns the float quotient', () => {
    expect(F(3, 4).valueOf()).toBe(0.75)
    expect(F(-1, 2).valueOf()).toBe(-0.5)
    expect(F(5).valueOf()).toBe(5)
  })

  it('toString formats "n/d", integers without the denominator', () => {
    expect(F(3, 4).toString()).toBe('3/4')
    expect(F(-3, 4).toString()).toBe('-3/4')
    expect(F(5).toString()).toBe('5')
    expect(F(10, 2).toString()).toBe('5')
    expect(F(0).toString()).toBe('0')
  })
})
