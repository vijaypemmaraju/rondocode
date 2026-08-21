import { Pattern, reify } from './pattern'
import { MiniError, miniParse, mini, n as nTag } from './mini'
import type { Loc } from './mini'
import { noteNameToMidi, parseScaleName, scaleDegree } from './scales'
import { timeHash } from './rand'
import { TimeSpan, hasOnset } from './types'
import { Fraction } from './fraction'
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
 * event fires.
 *
 * MODIFIER patterns carry theirs too, in `locs`. They used to be parsed
 * WITHOUT locs on the reasoning that "the event's loc belongs to the atom that
 * created it, not to a modifier" — which is true about the PRIMARY loc and was
 * the wrong conclusion. A `dur: <1 .5>` line is mini-notation the reader wrote
 * and watches, and it stayed dark while the notes beside it lit up. The rule is
 * simply: anywhere mini-notation is supported, it lights up.
 *
 * `loc` stays the note atom's, so nothing downstream that wants "the one place
 * this event came from" has to change; `locs` is everything else that
 * contributed, and the editor flashes all of them.
 */
export interface ControlMap {
  /** Scale degree (pre-scale, relative). Set by `n()`; consumed by `.scale()`. */
  n?: number
  /** Semitones from an accidental on that degree: `n('0 2# 4')`. Separate from
   *  `n` because a degree indexes the scale — there is no fractional degree to
   *  fold it into — and applied after the lookup, so `2#` means "the third
   *  degree, raised", whatever that degree happens to be in this scale. */
  nAcc?: number
  /** Per-note expression value from a bare `'n` suffix. Ordinary (not
   *  structural): it flows to the synth as a param named `expr`. */
  expr?: number
  /** Per-note probability from `'chance:n`. STRUCTURAL: consumed when the
   *  pattern is built and never reaches a synth. */
  chance?: number
  /** Which controls on this event came from a per-note LANE (`0'gain:.8`).
   *
   *  Provenance, so `.ctrl()` can leave them alone: a value written ON a note
   *  is more specific than one written for the whole block, and the specific
   *  one should win. Without this the block modifier simply landed later and
   *  overwrote it, which made a lane look broken on any block that also set
   *  the same control.
   *
   *  STRUCTURAL: listed in RESERVED_PARAM_NAMES so it never reaches a synth. */
  laneKeys?: readonly string[]
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
  /** Source ranges of the MODIFIER atoms that contributed to this event: the
   *  `<1 .5>` in `dur: <1 .5>`, the word in `sound: <a b>`. Flashed alongside
   *  `loc`, so every piece of mini-notation the reader wrote lights up when it
   *  actually fires. */
  locs?: Loc[]
  /** Any other key is a synth param (cutoff, res, wobble, ...). */
  [param: string]: number | string | Loc | Loc[] | readonly string[] | undefined
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
  return pattern as Pattern<{ value: number; loc: Loc; acc?: number; lanes?: Readonly<Record<string, number>> }>
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
    return withChance(pattern.withValue((v) => {
      const out: ControlMap = {
        note: typeof v.value === 'number' ? v.value : noteNameToMidi(v.value)!,
        loc: v.loc,
      }
      return applyLanes(out, v.lanes)
    }))
  }
  return reify(x).withValue((v): ControlMap => ({ note: v }))
}


/* ------------------------------------------------------------------------- *
 * PER-NOTE LANES: `0'2'gain:.8'chance:.5`.
 *
 * Three names are STRUCTURAL — the pattern engine consumes them, exactly as
 * `nAcc` rides along with `n`:
 *
 *   gain    the note's own level
 *   dur     a multiplier on the note's own length
 *   chance  the probability it sounds at all
 *
 * A LANE IS NAMED AFTER THE CONTROL IT SETS. These were `vel` and `len` at
 * first, which meant the same property had one name written on the note and a
 * different one written on the modifier line below it — `'vel:.8` here and
 * `gain: .8` two lines down, for the identical thing. `len` was worse: a pure
 * synonym for `dur`, which the reference already defines. One word, one
 * meaning; `chance` was already right because it had nothing to collide with.
 *
 * `chance` is applied where the pattern is built rather than by the caller,
 * and it draws from the SAME time-locked stream as degradeBy — so a note that
 * fires on cycle 3 fires on cycle 3 every time the loop comes round, which is
 * what makes a probabilistic line reproducible instead of merely random.
 *
 * Every other name is an ordinary param and reaches the synth untouched, so
 * `0'cut:.7` drives `param('cut')` on that note alone. That is the whole
 * reason the set is small: the language should not own a vocabulary of
 * musical properties when the synth already has one.
 * ------------------------------------------------------------------------- */

