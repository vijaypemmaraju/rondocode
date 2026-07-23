import { Pattern, reify } from './pattern'
import { MiniError, miniParse, mini, n as nTag } from './mini'
import type { Loc } from './mini'
import { noteNameToMidi, parseScaleName, scaleDegree } from './scales'
// Side-effect import: the control methods below extend the same prototype
// the combinators install onto; keep the module initialized first.
import './combinators'

/**
 * Control patterns: the layer that turns value patterns into event
 * descriptions the scheduler can fire. A Pattern<ControlMap> is a pattern
 * whose values are little property bags — note number, synth name, gain,
 * arbitrary synth params — built up by chaining control methods:
 *
 * ```ts
 * n('0 0 3 5').scale('a minor').sound('acid').ctrl('cutoff', sine)
 * ```
 *
 * MERGE SEMANTICS: every control method merges via appLeft — STRUCTURE
 * (wholes) always comes from the control-map side (the left/receiver);
 * the value argument only contributes values. A value pattern finer than
 * the event pattern subdivides values within each event (several haps
 * sharing one whole); a continuous value pattern is sampled over each
 * event's whole (midpoint — the app* convention). Setting a control that
 * is already present overwrites it.
 *
 * LOCS: string inputs to the entry points (`n('0 3')`, `note('c4 e4')`,
 * `sound('acid')`) are parsed with source locations, threaded into
 * ControlMap.loc so the editor can flash the originating text when an
 * event fires. Value patterns given to control METHODS (`.gain('0.5 1')`)
 * are parsed WITHOUT locs — the event's loc belongs to the atom that
 * created it, not to a modifier.
 */
export interface ControlMap {
  /** Scale degree (pre-scale, relative). Set by `n()`; consumed by `.scale()`. */
  n?: number
  /** Absolute midi note (post-scale resolution, or set directly by `note()`). */
  note?: number
  /** Synth name the scheduler routes the event to. */
  sound?: string
  /** 0..1. Not defaulted here; consumers treat a missing gain as 1. */
  gain?: number
  /** 0..1 stereo position (0.5 center). */
  pan?: number
  /** Gate length multiplier (legato). Missing = 1: the note fills its whole. */
  dur?: number
  /** 303-style slide: >0 holds this note's gate into the NEXT note so, on a
   *  mono+glide synth, the next note portamentos in (this one "slides to it").
   *  Missing/0 = the next note retriggers cleanly. */
  slide?: number
  /** Source range of the atom that created this event — editor highlighting. */
  loc?: Loc
  /** Any other key is a synth param (cutoff, res, wobble, ...). */
  [param: string]: number | string | Loc | undefined
}

/** What a control method accepts: a literal, a value pattern, or a mini string. */
export type ControlValue = number | string | Pattern<number> | Pattern<string | number>

// ------------------------------------------------------------ entry points

/**
 * Parse a mini string requiring every atom to be numeric; positioned
 * MiniError otherwise. Returns the loc-carrying pattern.
 */
const numericMini = (src: string, what: string) => {
  const { pattern, atoms } = miniParse(src)
  for (const a of atoms) {
    if (typeof a.value !== 'number') {
      throw new MiniError(`${what} requires numbers, got '${a.value}'`, a.loc.start, src)
    }
  }
  return pattern as Pattern<{ value: number; loc: Loc }>
}

/**
 * Absolute-pitch entry point → Pattern<ControlMap> with {note}.
 *
 * - number / Pattern<number>: used as midi directly.
 * - string: mini-parsed with locs; atoms may be midi numbers or note names
 *   (letter + #/b + octave, c4 = 60, octave defaults to 4 — see scales.ts).
 *   Anything else is a positioned MiniError.
 */
export function note(x: number | string | Pattern<number>): Pattern<ControlMap> {
  if (typeof x === 'string') {
    const { pattern, atoms } = miniParse(x)
    for (const a of atoms) {
      if (typeof a.value !== 'number' && noteNameToMidi(a.value) === undefined) {
        throw new MiniError(
          `'${a.value}' is not a note name (e.g. c4, f#3, eb2) or midi number`,
          a.loc.start,
          x,
        )
      }
    }
    return pattern.withValue((v) => ({
      note: typeof v.value === 'number' ? v.value : noteNameToMidi(v.value)!,
      loc: v.loc,
    }))
  }
  return reify(x).withValue((v): ControlMap => ({ note: v }))
}

/** Function form of `n`: degrees are numbers only (use `note()` for names). */
const nCtrl = (x: number | string | Pattern<number>): Pattern<ControlMap> => {
  if (typeof x === 'string') {
    return numericMini(x, 'n()').withValue((v) => ({ n: v.value, loc: v.loc }))
  }
  return reify(x).withValue((v): ControlMap => ({ n: v }))
}

const isTemplate = (x: unknown): x is TemplateStringsArray =>
  Array.isArray(x) && 'raw' in (x as object)

