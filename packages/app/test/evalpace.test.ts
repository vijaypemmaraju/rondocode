import { describe, expect, it } from 'vitest'
import { EVAL_PACE_DUTY, EVAL_PACE_MIN_MS, nextEvalInterval } from '../src/editor/evalpace'

/* A dragged number reaches the engine only through a re-eval, so the interval
 * between drag re-evals IS the number's latency over a knob. It is paced by
 * the measured cost of the last eval: cheap projects re-eval every rewrite,
 * expensive ones back off so the eval never hogs the main thread. */

describe('nextEvalInterval', () => {
  it('a cheap eval (the shipped examples: 0.3 to 2.7 ms) paces at the floor', () => {
    expect(nextEvalInterval(0.3)).toBe(EVAL_PACE_MIN_MS)
    expect(nextEvalInterval(2.7)).toBe(EVAL_PACE_MIN_MS)
    // right up to the point where the duty rule takes over
    expect(nextEvalInterval(EVAL_PACE_MIN_MS * EVAL_PACE_DUTY)).toBe(EVAL_PACE_MIN_MS)
  })

  it('the floor is one display frame, which is faster than the old fixed 70 ms', () => {
    expect(EVAL_PACE_MIN_MS).toBeLessThanOrEqual(16)
    expect(EVAL_PACE_MIN_MS).toBeGreaterThan(0)
  })

  it('an expensive eval backs off so it takes at most the duty share of the thread', () => {
    const interval = nextEvalInterval(20)
    expect(interval).toBe(80)
    expect(20 / interval).toBeCloseTo(EVAL_PACE_DUTY)
    // and it keeps scaling: twice the cost, twice the wait
    expect(nextEvalInterval(40)).toBe(2 * interval)
  })

  it('never waits less than the floor on nonsense timings', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(nextEvalInterval(bad), String(bad)).toBe(EVAL_PACE_MIN_MS)
    }
  })
})
