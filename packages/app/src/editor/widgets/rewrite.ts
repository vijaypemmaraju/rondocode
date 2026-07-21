/* ------------------------------------------------------------------------- *
 * Literal rewriting — PURE: value → source text → ChangeSpec. The TEXT is
 * the source of truth: widgets only ever edit the document, so copy/pasting
 * a doc reproduces the exact music, and undo history covers widget moves.
 * ------------------------------------------------------------------------- */

export interface LiteralRange {
  from: number
  to: number
}

export interface LiteralChange {
  from: number
  to: number
  insert: string
}

/** Snap a raw step to a "nice" 1/2/5 × 10^k value no larger than it —
 *  slider readouts then land on clean numbers (39.6 → 20, 0.005 → 0.005). */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [5, 2, 1]) {
    if (pow * m <= raw * 1.000001) return pow * m
  }
  return pow
}

/** Decimal places needed to print multiples of `step` exactly. */
const stepDecimals = (step: number): number => {
  const s = step.toString()
  if (s.includes('e')) {
    // 1e-7 etc: exponent gives the scale
    const exp = Number(s.slice(s.indexOf('e') + 1))
    return exp < 0 ? -exp : 0
  }
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

/** Strip trailing zeros from a toFixed result ("0.750" → "0.75"). */
const trimZeros = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)

/**
 * Format a number for insertion into source.
 * - With a `step`: quantize to the step grid (anchored at `min`, default 0)
 *   and print exactly the step's decimal places — slider drags then produce
 *   stable, readable literals.
 * - Without: 3 significant figures (integers stay exact integers).
 */
export function formatNumber(value: number, opts?: { step?: number; min?: number }): string {
  if (!Number.isFinite(value)) return '0'
  const step = opts?.step
  if (step !== undefined && step > 0) {
    const min = opts?.min ?? 0
    const snapped = min + Math.round((value - min) / step) * step
    return trimZeros(snapped.toFixed(Math.min(stepDecimals(step), 10)))
  }
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(3)))
}

export const formatBoolean = (b: boolean): string => (b ? 'true' : 'false')

/** ChangeSpec replacing a literal with new text. */
export const literalChange = (range: LiteralRange, insert: string): LiteralChange => ({
  from: range.from,
  to: range.to,
  insert,
})

/** ChangeSpec replacing a numeric literal (formatting per formatNumber). */
export const numberChange = (
  range: LiteralRange,
  value: number,
  opts?: { step?: number; min?: number },
): LiteralChange => literalChange(range, formatNumber(value, opts))
