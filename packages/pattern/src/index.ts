export { Fraction, F } from './fraction'
export { TimeSpan, hap, hasOnset } from './types'
export type { Hap } from './types'
export { Pattern, reify } from './pattern'
export { bjorklund } from './euclid'
export { timeHash } from './rand'
export { mini, miniLoc, miniParse, m, MiniError } from './mini'
export type { Loc, MiniValue } from './mini'
// `n` comes from controls, not mini: same template-tag behavior, plus the
// function form n('0 3') that builds a {n} control pattern (see controls.ts).
export { n, note, sound, s } from './controls'
export type { ControlMap, ControlValue } from './controls'
export { chord, parseChord } from './chords'
export { SCALES, parseScaleName, scaleDegree, noteNameToMidi } from './scales'
export { Scheduler } from './scheduler'
export type { SchedulerEvent, SchedulerOpts } from './scheduler'
export {
  signal,
  saw,
  saw2,
  isaw,
  isaw2,
  sine,
  sine2,
  cosine,
  cosine2,
  tri,
  tri2,
  square,
  square2,
  rand,
  irand,
  perlin,
} from './signal'
export { arrange, rise, fall } from './arrange'
export {
  parseMidi,
  MidiParseError,
  midiToName,
  ticksPerBar,
  midiCps,
  midiNotesToPattern,
  midiNotesToVoices,
} from './midi'
export type { MidiFile, MidiTrack, MidiNote, MiniOptions, MiniResult } from './midi'

// Side-effect import: combinators.ts installs the musical API (every, iter,
// euclid, degradeBy, segment, ...) onto Pattern.prototype via declaration
// merging. Importing @rondocode/pattern therefore activates it — do not
// remove this even though nothing is bound from it. (controls.ts, imported
// above for its exports, likewise installs the control methods.)
import './combinators'
