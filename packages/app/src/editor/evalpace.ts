/* ------------------------------------------------------------------------- *
 * How often a DRAG re-evaluates the document.
 *
 * A knob's sound comes from a direct param hold (~3 ms); a scrubbed plain
 * number has no param identity, so its only route to the engine is the
 * re-eval: rewrite -> compile -> evalCode -> Session diff -> patchConstants.
 * The pipeline itself is cheap (0.3 to 2.7 ms across the shipped examples).
 * What the ear noticed as "the sound trails the finger" was the FIXED 70 ms
 * throttle in front of it, measured in a real Chrome at a median of 39 ms and
 * a p90 of 70 ms from each rewrite to its engine message, on top of the
 * scrubber's own 30 ms rewrite cadence.
 *
 * So the interval is paced by what the last eval actually cost, not by a
 * constant: a project whose eval takes 2 ms re-evaluates on every rewrite; one
 * that takes 20 ms backs off to 80 ms, keeping the eval to a quarter of the
 * main thread so the pattern scheduler (25 ms tick, ~100 ms lookahead) keeps
 * posting notes on time. Pure, so the pacing rule is testable on its own.
 * ------------------------------------------------------------------------- */

/** Never re-eval faster than one display frame. */
export const EVAL_PACE_MIN_MS = 16
/** The eval may take at most this fraction of the drag's main-thread time. */
export const EVAL_PACE_DUTY = 0.25

/** The interval to wait before the next drag re-eval, given how long the
 *  last one took. Bad inputs (NaN, negative) fall back to the floor. */
export function nextEvalInterval(lastEvalMs: number): number {
  if (!Number.isFinite(lastEvalMs) || lastEvalMs <= 0) return EVAL_PACE_MIN_MS
  return Math.max(EVAL_PACE_MIN_MS, lastEvalMs / EVAL_PACE_DUTY)
}
