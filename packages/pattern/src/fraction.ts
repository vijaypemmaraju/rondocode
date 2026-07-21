/**
 * Exact rational arithmetic for pattern time.
 *
 * Pattern time is measured in cycles, and cycles subdivide into thirds,
 * fifths, sevenths... — values like 1/3 that binary floats cannot represent.
 * Accumulating float error would make events drift off the grid, so all
 * pattern-engine time math goes through this class and stays exact.
 *
 * Representation tradeoff: numerator/denominator are plain JS numbers, not
 * bigints — number arithmetic is much faster and pattern queries allocate
 * Fractions liberally. The cost is a bounded range: every operation checks
 * that the (reduced) components stay within Number.MAX_SAFE_INTEGER and
 * throws RangeError otherwise. Patterns doing pathological subdivision fail
 * loudly instead of silently corrupting time.
 */

/** Greatest common divisor of two non-negative safe integers. */
const gcd = (a: number, b: number): number => {
  while (b !== 0) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

/** Overflow guard: throw RangeError unless `x` is a safe integer. */
const checkSafe = (x: number, context: string): number => {
  if (!Number.isSafeInteger(x)) {
    throw new RangeError(
      `Fraction overflow in ${context}: |${x}| exceeds Number.MAX_SAFE_INTEGER; ` +
        'pattern time subdivided too finely to stay exact',
    )
  }
  return x
}

/** Product of two safe integers, guarded against overflow. */
const mulSafe = (a: number, b: number, context: string): number =>
  checkSafe(a * b, context)

/**
 * An immutable rational number, always stored in canonical form:
 * - reduced to lowest terms (gcd)
 * - denominator strictly positive (sign lives on the numerator)
 * - zero is 0/1
 *
 * Every operation returns a new Fraction; instances never mutate.
 * Canonical form makes equality a plain component comparison.
 */
export class Fraction {
  /** Numerator: a safe integer carrying the sign. */
  readonly n: number
  /** Denominator: a strictly positive safe integer. */
  readonly d: number

  /**
   * Build n/d (d defaults to 1). Both arguments must be integers — floats
   * are rejected (TypeError) rather than converted, forcing callers to be
   * explicit via {@link Fraction.fromNumber} when interop is intended.
   * d === 0 throws RangeError. Result is reduced and sign-normalized.
   */
  constructor(n: number, d = 1) {
    if (!Number.isInteger(n) || !Number.isInteger(d)) {
      throw new TypeError(
        `Fraction arguments must be integers, got ${n}/${d}; ` +
          'use Fraction.fromNumber for float interop',
      )
    }
    if (d === 0) throw new RangeError('Fraction denominator must not be zero')
    if (d < 0) {
      n = -n
      d = -d
    }
    const g = gcd(Math.abs(n), d) // >= 1: d is positive here
    const num = n / g
    this.n = num === 0 ? 0 : checkSafe(num, 'constructor') // no negative zero
    this.d = checkSafe(d / g, 'constructor')
  }

  /** Cached constant 0/1 — reuse instead of allocating on hot paths. */
  static readonly ZERO = new Fraction(0)

  /** Cached constant 1/1 — reuse instead of allocating on hot paths. */
  static readonly ONE = new Fraction(1)

  /** Convenience constructor: Fraction.of(3, 4) === new Fraction(3, 4). */
  static of(n: number, d?: number): Fraction {
    return new Fraction(n, d)
  }

  /**
   * Convert a float to a Fraction via continued-fraction approximation,
   * for interop only (e.g. cps math at the scheduling boundary).
   *
   * Precision contract: returns a convergent-based approximation with
   * denominator <= 1e6, accurate within 1e-6. Floats that originated from
   * such a rational round-trip exactly (fromNumber(1/3) is exactly 1/3).
   * Non-finite input throws RangeError; integer parts beyond
   * Number.MAX_SAFE_INTEGER throw RangeError from the overflow guard.
   */
  static fromNumber(x: number): Fraction {
    if (!Number.isFinite(x)) {
      throw new RangeError(`Fraction.fromNumber requires a finite number, got ${x}`)
    }
    const maxDenominator = 1e6
    const sign = x < 0 ? -1 : 1
    let rest = Math.abs(x)
    // Convergents h/k of the continued-fraction expansion of |x|
    let hPrev = 1
    let kPrev = 0
    let h = checkSafe(Math.floor(rest), 'fromNumber')
    let k = 1
    rest -= Math.floor(rest)
    while (rest > 0) {
      rest = 1 / rest
      const a = Math.floor(rest)
      const hNext = a * h + hPrev
      const kNext = a * k + kPrev
      if (kNext > maxDenominator || !Number.isSafeInteger(hNext)) break
      hPrev = h
      kPrev = k
      h = hNext
      k = kNext
      rest -= a
      // Stop once the convergent is exact for this float
      if (h / k === Math.abs(x)) break
    }
    return new Fraction(sign * h, k)
  }

  /** this + o. Exact; throws RangeError on component overflow. */
  add(o: Fraction | number): Fraction {
    const b = lift(o)
    const n = checkSafe(
      mulSafe(this.n, b.d, 'add') + mulSafe(b.n, this.d, 'add'),
      'add',
    )
    return new Fraction(n, mulSafe(this.d, b.d, 'add'))
  }

  /** this - o. Exact; throws RangeError on component overflow. */
  sub(o: Fraction | number): Fraction {
    const b = lift(o)
    const n = checkSafe(
      mulSafe(this.n, b.d, 'sub') - mulSafe(b.n, this.d, 'sub'),
      'sub',
    )
    return new Fraction(n, mulSafe(this.d, b.d, 'sub'))
  }

  /** this * o. Exact; throws RangeError on component overflow. */
  mul(o: Fraction | number): Fraction {
    const b = lift(o)
    // Cross-reduce before multiplying to keep intermediates small
    // (gcd >= 1 here: denominators are always strictly positive)
    const g1 = gcd(Math.abs(this.n), b.d)
    const g2 = gcd(Math.abs(b.n), this.d)
    return new Fraction(
      mulSafe(this.n / g1, b.n / g2, 'mul'),
      mulSafe(this.d / g2, b.d / g1, 'mul'),
    )
  }

  /** this / o. Division by zero throws RangeError. */
  div(o: Fraction | number): Fraction {
    const b = lift(o)
    if (b.n === 0) throw new RangeError('Fraction division by zero')
    return this.mul(new Fraction(b.d, b.n))
  }

  /** -this. */
  neg(): Fraction {
    return new Fraction(-this.n, this.d)
  }

  /** Largest integer <= this, as a Fraction. Exact (no float rounding). */
  floor(): Fraction {
    // Euclidean remainder of n mod d is exact for safe integers
    const r = ((this.n % this.d) + this.d) % this.d
    return new Fraction((this.n - r) / this.d)
  }

  /** Smallest integer >= this, as a Fraction. Exact (no float rounding). */
  ceil(): Fraction {
    const r = ((this.n % this.d) + this.d) % this.d
    const q = (this.n - r) / this.d
    return new Fraction(r === 0 ? q : q + 1)
  }

  /**
   * Euclidean modulo: result is always in [0, |o|), including for negative
   * dividends — F(-1, 4).mod(1) is 3/4, not -1/4. Tidal cycle math depends
   * on this: times before cycle zero still map to a position within their
   * cycle. Zero modulus throws RangeError.
   */
  mod(o: Fraction | number): Fraction {
    const b = lift(o)
    if (b.n === 0) throw new RangeError('Fraction modulo by zero')
    const m = b.n < 0 ? b.neg() : b
    const r = this.sub(m.mul(this.div(m).floor()))
    return r
  }

  /** Exact equality (canonical form makes this a component comparison). */
  eq(o: Fraction | number): boolean {
    const b = lift(o)
    return this.n === b.n && this.d === b.d
  }

  /** this < o. Uses guarded cross-multiplication, so it is always exact. */
  lt(o: Fraction | number): boolean {
    const b = lift(o)
    return mulSafe(this.n, b.d, 'lt') < mulSafe(b.n, this.d, 'lt')
  }

  /** this <= o. */
  lte(o: Fraction | number): boolean {
    return !lift(o).lt(this)
  }

  /** this > o. */
  gt(o: Fraction | number): boolean {
    return lift(o).lt(this)
  }

  /** this >= o. */
  gte(o: Fraction | number): boolean {
    return !this.lt(o)
  }

  /** The smaller of this and o. */
  min(o: Fraction | number): Fraction {
    const b = lift(o)
    return this.lte(b) ? this : b
  }

  /** The larger of this and o. */
  max(o: Fraction | number): Fraction {
    const b = lift(o)
    return this.gte(b) ? this : b
  }

  /** Start of the cycle containing this time (Tidal's "sam"): floor. */
  sam(): Fraction {
    return this.floor()
  }

  /** Start of the next cycle: sam + 1. */
  nextSam(): Fraction {
    return this.sam().add(Fraction.ONE)
  }

  /** Position within the current cycle: this - sam, always in [0, 1). */
  cyclePos(): Fraction {
    return this.sub(this.sam())
  }

  /**
   * Float value n/d — for display and scheduling interop only. Never feed
   * the result back into pattern time math; that reintroduces float drift.
   */
  valueOf(): number {
    return this.n / this.d
  }

  /** "3/4" for proper fractions, "5" for integers. */
  toString(): string {
    return this.d === 1 ? `${this.n}` : `${this.n}/${this.d}`
  }
}

/** Coerce a number operand to a Fraction (integers only — see constructor). */
const lift = (o: Fraction | number): Fraction =>
  o instanceof Fraction ? o : new Fraction(o)

/** Terse Fraction constructor for tests and internal use: F(3, 4) = 3/4. */
export const F = (n: number, d?: number): Fraction => new Fraction(n, d)
