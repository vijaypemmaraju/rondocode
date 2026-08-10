/**
 * Scale tables and pitch parsing for the control layer (`.scale()`,
 * `note()`).
 *
 * Conventions, pinned in scales.test.ts:
 *
 * - Note names are letter + optional accidental (#/b) + optional octave,
 *   with scientific octave numbering anchored at c4 = 60 (so a4 = 69,
 *   c-1 = 0). A missing octave defaults to 4.
 * - A scale ROOT is a bare letter + accidental (no octave) and is placed
 *   in the octave NEAREST middle C: pitch classes c..f# (0..6) map upward
 *   from 60 (c → 60, e → 64, f# → 66); g..b (7..11) map to just below
 *   (g → 55, a → 57, b → 59). This keeps every root within a tritone of
 *   middle C — 'a minor' is rooted at a3 = 57, not a4 = 69.
 * - Degrees beyond the scale length wrap with a PERIOD shift (degree 7
 *   in a 7-note scale = root + 12 by default); negative degrees mirror
 *   down the same way (degree -1 in major = root - 1, the leading tone
 *   below).
 *
 * TUNINGS (custom scales): intervals are semitones from the root as
 * FLOATS — the engine's note→frequency map (440·2^((n−69)/12)) is total
 * over fractional midi, so 1.5 is an exact quarter-tone. Three doors in:
 * - '<n>edo' mode names divide the octave into n equal steps, generically
 *   ('c 19edo', 'a 31edo'), no registration needed.
 * - defineScale(name, spec) registers a custom scale: a plain offsets
 *   array, { cents }, or { ratios }, each with an optional period for
 *   non-octave tunings (Bohlen–Pierce etc.).
 * - The registry is module-global and mirrors the last successful eval:
 *   the eval layer snapshots/clears/restores it around each run.
 */

/** Interval tables in semitones from the root, one octave's worth. */
export const SCALES: Record<string, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  // ionian/harmonicMinor round out the diatonic mode names: someone who reaches
  // for `ionian` by name means major, and hitting "unknown scale" for it is a
  // needless dead end when the other six modes are all spelled out above.
  ionian: [0, 2, 4, 5, 7, 9, 11],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  wholeTone: [0, 2, 4, 6, 8, 10],
  blues: [0, 3, 5, 6, 7, 10],
}

/** Mode lookup keyed by lowercased name ('minorpentatonic' → minorPentatonic). */
const MODES_LOWER = new Map<string, readonly number[]>(
  Object.entries(SCALES).map(([k, v]) => [k.toLowerCase(), v]),
)

const PITCH_CLASS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

const NOTE_RE = /^([a-g])([#b]?)(-?\d+)?$/

/** letter+accidental → pitch class 0..11, or undefined if not a pitch. */
const pitchClass = (letter: string, accidental: string): number | undefined => {
  const base = PITCH_CLASS[letter.toLowerCase()]
  if (base === undefined) return undefined
  const shift = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0
  return (base + shift + 12) % 12
}

/**
 * Parse a note name (c4 = 60 anchoring; octave defaults to 4) to a midi
 * number, or undefined when the string is not a note name. Case-insensitive
 * on the letter; the accidental must be '#' or 'b'.
 *
 * Enharmonics CARRY across the octave boundary: the accidental is applied
 * to the letter's semitone before the octave multiply, not wrapped mod 12 —
 * b#4 is 72 (enharmonic c5), cb4 is 59 (enharmonic b3).
 *
 * The result is raw pitch math, NOT clamped to midi 0..127: extreme
 * octaves parse to out-of-range numbers (c-2 → -12, c10 → 132). The synth
 * layer's note→frequency formula is total over all numbers, so passing
 * them through is harmless; callers wanting strict midi should clamp.
 */
export function noteNameToMidi(name: string): number | undefined {
  const m = NOTE_RE.exec(name.toLowerCase())
  if (!m) return undefined
  const base = PITCH_CLASS[m[1]!]
  if (base === undefined) return undefined
  const shift = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  const octave = m[3] === undefined ? 4 : parseInt(m[3], 10)
  return (octave + 1) * 12 + base + shift
}

/* ---- custom tunings ------------------------------------------------------ */

/** What defineScale accepts: semitone offsets from the root (floats make
 *  microtones), cents (100 cents = 1 semitone), or frequency ratios
 *  (12·log2(ratio) semitones). The optional period is the wrap span for
 *  degrees past the last entry — default one octave (12 semitones / 1200
 *  cents / ratio 2). */
export type ScaleSpec =
  | readonly number[]
  | { cents: readonly number[]; periodCents?: number }
  | { ratios: readonly number[]; periodRatio?: number }

interface CustomScale {
  intervals: readonly number[]
  period: number
}

/** A saved copy of the custom-scale registry (opaque to callers). */
export type CustomScaleSnapshot = ReadonlyMap<string, CustomScale>

/** Module-global custom-scale registry, keyed by lowercased name. The eval
 *  layer owns its lifecycle: snapshot → clear → run user code → restore on
 *  failure, so the registry always mirrors the LAST SUCCESSFUL eval and a
 *  removed defineScale call never leaves a stale scale behind. */
const customScales = new Map<string, CustomScale>()

const SCALE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/

const checkIntervals = (name: string, xs: readonly number[], what: string): void => {
  if (!Array.isArray(xs) || xs.length === 0) {
    throw new TypeError(`defineScale('${name}'): ${what} must be a non-empty array of numbers`)
  }
  for (const x of xs) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new TypeError(`defineScale('${name}'): ${what} must all be finite numbers, got ${String(x)}`)
    }
  }
}

