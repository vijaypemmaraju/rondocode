import { synth } from '@rondocode/engine'
import {
  Pattern,
  reify,
  mini,
  m,
  n,
  note,
  chord,
  sound,
  s,
  sine,
  sine2,
  cosine,
  saw,
  isaw,
  tri,
  square,
  saw2,
  tri2,
  square2,
  rand,
  perlin,
  irand,
  arrange,
  rise,
  fall,
} from '@rondocode/pattern'

/* ------------------------------------------------------------------------- *
 * The eval sandbox VOCABULARY: the exact set of names user code sees as
 * "globals" (they become parameters of the compiled Function — see
 * evalCode.ts). Combinators (.every, .scale, .rev, ...) ride along on
 * Pattern.prototype and need no entry here.
 *
 * This is a NAMESPACE, not a security boundary. User code is same-origin,
 * user-authored, and not adversarial: real globals (globalThis, fetch, ...)
 * remain reachable through the JS global scope exactly as in any <script>.
 * What this object guarantees is only that the DSL surface is closed and
 * explicit — nothing outside this list is part of the language we document,
 * complete, or promise stability for.
 *
 * Three more names complete the vocabulary at eval time — `p`, `defineSynth`
 * and `setCps` — injected per-eval by evalCode() because they write into
 * that eval's staging state (see evalCode.ts).
 *
 * All keys MUST be valid JS identifiers (they become parameter names).
 * ------------------------------------------------------------------------- */

/** slider(v, min?, max?, step?) — editor widget placeholder. In eval it is
 *  the identity on its first argument; the editor (Task 5.1) renders the
 *  call as a draggable slider and rewrites the literal. Values flow through
 *  unchanged here. */
const slider = (v: number, _min?: number, _max?: number, _step?: number): number => v

/** xy(x, y) — 2D-pad widget placeholder; evaluates to [x, y]. */
const xy = (x: number, y: number): [number, number] => [x, y]

/** toggle(b) — checkbox widget placeholder; identity on its argument. */
const toggle = (b: boolean): boolean => b

/** pick(v, ...options) — dropdown widget placeholder; identity on `v` (the
 *  options only feed the editor's dropdown). */
const pick = <T>(v: T, ..._options: T[]): T => v

/** The frozen sandbox scope. Shared across evals — safe because every value
 *  is a pure function or an immutable Pattern. */
export const baseScope: Readonly<Record<string, unknown>> = Object.freeze({
  // synth definition (engine builder DSL)
  synth,
  // pattern entry points
  n,
  note,
  chord,
  sound,
  s,
  mini,
  m,
  // pattern constructors
  cat: <T>(...args: (T | Pattern<T>)[]) => Pattern.cat(...args),
  fastcat: <T>(...args: (T | Pattern<T>)[]) => Pattern.fastcat(...args),
  stack: <T>(...args: (T | Pattern<T>)[]) => Pattern.stack(...args),
  timecat: <T>(pairs: [number, T | Pattern<T>][]) => Pattern.timecat(pairs),
  silence: Pattern.silence,
  reify,
  // song arrangement
  arrange,
  rise,
  fall,
  // continuous signals
  sine,
  sine2,
  cosine,
  saw,
  isaw,
  tri,
  square,
  saw2,
  tri2,
  square2,
  rand,
  perlin,
  irand,
  // editor widget placeholders (identity semantics — see docs above)
  slider,
  xy,
  toggle,
  pick,
})
