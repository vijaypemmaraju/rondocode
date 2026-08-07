/* CodeMirror language support for rondo (the terse music language that
 * transpiles to rondocode). Two pieces:
 *   - rondoLanguage(): a StreamLanguage that tags tokens with standard
 *     highlight tags, so it reuses the editor's existing HighlightStyle.
 *   - rondoCompletionSource: keyword/builtin/modifier autocomplete with docs.
 *
 * The heavy lifting (parse + diagnostics) is the @rondocode/rondo compiler,
 * driven from editor.ts; this module is only the editor-surface glue. */

import './rondo-ui.css'
import { StreamLanguage, LanguageSupport } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { hoverTooltip } from '@codemirror/view'
import { BUILTINS, KEYWORDS, MODIFIERS } from './words'
export { BUILTINS, KEYWORDS, MODIFIERS } from './words'
import { renderDocBlock, renderDocBlocks } from '../docblock'
import type { DocBlock } from '../docblock'
import { autocompletion } from '@codemirror/autocomplete'
import { restTag } from '../theme'
import { rondoMode } from '../langflag'
import { makeRondoCompletionSource } from './complete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { rondoWidgets } from './widgets'
import type { Hooks as RondoWidgetHooks } from './widgets'

export type { Hooks as RondoWidgetHooks } from './widgets'


const rondoStreamLang = StreamLanguage.define<{ curve?: boolean }>({
  name: 'rondo',
  // Mod-/ toggle comment (the defaultKeymap binding) needs to know rondo's
  // line-comment token; without this the command silently no-ops in rondo.
  languageData: { commentTokens: { line: '#' } },
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
    // arithmetic grouping. In a NOTATION line `(` is euclid, which the
    // notation branch below already paints as an atom — this only ever sees
    // the ones in expressions.
    if (ch === '(' || ch === ')') { stream.next(); return 'op' }
    if (ch === ':' || ch === '=') { stream.next(); return 'op' }
    // A REST gets its own token. It used to fall in with the grouping
    // characters below, which are amber — and so are the numbers — so in
    // `[~ -7!7]` the rest was the same colour as everything beside it.
    if (ch === '~') { stream.next(); return 'rest' }
    // notation / mini-notation characters, highlighted as atoms
    if ('<>[]@!'.includes(ch)) { stream.next(); return 'note' }
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
    rest: restTag,
  },
})

/** The rondo language for CodeMirror: highlighting + (when `hooks` is given)
 *  the inline widgets (knob · envelope · piano-roll). Pass `now` +
 *  `onNoteEvents` too and the widgets go LIVE — playhead lighting, envelope
 *  firing, pattern-driven knobs. Omit hooks for read-only contexts (docs
 *  snippets) that only need highlighting. */
export function rondoLanguage(hooks?: RondoWidgetHooks): LanguageSupport {
  return new LanguageSupport(rondoStreamLang, [rondoMode.of(true), rondoHover, ...(hooks ? [rondoWidgets(hooks)] : [])])
}

/* ---- autocomplete -------------------------------------------------------- */

/** One vocabulary entry. `detail` is the signature shown beside the label and
 *  at the top of the doc card; `info` is the prose; `example` is a line you
 *  could paste. Kept as plain DATA — the DOM rendering happens once, in
 *  docblock.ts, so hover and the completion panel cannot look different. */
export type RondoOption = Completion & { example?: string }

const c = (label: string, type: string, detail: string, info: string, example?: string): RondoOption =>
  example === undefined ? { label, type, detail, info } : { label, type, detail, info, example }

/** The vocabulary table: the one place each rondo word is DESCRIBED.
 *  complete.ts decides which of them belong at the cursor. */
