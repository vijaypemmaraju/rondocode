/* ------------------------------------------------------------------------- *
 * Where a quantized call lands.
 *
 * An agent's call arrives whenever its tool call happens to, which is never on
 * a bar line. `quantize: N` holds it until the next cycle that is a multiple
 * of N (1 = the next bar, 8 = the next eight-bar phrase).
 *
 * A program swap needs a LEAD. The scheduler asks the patterns for events a
 * lookahead before they sound, one tick at a time, so a swap made ON the
 * boundary is too late for the boundary's own downbeat: it must already be in
 * place when that window is queried. A param move has no such queue and takes
 * a lead of 0.
 *
 * Pure, so the rule is testable without a transport.
 * ------------------------------------------------------------------------- */

export interface Boundary {
  /** The cycle the change lands on: a whole multiple of `bars`. */
  cycle: number
  /** How long to hold the call, in ms, so it applies `leadMs` before that. */
  waitMs: number
}

/** The next boundary a call made at `cycle` can still reach.
 *
 *  A boundary already inside the lead is skipped for the one after: the swap
 *  could not be in place in time, and landing late is worse than landing a
 *  phrase later. Sitting exactly ON a boundary counts as having missed it for
 *  the same reason. */
export function nextBoundary(cycle: number, cps: number, bars: number, leadMs: number): Boundary {
  const leadCycles = (leadMs / 1000) * cps
  const target = Math.ceil((cycle + leadCycles + 1e-6) / bars) * bars
  const waitMs = Math.max(0, ((target - cycle) / cps) * 1000 - leadMs)
  return { cycle: target, waitMs }
}