/** Normalize a ScaleSpec to { intervals (semitones), period (semitones) }. */
const normalizeSpec = (name: string, spec: ScaleSpec): CustomScale => {
  if (Array.isArray(spec)) {
    checkIntervals(name, spec, 'the offsets')
    return { intervals: [...spec], period: 12 }
  }
  if (typeof spec === 'object' && spec !== null && 'cents' in spec) {
    const s = spec as { cents: readonly number[]; periodCents?: number }
    checkIntervals(name, s.cents, 'cents')
    let period = 12
    if (s.periodCents !== undefined) {
      if (typeof s.periodCents !== 'number' || !Number.isFinite(s.periodCents) || s.periodCents <= 0) {
        throw new TypeError(`defineScale('${name}'): periodCents must be a positive number`)
      }
      period = s.periodCents / 100
    }
    return { intervals: s.cents.map((c) => c / 100), period }
  }
  if (typeof spec === 'object' && spec !== null && 'ratios' in spec) {
    const s = spec as { ratios: readonly number[]; periodRatio?: number }
    checkIntervals(name, s.ratios, 'ratios')
    for (const r of s.ratios) {
      if (r <= 0) throw new TypeError(`defineScale('${name}'): ratios must be positive, got ${String(r)}`)
    }
    let periodRatio = 2
    if (s.periodRatio !== undefined) {
      if (typeof s.periodRatio !== 'number' || !Number.isFinite(s.periodRatio) || s.periodRatio <= 1) {
        throw new TypeError(`defineScale('${name}'): periodRatio must be a number greater than 1`)
      }
      periodRatio = s.periodRatio
    }
    return { intervals: s.ratios.map((r) => 12 * Math.log2(r)), period: 12 * Math.log2(periodRatio) }
  }
  throw new TypeError(
    `defineScale('${name}'): spec must be an offsets array, { cents: [...] }, or { ratios: [...] }`,
  )
}

/**
 * Register a custom scale under `name` (a word: letter, then letters/
 * digits/underscore; case-insensitive on lookup). Redefining the same name
 * silently replaces it — evals re-run whole programs, so defineScale must
 * be idempotent. Shadowing a built-in mode (or the reserved '<n>edo'
 * shape) is an error. The spec arrays are plain values: adding or removing
 * a note IS editing the array.
 */
export function defineScale(name: string, spec: ScaleSpec): void {
  if (typeof name !== 'string' || !SCALE_NAME_RE.test(name)) {
    throw new TypeError(
      `defineScale(): name must be a word (letter, then letters/digits/_), got ${JSON.stringify(name)}`,
    )
  }
  const key = name.toLowerCase()
  if (MODES_LOWER.has(key)) {
    throw new RangeError(`defineScale('${name}'): the name shadows a built-in scale — pick another`)
  }
  customScales.set(key, normalizeSpec(name, spec))
}

/** Drop every registered custom scale (the eval layer calls this at the
 *  start of each run so removed defineScale calls do not linger). */
export function clearCustomScales(): void {
  customScales.clear()
}

/** Copy the registry, for restore-on-failed-eval (all-or-nothing staging). */
export function snapshotCustomScales(): CustomScaleSnapshot {
  return new Map(customScales)
}

/** Replace the registry with a snapshot taken earlier. */
export function restoreCustomScales(snap: CustomScaleSnapshot): void {
  customScales.clear()
  for (const [k, v] of snap) customScales.set(k, v)
}

/** '<n>edo' mode names: n equal divisions of the octave, 1..96. Interval
 *  tables are cached per n (parseScaleName runs per query in .add/.sub). */