export const OPTIONS: RondoOption[] = [
  c('synth', 'keyword', 'synth NAME', 'Define a synth: a signal pipeline (one stage per line) + `name = …` bindings. Header opts: mono, glide:, unison:, detune:, spread:, curve:, blend:, octaves:, humanize:, voices:.', 'synth lead unison:5 detune:18\n  saw note\n  ladder 1800 res:.4\n  * adsr .01 .2 .6 .3'),
  c('play', 'keyword', 'play NAME', 'Play a pattern through a synth. Notation on the first line, modifiers below.', 'play lead\n  0 3 5 7  scale:a-min\n  every 4: rev'),
  c('beat', 'keyword', 'beat [NAME]', 'A drum line: notation words ARE synth names; `kick:.6` accents that step.', 'beat\n  kick ~ kick ~\n  ~ hat:.6 ~ hat'),
  c('sing', 'keyword', 'sing NAME voice:barbara', 'A neural vocal: LYRIC lines above MELODY lines (pairs), one syllable per note.'),
  c('irand', 'keyword', 'irand N seg:M', 'Random scale degrees 0..N−1, M steps per cycle — a deterministic improviser.', 'play lead\n  irand 8 seg:16  scale:d-dor'),
  c('post', 'keyword', 'post', 'A post FX chain over the summed voices (reverb/eq/…), folded from `input`.', 'post\n  reverb input room:.7\n  eq hp 80'),
  c('bpm', 'keyword', 'bpm 128', 'Set the tempo in beats per minute, counted in quarter notes (four to the bar unless timesig says otherwise).', 'bpm 128'),
  c('cps', 'keyword', 'cps N', 'Set the tempo in cycles per second, the engine unit: one cycle is one bar, so .5333 cps is 128 bpm.', 'cps .5333'),
  c('timesig', 'keyword', 'timesig BEATS UNIT', 'Set the meter. A cycle is one bar, so this is how long a bar is: it scales bpm, the header readout, the MIDI clock and an exported file\'s bar lines. Your notation still fills one cycle. The unit must be a power of two.', 'timesig 3 4'),
  c('sidechain', 'keyword', 'sidechain kick depth:.7 lead:.5', 'The pump: every kick ducks the other channels. Extra name:amount pairs are per-channel duck.', 'sidechain kick depth:.7 lead:.5'),
  c('master', 'keyword', 'master threshold:-6 ratio:2', 'Master-bus glue compressor.', 'master threshold:-6 ratio:2'),
  c('with', 'keyword', 'with drums', "On a section header: play THAT section too, stacked under this one. `song` puts sections in a row; this is the only way to put one on top of another, and it covers both layering (a drums-only section under several others) and variation (a section that is another plus two more parts). By reference, so editing the shared section changes everywhere it plays. It must name a section defined ABOVE this one.", 'section main 8 with drums'),
  c('patdef', 'keyword', 'patdef riff <[0 ~ 3] [5 ~ 7]>', "Name a pattern so it is written ONCE and referenced by name. Use it as a whole notation line in any play block; it is substituted at compile time, so nothing downstream can tell a named pattern from one typed out by hand. The same idea as macro (numbers), curvedef (shapes), scaledef and wavedef -- a pattern was the one thing the language could not name. A name that is also a synth is refused, because a beat line's bare word already means a synth.", 'patdef riff <[0 ~ 3] [5 ~ 7]>'),
  c('sum', 'keyword', 'sum k 1..16', "Repeat the indented body once per index and ADD the results — an additive stack in one block instead of sixteen near-identical lines. The index is in scope for the body AND for its bindings, which is what lets a partial's ratio be computed from it: bindings are how rondo writes what other languages need parentheses for. Index arithmetic folds at compile time, so `dk = 7.5 / k^.66` is a number, not a graph.", 'sum k 1..16'),
  c('level', 'keyword', 'level -4', "Overall output level in dB (0 = unity). Scales every part equally, so it moves the level without touching the balance. Reach for it when a bounce says it was normalized: above that ceiling per-part gains are inert.", 'level -4'),
  c('scaledef', 'keyword', 'scaledef pelog 0 1.2 2.7 5.4 6.7', 'Define a custom tuning: step offsets in semitones from the root (floats welcome), then `scale: c-pelog`. `Nedo` scales (`scale: c-19edo`) need no scaledef.'),
  c('wavedef', 'keyword', 'wavedef vox 1 .3 / .5 1 .6', 'Define a custom wavetable: `/`-separated frames of harmonic partial amplitudes, then `wavetable note pos table:vox`. The inline editor draws the morph; drag the bars to shape it.'),
  c('bus', 'keyword', 'bus space', 'A shared FX bus: effect lines fold from `input`; `send SYNTH AMT` routes synths in.'),
  c('send', 'keyword', 'send lead .35', 'Route a synth into this bus (0..1, pre-fader).'),
  c('visual', 'keyword', 'visual', 'A WGSL fragment shader block, rendered behind the code.'),
  c('js', 'keyword', 'js{ … } / js block', 'Escape hatch: raw JavaScript, verbatim — total parity with the JS API.'),
  c('saw', 'function', 'saw [freq]', 'Sawtooth oscillator. Default freq = the note.'),
  c('square', 'function', 'square [freq]', 'Square oscillator. Default freq = the note.'),
  c('sine', 'function', 'sine [freq]', 'Sine oscillator (also a global LFO/continuous signal).'),
  c('tri', 'function', 'tri [freq]', 'Triangle oscillator.'),
  c('adsr', 'function', 'adsr a d s r', 'Attack/decay/sustain/release envelope on the note gate.'),
  c('knob', 'function', 'knob DEF lo..hi [log]', 'Declare a live control param (drivable with `name: …`).'),
  c('ladder', 'function', 'ladder cutoff res:…', 'Moog-style resonant low-pass filter on the running signal.'),
  c('svf', 'function', 'svf cutoff res:… mode:…', 'State-variable filter (lp/hp/bp/notch/peak/allpass).'),
  c('dualsvf', 'function', 'dualsvf cutA cutB mode:… a:… b:…', 'Dual filter: two svf stages (a/b types, own cutoffs), serial or parallel.'),
  c('onepole', 'function', 'onepole cutoff', 'Gentle one-pole low-pass.'),
  c('supersaw', 'function', 'supersaw detune:… mix:…', 'Seven detuned saws — the wide trance/EDM lead.'),
  c('wavetable', 'function', 'wavetable [freq] [pos] table:… warp:… warpamt:…', 'Morphing wavetable oscillator: pos (0..1) scans the table (built-in or wavedef). warp bends the cycle read — sync (hard-sync tear), bend (bowed tilt), mirror (palindrome) — warpamt (0..1, sig) drives it.'),
  c('fm', 'function', 'fm [freq] [mod] feedback:…', 'FM operator: a sine whose pitch the mod signal wobbles at audio rate.'),
  c('pulse', 'function', 'pulse [freq] [width]', 'Pulse oscillator with a settable duty width.'),
  c('noise', 'function', 'noise [white|pink|brown]', 'Noise source — pink/brown are warmer.'),
  c('lfo', 'function', 'lfo rate [sine|tri|square|saw|rand]', 'Low-frequency modulator (wobble: `lfo 4 tri -> 200..3000`).'),
  c('mic', 'function', 'mic', 'The LIVE microphone as a signal. Vocode it, filter it, granular it. Headphones advised.'),
  c('sample', 'function', 'sample name root:… loop:1 start:… end:… reverse:1 slices:8', 'Play a loaded sample, pitched from its root note. Slice it with start/end, reverse it, or chop it with slices:N and let the note pick the chop.'),
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
  c('env', 'function', 'env t lvl t lvl:curve … release:… curve:… loop:1', 'Breakpoint envelope: time/level pairs (the flexible cousin of adsr). A level may carry its OWN curve as `1:3` — the envelope-wide `curve:` bends every joint the same way, and a drawn curve does not.'),
  c('eq', 'function', 'eq hp 170 peak 300 -3 2 highshelf 7000 4', 'Parametric EQ: each band is a type word + freq [gain] [q].'),
  c('vocoder', 'function', 'vocoder MOD bands:20', 'Vocoder: the running signal is the carrier, MOD supplies the voice.'),
  c('reverb', 'function', 'reverb room:… mix:…', 'Algorithmic reverb (post). `mix:` blends wet over dry.'),
  c('chorus', 'function', 'chorus rate:… depth:… mix:…', 'Stereo chorus (post).'),
  c('width', 'function', 'width AMT mode:wide|tight', 'Stereo widener (post): amount 0..1 pulls the two sides apart, and the mono sum stays clean.'),
  c('transient', 'function', 'transient attack:… sustain:…', 'Transient designer: attack −1..1 snaps or softens the hit, sustain −1..1 lifts or dries the tail.'),
  c('flanger', 'function', 'flanger rate:… feedback:…', 'Swept resonant comb — the jet whoosh (post).'),
  c('exciter', 'function', 'exciter freq:… amount:…', 'Harmonic exciter — adds air/sheen (post).'),
  c('ott', 'function', 'ott depth:…', 'OTT multiband compressor — the modern glue (post).'),
  // sig ops: on a spine line they take the running signal (`abs`, `max 0.2`);
  // in a BINDING they are a call, target first (`amt = max norm 0.2`)
  c('abs', 'function', 'abs', 'Absolute value — full-wave rectification (an octave-up buzz on audio; distance from centre on an LFO).'),
  c('ceil', 'function', 'ceil', 'Round up to a whole number.'),
  c('floor', 'function', 'floor', 'Round DOWN to a whole number: quantizes a smooth sweep into steps. `lfo .25 -> 0..8` then `floor` then `/ 8` is an audible eight-step sample-and-hold.'),
  c('round', 'function', 'round', 'Round to the nearest whole number.'),
  c('sign', 'function', 'sign', 'Sign of the signal: -1, 0 or 1.'),
  c('sqrt', 'function', 'sqrt', 'Square root. A negative input gives 0 rather than NaN — a NaN would spread through everything downstream and silence the voice.'),
  c('exp', 'function', 'exp', 'e to the power of the signal, clamped so the result stays finite.'),
  c('log', 'function', 'log', 'Natural log. Zero or less gives about -20.7 rather than -Infinity.'),
  c('sin', 'function', 'sin', 'Sine of the signal IN RADIANS — for waveshaping. Not the oscillator: `sine freq` makes a tone, `sin` shapes one.'),
  c('cos', 'function', 'cos', 'Cosine of the signal in radians, for waveshaping.'),
  c('min', 'function', 'min x', 'The smaller of the signal and x — a ceiling.'),
  c('max', 'function', 'max x', 'The larger of the signal and x — a floor. `max 0` is half-wave rectification.'),
  c('mod', 'function', 'mod x', 'Remainder, FLOORED: it takes the sign of the divisor, so `-0.1 mod 1` is 0.9. Wraps a rising ramp back to the start, which is how you build a phasor out of anything. Modulo 0 is 0.'),
  c('fold', 'function', 'fold', 'Wave folding: reflects the signal back on itself past ±1 instead of clipping it, adding harmonics rather than flattening.'),
  c('syncsaw', 'function', 'syncsaw freq ratio:…', 'Hard-synced sawtooth: a second oscillator restarted by the first, for the classic sync tear.'),
  c('lfsr', 'function', 'lfsr freq mode:white|periodic', 'Linear-feedback shift register — the chiptune noise channel. `periodic` is the short, pitched rattle.'),
  c('curvedef', 'keyword', 'curvedef NAME frac lvl frac lvl', "Name a curve SHAPE. Fractions are relative segment lengths, not durations — the shape is scaled where it is used, so one definition serves both a synth's env (seconds) and a lane (cycles). A level may carry its own bend as `1:3`, exactly as in env."),
  c('curve', 'keyword', 'curve cyc lvl cyc lvl', 'A breakpoint automation lane on a play modifier, measured in CYCLES: `cut: curve 8 1 8 .2 300..6000` opens over 8 bars and falls over 8. Takes the same range/slow/fast suffixes every signal value does.'),
  c('shape', 'keyword', 'shape NAME cycles', 'A named curvedef scaled to a length in cycles, as a modifier value: `cut: shape swell 16 300..6000`.'),
  c('slide', 'keyword', 'slide: 0 1 0 1', "303-style slide: a step with slide > 0 TIES into the next note so it glides in; others snap to pitch. The bend comes from the synth, so it needs `mono glide:.08` on the header — glide supplies the slide and this decides which steps get one. For a line that glides throughout, slide every step.", 'play bass\n  0 0 3 5\n  slide: 0 1 0 1'),
  c('add', 'keyword', 'add N', 'Transpose the block by N scale degrees. The roll widget writes this line when you drag its left edge.', 'add 7'),
  c('overchord', 'keyword', 'overchord: <Am7 F>', 'Read the degrees as CHORD degrees, re-voiced by the progression underneath.', 'play pad\n  overchord Am7 D9 Gmaj7'),
  c('off', 'keyword', 'off .25: <comb>', 'Layer a shifted copy: `off .25: gain .3` plays the pattern again a quarter cycle later.', 'off .125: add 7'),
  c('jux', 'keyword', 'jux: <comb>', 'Hard-pan the original left and a transformed copy right.', 'jux: rev'),
  c('degrade', 'keyword', 'degrade', 'Randomly drop about half the events (degradeby N for a set share).'),
  c('palindrome', 'keyword', 'palindrome', 'Play the cycle forwards, then backwards.', 'palindrome'),
  c('sometimes', 'keyword', 'sometimes: <comb>', 'Apply a combinator to a random half of the cycles (also often / rarely / always).', 'sometimes: fast 2'),
  c('iter', 'keyword', 'iter N', 'Rotate the pattern one step further each cycle, over N cycles.', 'iter 4'),
  c('ply', 'keyword', 'ply N', 'Repeat every event N times in its own slot.', 'ply 2'),
  c('segment', 'keyword', 'segment N', 'Sample a continuous signal into N discrete steps per cycle.', 'segment 16'),
  c('sub', 'keyword', 'sub N', 'Transpose DOWN by N scale degrees — the companion to add.', 'sub 5'),
  c('degradeby', 'keyword', 'degradeby 0.3', 'Randomly drop that share of the events (degrade alone drops about half).', 'degradeby 0.3'),
  c('often', 'keyword', 'often: <comb>', 'Apply a combinator on about 3 cycles in 4 (see also sometimes / rarely / always).', 'often: add 12'),
  c('rarely', 'keyword', 'rarely: <comb>', 'Apply a combinator on about 1 cycle in 4.', 'rarely: ply 2'),
  c('always', 'keyword', 'always: <comb>', 'Apply a combinator on every cycle — the readable way to say "no dice roll".', 'always: rev'),
  c('superimpose', 'keyword', 'superimpose: <comb>', 'Layer a transformed copy OVER the original, both sounding.', 'superimpose: add 7'),
  c('chunk', 'keyword', 'chunk N: <comb>', 'Apply a combinator to a different 1/N of the cycle each time round.', 'chunk 4: fast 2'),
  c('rand', 'keyword', 'rand', 'A continuous 0..1 random signal, as a modifier value: `gain: rand 0.4..1`.', 'gain: rand 0.4..1'),
  c('perlin', 'keyword', 'perlin', 'Smooth 0..1 noise — drifts rather than jumping, unlike rand.', 'pan: perlin 0..1'),
  c('switch', 'keyword', 'switch fat 1 9', 'A knob with two fixed values instead of a range. Tapping it swaps them in the source, so the first value is always the one it is resting on. Project-wide at the top level; on a binding (`fat = switch 1 9`) it is that synth\'s own.', 'switch fat 1 9'),
  c('macro', 'keyword', 'macro bright 1480 500..7300 log', 'A project-wide knob. One control, any number of destinations at any ratio: read it by name wherever a number goes, and arithmetic on it comes free.', 'macro bright 1480 500..7300 log'),
  c('section', 'keyword', 'section drop 8', 'A named span of N cycles holding `play` and `beat` blocks. Sequence them with `song`.', 'section drop 8\n  play lead\n    0 3 5 7'),
  c('song', 'keyword', 'song intro drop drop', 'The arrangement: the order sections play in. Repeat a name to repeat the section.', 'song intro drop drop outro'),
  c('mini', 'function', 'mini "<0 3>*2"', 'Mini-notation as a signal, where a bare pattern will not fit — inside an expression or a modifier value.', 'struct mini "1 ~ 1 1"'),
  // the implicit signals: highlighted since the tokenizer shipped, and until
  // now impossible to look up. A word that colours but has no hover is the
  // same confusion as one that hovers but does not colour.
  c('note', 'function', 'note', 'The note being played, as a frequency in Hz. `saw note` is an oscillator at pitch; `note/2` is an octave down.', 'saw + square note/2'),
  c('gate', 'function', 'gate', 'The note gate: 1 while the note is held, 0 after. What an envelope reads. Usually implicit — `adsr` takes it for you.', 'env = adsr .003 .2 .3 .1'),
  c('velocity', 'function', 'velocity', "The note's 0..1 velocity, from the pattern's `gain:`. Multiply by it to make accents shape the sound, not just its volume.", '* velocity ^ .5'),
  c('input', 'function', 'input', 'The summed signal arriving at a `post` or `bus` block. Only needed in a BINDING: on an ordinary chain line the running signal is already implicit, so `reverb room:.7` is the whole line and `reverb input room:.7` is one argument too many.', 'post\n  rv = reverb input room:.7\n  mix rv .3'),
  c('scale', 'keyword', 'scale:a-min', 'Resolve degree notation to notes in a scale.', 'scale:a-min'),
  c('every', 'keyword', 'every N: <comb>', 'Apply a combinator every Nth cycle (e.g. `every 4: rev`).', 'every 4: rev'),
  c('gain', 'keyword', 'gain: v', 'Note velocity (0..1).', 'gain: .8'),
  c('dur', 'keyword', 'dur: v', 'Gate length / legato.', 'dur: .25'),
  c('struct', 'keyword', 'struct <mini>', 'Impose a rhythm from a mini-notation boolean pattern.', 'struct 1 ~ 1 1'),
  c('rev', 'keyword', 'rev', 'Reverse the pattern.', 'rev'),
  c('fast', 'keyword', 'fast N', 'Speed the pattern up N×.', 'fast 2'),
  c('slow', 'keyword', 'slow N', 'Slow the pattern down N×.', 'slow 4'),
  c('euclid', 'keyword', 'euclid p s', 'Euclidean rhythm: p pulses over s steps.', 'euclid 3 8'),
]

