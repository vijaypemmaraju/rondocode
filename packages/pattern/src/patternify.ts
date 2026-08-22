/* PATTERNIFIED COUNTS — the Strudel move where a combinator's numeric arg may
 * itself be a pattern, so the count changes over time: `fast("<1 2>")`,
 * `euclid("<3 5>", 8)`, `ply("<2 3>")`.
 *
 * Rather than rewrite twenty method bodies, this CAPTURES each method's current
 * implementation as the numeric CORE and wraps it: a plain number (or Fraction)
 * takes the core directly — byte-identical to before, which matters because
 * `fast`/`slow` are on the hot path and called internally with numbers — while
 * a mini string (what rondo emits for `<…>`) or a Pattern drives the transform
 * through `innerBind`, applying the core per value-span of the count. Leading
 * args patternify; trailing function/seed args (every's f, degradeBy's seed)
 * ride through untouched.
 *
 * Loaded LAST by the package index, after controls/chords/combinators have
 * installed the methods this wraps.
 */
import { Pattern } from './pattern'
import { Fraction } from './fraction'
import { mini } from './mini'

type Proto = Record<string, (this: Pattern<unknown>, ...args: unknown[]) => Pattern<unknown>>
const proto = Pattern.prototype as unknown as Proto

/** A count arg is a scalar (taken as-is) or a pattern/mini-string (queried). */
const isScalar = (x: unknown): boolean => typeof x === 'number' || x instanceof Fraction

/** A mini string or a Pattern → a Pattern of numbers (non-numeric atoms coerced,
 *  so `<2 4>` and a bare `3` both work). */
const asNumPat = (x: string | Pattern<unknown>): Pattern<number> =>
  (typeof x === 'string' ? mini(x) : x).withValue((v) =>
    Math.floor(typeof v === 'number' ? v : Number(v)),
  ) as unknown as Pattern<number>

/**
 * Wrap `Pattern.prototype[name]` so its first `count` args accept a pattern.
 * When every leading arg is a scalar the original runs unchanged; otherwise the
 * patterned leading args are product-joined (first outermost) and the core runs
 * per combination, with any trailing args (functions, seeds) passed through.
 */
function patternify(name: string, count: number): void {
  const core = proto[name]
  if (typeof core !== 'function') throw new Error(`patternify: no Pattern.prototype.${name}`)
  proto[name] = function (this: Pattern<unknown>, ...args: unknown[]): Pattern<unknown> {
    const k = Math.min(count, args.length)
    let patterned = false
    for (let i = 0; i < k; i++) if (!isScalar(args[i])) { patterned = true; break }
    if (!patterned) return core.apply(this, args)
    const self = this
    const rest = args.slice(k)
    const go = (i: number, acc: unknown[]): Pattern<unknown> => {
      if (i === k) return core.apply(self, [...acc, ...rest])
      const a = args[i]
      if (isScalar(a)) return go(i + 1, [...acc, a])
      return asNumPat(a as string | Pattern<unknown>).innerBind((v) => go(i + 1, [...acc, v]))
    }
    return go(0, [])
  }
}

// One leading count (rest = a function, a seed, or nothing).
for (const n of [
  'fast', 'slow', 'early', 'late',
  'ply', 'segment', 'iter', 'iterBack', 'linger', 'swing',
  'chunk', 'every', 'off',
  'degradeBy', 'undegradeBy', 'sometimesBy',
  'invert', 'octave', 'voiceLead',
]) patternify(n, 1)

// Two leading counts (trailing seed rides through for humanizeBy).
for (const n of ['swingBy', 'roll', 'humanizeBy']) patternify(n, 2)

// Three leading counts (optional trailing ones just aren't present).
for (const n of ['euclid', 'euclidInv', 'echo', 'ping']) patternify(n, 3)
