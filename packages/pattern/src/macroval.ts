/* ------------------------------------------------------------------------- *
 * Macros, seen from the PATTERN layer.
 *
 * A macro is normally a synth param: a per-sample buffer inside the audio
 * graph. That is the right home for a filter cutoff, and it is why
 * `dur: bright / 7300` could not work — `dur` is structural, consumed by the
 * scheduler per event and never sent to the engine, so the two layers could
 * not see each other.
 *
 * This is the other half of the same control. The macro's CURRENT value is
 * mirrored here as a plain number, and `macroval(name)` reads it as a
 * continuous signal — so the pattern layer can do arithmetic on the same knob
 * the synths are reading, and one control really does reach everything.
 *
 * SAMPLED PER EVENT, not per sample. `.dur(macroval('bright').div(7300))`
 * takes the value at each onset and holds it for that note, exactly like any
 * other signal-driven control. Moving the knob changes the next notes, not the
 * ones already scheduled — the same contract `.ctrl('cutoff', sine…)` has, and
 * the honest one for something the scheduler reads ahead of time.
 * ------------------------------------------------------------------------- */

import { signal } from './signal'
import type { Pattern } from './pattern'

/** Live macro values, mirrored from whoever owns the real ones (the app writes
 *  the declared defaults on each eval, and the knob writes as it moves). */
const values = new Map<string, number>()

/** Set a macro's current value. Called on eval for every declaration, and on
 *  every move of a macro knob so the pattern side does not wait for a
 *  re-eval. */
export function setMacroValue(name: string, value: number): void {
  if (Number.isFinite(value)) values.set(name, value)
}

/** The current value, or undefined when nothing has declared this name. */
export function getMacroValue(name: string): number | undefined {
  return values.get(name)
}

/** Drop every mirrored value (the eval layer clears before each run so a
 *  deleted macro does not linger). */
export function clearMacroValues(): void {
  values.clear()
}

/** Every mirrored value, for tests and diagnostics. */
export function getMacroValues(): ReadonlyMap<string, number> {
  return new Map(values)
}

/**
 * A macro as a pattern signal: `macroval('bright').div(7300)`.
 *
 * Reads the value at QUERY time rather than capturing it, so the knob keeps
 * working without re-evaluating the program. An undeclared name reads 0 —
 * silence rather than NaN, which would spread through every arithmetic
 * combinator downstream and take the whole pattern with it.
 */
export function macroval(name: string): Pattern<number> {
  return signal(() => values.get(name) ?? 0)
}
