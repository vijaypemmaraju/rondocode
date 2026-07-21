import { Fraction } from './fraction'
import { TimeSpan, hap, hasOnset } from './types'
import type { Hap } from './types'

/**
 * Coerce a combinator argument to exact pattern time. Numbers go through
 * {@link Fraction.fromNumber} (continued-fraction interop), so `fast(0.25)`
 * means exactly 1/4 — but prefer passing Fractions for anything that did not
 * originate as a simple literal.
 *
 * @remarks Shared by the combinator modules; not part of the musical API.
 */
export const toF = (x: Fraction | number): Fraction =>
  x instanceof Fraction ? x : Fraction.fromNumber(x)

/**
 * A pattern of values of type T: a pure function from a query TimeSpan to
 * the Haps (events) active within it — Tidal's core representation.
 *
 * Everything musical is algebra over these query functions. Combinators
 * never mutate; they wrap the query in a new Pattern. Two laws every
 * combinator preserves (tests enforce them):
 *
 * - each returned hap's `part` lies within the queried span
 * - when a hap has a `whole`, its `part` lies within that whole
 *
 * Querying is required to be stateless and deterministic: the same span
 * always yields the same haps, so the scheduler may re-query freely.
 */
export class Pattern<T> {
  constructor(readonly query: (span: TimeSpan) => Hap<T>[]) {}

  // ----------------------------------------------------------- factories

  /**
   * One event per cycle carrying `value`, whole = [sam, sam+1). A partial
   * query clips the part but the whole keeps its full extent — that is how
   * downstream code can tell a clipped tail from an onset.
   */
  static pure<T>(value: T): Pattern<T> {
    return new Pattern((span) =>
      span.cycleSpans().map((s) => {
        const sam = s.begin.sam()
        return hap(new TimeSpan(sam, sam.add(Fraction.ONE)), s, value)
      }),
    )
  }

  /** The empty pattern: every query returns no haps. */
  static readonly silence: Pattern<never> = new Pattern(() => [])

  /**
   * A continuous pattern holding `value` at every instant: one hap per
   * query whose part is the query span itself and whose whole is undefined
   * (no discrete onset — see {@link hasOnset}).
   */
  static steady<T>(value: T): Pattern<T> {
    return new Pattern((span) => [hap(undefined, span, value)])
  }

  /**
   * Concatenate patterns over successive cycles (Tidal's slowcat): cycle c
   * plays pattern `c mod n`. Each pattern continues its OWN timeline — the
   * result's cycle c shows pattern i's cycle floor(c / n), not its cycle c,
   * so multi-cycle inner structure advances one inner cycle per visit.
   *
   * Bare values auto-reify: `cat('a', 'b')` means `cat(pure('a'), pure('b'))`.
   */
  static cat<T>(...args: (T | Pattern<T>)[]): Pattern<T> {
    const pats = args.map((p) => reify(p))
    if (pats.length === 0) return Pattern.silence
    return new Pattern<T>((span) => {
      // One cycle at a time: the pattern index is constant within a cycle.
      const cycle = span.begin.sam()
      const i = cycle.mod(pats.length).valueOf()
      const pat = pats[i]
      if (pat === undefined) return []
      // Shift so the chosen pattern sees its own timeline: its k-th visit
      // (outer cycle c = k*n + i) must query its cycle floor(c / n).
      const offset = cycle.sub(cycle.div(pats.length).floor())
      const shifted = span.withTime((t) => t.sub(offset))
      return pat
        .query(shifted)
        .map((h) =>
          hap(
            h.whole?.withTime((t) => t.add(offset)),
            h.part.withTime((t) => t.add(offset)),
            h.value,
          ),
        )
    }).splitQueries()
  }

  /**
   * Concatenate patterns within a single cycle, equal slices each.
   * Bare values auto-reify (see {@link reify}).
   */
  static fastcat<T>(...args: (T | Pattern<T>)[]): Pattern<T> {
    return Pattern.cat(...args).fast(args.length)
  }

