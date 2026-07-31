/* ------------------------------------------------------------------------- *
 * MACROS: one knob that reaches across the whole project.
 *
 * A param() belongs to the synth that declared it — that is deliberate, and it
 * is why two synths with a `cutoff` each are two separate controls. A macro is
 * the OPT-IN to the other behaviour: declared once at the top of a program,
 * then referenced by name from any synth or post chain, so moving it moves
 * every use site together.
 *
 * The design decision that makes this cheap: a macro is a VALUE, not a wire.
 * Every use site gets an ordinary param carrying the SAME number, and each
 * site is free to scale it however it likes —
 *
 *     macro('bright', 1480, { min: 500, max: 7300, curve: 'log' })
 *     svf(saw(note.freq), param('bright'))              // 1:1
 *     svf(saw(note.freq), param('bright').mul(0.5))     // half
 *     delay(x, 0.25, { fb: param('bright').div(7300).mul(-0.55).add(0.6) })
 *
 * so "different ratios and formulas from one knob" needs no macro machinery at
 * all: it is arithmetic on a Sig, which already works. The registry below only
 * has to answer "what are this name's default and bounds", so the numbers are
 * written ONCE and no use site can drift from another.
 *
 * The lifecycle mirrors defineWavetable/defineScale exactly: a module-global
 * in the eval realm, with the eval layer owning snapshot -> clear -> run ->
 * restore-on-failure, so the registry always reflects the LAST SUCCESSFUL
 * eval. Declaration must precede use, for the same reason a wavetable must:
 * synth() eager-compiles its graph, so param('bright') resolves at build time.
 * ------------------------------------------------------------------------- */

import { GraphError } from './graph'

/** Control keys the scheduler consumes as STRUCTURAL, so a param (or macro)
 *  with one of these names could never be driven by .ctrl(). Mirrors the
 *  Session's NON_PARAM_KEYS; lives here so builder.ts and macro() share one
 *  list rather than two that can drift. */
export const RESERVED_PARAM_NAMES: ReadonlySet<string> = new Set([
  'note', 'n', 'sound', 'gain', 'pan', 'dur', 'slide', 'loc',
])

/** What a macro declares: the same four numbers a param() takes, held in one
 *  place so every use site reads them instead of repeating them. */
export interface MacroSpec {
  name: string
  default: number
  min: number
  max: number
  curve?: 'lin' | 'log'
  /** A SWITCH macro: two values, no range. See ParamSpec.values. */
  values?: readonly [number, number]
}

export type MacroSnapshot = ReadonlyMap<string, MacroSpec>

const macros = new Map<string, MacroSpec>()

/**
 * Declare a project-wide macro. Any synth or post chain below this call can
 * then say `param('name')` with no default and get a control that moves with
 * every other use of the name.
 *
 * Redefining a name silently replaces it (evals re-run whole programs, so
 * idempotence is required). The bounds are validated HERE, at the declaration,
 * rather than at each use site — a bad range should point at the one line that
 * owns the numbers.
 */
export function macro(
  name: string,
  def: number,
  opts?: { min?: number; max?: number; curve?: 'lin' | 'log'; values?: readonly number[] },
): void {
  if (typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) {
    throw new GraphError(`macro(): name must be an identifier (letters, digits, _), got '${String(name)}'`)
  }
  if (RESERVED_PARAM_NAMES.has(name)) {
    throw new GraphError(
      `macro '${name}' shadows a structural control key — it could never be driven (those are consumed as note/gain/pan/dur/…). Rename the macro.`,
    )
  }
  if (!Number.isFinite(def)) throw new GraphError(`macro '${name}': default must be a finite number`)
  if (def < 0 && opts?.min === undefined && opts?.values === undefined) {
    throw new GraphError(`macro '${name}': negative default (${def}) requires an explicit min (omitted min defaults to 0)`)
  }
  const pair = validateSwitchValues(`macro '${name}'`, def, opts)
  if (pair !== undefined) {
    macros.set(name, { name, default: def, min: Math.min(...pair), max: Math.max(...pair), values: pair })
    return
  }
  const min = opts?.min ?? 0
  const max = opts?.max ?? (def > 0 ? def * 4 : 1)
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new GraphError(`macro '${name}': min/max must be finite numbers`)
  if (!(min < max)) throw new GraphError(`macro '${name}': min (${min}) must be < max (${max})`)
  if (def < min || def > max) throw new GraphError(`macro '${name}': default ${def} outside [${min}, ${max}]`)
  if (opts?.curve === 'log' && !(min > 0)) throw new GraphError(`macro '${name}': log curve requires min > 0 (got ${min})`)
  const spec: MacroSpec = { name, default: def, min, max }
  if (opts?.curve !== undefined) spec.curve = opts.curve
  macros.set(name, spec)
}

/** The spec for `name`, or undefined when no macro declares it. */
export function lookupMacro(name: string): MacroSpec | undefined {
  return macros.get(name)
}

/** Drop every declared macro (the eval layer calls this at the start of each
 *  run so a deleted macro line does not linger). */
export function clearMacros(): void {
  macros.clear()
}

/** Copy the registry, for restore-on-failed-eval (all-or-nothing staging). */
export function snapshotMacros(): MacroSnapshot {
  return new Map(macros)
}

/** Replace the registry with a snapshot taken earlier. */
export function restoreMacros(snap: MacroSnapshot): void {
  macros.clear()
  for (const [k, v] of snap) macros.set(k, v)
}

/** Every declared macro, for a control surface that wants to draw one knob per
 *  macro. Read only — a copy, so a caller cannot mutate the registry. */
export function getMacros(): ReadonlyMap<string, MacroSpec> {
  return new Map(macros)
}

/**
 * Validate a switch declaration, returning the pair (or undefined when this is
 * an ordinary ranged control).
 *
 * Shared by param() and macro() because a switch means the same thing at both
 * scopes, and two copies of these rules would be two chances to disagree about
 * what a legal switch is.
 *
 * The strict bits and why:
 *  - exactly two values: a "switch" with three is a picker, and the widget,
 *    the tap gesture and the write-back are all built for a pair.
 *  - distinct: equal values give a control that cannot do anything.
 *  - the default must BE one of them: a switch resting on a third value could
 *    not be written back to the source, since the source only holds the pair.
 *  - no min/max/curve: a switch has no range to bound or to warp, and quietly
 *    ignoring them would hide a real misunderstanding.
 */
export function validateSwitchValues(
  what: string,
  def: number,
  opts?: { min?: number; max?: number; curve?: 'lin' | 'log'; values?: readonly number[] },
): [number, number] | undefined {
  const values = opts?.values
  if (values === undefined) return undefined
  if (!Array.isArray(values) || values.length !== 2) {
    throw new GraphError(`${what}: a switch takes exactly two values, got ${Array.isArray(values) ? values.length : typeof values}`)
  }
  const [a, b] = values as [number, number]
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new GraphError(`${what}: switch values must be finite numbers`)
  }
  if (a === b) throw new GraphError(`${what}: a switch needs two DIFFERENT values (both are ${a})`)
  if (def !== a && def !== b) {
    throw new GraphError(`${what}: default ${def} is not one of the switch values (${a}, ${b}) — a switch can only rest on a value it can be written back as`)
  }
  if (opts?.min !== undefined || opts?.max !== undefined) {
    throw new GraphError(`${what}: a switch has no range, so min/max mean nothing here — the two values ARE the bounds`)
  }
  if (opts?.curve !== undefined) {
    throw new GraphError(`${what}: a switch has no range to warp, so curve means nothing here`)
  }
  return [a, b]
}
