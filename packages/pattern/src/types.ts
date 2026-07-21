import { Fraction } from './fraction'

/**
 * A half-open interval [begin, end) of pattern time, in cycles.
 *
 * Spans are the currency of pattern queries: the engine asks a pattern for
 * events within a span, and events carry spans describing where they live.
 * Zero-width spans (begin === end) are legal and meaningful — they query a
 * single instant, which is how continuous signals are sampled.
 *
 * Immutable: every operation returns a new TimeSpan.
 */
export class TimeSpan {
  /** begin <= end is enforced; violating it throws RangeError. */
  constructor(
    readonly begin: Fraction,
    readonly end: Fraction,
  ) {
    if (begin.gt(end)) {
      throw new RangeError(`TimeSpan begin ${begin} must be <= end ${end}`)
    }
  }

  /** Duration: end - begin (zero for instant spans). */
  get length(): Fraction {
    return this.end.sub(this.begin)
  }

  /**
   * Map both endpoints through time functions: `fb` transforms begin,
   * `fe` transforms end (defaults to `fb`). The transformed endpoints must
   * still satisfy begin <= end, or the constructor throws.
   */
  withTime(
    fb: (t: Fraction) => Fraction,
    fe: (t: Fraction) => Fraction = fb,
  ): TimeSpan {
    return new TimeSpan(fb(this.begin), fe(this.end))
  }

  /**
   * Unchecked intersection: plain max(begin) / min(end), no overlap test.
   * The caller guarantees the spans overlap (or at least touch) — if they
   * don't, the TimeSpan constructor throws RangeError (begin > end).
   *
   * When to use which: `sect` is for combining WHOLES in the app*
   * combinators once the parts are already known to intersect (Strudel
   * semantics — running the checked {@link intersection} on wholes there
   * can drop a whole that merely edge-touches during a point query).
   * Use {@link intersection} when overlap is genuinely in question,
   * e.g. clipping parts against a query span.
   */
  sect(other: TimeSpan): TimeSpan {
    return new TimeSpan(this.begin.max(other.begin), this.end.min(other.end))
  }

  /**
   * Checked overlap with another span, or undefined when they don't
   * overlap. See {@link sect} for the unchecked variant used to combine
   * wholes in the app* combinators.
   *
   * Zero-width semantics (matters for continuous-signal sampling; matches
   * Tidal's `subArc`): spans are half-open, so a zero-width result that
   * sits at the END of a positive-width operand lies outside that span and
   * yields undefined — `[0,1) ∩ [1,1]` is empty, as is the edge-touch of
   * two positive-width spans (`[0,1) ∩ [1,2)`). A zero-width span whose
   * point falls at the BEGIN edge or interior of the other span does
   * intersect (`[0,1) ∩ [0,0]` is `[0,0]`), and two identical zero-width
   * spans intersect. Without the end-edge exclusion, point queries produce
   * phantom haps from events that end exactly at the queried instant.
   */
  intersection(other: TimeSpan): TimeSpan | undefined {
    const begin = this.begin.max(other.begin)
    const end = this.end.min(other.end)
    if (begin.gt(end)) return undefined
    if (begin.eq(end)) {
      // Half-open exclusion (Tidal subArc): a point at the END of a
      // positive-width operand is outside it. This also covers the
      // edge-touch of two positive-width spans. Begin-edge and interior
      // points intersect, as do two identical zero-width spans.
      if (this.begin.lt(this.end) && end.eq(this.end)) return undefined
      if (other.begin.lt(other.end) && end.eq(other.end)) return undefined
    }
    return new TimeSpan(begin, end)
  }

  /**
   * Split at integer cycle boundaries: [1/2, 5/2) becomes
   * [1/2,1), [1,2), [2,5/2). Spans lying within one cycle come back as a
   * single element; a zero-width span comes back as [itself]. The engine
   * uses this to query patterns one cycle at a time.
   */
  cycleSpans(): TimeSpan[] {
    if (this.begin.eq(this.end)) return [this]
    const spans: TimeSpan[] = []
    let b = this.begin
    while (b.lt(this.end)) {
      const e = b.nextSam().min(this.end)
      spans.push(new TimeSpan(b, e))
      b = e
    }
    return spans
  }

  /** Exact endpoint equality. */
  equals(other: TimeSpan): boolean {
    return this.begin.eq(other.begin) && this.end.eq(other.end)
  }

  /** "[1/2, 3/2)" — half-open interval notation. */
  toString(): string {
    return `[${this.begin}, ${this.end})`
  }
}

/**
 * A pattern event ("happening"), the unit returned by pattern queries.
 *
 * `whole` is the event's full extent — where it would sound if nothing
 * clipped it. `part` is the fragment that actually falls inside the queried
 * span; when `whole` exists, `part` always lies within it. A missing
 * `whole` marks a continuous signal sample: there is no discrete onset,
 * just a value observed over `part`.
 */
export interface Hap<T> {
  whole?: TimeSpan
  part: TimeSpan
  value: T
}

/**
 * Build a Hap. Pass `undefined` for whole to mark a continuous sample.
 * Not validated: callers maintain the part-within-whole invariant.
 */
export const hap = <T>(
  whole: TimeSpan | undefined,
  part: TimeSpan,
  value: T,
): Hap<T> => ({ whole, part, value })

/**
 * True when the event actually STARTS inside this fragment: it has a
 * discrete extent and the fragment begins exactly at the event's beginning.
 * The scheduler fires only onset haps — a clipped tail (part.begin >
 * whole.begin) is the continuation of a note already triggered in an
 * earlier query, and continuous samples never trigger at all.
 */
export function hasOnset<T>(h: Hap<T>): boolean {
  return h.whole !== undefined && h.whole.begin.eq(h.part.begin)
}
