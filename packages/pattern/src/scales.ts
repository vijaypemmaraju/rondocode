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
 * - Degrees beyond the scale length wrap with an octave shift (degree 7
 *   in a 7-note scale = root + 12); negative degrees mirror down the same
 *   way (degree -1 in major = root - 1, the leading tone below).
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

/**
 * Parse "root mode" ('a minor', 'f# mixolydian') into a root midi note and
 * the mode's interval table. Case-insensitive, whitespace-tolerant. The
 * root is placed in the octave nearest middle C (see module doc). Throws
 * RangeError on a malformed root or unknown mode.
 */
export function parseScaleName(name: string): {
  root: number
  intervals: readonly number[]
} {
  const parts = name.trim().toLowerCase().split(/\s+/)
  if (parts.length !== 2) {
    throw new RangeError(
      `scale name must be 'root mode' (e.g. 'a minor'), got '${name}'`,
    )
  }
  const [rootStr, modeStr] = parts as [string, string]
  const m = /^([a-g])([#b]?)$/.exec(rootStr)
  const pc = m ? pitchClass(m[1]!, m[2]!) : undefined
  if (pc === undefined) {
    throw new RangeError(
      `scale root must be a note letter with optional #/b, got '${rootStr}' in '${name}'`,
    )
  }
  const intervals = MODES_LOWER.get(modeStr)
  if (intervals === undefined) {
    throw new RangeError(
      `unknown scale '${modeStr}' in '${name}'; available: ${Object.keys(SCALES).join(', ')}`,
    )
  }
  // Nearest-to-middle-C octave: classes 0..6 sit at/above 60, 7..11 below.
  const root = pc <= 6 ? 60 + pc : 48 + pc
  return { root, intervals }
}

/**
 * Semitone offset of scale degree `degree` (any integer): the table entry
 * for `degree mod length`, shifted by 12 per octave of wrap. Negative
 * degrees mirror down (Euclidean mod), so -1 in major is the leading tone
 * one semitone below the root.
 */
export function scaleDegree(intervals: readonly number[], degree: number): number {
  const len = intervals.length
  const oct = Math.floor(degree / len)
  const idx = degree - oct * len
  return intervals[idx]! + 12 * oct
}
