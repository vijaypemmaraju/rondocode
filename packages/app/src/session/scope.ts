import { synth, defineWavetable, macro, lookupMacro } from '@rondocode/engine'
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
  defineScale,
  macroval,
  curve,
  curvedef,
  shape,
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

/** A macro's declared value as a number. 0 for an unknown name, matching
 *  macroval's choice: NaN would spread through whatever arithmetic follows and
 *  take the whole sidechain with it. */
const macroNum = (name: string): number => lookupMacro(name)?.default ?? 0

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
  // breakpoint automation over the TIMELINE: the same shape as a synth's
  // env(), measured in cycles and run against the transport, for what a DAW
  // calls an automation lane. rise/fall are its two-point special cases.
  curve,
  // named curve SHAPES, stored normalised and scaled at the point of use:
  // env measures in seconds and curve() in cycles, so a shape carrying real
  // durations would mean two different things depending on where you spent
  // it. Same registry lifecycle as defineScale.
  curvedef,
  shape,
  // custom tunings: register a scale for .scale(). NOT per-eval staging —
  // the registry lives in the pattern package; evalCode snapshots/clears/
  // restores it around each run so it mirrors the last successful eval.
  defineScale,
  // custom wavetables: register a table for wavetable(..., { table }). Same
  // lifecycle as defineScale (registry in the engine package; evalCode
  // snapshots/clears/restores it). Must run BEFORE the synth() that uses the
  // table — synth() eager-compiles and resolves table names at construction.
  defineWavetable,
  // project-wide macros: one declaration, referenced as param('name') with no
  // default from any synth or post chain, so every use site reads ONE set of
  // numbers and one knob moves them all. Same registry lifecycle as
  // defineScale/defineWavetable (see macro.ts) and the same ordering rule —
  // declare it above the synths that use it.
  macro,
  // the same macro, read from the PATTERN layer: `dur: bright / 7300` is
  // .dur(macroval('bright').div(7300)). `dur`/`gain`/`pan` are structural —
  // the scheduler consumes them per event and they never reach the engine —
  // so a synth param could not drive them. This mirrors the value across.
  // the same macro as a plain NUMBER, for the places that capture a value at
  // eval rather than reading a signal per sample. sidechain()'s duck depth is
  // the one that matters: the pump was the only project control a macro could
  // not reach. Resolves to the DECLARED value, so it follows a switch tap (which
  // rewrites the source and re-evals) but not a knob mid-drag.
  macroNum,
  macroval,
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