/** Tagged-template form: mini-compatible numeric pattern (`` n`0 3 5` ``). */
export function n(
  strings: TemplateStringsArray,
  ...values: (string | number)[]
): Pattern<number>
/** Function form: scale-degree control pattern (`n('0 3')` → {n} maps). */
export function n(x: number | string | Pattern<number>): Pattern<ControlMap>
/**
 * DUAL-USE `n`: one export serving both the mini template tag and the
 * control entry point, because live-code reads better with both spelled
 * `n`. Dispatch is on the first argument: a TemplateStringsArray (an array
 * with a `raw` property — what JS passes a tag) takes the tag path and
 * returns a plain Pattern<number> exactly as mini's `n` always has; any
 * other argument (number, mini string, Pattern<number>) takes the control
 * path and returns Pattern<ControlMap> with {n} set (locs threaded for
 * strings). Both paths reject non-numeric atoms with a MiniError.
 */
export function n(
  first: TemplateStringsArray | number | string | Pattern<number>,
  ...values: (string | number)[]
): Pattern<number> | Pattern<ControlMap> {
  if (isTemplate(first)) return nTag(first, ...values)
  return nCtrl(first)
}

/**
 * Synth-name entry point → Pattern<ControlMap> with {sound}. A string is
 * mini-parsed as a word pattern with locs (`sound('bd sn:2')`); numeric
 * atoms are stringified (a sound name is always a string). A
 * Pattern<string> passes through per event.
 */
export function sound(x: string | Pattern<string>): Pattern<ControlMap> {
  if (typeof x === 'string') {
    return miniParse(x).pattern.withValue((v) => ({
      sound: String(v.value),
      loc: v.loc,
    }))
  }
  return x.withValue((v): ControlMap => ({ sound: v }))
}

/** Short alias for {@link sound}. */
export const s = sound

// ------------------------------------------------------- prototype methods

declare module './pattern' {
  interface Pattern<T> {
    /**
     * Set a named control on every event, merging via appLeft (structure
     * from this — see the controls.ts module doc). `x` may be a literal
     * (number/word), a Pattern of values, or a mini string (parsed without
     * locs). Overwrites any existing value for `name`.
     */
    ctrl(
      this: Pattern<ControlMap>,
      name: string,
      x: ControlValue,
    ): Pattern<ControlMap>
    /** ctrl('sound', x): route events to the named synth. */
    sound(this: Pattern<ControlMap>, x: string | Pattern<string>): Pattern<ControlMap>
    /** ctrl('gain', x): event level 0..1 (missing = 1). */
    gain(this: Pattern<ControlMap>, x: ControlValue): Pattern<ControlMap>
    /** ctrl('pan', x): stereo position 0..1. */
    pan(this: Pattern<ControlMap>, x: ControlValue): Pattern<ControlMap>
    /** ctrl('dur', x): gate length multiplier (legato). */
    dur(this: Pattern<ControlMap>, x: ControlValue): Pattern<ControlMap>
    /** ctrl('slide', x): 303-style per-note slide. A note with slide > 0 ties
     *  into the next one so the next note glides in (needs a mono + glide
     *  synth). e.g. note('a2 c3 e3 c3').slide('0 1 0 1') slides into c3 and c3. */
    slide(this: Pattern<ControlMap>, x: ControlValue): Pattern<ControlMap>
    /** ctrl('cutoff', x): filter cutoff synth param. */
    cutoff(this: Pattern<ControlMap>, x: ControlValue): Pattern<ControlMap>
    /** ctrl('res', x): filter resonance synth param. */
    res(this: Pattern<ControlMap>, x: ControlValue): Pattern<ControlMap>
    /**
     * Resolve scale degrees to absolute pitch: every event with an `n`
     * gets `note = root + scaleDegree(intervals, round(n))`; `n` is kept.
     * Events without `n` pass through untouched. Scale names are
     * 'root mode' ('c major', 'f# mixolydian') — parsed eagerly, so an
     * unknown scale throws immediately, not at query time. Degrees wrap
     * past the scale length with octave shifts and mirror down for
     * negatives; non-integer degrees are rounded to the nearest integer.
     */
    scale(this: Pattern<ControlMap>, name: string): Pattern<ControlMap>
    /**
     * Stereo split (Tidal): stack an untransformed copy panned hard left
     * with f(copy) panned hard right — juxBy(1, f). The pans are applied
     * AFTER f, so they win over any pan the transform sets.
     */
    jux(
      this: Pattern<ControlMap>,
      f: (p: Pattern<ControlMap>) => Pattern<ControlMap>,
    ): Pattern<ControlMap>
    /** jux by a width: pans 0.5 ± amount/2 (juxBy(0, f) keeps both centered). */
    juxBy(
      this: Pattern<ControlMap>,
      amount: number,
      f: (p: Pattern<ControlMap>) => Pattern<ControlMap>,
    ): Pattern<ControlMap>
    /**
     * Tempo-synced delay: layer `count` copies (including the dry one), each
     * `time` cycles later than the last and `feedback` (default 0.5) times as
     * loud — a musical echo, since `time` is in cycles the scheduler resolves
     * against the current cps. Multiplies each tap's gain (respecting any gain
     * already set).
     */
    echo(this: Pattern<ControlMap>, count: number, time: number, feedback?: number): Pattern<ControlMap>
    /** Like {@link echo} but successive taps alternate right/left for a
     *  ping-pong stereo delay. */
    ping(this: Pattern<ControlMap>, count: number, time: number, feedback?: number): Pattern<ControlMap>
  }
}