  /**
   * Play all patterns simultaneously (haps concatenated, order not
   * meaningful). Bare values auto-reify (see {@link reify}).
   */
  static stack<T>(...args: (T | Pattern<T>)[]): Pattern<T> {
    const pats = args.map((p) => reify(p))
    return new Pattern((span) => pats.flatMap((p) => p.query(span)))
  }

  /**
   * Weighted fastcat (mini-notation `@`): each pattern gets a slice of the
   * cycle proportional to its weight, and ONE cycle of that pattern is
   * compressed into its slice — successive cycles advance the inner
   * patterns' own cycles. Non-positive weights get no slice.
   * Bare values auto-reify (see {@link reify}).
   */
  static timecat<T>(pairs: [number, T | Pattern<T>][]): Pattern<T> {
    const weights = pairs.map(([w]) => toF(w))
    let total = Fraction.ZERO
    for (const w of weights) if (w.gt(0)) total = total.add(w)
    if (total.eq(0)) return Pattern.silence
    const slices: Pattern<T>[] = []
    let begin = Fraction.ZERO
    for (let i = 0; i < pairs.length; i++) {
      const w = weights[i]!
      if (!w.gt(0)) continue
      const end = begin.add(w.div(total))
      slices.push(reify(pairs[i]![1]).compressSpan(begin, end))
      begin = end
    }
    return Pattern.stack(...slices)
  }

  // ---------------------------------------------------------------- time

  /**
   * Speed up by factor k: k cycles of the pattern squeezed into one.
   * k <= 0 yields silence (Tidal has no time-reversal via fast; use rev).
   */
  fast(k: Fraction | number): Pattern<T> {
    const f = toF(k)
    if (!f.gt(0)) return Pattern.silence
    return this.withQueryTime((t) => t.mul(f)).withHapTime((t) => t.div(f))
  }

  /** Slow down by factor k: fast(1/k). k <= 0 yields silence. */
  slow(k: Fraction | number): Pattern<T> {
    const f = toF(k)
    if (!f.gt(0)) return Pattern.silence
    return this.fast(Fraction.ONE.div(f))
  }

  /**
   * Shift the pattern earlier in time by t cycles (Tidal's `<~`): every
   * event happens t sooner. A pure shift, not a cycle-local rotation —
   * material from later cycles slides in at the end.
   */
  early(t: Fraction | number): Pattern<T> {
    const o = toF(t)
    return this.withQueryTime((x) => x.add(o)).withHapTime((x) => x.sub(o))
  }

  /** Shift later by t cycles (Tidal's `~>`): early(-t). */
  late(t: Fraction | number): Pattern<T> {
    return this.early(toF(t).neg())
  }

  /**
   * Reverse WITHIN each cycle: cycle c is reflected about its midpoint
   * (t -> 2c + 1 - t), wholes included. Cycle-local, so rev of a repeating
   * pattern looks the same shape every cycle, and rev.rev = identity.
   */
  rev(): Pattern<T> {
    return new Pattern<T>((span) => {
      const cycle = span.begin.sam()
      const pivot = cycle.add(cycle).add(Fraction.ONE) // 2c + 1
      const reflect = (s: TimeSpan) =>
        new TimeSpan(pivot.sub(s.end), pivot.sub(s.begin))
      return this.query(reflect(span)).map((h) =>
        hap(h.whole && reflect(h.whole), reflect(h.part), h.value),
      )
    }).splitQueries()
  }

  // ----------------------------------------------------- structure/value

  /** Map every hap's value through f (functor map). */
  withValue<U>(f: (v: T) => U): Pattern<U> {
    return new Pattern((span) =>
      this.query(span).map((h) => hap(h.whole, h.part, f(h.value))),
    )
  }

