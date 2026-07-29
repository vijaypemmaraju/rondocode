/* ------------------------------------------------------------------------- *
 * Named curve shapes.
 *
 * A shape is stored NORMALISED — segment lengths as fractions of the whole,
 * levels as written — and scaled at the point of use. That is the decision
 * that lets one definition serve both layers: `env` measures in seconds and
 * `curve()` in cycles, so a shape carrying real durations would mean two
 * different things depending on where you spent it.
 *
 *   curvedef('swell', [[0.25, 1], [0.75, 0.2]])
 *   env(gate, shape('swell', 0.8))     // 0.8 SECONDS  -> [[0.2, 1], [0.6, 0.2]]
 *   curve(shape('swell', 16))          // 16 CYCLES    -> [[4, 1], [12, 0.2]]
 *
 * The cost, stated plainly: you cannot bake an absolute timing into a named
 * curve. `swell` is a shape, and how long it takes belongs to the call.
 *
 * No engine involvement: `shape()` returns a plain points array, which is
 * exactly what env() and curve() already take. So this is a registry and a
 * scaling function, not a new kind of thing for either layer to understand.
 *
 * Lifecycle mirrors defineScale/defineWavetable — a module-global in the eval
 * realm, with the eval layer owning snapshot -> clear -> run -> restore.
 * ------------------------------------------------------------------------- */

import type { CurvePoint } from './curve'

/** A normalised breakpoint: `[fraction, level]`, or with its own curve.
 *  Fractions are relative segment lengths; they need not sum to 1. */
export type ShapePoint = [number, number] | [number, number, number]

const shapes = new Map<string, ShapePoint[]>()

/**
 * Register a named shape. Fractions are RELATIVE — `[1, 1], [3, 0]` and
 * `[0.25, 1], [0.75, 0]` are the same shape — because insisting they sum to 1
 * would make every edit of one segment a re-edit of all the others.
 *
 * Redefining a name replaces it (an eval re-runs the whole program, so
 * idempotence is required).
 */
export function curvedef(name: string, points: readonly ShapePoint[]): void {
  if (typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) {
    throw new Error(`curvedef(): name must be an identifier, got '${String(name)}'`)
  }
  const clean = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (clean.length === 0) throw new Error(`curvedef('${name}'): needs at least one [fraction, level] point`)
  if (!clean.some((p) => p[0] > 0)) {
    throw new Error(`curvedef('${name}'): at least one segment needs a length above 0`)
  }
  shapes.set(name, clean.map((p) => [...p] as ShapePoint))
}

/** Drop every registered shape (the eval layer clears before each run). */
export function clearCurveShapes(): void {
  shapes.clear()
}

/** Copy the registry, for restore-on-failed-eval. */
export function snapshotCurveShapes(): ReadonlyMap<string, ShapePoint[]> {
  return new Map(shapes)
}

/** Replace the registry with an earlier snapshot. */
export function restoreCurveShapes(snap: ReadonlyMap<string, ShapePoint[]>): void {
  shapes.clear()
  for (const [k, v] of snap) shapes.set(k, v)
}

/** Every registered shape, for tooling. */
export function getCurveShapes(): ReadonlyMap<string, ShapePoint[]> {
  return new Map(shapes)
}

/**
 * A named shape scaled to `total` — seconds for `env`, cycles for `curve`.
 *
 * Throws on an unknown name rather than returning an empty envelope: a silent
 * `[]` would be a synth that makes no sound with nothing to look at, and the
 * name is a typo you can see.
 */
export function shape(name: string, total: number): CurvePoint[] {
  const pts = shapes.get(name)
  if (pts === undefined) {
    const known = [...shapes.keys()].sort().join(', ')
    throw new Error(`shape('${name}'): no curvedef by that name${known === '' ? '' : ` (have: ${known})`}`)
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`shape('${name}', ${String(total)}): length must be a positive number`)
  }
  const sum = pts.reduce((n, p) => n + Math.max(0, p[0]), 0)
  const k = total / sum
  return pts.map((p) => {
    const len = Math.max(0, p[0]) * k
    return (p.length > 2 ? [len, p[1], p[2]] : [len, p[1]]) as CurvePoint
  })
}
