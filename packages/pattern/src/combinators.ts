import { Fraction, F } from './fraction'
import { TimeSpan, hap } from './types'
import type { Hap } from './types'
import { Pattern, reify, toF } from './pattern'
import { bjorklund } from './euclid'
import { timeHash } from './rand'
import { scaleDegree, parseScaleName } from './scales'

/**
 * The combinator library: the musical surface that makes patterns feel
 * like Tidal. Everything here is installed onto Pattern.prototype via
 * declaration merging + prototype assignment, so this module must be
 * imported FOR ITS SIDE EFFECTS — the package index does that; importing
 * `@rondocode/pattern` activates the full API.
 *
 * Semantics follow Tidal, with Strudel's choices where the two diverge;
 * every behavior is pinned in combinators.test.ts. Randomness is fully
 * deterministic via {@link timeHash} — no Math.random anywhere.
 *
 * NOT here (deliberately):
 * - `jux`/`juxBy` need the pan control, so they arrive with ControlMap in
 *   Task 2.5.
 * - `struct` takes a Pattern<boolean> only; the mini-notation string form
 *   lands with the parser in Task 2.4.
 */

declare module './pattern' {
  interface Pattern<T> {
    /**
     * Apply f on cycles where cycle % n === 0 (Tidal: `when ((cycle) mod n)
     * == 0`) — so cycle 0 is always a hit. Euclidean mod: cycles before
     * zero index consistently. n <= 0 is identity.
     */
    every(n: number, f: (p: Pattern<T>) => Pattern<T>): Pattern<T>
    /** Apply f only on cycles whose integer index satisfies `test`. */
    whenCycle(
      test: (cycle: number) => boolean,
      f: (p: Pattern<T>) => Pattern<T>,
    ): Pattern<T>
    /**
     * Rotate one n-th earlier each cycle: cycle c plays the pattern shifted
     * early by (c mod n)/n, so cycle 1 of `"a b c d".iter(4)` starts at b.
     * n <= 1 is identity.
     */
    iter(n: number): Pattern<T>
    /** iter in the opposite direction: cycle 1 starts at the LAST slot. */
    iterBack(n: number): Pattern<T>
    /** Superimpose f applied to a copy shifted t cycles later. */
    off(t: Fraction | number, f: (p: Pattern<T>) => Pattern<T>): Pattern<T>
    /** Pointwise +. On a numeric pattern (signals, degrees) it adds to the
     *  value; on a note()/n() pattern it TRANSPOSES (adds semitones to the
     *  note, or steps to the degree), keeping loc + other controls. Pattern
     *  operands combine appLeft: structure from this. */
    add(this: Pattern<T>, other: number | Pattern<number>): Pattern<T>
    /** Pointwise - (structure from this). Transposes note/degree patterns down. */
    sub(this: Pattern<T>, other: number | Pattern<number>): Pattern<T>
    /** Pointwise * (structure from this). */
    mul(this: Pattern<T>, other: number | Pattern<number>): Pattern<T>
    /** Pointwise / (structure from this). Float semantics: x/0 is Infinity. */
    div(this: Pattern<T>, other: number | Pattern<number>): Pattern<T>
    /** Map a unipolar [0,1] pattern linearly onto [lo, hi]. */
    range(this: Pattern<number>, lo: number, hi: number): Pattern<number>
    /**
     * Exponential range: lo * (hi/lo)^v — perceptually even sweeps for
     * frequencies. Requires lo, hi > 0 (throws RangeError otherwise).
     */
    rangex(this: Pattern<number>, lo: number, hi: number): Pattern<number>
    /**
     * Take structure from a boolean pattern, values from this: each `true`
     * step becomes an event carrying this pattern's value there; `false`
     * steps are silent. (Mini-notation string arg arrives with Task 2.4.)
     */
    struct(boolPat: Pattern<boolean>): Pattern<T>
    /**
     * Euclidean rhythm: struct with bjorklund(pulses, steps), optionally
     * rotated left by `rotation` steps (Tidal's rotL direction).
     */
    euclid(pulses: number, steps: number, rotation?: number): Pattern<T>
    /** The complementary rhythm: onsets where euclid rests (offbeats). */
    euclidInv(pulses: number, steps: number, rotation?: number): Pattern<T>
    /**
     * Randomly drop haps with probability p, deciding by
     * timeHash(whole.begin, seed) — deterministic per event position, so
     * the same events drop every query and every run.
     *
     * TIME-LOCKED RANDOMNESS: at any given seed, ALL stochastic
     * combinators draw from the same per-time stream, so chained calls at
     * the default seed 0 are fully correlated, not independent:
     * `.degrade().degrade()` drops nothing further (the survivors already
     * have hash >= 0.5), and `.degrade().sometimes(f)` never fires f (the
     * survivors are exactly the haps sometimes leaves untransformed).
     * Tidal and Strudel share this quirk — kept for parity and scheduler
     * stability. Pass distinct `seed` values for independent draws.
     */
    degradeBy(p: number, seed?: number): Pattern<T>
    /** degradeBy(0.5). See degradeBy for the time-locked randomness caveat. */
    degrade(): Pattern<T>
    /** Keep exactly the haps degradeBy(p, seed) drops (the complement). */
    undegradeBy(p: number, seed?: number): Pattern<T>
    /**
     * Apply f to a random subset of events (probability p), keep the rest
     * unchanged. Both halves share one seed, so they partition EXACTLY:
     * sometimesBy(p, id) ≡ identity — no doubled, no missing events.
     *
     * Draws come from the same time-locked stream as degradeBy (see its
     * doc): at the default seed 0, chaining stochastic combinators
     * correlates them — `.degrade().sometimes(f)` never fires f. Pass a
     * distinct `seed` for an independent draw.
     */
    sometimesBy(p: number, f: (p: Pattern<T>) => Pattern<T>, seed?: number): Pattern<T>
    /** sometimesBy(0.5, f). */
    sometimes(f: (p: Pattern<T>) => Pattern<T>): Pattern<T>
    /** sometimesBy(0.75, f). */
    often(f: (p: Pattern<T>) => Pattern<T>): Pattern<T>
    /** sometimesBy(0.25, f). */
    rarely(f: (p: Pattern<T>) => Pattern<T>): Pattern<T>
    /** f applied to everything: f(this). */
    always(f: (p: Pattern<T>) => Pattern<T>): Pattern<T>
    /** f applied to nothing: this. */
    never(f: (p: Pattern<T>) => Pattern<T>): Pattern<T>
    /** Stack this with f(this). */
    superimpose(f: (p: Pattern<T>) => Pattern<T>): Pattern<T>
    /** Alternate forward and reversed cycles: cat(this, this.rev()). */
    palindrome(): Pattern<T>
    /**
     * Repeat each event n times within its own span (a specialized
     * squeeze-bind: subdivide every whole into n equal sub-events).
     * Continuous haps pass through untouched.
     */
    ply(n: number): Pattern<T>
    /**
     * Accelerating fill — a snare roll / build-up. Replaces each event with
     * `n` hits inside its whole; hit i (0-based) begins at fraction
     * `f_i = 1 - (1 - i/n)^accel` of the whole and ends at `f_{i+1}`
     * (`f_n = 1`), each carrying the original value with its own onset.
     *
     * `accel = 1` (default) → even spacing (f_i = i/n): a straight
     * roll/ratchet. `accel > 1` → hits accelerate toward the event's END
     * (gaps shrink) — the classic build-up into the downbeat. `accel < 1`
     * → decelerate. n must be a positive integer and accel > 0 (throws
     * otherwise). Spacing is EXACT for integer accel (rational powers of
     * (n-i)/n); non-integer accel routes the computed fraction through
     * Fraction.fromNumber (a continued-fraction approximation, as other
     * combinators do for irrational factors). Continuous (whole-less) haps
     * pass through untouched, like ply.
     */
    roll(n: number, accel?: number): Pattern<T>
    /**
     * Discretize into n events per cycle, values sampled from this — the
     * standard way to turn a continuous signal into notes. Each step
     * samples the signal at the step's midpoint.
     */
    segment(n: number): Pattern<T>
    /**
     * Divide the cycle into n parts and apply f to a different part each
     * cycle: cycle 0 transforms [0,1/n), cycle 1 [1/n,2/n), ... (Tidal
     * chunk). Events are assigned to the window by where they BEGIN, after
     * f on the transformed branch.
     */
    chunk(n: number, f: (p: Pattern<T>) => Pattern<T>): Pattern<T>
    /**
     * Play only the first t of each cycle, looped to fill the cycle
     * (Tidal linger). t >= 1 is identity; t <= 0 is silence. Cycle-local:
     * each cycle lingers its OWN first t.
     */
    linger(t: Fraction | number): Pattern<T>
    /**
     * Swing, Strudel convention (`swingBy(a, n) = inside(n, late(seq(0,
     * a/2)))`): divide the cycle into n slices; the SECOND HALF of each
     * slice — i.e. the odd subdivisions of the 2n grid — shifts late by
     * amount/(2n). So `"hh*8".swingBy(1/3, 4)` moves the 2nd/4th/6th/8th
     * eighths by 1/24, and events sitting only on the n grid do not move.
     * Events are partitioned by the 2n-grid subdivision their whole BEGINS
     * in, then the odd half is shifted — an exact partition (unlike the
     * within-based original, which filters after shifting; pinned).
     */
    swingBy(amount: Fraction | number, n: number): Pattern<T>
    /** swingBy(1/3, n) — classic triplet swing. */
    swing(n: number): Pattern<T>
  }
}