  /** Keep only haps satisfying the predicate. */
  filterHaps(f: (h: Hap<T>) => boolean): Pattern<T> {
    return new Pattern((span) => this.query(span).filter(f))
  }

  /** Keep only haps whose value satisfies the predicate. */
  filterValues(f: (v: T) => boolean): Pattern<T> {
    return this.filterHaps((h) => f(h.value))
  }

  /**
   * Keep only haps that actually begin within their part — what a
   * scheduler fires. Drops clipped tails and continuous samples.
   */
  onsetsOnly(): Pattern<T> {
    return this.filterHaps(hasOnset)
  }

  // ------------------------------------------------------ app/bind family

  /**
   * Applicative combine taking STRUCTURE FROM THIS pattern: for each hap
   * here, `other` is sampled over the hap's whole (or part when
   * continuous), and each other-hap overlapping our part yields a result
   * hap with our whole, the parts' intersection as part, and
   * combine(ours, theirs) as value. A single left hap can yield several
   * result haps when `other` subdivides it (the whole is kept each time).
   */
  appLeft<U, R>(other: Pattern<U>, combine: (a: T, b: U) => R): Pattern<R> {
    return new Pattern((span) => {
      const out: Hap<R>[] = []
      for (const hl of this.query(span)) {
        for (const hr of other.query(hl.whole ?? hl.part)) {
          const part = hl.part.intersection(hr.part)
          if (part === undefined) continue
          out.push(hap(hl.whole, part, combine(hl.value, hr.value)))
        }
      }
      return out
    })
  }

  /** Mirror of {@link appLeft}: structure (wholes) from OTHER. */
  appRight<U, R>(other: Pattern<U>, combine: (a: T, b: U) => R): Pattern<R> {
    return new Pattern((span) => {
      const out: Hap<R>[] = []
      for (const hr of other.query(span)) {
        for (const hl of this.query(hr.whole ?? hr.part)) {
          const part = hl.part.intersection(hr.part)
          if (part === undefined) continue
          out.push(hap(hr.whole, part, combine(hl.value, hr.value)))
        }
      }
      return out
    })
  }

  /**
   * Applicative combine taking structure from BOTH: both patterns are
   * queried over the span, haps pair up wherever their parts intersect,
   * and the result whole is the sect of the two wholes — undefined if
   * either side is continuous. (Unchecked sect on wholes per the TimeSpan
   * docs: once parts intersect, wholes are known to be combinable.)
   */
  appBoth<U, R>(other: Pattern<U>, combine: (a: T, b: U) => R): Pattern<R> {
    return new Pattern((span) => {
      const rights = other.query(span)
      const out: Hap<R>[] = []
      for (const hl of this.query(span)) {
        for (const hr of rights) {
          const part = hl.part.intersection(hr.part)
          if (part === undefined) continue
          const whole =
            hl.whole && hr.whole ? hl.whole.sect(hr.whole) : undefined
          out.push(hap(whole, part, combine(hl.value, hr.value)))
        }
      }
      return out
    })
  }

  /**
   * Monadic bind taking structure from the INNER pattern: each outer hap
   * selects f(value), which is queried over the outer part; inner haps
   * keep their own wholes.
   */
  innerBind<U>(f: (v: T) => Pattern<U>): Pattern<U> {
    return this.bindWhole((_outer, inner) => inner, f)
  }

  /**
   * Monadic bind taking structure from the OUTER pattern (this): inner
   * haps are re-wholed with the outer hap's whole.
   */
  outerBind<U>(f: (v: T) => Pattern<U>): Pattern<U> {
    return this.bindWhole((outer) => outer, f)
  }

  // NOTE: squeezeBind (each inner pattern compressed into its outer hap's
  // whole — the basis of `squeeze`/`chop`) is deliberately not implemented
  // yet; it arrives with the task that needs it.

  // ------------------------------------------------------------- helpers