const EDO_RE = /^(\d+)edo$/
const MAX_EDO = 96
const edoCache = new Map<number, readonly number[]>()

const edoIntervals = (n: number): readonly number[] => {
  let table = edoCache.get(n)
  if (table === undefined) {
    table = Array.from({ length: n }, (_, k) => (12 * k) / n)
    edoCache.set(n, table)
  }
  return table
}

/**
 * Parse "root mode" ('a minor', 'f# mixolydian') into a root midi note,
 * the mode's interval table, and its wrap period in semitones (12 for
 * every octave-based scale). Case-insensitive, whitespace-tolerant. The
 * root is placed in the octave nearest middle C (see module doc). Modes
 * resolve built-ins first, then the generic '<n>edo' names ('c 19edo'),
 * then defineScale registrations. Throws RangeError on a malformed root
 * or unknown mode.
 */
/** Short mode spellings. ONE table: rondo's `scale:a-min` and a mini atom
 *  `<c_maj f_min>` both land here, so the abbreviations cannot drift between
 *  the language and the pattern engine. */
export const SCALE_MODE: Readonly<Record<string, string>> = {
  min: 'minor', maj: 'major', dor: 'dorian', phr: 'phrygian', lyd: 'lydian',
  mix: 'mixolydian', loc: 'locrian',
}

export function parseScaleName(name: string): {
  root: number
  intervals: readonly number[]
  period: number
} {
  /* `c_major`, `c-maj` and `c major` are the same scale.
   *
   * Mini atoms are SPACE-delimited and the mini lexer rejects `-` inside a
   * word, so the canonical two-word form cannot be a single atom — which is
   * exactly what stopped `scale: <c-maj f-min>` from being expressible at all.
   * `_` is the separator that survives mini, and rondo rewrites its `-` to one
   * WITHOUT changing the length, so note-flash offsets still land on the right
   * characters. No mode name contains a separator (all 16 checked), so
   * splitting on the first one is unambiguous. */
  const sep = /[_-]/.exec(name)
  const spaced = !name.includes(' ') && sep !== null
    ? `${name.slice(0, sep.index)} ${name.slice(sep.index + 1)}`
    : name
  const parts = spaced.trim().toLowerCase().split(/\s+/)
  if (parts.length !== 2) {
    throw new RangeError(
      `scale name must be 'root mode' (e.g. 'a minor'), got '${name}'`,
    )
  }
  const [rootStr, rawMode] = parts as [string, string]
  // `maj` and `major` are the same mode; see SCALE_MODE
  const modeStr = SCALE_MODE[rawMode] ?? rawMode
  const m = /^([a-g])([#b]?)$/.exec(rootStr)
  const pc = m ? pitchClass(m[1]!, m[2]!) : undefined
  if (pc === undefined) {
    throw new RangeError(
      `scale root must be a note letter with optional #/b, got '${rootStr}' in '${name}'`,
    )
  }
  // Nearest-to-middle-C octave: classes 0..6 sit at/above 60, 7..11 below.
  const root = pc <= 6 ? 60 + pc : 48 + pc
  const builtin = MODES_LOWER.get(modeStr)
  if (builtin !== undefined) return { root, intervals: builtin, period: 12 }
  const edo = EDO_RE.exec(modeStr)
  if (edo !== null) {
    const n = parseInt(edo[1]!, 10)
    if (n < 1 || n > MAX_EDO) {
      throw new RangeError(
        `unknown scale '${modeStr}' in '${name}': edo divisions must be 1..${MAX_EDO}`,
      )
    }
    return { root, intervals: edoIntervals(n), period: 12 }
  }
  const custom = customScales.get(modeStr)
  if (custom !== undefined) return { root, intervals: custom.intervals, period: custom.period }
  const customNames = customScales.size > 0 ? `, custom: ${[...customScales.keys()].join(', ')}` : ''
  throw new RangeError(
    `unknown scale '${modeStr}' in '${name}'; available: ${Object.keys(SCALES).join(', ')}, <n>edo (e.g. 19edo)${customNames}`,
  )
}

/**
 * Semitone offset of scale degree `degree` (any integer): the table entry
 * for `degree mod length`, shifted by `period` (default 12, one octave)
 * per wrap past the table. Negative degrees mirror down (Euclidean mod),
 * so -1 in major is the leading tone one semitone below the root. Float
 * interval tables (custom tunings) flow through untouched.
 */
export function scaleDegree(intervals: readonly number[], degree: number, period = 12): number {
  const len = intervals.length
  const oct = Math.floor(degree / len)
  const idx = degree - oct * len
  return intervals[idx]! + period * oct
}
