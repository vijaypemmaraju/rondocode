/* CodeMirror language support for rondo (the terse music language that
 * transpiles to rondocode). Two pieces:
 *   - rondoLanguage(): a StreamLanguage that tags tokens with standard
 *     highlight tags, so it reuses the editor's existing HighlightStyle.
 *   - rondoCompletionSource: keyword/builtin/modifier autocomplete with docs.
 *
 * The heavy lifting (parse + diagnostics) is the @rondocode/rondo compiler,
 * driven from editor.ts; this module is only the editor-surface glue. */

import { StreamLanguage, LanguageSupport } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { rondoWidgets } from './widgets'
import type { Hooks as RondoWidgetHooks } from './widgets'

export type { Hooks as RondoWidgetHooks } from './widgets'

/** Block keywords. */
const KEYWORDS = new Set(['synth', 'play', 'cps', 'post', 'bus', 'send', 'sidechain', 'master', 'visual', 'js', 'section', 'song'])
/** Synth-ctx builtins (oscillators, filters, envelopes, effects, sources) —
 *  keep in sync with @rondocode/rondo src/builtins.ts. */
const BUILTINS = new Set([
  'note', 'gate', 'velocity', 'input', 'adsr', 'knob', 'mini',
  'saw', 'square', 'sine', 'tri', 'pulse', 'syncsaw', 'fm', 'wavetable',
  'supersaw', 'noise', 'lfsr', 'lfo',
  'sample', 'granular', 'pluck', 'modal',
  'ladder', 'svf', 'onepole', 'delay', 'comb', 'shape', 'formant', 'pan',
  'bitcrush', 'compress', 'phaser', 'reverb', 'chorus', 'exciter', 'ott',
  'tanh', 'clip', 'fold', 'mix',
])
/** Pattern modifiers / combinators on play lines. */
const MODIFIERS = new Set([
  'scale', 'gain', 'dur', 'pan', 'every', 'struct', 'fast', 'slow', 'rev',
  'euclid', 'degradeby', 'degrade', 'add', 'sub', 'ply', 'segment', 'rand', 'perlin',
])

const rondoStreamLang = StreamLanguage.define<{ curve?: boolean }>({
  name: 'rondo',
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null
    const ch = stream.peek()!
    if (ch === '#') {
      // a comment only at line start or after whitespace — matching the
      // lexer's rule, so `c#4` keeps its sharp instead of greying out
      const prev = stream.pos === 0 ? ' ' : stream.string.charAt(stream.pos - 1)
      if (/\s/.test(prev)) { stream.skipToEnd(); return 'comment' }
      stream.next()
      return 'note'
    }
    if (stream.match('..') || stream.match('->')) return 'op'
    // number (single decimal; never eats a `..` range)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(stream.string.charAt(stream.pos + 1)))) {
      stream.match(/^\d*\.?\d+/)
      return 'num'
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const m = stream.match(/^[a-zA-Z_][A-Za-z0-9_]*/) as RegExpMatchArray | null
      const w = m ? m[0] : (stream.next(), '')
      if (KEYWORDS.has(w)) return 'kw'
      if (BUILTINS.has(w)) return 'builtin'
      if (MODIFIERS.has(w)) return 'mod'
      return 'var'
    }
    if ('+-*/^'.includes(ch)) { stream.next(); return 'op' }
    if (ch === ':' || ch === '=') { stream.next(); return 'op' }
    // notation / mini-notation characters, highlighted as atoms
    if ('<>[]~@!'.includes(ch)) { stream.next(); return 'note' }
    stream.next()
    return null
  },
  tokenTable: {
    kw: t.keyword,
    builtin: t.function(t.variableName),
    mod: t.keyword,
    num: t.number,
    comment: t.lineComment,
    op: t.operator,
    var: t.variableName,
    note: t.atom,
  },
})

/** The rondo language for CodeMirror: highlighting + (when `hooks` is given)
 *  the inline widgets (knob · envelope · piano-roll). Pass `now` +
 *  `onNoteEvents` too and the widgets go LIVE — playhead lighting, envelope
 *  firing, pattern-driven knobs. Omit hooks for read-only contexts (docs
 *  snippets) that only need highlighting. */
export function rondoLanguage(hooks?: RondoWidgetHooks): LanguageSupport {
  return new LanguageSupport(rondoStreamLang, hooks ? [rondoWidgets(hooks)] : [])
}

/* ---- autocomplete -------------------------------------------------------- */

const c = (label: string, type: string, detail: string, info: string): Completion => ({ label, type, detail, info })