  /** Shared bind: chooseWhole picks the result whole from (outer, inner). */
  private bindWhole<U>(
    chooseWhole: (
      outer: TimeSpan | undefined,
      inner: TimeSpan | undefined,
    ) => TimeSpan | undefined,
    f: (v: T) => Pattern<U>,
  ): Pattern<U> {
    return new Pattern((span) =>
      this.query(span).flatMap((outer) =>
        f(outer.value)
          .query(outer.part)
          .map((inner) =>
            hap(chooseWhole(outer.whole, inner.whole), inner.part, inner.value),
          ),
      ),
    )
  }

  /**
   * Transform query-span endpoints (time going IN to the pattern).
   *
   * @remarks Low-level plumbing for combinator modules; not part of the
   * musical API.
   */
  withQueryTime(f: (t: Fraction) => Fraction): Pattern<T> {
    return new Pattern((span) => this.query(span.withTime(f)))
  }

  /**
   * Transform result-hap endpoints, whole and part alike (time coming OUT).
   *
   * @remarks Low-level plumbing for combinator modules; not part of the
   * musical API.
   */
  withHapTime(f: (t: Fraction) => Fraction): Pattern<T> {
    return new Pattern((span) =>
      this.query(span).map((h) =>
        hap(h.whole?.withTime(f), h.part.withTime(f), h.value),
      ),
    )
  }

  /**
   * Decompose every query at cycle boundaries, so the wrapped query only
   * ever sees spans within a single cycle. Required by any query whose
   * behavior depends on "which cycle is this" (cat, rev).
   *
   * @remarks Low-level plumbing for combinator modules; not part of the
   * musical API.
   */
  splitQueries(): Pattern<T> {
    return new Pattern((span) =>
      span.cycleSpans().flatMap((s) => this.query(s)),
    )
  }

  /**
   * Fit ONE cycle of this pattern into [cycle+b, cycle+e) of every cycle,
   * silent elsewhere (Tidal's compress restricted to cycle position —
   * fastGap composed with late). Inner cycle c maps onto outer cycle c's
   * window, so multi-cycle inner structure still advances per cycle.
   * Requires 0 <= b < e <= 1; anything else is silence.
   *
   * @remarks Low-level plumbing for combinator modules; not part of the
   * musical API.
   */
  compressSpan(b: Fraction, e: Fraction): Pattern<T> {
    if (b.lt(0) || e.gt(1) || !b.lt(e)) return Pattern.silence
    const width = e.sub(b)
    return new Pattern<T>((span) => {
      const out: Hap<T>[] = []
      for (const cs of span.cycleSpans()) {
        const cycle = cs.begin.sam()
        const win = new TimeSpan(cycle.add(b), cycle.add(e))
        // intersection's end-edge point exclusion already drops a point
        // query landing exactly on the window's end (next inner cycle).
        const clipped = cs.intersection(win)
        if (clipped === undefined) continue
        const toInner = (t: Fraction) =>
          t.sub(cycle).sub(b).div(width).add(cycle)
        const toOuter = (t: Fraction) =>
          t.sub(cycle).mul(width).add(b).add(cycle)
        for (const h of this.query(clipped.withTime(toInner))) {
          out.push(
            hap(
              h.whole?.withTime(toOuter),
              h.part.withTime(toOuter),
              h.value,
            ),
          )
        }
      }
      return out
    })
  }
}

/**
 * Coerce a value to a Pattern: Patterns pass through untouched, anything
 * else becomes `Pattern.pure(x)`. This is what lets the combinator surface
 * accept bare values (`cat('a', 'b')`, `p.add(12)`) Strudel-style.
 *
 * Caveat: a value that IS a Pattern cannot be pure-wrapped through reify —
 * patterns-of-patterns must call `Pattern.pure` explicitly.
 */
export function reify<T>(x: T | Pattern<T>): Pattern<T> {
  return x instanceof Pattern ? (x as Pattern<T>) : Pattern.pure(x as T)
}