/** Apply and strip `chance`: keep the note with that probability, and never
 *  let the key reach a synth.
 *
 *  The draw is the SAME time-locked stream degradeBy uses, keyed on the hap's
 *  start — so a note that fires on cycle 3 fires on cycle 3 every time the
 *  loop comes round. That is what separates a reproducible probabilistic line
 *  from one that is merely random, and it is the property that makes this
 *  usable in a piece rather than only in a jam. */
function withChance(p: Pattern<ControlMap>): Pattern<ControlMap> {
  return p
    .filterHaps((h) => {
      const c = h.value.chance
      return c === undefined || timeHash((h.whole ?? h.part).begin, 0) < c
    })
    .withValue((v) => {
      if (v.chance === undefined) return v
      const { chance: _drop, ...rest } = v
      return rest as ControlMap
    })
}

/** Lane names the pattern engine consumes rather than forwarding to a synth.
 *  Each is spelled exactly like the control it sets. */
export const STRUCTURAL_LANES = new Set(['gain', 'dur', 'chance'])

/** The names these lanes used to have. Kept ONLY to say so: a lane whose name
 *  the engine does not know is forwarded to the synth as a param, so `'vel:.8`
 *  would silently become `param('vel')` — a live control that does nothing,
 *  which is exactly the failure mode a rename should not create. */
export const RENAMED_LANES: ReadonlyMap<string, string> = new Map([['vel', 'gain'], ['len', 'dur']])

/** Fold a note's lanes into its ControlMap. `chance` is left ON the map for
 *  the filter below and stripped there, so this stays a pure mapping. */
function applyLanes(out: ControlMap, lanes: Readonly<Record<string, number>> | undefined): ControlMap {
  if (lanes === undefined) return out
  const from: string[] = []
  for (const [k, v] of Object.entries(lanes)) {
    const renamed = RENAMED_LANES.get(k)
    if (renamed !== undefined) {
      throw new TypeError(
        `'${k}' is now '${renamed}' — a lane is named after the control it sets. `
        + `Write '${renamed}:${v} instead.`,
      )
    }
    if (k === 'gain') out.gain = v
    else if (k === 'dur') out.dur = v
    else if (k === 'chance') out.chance = v
    else (out as Record<string, unknown>)[k] = v
    from.push(k)
  }
  if (from.length > 0) out.laneKeys = [...(out.laneKeys ?? []), ...from]
  return out
}