/** Lift a control-method argument to a value pattern (mini strings loc-free). */
const liftValue = (x: ControlValue): Pattern<string | number> =>
  typeof x === 'string' ? mini(x) : reify(x)

/** Keys .ctrl() refuses: they carry structural meaning and have dedicated
 *  entry points / are scheduler-managed, so patterning them as raw params
 *  is a mistake worth catching loudly. */
const RESERVED_CTRL_KEYS = new Map<string, string>([
  ['loc', 'locs are set by mini-notation parsing'],
  ['n', 'use n() / the n entry point'],
  ['note', 'use note() or .scale()'],
  ['sound', 'use sound() / .sound()'],
])

Pattern.prototype.ctrl = function (
  this: Pattern<ControlMap>,
  name: string,
  x: ControlValue,
): Pattern<ControlMap> {
  const why = RESERVED_CTRL_KEYS.get(name)
  if (why !== undefined) {
    throw new TypeError(`ctrl('${name}') is reserved: ${why}`)
  }
  return this.appLeft(liftValue(x), (c, v): ControlMap => ({ ...c, [name]: v }))
}

Pattern.prototype.sound = function (
  this: Pattern<ControlMap>,
  x: string | Pattern<string>,
): Pattern<ControlMap> {
  const vals: Pattern<string> =
    typeof x === 'string' ? mini(x).withValue((v) => String(v)) : x
  return this.appLeft(vals, (c, v): ControlMap => ({ ...c, sound: v }))
}

const ctrlAlias = (name: string) =>
  function (this: Pattern<ControlMap>, x: ControlValue): Pattern<ControlMap> {
    return this.ctrl(name, x)
  }

Pattern.prototype.gain = ctrlAlias('gain')
Pattern.prototype.pan = ctrlAlias('pan')
Pattern.prototype.dur = ctrlAlias('dur')
Pattern.prototype.slide = ctrlAlias('slide')
Pattern.prototype.cutoff = ctrlAlias('cutoff')
Pattern.prototype.res = ctrlAlias('res')

Pattern.prototype.scale = function (
  this: Pattern<ControlMap>,
  name: string,
): Pattern<ControlMap> {
  const { root, intervals } = parseScaleName(name) // eager: bad names throw now
  // Stamp the scale NAME on each event (a string — skipped by param dispatch)
  // so a later .add()/.sub() can transpose in SCALE STEPS and re-resolve the
  // note through this scale, instead of moving by raw semitones.
  return this.withValue((c) =>
    typeof c.n === 'number'
      ? { ...c, note: root + scaleDegree(intervals, Math.round(c.n)), scale: name }
      : c,
  )
}

Pattern.prototype.juxBy = function (
  this: Pattern<ControlMap>,
  amount: number,
  f: (p: Pattern<ControlMap>) => Pattern<ControlMap>,
): Pattern<ControlMap> {
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) {
    throw new RangeError(`juxBy amount must be in [0, 1], got ${amount}`)
  }
  return Pattern.stack(
    this.ctrl('pan', 0.5 - amount / 2),
    f(this).ctrl('pan', 0.5 + amount / 2),
  )
}

Pattern.prototype.jux = function (
  this: Pattern<ControlMap>,
  f: (p: Pattern<ControlMap>) => Pattern<ControlMap>,
): Pattern<ControlMap> {
  return this.juxBy(1, f)
}

/** Multiply an event's gain (default 1) by `f`. */
const scaleGain = (v: ControlMap, f: number): ControlMap => ({
  ...v,
  gain: (typeof v.gain === 'number' ? v.gain : 1) * f,
})

Pattern.prototype.echo = function (
  this: Pattern<ControlMap>,
  count: number,
  time: number,
  feedback = 0.5,
): Pattern<ControlMap> {
  const n = Math.max(1, Math.floor(count))
  const layers: Pattern<ControlMap>[] = []
  for (let i = 0; i < n; i++) {
    const tap = this.late(time * i)
    layers.push(i === 0 ? tap : tap.withValue((v) => scaleGain(v, feedback ** i)))
  }
  return Pattern.stack(...layers)
}

Pattern.prototype.ping = function (
  this: Pattern<ControlMap>,
  count: number,
  time: number,
  feedback = 0.5,
): Pattern<ControlMap> {
  const n = Math.max(1, Math.floor(count))
  const layers: Pattern<ControlMap>[] = []
  for (let i = 0; i < n; i++) {
    const tap = this.late(time * i)
    if (i === 0) {
      layers.push(tap)
      continue
    }
    const pan = i % 2 === 1 ? 0.85 : 0.15 // alternate right/left
    layers.push(tap.withValue((v) => ({ ...scaleGain(v, feedback ** i), pan })))
  }
  return Pattern.stack(...layers)
}
