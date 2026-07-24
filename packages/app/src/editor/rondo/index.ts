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

/** Block keywords + `post`. */
const KEYWORDS = new Set(['synth', 'play', 'cps', 'post'])
/** Synth-ctx builtins (oscillators, filters, envelopes, effects, sources). */
const BUILTINS = new Set([
  'saw', 'square', 'sine', 'tri', 'note', 'gate', 'input',
  'adsr', 'knob', 'ladder', 'svf', 'onepole',
  'reverb', 'chorus', 'exciter', 'ott', 'mini',
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
    if (ch === '#') { stream.skipToEnd(); return 'comment' }
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
 *  the inline widgets (knob, …). Pass hooks in the editor; omit for read-only
 *  contexts (docs snippets) that only need highlighting. */
export function rondoLanguage(hooks?: { requestEval: (immediate: boolean) => void }): LanguageSupport {
  return new LanguageSupport(rondoStreamLang, hooks ? [rondoWidgets(hooks)] : [])
}

/* ---- autocomplete -------------------------------------------------------- */

const c = (label: string, type: string, detail: string, info: string): Completion => ({ label, type, detail, info })

const OPTIONS: Completion[] = [
  c('synth', 'keyword', 'synth NAME', 'Define a synth: a signal pipeline (one stage per line) + `name = …` bindings.'),
  c('play', 'keyword', 'play NAME', 'Play a pattern through a synth. Notation on the first line, modifiers below.'),
  c('post', 'keyword', 'post', 'A post FX chain over the summed voices (reverb/eq/…), folded from `input`.'),
  c('cps', 'keyword', 'cps N', 'Set tempo in cycles per second.'),
  c('saw', 'function', 'saw [freq]', 'Sawtooth oscillator. Default freq = the note.'),
  c('square', 'function', 'square [freq]', 'Square oscillator. Default freq = the note.'),
  c('sine', 'function', 'sine [freq]', 'Sine oscillator (also a global LFO/continuous signal).'),
  c('tri', 'function', 'tri [freq]', 'Triangle oscillator.'),
  c('adsr', 'function', 'adsr a d s r', 'Attack/decay/sustain/release envelope on the note gate.'),
  c('knob', 'function', 'knob DEF lo..hi [log]', 'Declare a live control param (drivable with `name: …`).'),
  c('ladder', 'function', 'ladder cutoff res:…', 'Moog-style resonant low-pass filter on the running signal.'),
  c('svf', 'function', 'svf cutoff res:… mode:…', 'State-variable filter (lp/hp/bp/notch/peak).'),
  c('onepole', 'function', 'onepole cutoff', 'Gentle one-pole low-pass.'),
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