/* ---- hover docs ---------------------------------------------------------- *
 * EVERY word rondo knows, answered in rondo. Builtins used to fall through to
 * the JS DSL's dslHover, which documents the underlying CALL — `svf(inp,
 * cutoff, opts?)` for a language whose actual spelling is `svf cutoff res:…`.
 * Accurate about JavaScript, and about nothing you can type here. dslHover
 * now stands down in rondo documents (see langflag.ts), so these do not
 * stack. */
const HOVER_DOCS = new Map<string, RondoOption>(OPTIONS.map((o) => [o.label as string, o]))

export const rondoHover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos)
  const text = line.text
  const off = pos - line.from
  let a = off, b = off
  while (a > 0 && /[\w]/.test(text.charAt(a - 1))) a--
  while (b < text.length && /[\w]/.test(text.charAt(b))) b++
  if (a === b) return null
  const doc = HOVER_DOCS.get(text.slice(a, b))
  if (doc === undefined) return null
  return {
    pos: line.from + a,
    end: line.from + b,
    above: true,
    // the SAME card the JS hover and both completion panels draw. This used to
    // be a pair of bare divs under class names the theme had never heard of,
    // which is why rondo's docs looked like a plain tooltip next to
    // JavaScript's formatted one — same words, no styling.
    create: () => ({ dom: renderDocBlocks([docBlockFor(doc)]) }),
  }
})

