/** Block-end state hygiene shared by stateful kernels, called once per
 *  process(). Zeroes state below 1e-15 — an "inaudible tail" cutoff well above
 *  the true denormal range, so long silent tails settle to exact 0 cheaply —
 *  and zeroes non-finite state, so NaN/Inf arriving on ANY input (signal or
 *  control) poisons the kernel for at most one block and recovers at block
 *  end. */
export const flush = (s: number): number => (!Number.isFinite(s) || Math.abs(s) < 1e-15 ? 0 : s)

/** Per-sample defensive clamp; NaN passes through (flush() catches it). */
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Slope-matched tanh soft knee: identity for |v| <= t, and
 *  sign(v) * (t + (1-t) * tanh((|v|-t)/(1-t))) beyond it. Value- AND
 *  slope-matched at ±t (f(t) = t, f'(t) = 1 — the same C1 requirement as
 *  delay.ts's reciprocal knee; see its doc for why a naive tanh-above-
 *  threshold writes audible steps), monotonic, asymptotes at ±1 exactly.
 *  Assumes 0 < t < 1. Non-finite v passes through untouched — callers that
 *  need NaN safety scrub separately (see realtime.ts masterSafety). */
export const softClipTanh = (v: number, t: number): number => {
  if (v > t) return t + (1 - t) * Math.tanh((v - t) / (1 - t))
  if (v < -t) return -(t + (1 - t) * Math.tanh((-v - t) / (1 - t)))
  return v
}