// ------------------------------------------------------------------ helpers

const requireInt = (n: number, what: string): number => {
  if (!Number.isInteger(n)) {
    throw new TypeError(`${what} requires an integer, got ${n}`)
  }
  return n
}

const requirePosInt = (n: number, what: string): number => {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`${what} requires a positive integer, got ${n}`)
  }
  return n
}

/** The exact time a stochastic decision about a hap is keyed on. */
const hapKey = <T>(h: Hap<T>): Fraction => (h.whole ?? h.part).begin

/**
 * Tidal's `within`, module-private: apply f, keep only the transformed haps
 * whose (whole) start lands in cycle window [b, e); keep the untransformed
 * pattern everywhere else. Used by chunk.
 */
const within = <T>(
  pat: Pattern<T>,
  b: Fraction,
  e: Fraction,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> => {
  const inWindow = <U>(h: Hap<U>): boolean => {
    const pos = hapKey(h).cyclePos()
    return pos.gte(b) && pos.lt(e)
  }
  return Pattern.stack(
    f(pat).filterHaps(inWindow),
    pat.filterHaps((h) => !inWindow(h)),
  )
}

const iterWith = <T>(pat: Pattern<T>, n: number, back: boolean): Pattern<T> => {
  requireInt(n, 'iter')
  if (n <= 1) return pat
  return new Pattern<T>((span) => {
    const k = span.begin.sam().mod(n).div(n) // (c mod n)/n, Euclidean
    return (back ? pat.late(k) : pat.early(k)).query(span)
  }).splitQueries()
}

const euclidBits = (
  pulses: number,
  steps: number,
  rotation: number,
): boolean[] => {
  requireInt(rotation, 'euclid rotation')
  const bits = bjorklund(pulses, steps)
  const r = ((rotation % steps) + steps) % steps
  return r === 0 ? bits : [...bits.slice(r), ...bits.slice(0, r)]
}

// ------------------------------------------------------ prototype assignment

Pattern.prototype.whenCycle = function <T>(
  this: Pattern<T>,
  test: (cycle: number) => boolean,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  const transformed = f(this)
  return new Pattern<T>((span) =>
    (test(span.begin.sam().valueOf()) ? transformed : this).query(span),
  ).splitQueries()
}

Pattern.prototype.every = function <T>(
  this: Pattern<T>,
  n: number,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  requireInt(n, 'every')
  if (n <= 0) return this
  return this.whenCycle((c) => ((c % n) + n) % n === 0, f)
}

Pattern.prototype.iter = function <T>(this: Pattern<T>, n: number): Pattern<T> {
  return iterWith(this, n, false)
}

Pattern.prototype.iterBack = function <T>(this: Pattern<T>, n: number): Pattern<T> {
  return iterWith(this, n, true)
}

Pattern.prototype.off = function <T>(
  this: Pattern<T>,
  t: Fraction | number,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  return Pattern.stack(this, f(this.late(t)))
}

/** Apply a numeric op to a pattern value. Three cases, most-specific first:
 *  1. A plain number (signals, bare degrees) — operate directly.
 *  2. A SCALED control map (`n` + a stamped `scale`, from `n(...).scale(...)`)
 *     — operate on the DEGREE and RE-RESOLVE the note through that scale, so
 *     `.add(2)` moves two SCALE STEPS and stays in key.
 *  3. Any other control map — shift `n` (pre-scale degree) or `note` (absolute)
 *     directly, a raw/semitone move.
 *  loc and every other control ride along untouched. */
const applyArith = (op: (a: number, b: number) => number, a: unknown, b: number): unknown => {
  if (typeof a === 'number') return op(a, b)
  if (a !== null && typeof a === 'object') {
    const m = a as Record<string, unknown>
    if (typeof m['n'] === 'number') {
      const nn = op(m['n'], b)
      if (typeof m['scale'] === 'string') {
        const { root, intervals } = parseScaleName(m['scale'])
        // Preserve any note-level offset a prior .octave()/.invert()/.voicing()
        // baked into `note` on top of the scale resolution — don't recompute the
        // note from the degree alone, or that revoicing is silently discarded.
        const resolvedOld = root + scaleDegree(intervals, Math.round(m['n']))
        const offset = typeof m['note'] === 'number' ? m['note'] - resolvedOld : 0
        return { ...m, n: nn, note: root + scaleDegree(intervals, Math.round(nn)) + offset }
      }
      return { ...m, n: nn }
    }
    if (typeof m['note'] === 'number') return { ...m, note: op(m['note'], b) }
  }
  return a
}

/** Apply a unary numeric fn to a pattern value: directly for a plain number
 *  (signals/degrees), else to the pitch field of a control map (note, then n),
 *  keeping loc + the other controls. Non-numeric values pass through. Used by
 *  range/rangex so they don't NaN-out a note()/n()/chord() pattern. */
const mapNumericField = (fn: (v: number) => number, a: unknown): unknown => {
  if (typeof a === 'number') return fn(a)
  if (a !== null && typeof a === 'object') {
    const m = a as Record<string, unknown>
    if (typeof m['note'] === 'number') return { ...m, note: fn(m['note']) }
    if (typeof m['n'] === 'number') return { ...m, n: fn(m['n']) }
  }
  return a
}

const arith = (
  op: (a: number, b: number) => number,
): (<T>(this: Pattern<T>, other: number | Pattern<number>) => Pattern<T>) =>
  function <T>(this: Pattern<T>, other: number | Pattern<number>): Pattern<T> {
    return this.appLeft(reify(other), (a: T, b) => applyArith(op, a, b as number) as T)
  }

Pattern.prototype.add = arith((a, b) => a + b)
Pattern.prototype.sub = arith((a, b) => a - b)
Pattern.prototype.mul = arith((a, b) => a * b)
Pattern.prototype.div = arith((a, b) => a / b)

Pattern.prototype.range = function (
  this: Pattern<number>,
  lo: number,
  hi: number,
): Pattern<number> {
  return this.withValue((v) => mapNumericField((x) => x * (hi - lo) + lo, v) as number)
}

Pattern.prototype.rangex = function (
  this: Pattern<number>,
  lo: number,
  hi: number,
): Pattern<number> {
  if (!(lo > 0) || !(hi > 0)) {
    throw new RangeError(`rangex requires positive bounds, got ${lo}..${hi}`)
  }
  return this.withValue((v) => mapNumericField((x) => lo * (hi / lo) ** x, v) as number)
}

Pattern.prototype.struct = function <T>(
  this: Pattern<T>,
  boolPat: Pattern<boolean>,
): Pattern<T> {
  // Structure (wholes) from the boolean pattern, values sampled from this
  // over each structural whole — appRight is exactly that shape.
  return this.appRight(boolPat, (v, b) => (b ? { v } : undefined))
    .filterValues((x) => x !== undefined)
    .withValue((x) => (x as { v: T }).v)
}

Pattern.prototype.euclid = function <T>(
  this: Pattern<T>,
  pulses: number,
  steps: number,
  rotation = 0,
): Pattern<T> {
  return this.struct(Pattern.fastcat(...euclidBits(pulses, steps, rotation)))
}

Pattern.prototype.euclidInv = function <T>(
  this: Pattern<T>,
  pulses: number,
  steps: number,
  rotation = 0,
): Pattern<T> {
  return this.struct(
    Pattern.fastcat(...euclidBits(pulses, steps, rotation).map((b) => !b)),
  )
}

Pattern.prototype.degradeBy = function <T>(
  this: Pattern<T>,
  p: number,
  seed = 0,
): Pattern<T> {
  return this.filterHaps((h) => timeHash(hapKey(h), seed) >= p)
}

Pattern.prototype.undegradeBy = function <T>(
  this: Pattern<T>,
  p: number,
  seed = 0,
): Pattern<T> {
  return this.filterHaps((h) => timeHash(hapKey(h), seed) < p)
}

Pattern.prototype.degrade = function <T>(this: Pattern<T>): Pattern<T> {
  return this.degradeBy(0.5)
}

Pattern.prototype.sometimesBy = function <T>(
  this: Pattern<T>,
  p: number,
  f: (p: Pattern<T>) => Pattern<T>,
  seed = 0,
): Pattern<T> {
  // Same seed on both halves: each hap goes to exactly one side, so the
  // result is an exact partition (sometimesBy(p, id) ≡ identity).
  return Pattern.stack(this.degradeBy(p, seed), f(this.undegradeBy(p, seed)))
}

Pattern.prototype.sometimes = function <T>(
  this: Pattern<T>,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  return this.sometimesBy(0.5, f)
}

Pattern.prototype.often = function <T>(
  this: Pattern<T>,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  return this.sometimesBy(0.75, f)
}

Pattern.prototype.rarely = function <T>(
  this: Pattern<T>,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  return this.sometimesBy(0.25, f)
}

Pattern.prototype.always = function <T>(
  this: Pattern<T>,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  return f(this)
}

Pattern.prototype.never = function <T>(
  this: Pattern<T>,
  _f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  return this
}

Pattern.prototype.superimpose = function <T>(
  this: Pattern<T>,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  return Pattern.stack(this, f(this))
}

Pattern.prototype.palindrome = function <T>(this: Pattern<T>): Pattern<T> {
  return Pattern.cat(this, this.rev())
}

Pattern.prototype.ply = function <T>(this: Pattern<T>, n: number): Pattern<T> {
  requirePosInt(n, 'ply')
  if (n === 1) return this
  return new Pattern<T>((span) => {
    const out: Hap<T>[] = []
    for (const h of this.query(span)) {
      if (h.whole === undefined) {
        out.push(h) // continuous: nothing to repeat
        continue
      }
      const w = h.whole.length.div(n)
      for (let i = 0; i < n; i++) {
        const b = h.whole.begin.add(w.mul(i))
        const sub = new TimeSpan(b, b.add(w))
        const part = sub.intersection(h.part)
        if (part === undefined) continue
        out.push(hap(sub, part, h.value))
      }
    }
    return out
  })
}

Pattern.prototype.roll = function <T>(
  this: Pattern<T>,
  n: number,
  accel = 1,
): Pattern<T> {
  requirePosInt(n, 'roll')
  if (!(accel > 0)) {
    throw new RangeError(`roll requires accel > 0, got ${accel}`)
  }
  const intAccel = Number.isInteger(accel)
  // Fraction of the whole where hit i begins: f_i = 1 - (1 - i/n)^accel.
  // For integer accel this is exact ((n-i)/n raised by repeated mul); for
  // non-integer accel we fall back to Fraction.fromNumber on the float.
  const fracAt = (i: number): Fraction => {
    if (i === 0) return Fraction.ZERO
    if (i === n) return Fraction.ONE
    if (intAccel) {
      const base = F(n - i, n) // 1 - i/n, exactly rational
      let pow = Fraction.ONE
      for (let k = 0; k < accel; k++) pow = pow.mul(base)
      return Fraction.ONE.sub(pow)
    }
    return Fraction.fromNumber(1 - (1 - i / n) ** accel)
  }
  return new Pattern<T>((span) => {
    const out: Hap<T>[] = []
    for (const h of this.query(span)) {
      if (h.whole === undefined) {
        out.push(h) // continuous: nothing to roll
        continue
      }
      const wb = h.whole.begin
      const len = h.whole.length
      let f0 = fracAt(0)
      for (let i = 0; i < n; i++) {
        const f1 = fracAt(i + 1)
        const b = wb.add(len.mul(f0))
        const sub = new TimeSpan(b, wb.add(len.mul(f1)))
        f0 = f1
        const part = sub.intersection(h.part)
        if (part === undefined) continue
        out.push(hap(sub, part, h.value))
      }
    }
    return out
  })
}

Pattern.prototype.segment = function <T>(this: Pattern<T>, n: number): Pattern<T> {
  requirePosInt(n, 'segment')
  return this.struct(Pattern.pure(true).fast(n))
}

Pattern.prototype.chunk = function <T>(
  this: Pattern<T>,
  n: number,
  f: (p: Pattern<T>) => Pattern<T>,
): Pattern<T> {
  requirePosInt(n, 'chunk')
  return Pattern.cat(
    ...Array.from({ length: n }, (_, i) => within(this, F(i, n), F(i + 1, n), f)),
  )
}

Pattern.prototype.linger = function <T>(
  this: Pattern<T>,
  t: Fraction | number,
): Pattern<T> {
  const tf = toF(t)
  if (!tf.gt(0)) return Pattern.silence
  if (tf.gte(1)) return this
  return new Pattern<T>((span) => {
    const out: Hap<T>[] = []
    for (const cs of span.cycleSpans()) {
      const cycle = cs.begin.sam()
      // Windows [cycle + k*t, cycle + (k+1)*t) tile the cycle; each plays
      // this pattern's FIRST t of the cycle, shifted into place. Only scan
      // windows that can overlap this span: start at the window containing
      // cs.begin, stop once the window start passes cs.end (a zero-width
      // span still admits the window BEGINNING at its point).
      const firstK = cs.begin.sub(cycle).div(tf).floor().valueOf()
      for (let k = firstK; ; k++) {
        const offset = tf.mul(k)
        if (offset.gte(1)) break
        const wb = cycle.add(offset)
        if (wb.gt(cs.end) || (cs.begin.lt(cs.end) && wb.gte(cs.end))) break
        const we = wb.add(tf).min(cycle.add(Fraction.ONE))
        const clipped = cs.intersection(new TimeSpan(wb, we))
        if (clipped === undefined) continue
        for (const h of this.query(clipped.withTime((x) => x.sub(offset)))) {
          out.push(
            hap(
              h.whole?.withTime((x) => x.add(offset)),
              h.part.withTime((x) => x.add(offset)),
              h.value,
            ),
          )
        }
      }
    }
    return out
  })
}

Pattern.prototype.swingBy = function <T>(
  this: Pattern<T>,
  amount: Fraction | number,
  n: number,
): Pattern<T> {
  requirePosInt(n, 'swingBy')
  const grid = 2 * n // Strudel: the swung positions are the odd 2n-ths
  const shift = toF(amount).div(grid)
  const odd = <U>(h: Hap<U>): boolean =>
    hapKey(h).cyclePos().mul(grid).floor().valueOf() % 2 === 1
  return Pattern.stack(
    this.filterHaps((h) => !odd(h)),
    this.filterHaps(odd).late(shift),
  )
}

Pattern.prototype.swing = function <T>(this: Pattern<T>, n: number): Pattern<T> {
  return this.swingBy(F(1, 3), n)
}