const OPTIONS: Completion[] = [
  c('synth', 'keyword', 'synth NAME', 'Define a synth: a signal pipeline (one stage per line) + `name = …` bindings.'),
  c('play', 'keyword', 'play NAME', 'Play a pattern through a synth. Notation on the first line, modifiers below.'),
  c('post', 'keyword', 'post', 'A post FX chain over the summed voices (reverb/eq/…), folded from `input`.'),
  c('cps', 'keyword', 'cps N', 'Set tempo in cycles per second.'),
  c('sidechain', 'keyword', 'sidechain kick depth:.7 lead:.5', 'The pump: every kick ducks the other channels. Extra name:amount pairs are per-channel duck.'),
  c('master', 'keyword', 'master threshold:-6 ratio:2', 'Master-bus glue compressor.'),
  c('bus', 'keyword', 'bus space', 'A shared FX bus: effect lines fold from `input`; `send SYNTH AMT` routes synths in.'),
  c('send', 'keyword', 'send lead .35', 'Route a synth into this bus (0..1, pre-fader).'),
  c('visual', 'keyword', 'visual', 'A WGSL fragment shader block, rendered behind the code.'),
  c('js', 'keyword', 'js{ … } / js block', 'Escape hatch: raw rondocode/JS, verbatim — total parity with the JS API.'),
  c('saw', 'function', 'saw [freq]', 'Sawtooth oscillator. Default freq = the note.'),
  c('square', 'function', 'square [freq]', 'Square oscillator. Default freq = the note.'),
  c('sine', 'function', 'sine [freq]', 'Sine oscillator (also a global LFO/continuous signal).'),
  c('tri', 'function', 'tri [freq]', 'Triangle oscillator.'),
  c('adsr', 'function', 'adsr a d s r', 'Attack/decay/sustain/release envelope on the note gate.'),
  c('knob', 'function', 'knob DEF lo..hi [log]', 'Declare a live control param (drivable with `name: …`).'),
  c('ladder', 'function', 'ladder cutoff res:…', 'Moog-style resonant low-pass filter on the running signal.'),
  c('svf', 'function', 'svf cutoff res:… mode:…', 'State-variable filter (lp/hp/bp/notch/peak).'),
  c('onepole', 'function', 'onepole cutoff', 'Gentle one-pole low-pass.'),
  c('supersaw', 'function', 'supersaw detune:… mix:…', 'Seven detuned saws — the wide trance/EDM lead.'),
  c('fm', 'function', 'fm [freq] [mod] feedback:…', 'FM operator: a sine whose pitch the mod signal wobbles at audio rate.'),
  c('pulse', 'function', 'pulse [freq] [width]', 'Pulse oscillator with a settable duty width.'),
  c('noise', 'function', 'noise [white|pink|brown]', 'Noise source — pink/brown are warmer.'),
  c('lfo', 'function', 'lfo rate [sine|tri|square|saw|rand]', 'Low-frequency modulator (wobble: `lfo 4 tri -> 200..3000`).'),
  c('sample', 'function', 'sample name root:… loop:1', 'Play a loaded sample, pitched from its root note.'),
  c('granular', 'function', 'granular name pos:… size:…', 'Grain cloud over a loaded sample.'),
  c('pluck', 'function', 'pluck [freq] decay:…', 'Karplus–Strong plucked string.'),
  c('modal', 'function', 'modal [freq] model:bell', 'Modal resonator: bell/bar/drum/glass.'),
  c('delay', 'function', 'delay time [feedback]', 'Echo on the running signal.'),
  c('shape', 'function', 'shape drive type:tube', 'Waveshaper drive: soft/hard/sine/tube.'),
  c('bitcrush', 'function', 'bitcrush bits:8', 'Bit/rate crusher — lo-fi grit.'),
  c('compress', 'function', 'compress threshold:… ratio:…', 'Compressor on the running signal.'),
  c('phaser', 'function', 'phaser rate:… depth:…', 'Swept-notch phaser motion.'),
  c('comb', 'function', 'comb freq [feedback]', 'Comb filter — metallic resonance.'),
  c('formant', 'function', 'formant morph', 'Vowel filter: morph 0..1 scans a→e→i→o→u.'),
  c('pan', 'function', 'pan pos', 'Stereo position −1..1 on the running signal.'),
  c('tanh', 'function', 'tanh', 'Saturate the running signal (harmonic bass).'),
  c('clip', 'function', 'clip [lo hi]', 'Hard-clip the running signal.'),
  c('mix', 'function', 'mix other t', 'Crossfade the running signal with another.'),
  c('reverb', 'function', 'reverb room:… mix:…', 'Algorithmic reverb (post). `mix:` blends wet over dry.'),
  c('chorus', 'function', 'chorus rate:… depth:… mix:…', 'Stereo chorus (post).'),
  c('exciter', 'function', 'exciter freq:… amount:…', 'Harmonic exciter — adds air/sheen (post).'),
  c('ott', 'function', 'ott depth:…', 'OTT multiband compressor — the modern glue (post).'),
  c('scale', 'keyword', 'scale:a-min', 'Resolve degree notation to notes in a scale.'),
  c('every', 'keyword', 'every N: <comb>', 'Apply a combinator every Nth cycle (e.g. `every 4: rev`).'),
  c('gain', 'keyword', 'gain: v', 'Note velocity (0..1).'),
  c('dur', 'keyword', 'dur: v', 'Gate length / legato.'),
  c('struct', 'keyword', 'struct <mini>', 'Impose a rhythm from a mini-notation boolean pattern.'),
  c('rev', 'keyword', 'rev', 'Reverse the pattern.'),
  c('fast', 'keyword', 'fast N', 'Speed the pattern up N×.'),
  c('slow', 'keyword', 'slow N', 'Slow the pattern down N×.'),
  c('euclid', 'keyword', 'euclid p s', 'Euclidean rhythm: p pulses over s steps.'),
]

export function rondoCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[a-zA-Z_]\w*/)
  if (!word || (word.from === word.to && !ctx.explicit)) return null
  const options = OPTIONS.filter((o) => (o.label as string).startsWith(word.text))
  if (options.length === 0) return null
  return { from: word.from, options, validFor: /^[a-zA-Z_]\w*$/ }
}
