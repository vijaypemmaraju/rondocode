/* ------------------------------------------------------------------------- *
 * The rondo vocabulary, as plain data.
 *
 * Separated from the CodeMirror language so the static highlighter (the synth
 * library's code preview, the docs page) can share the exact same word lists
 * without pulling an editor into a page that only wants to colour a string.
 * One list, four consumers — PR #191 was the cleanup after three of them had
 * quietly drifted apart, and a fourth copy would start that over.
 * ------------------------------------------------------------------------- */
import { BLOCK_KEYWORDS } from '@rondocode/rondo'


/** Block keywords: every word the parser's top-level dispatch accepts
 *  (imported, so a new block is coloured the day it parses), plus the two
 *  BODY-level words that open nothing at the top level but still read as
 *  keywords inside a block. */
export const KEYWORDS: ReadonlySet<string> = new Set([...BLOCK_KEYWORDS, 'post', 'send', 'sum'])

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

/** Synth-ctx builtins (oscillators, filters, envelopes, effects, sources) —
 *  keep in sync with @rondocode/rondo src/builtins.ts. */
export const BUILTINS = new Set([
  'note', 'gate', 'velocity', 'input', 'adsr', 'knob', 'mini',
  'saw', 'square', 'sine', 'tri', 'pulse', 'syncsaw', 'fm', 'wavetable',
  'supersaw', 'noise', 'lfsr', 'lfo',
  'sample', 'granular', 'pluck', 'modal',
  'ladder', 'svf', 'dualsvf', 'onepole', 'delay', 'comb', 'shape', 'formant', 'pan',
  'bitcrush', 'compress', 'phaser', 'reverb', 'chorus', 'width', 'transient', 'flanger', 'exciter', 'ott',
  'tanh', 'clip', 'fold', 'mix',
  // These 17 were documented and completed but not highlighted — the same
  // state `slide` was in before #191, which only closed the KEYWORD half of
  // the gap. The reference panel's "other" bucket is what surfaced them.
  'mic', 'env', 'eq', 'vocoder',
  'abs', 'ceil', 'floor', 'round', 'sign', 'sqrt', 'exp', 'log', 'sin', 'cos',
  'min', 'max', 'mod',
])