/** A vocabulary entry as a doc card. */
export const docBlockFor = (o: RondoOption): DocBlock => {
  const { example } = o
  return {
    signature: String(o.detail ?? o.label),
    summary: String(o.info ?? ''),
    ...(example !== undefined ? { example } : {}),
  }
}

/** Give every option the rich info panel. CodeMirror renders a STRING `info`
 *  as a bare text node inside `.cm-completionInfo`, which carries no padding of
 *  its own — so Cmd-Space over rondo showed unpadded prose with no signature
 *  and no example, while the same key over JavaScript showed a card. The
 *  vocabulary table stays plain data; the renderer is attached here. */
export const withDocPanel = (o: RondoOption): Completion =>
  o.info === undefined ? o : { ...o, info: () => renderDocBlock(docBlockFor(o)) }

/** Context-aware: what may go HERE, not the whole vocabulary. OPTIONS stays
 *  the single place words are DESCRIBED; complete.ts decides which of them
 *  belong at the cursor (and adds the ones only the document knows — this
 *  block's bindings, the project's macros, a call's named args). */
export const rondoCompletionSource = makeRondoCompletionSource(OPTIONS.map(withDocPanel))

/** The prebuilt rondo autocomplete extension (main editor + docs share it). */
export const rondoAutocomplete = autocompletion({
  override: [rondoCompletionSource],
  activateOnTyping: true,
  maxRenderedOptions: 20,
})