/** Function form of `n`: degrees are numbers only (use `note()` for names). */
const nCtrl = (x: number | string | Pattern<number>): Pattern<ControlMap> => {
  if (typeof x === 'string') {
    return withChance(numericMini(x, 'n()').withValue((v) => {
      const out: ControlMap = { n: v.value, loc: v.loc }
      if (v.acc !== undefined) out.nAcc = v.acc
      return applyLanes(out, v.lanes)
    }))
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
 *
 * Events carry a DEFAULT note (60): the scheduler drops note-less events,
 * so without it `sound('kick hat')` — the documented "synth names alone"
 * usage — would be silent. Pitch-sensitive lines use n(…).sound(…) instead.
 */
export function sound(x: string | Pattern<string>): Pattern<ControlMap> {
  if (typeof x === 'string') {
    return withChance(miniParse(x).pattern.withValue((v) => {
      const out: ControlMap = { sound: String(v.value), note: 60, loc: v.loc }
      // a drum hit carries lanes too: `kick'vel:.6 hat'chance:.5`
      return applyLanes(out, v.lanes)
    }))
  }
  return x.withValue((v): ControlMap => ({ sound: v, note: 60 }))
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
    /** SMART BOWING: derive per-note slide ties from the note content, the
     *  way a string player slurs. A note ties into the next only when the
     *  next starts EXACTLY where this one ends (a rest breaks the phrase)
     *  and carries a DIFFERENT pitch — a slide tie between identical pitches
     *  erases the boundary entirely (no gate edge, no pitch change: the
     *  synth cannot know a new note happened), which is also why a player
     *  re-articulates repeated notes even under a slur. `prob` (default 0.8)
     *  is the chance a tieable boundary actually ties, drawn deterministically
     *  from the boundary's exact time, so bow lengths vary but re-renders are
     *  bit-identical (mean slur ~= 1/(1-prob) notes). Events that already
     *  carry a slide value are left untouched, so explicit `.slide()` wins.
     *  Patterns LOOP, so a cycle's last note ties into the next cycle's
     *  first — end the phrase with a rest to breathe. Needs a mono voice to
     *  sound tied, like slide itself. */
    slur(this: Pattern<ControlMap>, prob?: number, seed?: number): Pattern<ControlMap>
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
    /** Resolve degrees through a scale. A plain name (`'a minor'`) applies
     *  throughout; a mini string of hyphen-joined names
     *  (`'<c-major f-minor>'`) MODULATES, resolving per event. */
    scale(this: Pattern<ControlMap>, name: string | Pattern<string>): Pattern<ControlMap>
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

/** Lift a control-method argument to a value pattern that keeps its source
 *  range when there is one. A mini STRING is the only form that has a place in
 *  the document to point at; a Pattern or a bare number does not. */
const liftValue = (x: ControlValue): Pattern<{ value: string | number; loc?: Loc }> => {
  if (typeof x === 'string') {
    return miniParse(x).pattern.withValue((v) => ({ value: v.value, loc: v.loc }))
  }
  return reify(x).withValue((v) => ({ value: v as string | number }))
}

/** Append a modifier's source range, keeping the ones already there. */
const withLoc = (c: ControlMap, loc: Loc | undefined): Loc[] | undefined => {
  if (loc === undefined) return c.locs
  return c.locs === undefined ? [loc] : [...c.locs, loc]
}

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
  return this.appLeft(liftValue(x), (c, v): ControlMap => {
    /* A LANE WINS. `0'cutoff:500` inside a block that also says
     * `cutoff: 17100` keeps its 500: the value written on the note is the more
     * specific of the two, and specificity is what every other layered system
     * resolves by. Previously the block modifier merely landed later and
     * overwrote it, so a lane looked broken on exactly the blocks where it was
     * most useful. Notes with no lane for this control still take the block's
     * value, which is the point of setting it there. */
    const out: ControlMap = c.laneKeys?.includes(name) === true ? { ...c } : { ...c, [name]: v.value }
    const locs = withLoc(c, v.loc)
    if (locs !== undefined) out.locs = locs
    return out
  })
}

Pattern.prototype.sound = function (
  this: Pattern<ControlMap>,
  x: string | Pattern<string>,
): Pattern<ControlMap> {
  const vals = typeof x === 'string'
    ? miniParse(x).pattern.withValue((v) => ({ value: String(v.value), loc: v.loc as Loc | undefined }))
    : x.withValue((v) => ({ value: v, loc: undefined as Loc | undefined }))
  return this.appLeft(vals, (c, v): ControlMap => {
    const out: ControlMap = { ...c, sound: v.value }
    const locs = withLoc(c, v.loc)
    if (locs !== undefined) out.locs = locs
    return out
  })
}

const ctrlAlias = (name: string) =>
  function (this: Pattern<ControlMap>, x: ControlValue): Pattern<ControlMap> {
    return this.ctrl(name, x)
  }

Pattern.prototype.gain = ctrlAlias('gain')
Pattern.prototype.pan = ctrlAlias('pan')
Pattern.prototype.dur = ctrlAlias('dur')
Pattern.prototype.slide = ctrlAlias('slide')

/** Draw stream for slur bow-length variety; distinct from humanize (46) and
 *  the shared seed-0 chance stream, for the reason humanizeBy documents. */
const SLUR_SEED = 71
const SLUR_EPS = new Fraction(1, 4096)

Pattern.prototype.slur = function (
  this: Pattern<ControlMap>,
  prob = 0.8,
  seed: number = SLUR_SEED,
): Pattern<ControlMap> {
  const src = this
  return new Pattern<ControlMap>((span) =>
    src.query(span).map((h) => {
      if (!hasOnset(h) || h.whole === undefined || typeof h.value.note !== 'number') return h
      if (h.value.slide !== undefined) return h // explicit slide wins
      const end = h.whole.end
      // the note (or notes — a chord is several haps) starting exactly at
      // this note's end; a gap of any size means the phrase breathes
      const nexts = src
        .query(new TimeSpan(end, end.add(SLUR_EPS)))
        .filter(
          (x) =>
            x.whole !== undefined && x.whole.begin.eq(end) && hasOnset(x) && typeof x.value.note === 'number',
        )
      const tie =
        nexts.length > 0 &&
        nexts.every((x) => x.value.note !== h.value.note) &&
        timeHash(end, seed) < prob
      if (!tie) return h
      return { ...h, value: { ...h.value, slide: 1 } }
    }),
  )
}
Pattern.prototype.cutoff = ctrlAlias('cutoff')
Pattern.prototype.res = ctrlAlias('res')

/** Characters that mean mini STRUCTURE. A plain scale name (`a minor`,
 *  `f#-minor`) contains none of them, which is how a name is told from a
 *  pattern of names without a second argument. */
const MINI_META = /[<>[\]{}*!@?|,]/

/** parseScaleName is not free (it builds the interval table), and a patterned
 *  scale asks for the same few names on every event. */
const scaleCache = new Map<string, ReturnType<typeof parseScaleName>>()
const resolveScale = (name: string): ReturnType<typeof parseScaleName> => {
  let hit = scaleCache.get(name)
  if (hit === undefined) {
    hit = parseScaleName(name)
    scaleCache.set(name, hit)
  }
  return hit
}

Pattern.prototype.scale = function (
  this: Pattern<ControlMap>,
  name: string | Pattern<string>,
): Pattern<ControlMap> {
  /* A PATTERN of scales: `scale: <c-major f-minor>` modulates the key. The
   * scale is resolved per event and STAMPED, so a later `.add()` transposes in
   * the scale that is actually sounding then — which is the whole reason the
   * name rides along on the control map rather than being baked away here.
   *
   * Note names are hyphen-joined inside mini notation because atoms are
   * space-delimited; parseScaleName accepts both spellings. */
  if (typeof name !== 'string' || MINI_META.test(name)) {
    const vals = typeof name === 'string'
      ? (() => {
          const { pattern, atoms } = miniParse(name)
          // eager: a bad name still throws NOW, exactly as the static form does
          for (const a of atoms) resolveScale(String(a.value))
          return pattern.withValue((v) => ({ value: String(v.value), loc: v.loc as Loc | undefined }))
        })()
      : name.withValue((v) => ({ value: v, loc: undefined as Loc | undefined }))
    return this.appLeft(vals, (c, v): ControlMap => {
      if (typeof c.n !== 'number') return c
      const { root, intervals, period } = resolveScale(v.value)
      const out: ControlMap = {
        ...c,
        note: root + scaleDegree(intervals, Math.round(c.n), period) + (c.nAcc ?? 0),
        scale: v.value,
      }
      const locs = withLoc(c, v.loc)
      if (locs !== undefined) out.locs = locs
      return out
    })
  }
  const { root, intervals, period } = parseScaleName(name) // eager: bad names throw now
  // Stamp the scale NAME on each event (a string — skipped by param dispatch)
  // so a later .add()/.sub() can transpose in SCALE STEPS and re-resolve the
  // note through this scale, instead of moving by raw semitones.
  return this.withValue((c) =>
    typeof c.n === 'number'
      ? {
          ...c,
          // The accidental is added AFTER the degree resolves, in semitones.
          // It cannot be folded into the degree: degrees index a scale, so
          // `2 + 0.5` would just round back to a degree, which is exactly the
          // silent wrong answer `n('0 2.5 4')` gives today.
          note: root + scaleDegree(intervals, Math.round(c.n), period) + (c.nAcc ?? 0),
          scale: name,
        }
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
