/* ------------------------------------------------------------------------- *
 * The rondo vocabulary, as plain data.
 *
 * Separated from the CodeMirror language so the static highlighter (the synth
 * library's code preview, the docs page) can share the exact same word lists
 * without pulling an editor into a page that only wants to colour a string.
 * One list, four consumers — PR #191 was the cleanup after three of them had
 * quietly drifted apart, and a fourth copy would start that over.
 * ------------------------------------------------------------------------- */
import { BLOCK_KEYWORDS, BUILTINS as RONDO_BUILTINS } from '@rondocode/rondo'


/** Block keywords: every word the parser's top-level dispatch accepts
 *  (imported, so a new block is coloured the day it parses), plus the two
 *  BODY-level words that open nothing at the top level but still read as
 *  keywords inside a block. */
export const KEYWORDS: ReadonlySet<string> = new Set([...BLOCK_KEYWORDS, 'post', 'send', 'sum', 'with'])

/** Pattern modifiers / combinators on play lines. Kept in step with the
 *  OPTIONS table by a test: anything documented has to be highlighted. */
export const MODIFIERS = new Set([
  'scale', 'gain', 'dur', 'pan', 'every', 'struct', 'fast', 'slow', 'rev',
  'euclid', 'degradeby', 'degrade', 'add', 'sub', 'ply', 'segment', 'rand', 'perlin',
  // These were documented and completed but never highlighted, so `slide:`
  // read as a plain identifier sitting next to a coloured `gain:` — the
  // inconsistency is what makes it look like the feature is not real. The
  // test below keeps this set and the docs table from drifting again.
  'slide', 'overchord', 'off', 'jux', 'iter', 'palindrome', 'sometimes',
  'often', 'rarely', 'always', 'superimpose', 'chunk', 'irand', 'curve', 'shape',
])

/** The words that are only meaningful INSIDE a synth — the voice's own inputs
 *  and the two forms that are syntax rather than calls. Not in BUILTINS,
 *  because the compiler does not dispatch them as builtins. */
const SYNTH_CTX = ['note', 'gate', 'velocity', 'input', 'adsr', 'knob', 'mini']

/**
 * Synth-ctx builtins: oscillators, filters, envelopes, effects, sources.
 *
 * DERIVED, like KEYWORDS above it. The hand-written copy carried a "keep in
 * sync with builtins.ts" comment, which is a comment where a derivation
 * belongs: it had drifted by seven — `limiter`, `deess`, `tape`, `convolve`,
 * `pitchshift`, `follow` and `noisegate` all parsed, ran, and read as plain
 * identifiers next to a coloured `compress`. That is the third time this list
 * has drifted (see #191, and the seventeen found after it), and the first time
 * it cannot.
 */
export const BUILTINS: ReadonlySet<string> = new Set([...Object.keys(RONDO_BUILTINS), ...SYNTH_CTX])
