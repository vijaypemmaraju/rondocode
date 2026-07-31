/* ------------------------------------------------------------------------- *
 * The hand-written guide: short sections, each ending in a COMPLETE program
 * you can hear. Every snippet defines its own synth so pressing play always
 * makes sound and every block is copy-paste ready. Signatures here match
 * dsl-docs.ts.
 * ------------------------------------------------------------------------- */

import { RECIPES } from './cookbook'
import type { Recipe } from './cookbook'

/* Block kinds. Prose that TEACHES stays a paragraph; enumerations a reader
 * SCANS become a table or a list, and the handful of real warnings become
 * notes. Every kind renders on the docs page (docs.ts), in the LLM-facing
 * Markdown (markdown.ts) and into the search index (blockText below).
 * `inline `code` spans` work in every text field, through one shared
 * formatter (docs/blocks.ts). */

/** A prose paragraph. */
export interface ParagraphBlock {
  kind: 'p'
  text: string
}

/** A complete, playable program. */
export interface CodeBlock {
  kind: 'code'
  /** program source */
  text: string
  /** short caption shown above the block */
  caption?: string
  /** code language: omitted = JavaScript; 'rondo' = the rondo language
   *  (rendered with rondo highlighting, transpiled before play). */
  lang?: 'rondo'
}

/** A reference-like enumeration: option / meaning / example. Every row must
 *  carry exactly `headers.length` cells (pinned by docs.test.ts). */
export interface TableBlock {
  kind: 'table'
  caption?: string
  headers: string[]
  rows: string[][]
}

/** Steps (ordered) or a short enumeration that is not two-column (bulleted). */
export interface ListBlock {
  kind: 'list'
  items: string[]
  ordered?: boolean
}

/** A restrained callout for something that will bite: 'warn' for the real
 *  hazards (mic feedback), 'info' for the surprises (a one-time download). */
export interface NoteBlock {
  kind: 'note'
  text: string
  tone?: 'info' | 'warn'
}

export type Block = ParagraphBlock | CodeBlock | TableBlock | ListBlock | NoteBlock

export interface Section {
  id: string
  title: string
  /** nav group heading; consecutive sections sharing one render under it. */
  group: string
  blocks: Block[]
}

const p = (text: string): ParagraphBlock => ({ kind: 'p', text })
const code = (caption: string, text: string): CodeBlock => ({ kind: 'code', caption, text })
/** a runnable RONDO-language block (transpiled before play). */
const rondo = (caption: string, text: string): CodeBlock => ({ kind: 'code', caption, text, lang: 'rondo' })
const table = (caption: string, headers: string[], rows: string[][]): TableBlock => ({ kind: 'table', caption, headers, rows })
const list = (items: string[], ordered = false): ListBlock => ({ kind: 'list', items, ordered })
const note = (text: string, tone: 'info' | 'warn' = 'info'): NoteBlock => ({ kind: 'note', text, tone })

/** Every human-readable string a block contributes, for the docs search index
 *  (docs.ts) and the style sweeps in the tests. A new block kind that forgets
 *  to report its text here goes silently unsearchable, so this is the ONE
 *  place that knows how to read a block's words. */
export function blockText(b: Block): string {
  switch (b.kind) {
    case 'p':
    case 'note':
      return b.text
    case 'code':
      return `${b.caption ?? ''} ${b.text}`
    case 'list':
      return b.items.join(' ')
    case 'table':
      return [b.caption ?? '', ...b.headers, ...b.rows.flat()].join(' ')
  }
}

export const HERO = {
  title: 'rondocode',
  tagline: 'Live-codeable synths and mini-notation patterns, in your browser.',
  blurb:
    'There are two kinds of code here: synths, which turn oscillators, filters, and envelopes into a sound, and patterns, which trigger those sounds in time. And two languages to write them in: JavaScript (the full API, below) and rondo (the terse phone-first language; see \u201cthe rondo language\u201d). Press play on any example to hear it, or open it in the editor to change it.',
}

/** The order the guide's groups read in. Sections are authored in whatever
 *  order suits editing, so the page GROUPS them by this list before
 *  rendering: without it a group that appears twice in the array produces two
 *  separate nav headings (the guide had "sound design" three times). A group
 *  missing from this list sorts last, and a test pins that none are. */
export const GROUP_ORDER: readonly string[] = [
  'start here',
  'sound design',
  'effects & mix',
  'patterns & form',
  'voice & visuals',
  'the rondo language',
  // The cookbook sits AFTER the guide: it answers "how do I say X", which is
  // the question you have once you already know what the pieces are.
  'cookbook',
]

/** SECTIONS grouped and ordered for display: groups in GROUP_ORDER, sections
 *  keeping their authored order within a group. Pure. */
export function orderedSections(sections: readonly Section[] = SECTIONS): Section[] {
  const rank = (g: string): number => {
    const i = GROUP_ORDER.indexOf(g)
    return i < 0 ? GROUP_ORDER.length : i
  }
  return sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s.group) - rank(b.s.group) || a.i - b.i)
    .map((x) => x.s)
}

export const SECTIONS: Section[] = [
  {
    id: 'first-sound',
    group: 'start here',
    title: 'Your first sound',
    blocks: [
      p('A synth is a function of its voice inputs: the note being played, the gate that says when it is held, and a set of oscillators and envelopes. Name it with const and it registers under that name.'),
      p("A pattern is a sequence in mini-notation. note('…') turns note names into pitches, and .sound('pluck') sends them to your synth. p('melody', …) registers the pattern so it plays."),
      code(
        'Define a synth, then send it some notes.',
        `const pluck = synth(({ note, gate, adsr, tri }) => {
  const env = adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })
  return tri(note.freq).mul(env)
})

p('melody', note('c4 e4 g4 e4').sound('pluck'))`,
      ),
    ],
  },
  {
    id: 'patterns',
    group: 'start here',
    title: 'Patterns & mini-notation',
    blocks: [
      p('Steps separated by spaces split the cycle evenly. Nest them in brackets to subdivide a step, use angle brackets to change the step each cycle, and add *n to repeat it faster.'),
      code(
        '[ ] fits into one step. <> changes each cycle. *n repeats.',
        `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })))

p('seq', note('c4 [e4 g4] <b4 a4> c5*2').sound('pluck'))`,
      ),
      p("Rests and lengths shape the rhythm without changing the tempo: `~` is a silent step, `_` holds the previous note for another step, `@n` gives a step n steps' worth of time, and `!n` repeats a step n times."),
      code(
        '~ rest, _ hold, @n weight, !n repeat.',
        `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })))

// "c4 held for 2, rest, a chord, then 3 quick c5s"
p('seq', note('c4@2 ~ [e4,g4,b4] c5!3').sound('pluck'))`,
      ),
      p("Speed changes and randomness keep a loop alive: `*n` fits n repeats INTO a step, `/n` stretches a step over n cycles, `?` drops a step at random, and `a | b` picks one alternative each cycle. Note what `/n` implies: a stretched step only SOUNDS on the cycle its onset lands in; the other n-1 cycles hold the note's tail, so that slot is silent there. That silence is deterministic, not random. All true randomness is seeded per cycle, so a loop is different bar to bar but identical every time you replay it."),
      code(
        '*n / /n speed, ? maybe, | random choice.',
        `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.12, s: 0, r: 0.1 })))

// g4/2 sounds every OTHER cycle (its off-cycles are the stretched tail);
// <g4 a4> alternates every cycle. Combining them compounds both rules.
p('seq', note('c4*2 e4? g4/2 [c5 b4 | e5 d5]').scale('c major').sound('pluck'))`,
      ),
      p("Write a Euclidean rhythm inline with (pulses, steps): it spreads the pulses as evenly as it can, so (3,8) is the tresillo. And `{a b c, d e}%n` is polymeter, several voices running at n steps per cycle so they drift against each other."),
      code(
        'Euclid (p,s) and polymeter {…}%n. Two parts get two synths in two registers, so the lines stay distinct instead of overlapping on one voice.',
        `const tick = synth(({ note, gate, adsr, sine }) =>
  sine(note.freq).mul(adsr(gate, { a: 0.002, d: 0.06, s: 0, r: 0.04 })))
const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })))

p('euclid', note('c6(3,8)').sound('tick').gain(0.6))
p('poly', note('{c3 e3 g3, c4 b3}%4').sound('pluck').gain(0.5))`,
      ),
      p('The API reference panel (search or scroll to Mini-notation) lists every operator with a one-line description, `*` `/` `!` `@` `~` `_` `[]` `<>` `{}` `?` `|` and the euclid form, in one place.'),
    ],
  },
  {
    id: 'notes',
    group: 'start here',
    title: 'Notes, scales & chords',
    blocks: [
      p("note() takes absolute pitches like c4 or f#3. n() takes scale degrees, where 0 is the root and 7 is the octave, and .scale('c minor') puts them in a key, so you can move a whole line by changing one word. chord() turns a name like Cm7 into a stack of notes."),
      code(
        'Scale degrees and named chords. Give the lead and pad SEPARATE synths so a shared note is not cut short by the other part.',
        `const lead = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.2, s: 0.3, r: 0.2 })))
const pad = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq), 1800, { res: 0.2 }).mul(adsr(gate, { a: 0.2, d: 0.3, s: 0.6, r: 0.4 })).mul(0.35))

p('lead', n('0 2 4 <7 6> 4 2').scale('c minor').sound('lead'))
p('pad', chord('<Cm7 Abmaj7>').sound('pad').dur(0.96))`,
      ),
      p("Every diatonic mode is built in by name: major (ionian), minor (aeolian), dorian, phrygian, lydian, mixolydian, locrian. So are both pentatonics, blues, wholeTone, harmonicMinor, melodicMinor, and CHROMATIC. `.scale('c chromatic')` makes degrees 0..11 the full 12-tone set, and note names (`c4 f#4 g#4`) are always chromatic, scale or no scale. Changing `'e dorian'` to `'e phrygian'` recolors a whole line with one word."),
      p("Chords sit in root position by default. Reshape them with .invert(k) (inversions), .octave(n), and .voicing('drop2') (open/jazz spreads). Best of all, .voiceLead() nudges each chord onto the octaves nearest the previous one, so a progression glides smoothly instead of leaping, the difference between a beginner and a pro-sounding comp."),
      code(
        'The same progression, voice-led so the chords barely move.',
        `const pad = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq), 2200, { res: 0.2 }).mul(adsr(gate, { a: 0.3, d: 0.4, s: 0.8, r: 0.6 })).mul(0.3))

p('pad', chord('<Cmaj7 Fmaj7 Bm7b5 E7>').voiceLead().sound('pad').dur(0.98))
setCps(0.4)`,
      ),
      p('A progression to sing over is one line: pick a preset shape (pop `<C G Am F>`, doo-wop `<C Am F G7>`, a ii-V-I `<Dm7 G7 Cmaj7>`), give it a soft pad and a slow tempo, and the changes loop underneath your voice. The chords chip in the rondo tap palette inserts one ready to edit.'),
      p("TUNINGS are not locked to those 12 notes: note numbers are floats all the way to the oscillator, so fractional midi is a real pitch. Any `Nedo` scale name divides the octave into N equal steps (`'c 19edo'`, `'a 31edo'`), and defineScale() registers your own scale from a math spec: step offsets in semitones from the root (floats welcome), cents, or frequency ratios like `{ ratios: [1, 9/8, 5/4, 3/2, 5/3] }` for just intonation, each with an optional period for non-octave tunings (Bohlen-Pierce is `{ ratios: [...], periodRatio: 3 }`). The spec is a plain array, so adding or subtracting a note is just editing the array. Custom names then work anywhere a scale name does; degrees past the last entry wrap up by the period, exactly like degree 7 in a major scale."),
      code(
        'Two tunings you cannot play on a piano: 19 equal steps, then a pelog-style pentatonic given in cents.',
        `const bell = synth(({ note, gate, adsr, fm }) => {
  const mod = fm(note.freq.mul(2)).mul(adsr(gate, { a: 0.001, d: 1.2, s: 0, r: 0.5 }).mul(0.2))
  return fm(note.freq, mod).mul(adsr(gate, { a: 0.001, d: 1.4, s: 0, r: 0.6 })).mul(0.4)
})

// 19 notes per octave, no setup needed: any Nedo name works
p('lead', n('0 3 6 8 11 14 16 19').scale('c 19edo').sound('bell'))

// your own tuning, in cents from the root
defineScale('pelog', { cents: [0, 120, 270, 670, 785] })
p('gong', n('<0 4 1 3>').sub(5).scale('c pelog').sound('bell').dur(2))
setCps(0.35)`,
      ),
    ],
  },
  {
    id: 'synths',
    group: 'sound design',
    title: 'Designing synths',
    blocks: [
      p('Inside the synth function you build a signal graph out of oscillators (sine, saw, square, tri, pulse, wavetable, noise), filters (svf, ladder, onepole, dualsvf), and envelopes (adsr, lfo). Signals combine with .mul, .add, .mix, and .range.'),
      p('dualsvf is the Serum-style dual filter: two svf stages with their own cutoffs and types (a/b), run serial (hp into lp carves a steep band) or parallel (lp + hp leaves a hole between the cutoffs). And unison stacks can be SHAPED from the synth opts: curve (>1 pulls the inner voices toward the note), blend (edge-voice gain 0..1) and octaves (every Nth voice plays +12) turn a flat detune spread into a sculpted supersaw. humanize (0..1) is the last touch: every voice gets its own tiny pitch and timing offset, up to 8 cents and 14 ms late at full amount, so the stack breathes instead of sounding like N identical copies. The offsets are hashed from the voice and the note rather than rolled at random, so the render still repeats exactly.'),
      p('The wavetable oscillator is the most sweepable sound in the engine: `wavetable(freq, pos, { table })` scans `pos` (0..1) through a bank of single-cycle waves. Drive `pos` with an envelope so every note opens through the table.'),
      table(
        'The built-in tables.',
        ['table', 'what `pos` scans through'],
        [
          ['`basic`', 'sine to saw to square: the plain morph'],
          ['`harmonic`', 'a MOVING FORMANT, the vowel-like bloom under a lot of modern leads'],
          ['`pwm`', 'widening pulses, from a thin sliver to a full square'],
        ],
      ),
      p("The 'wavetable lead' example is the full recipe: formant scan, supersaw width, mono glide, ott sheen."),
      p("You can also DESIGN a table: `defineWavetable('vox', [[1, 0.25], [0.4, 1, 0.5], [0.3, 0.8, 1, 0.7]])` registers a custom bank where each frame is a list of harmonic partial amplitudes (harmonic 1, 2, 3, ...) and `pos` morphs between the frames. The engine synthesizes band-limited waves from the partials, so a custom table stays as clean up high as the built-ins, and because the table is just numbers in your code, editing an amplitude IS sound design. Call defineWavetable before the synth that names the table."),
      p("Or RECORD one: every sample row in the samples popover has a wave button that FFT-resynthesizes that audio (a mic take, a resampled bounce, a loaded file) into partial frames and appends the defineWavetable call to your code. Your voice becomes a morphing oscillator, as numbers you can edit."),
      p("Warp modes reshape how each cycle READS the table, on top of any table: `wavetable(freq, pos, { warp: 'sync', warpAmt })`. `warpAmt` (0..1, default 0.5) is a signal, so sweep it with an envelope for the sync scream; the read stays mipmap-anti-aliased while it tears."),
      table(
        'The three warp modes.',
        ['warp', 'what it does to the cycle', 'the sound'],
        [
          ["`'sync'`", 're-runs the cycle faster and wraps it', 'the classic hard-sync tear'],
          ["`'bend'`", 'bows the phase curve', 'tilts the harmonic balance'],
          ["`'mirror'`", 'reflects the cycle at its midpoint', 'palindromic symmetry'],
        ],
      ),
      p('This is an acid bass: a sawtooth through a ladder filter, with the envelope opening the cutoff on each note. param() declares a knob you can automate later.'),
      code(
        'A ladder bass with a resonant filter sweep, and a dual-filtered, shaped-unison stab over it.',
        `const acid = synth(({ note, gate, param, adsr, saw, square, ladder }) => {
  const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })
  const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
  const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)
  return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)
})

// dualsvf: parallel lp+hp scoops the middle; curve/blend/octaves shape the unison stack
const hollow = synth(
  ({ note, gate, adsr, saw, dualsvf }) => {
    const env = adsr(gate, { a: 0.004, d: 0.25, s: 0.2, r: 0.15 })
    return dualsvf(saw(note.freq), 350, 2800, { mode: 'parallel', a: 'lp', b: 'hp', res: 0.3 }).mul(env)
  },
  { unison: 5, detune: 16, spread: 0.8, curve: 2, blend: 0.7, octaves: 4, humanize: 0.5 },
)

p('bass', note('c2 c2 g2 c2 eb2 c2 g1 c2').sound('acid'))
p('stab', note('<c4 ~ eb4 ~>').sound('hollow').gain(0.5))`,
      ),
    ],
  },
  {
    id: 'fm',
    group: 'sound design',
    title: 'FM synthesis',
    blocks: [
      p("fm() is a phase-modulation operator: a sine whose pitch is bent by another signal. Feed one fm() as the mod of another and its amplitude becomes the modulation index, more index means more sidebands and a brighter tone. A whole-number ratio keeps the sidebands harmonic (musical); a non-whole ratio makes them inharmonic (bells and mallets). Because the modulator's amplitude is the index, an envelope on the modulator sweeps the timbre, and keeping the index modest (1 to 3) keeps the sound warm rather than harsh."),
      p('This is a warm FM electric piano: a 3:1 ratio whose index decays quickly, so each note has a soft bark that settles to a near-sine body, plus a gentle bell on top.'),
      code(
        'A mellow FM e-piano, with a soft inharmonic bell above it.',
        `const ep = synth(({ note, gate, adsr, fm }) => {
  // modulator at 3:1; its index decays fast from 2 -> 0 (the tine bark)
  const mod = fm(note.freq.mul(3)).mul(adsr(gate, { a: 0.001, d: 0.4, s: 0, r: 0.2 }).mul(2))
  return fm(note.freq, mod, { feedback: 0.05 }).mul(adsr(gate, { a: 0.002, d: 1.2, s: 0.2, r: 0.4 })).mul(0.5)
})
const bell = synth(({ note, gate, adsr, fm }) => {
  // 1.4 ratio is inharmonic; a LOW index (2.2) keeps the ring soft, not clangy
  const mod = fm(note.freq.mul(2)).mul(adsr(gate, { a: 0.001, d: 1.2, s: 0, r: 0.5 }).mul(0.2))
  return fm(note.freq, mod).mul(adsr(gate, { a: 0.001, d: 1.6, s: 0, r: 0.6 })).mul(0.35)
})

p('keys', chord('<Cmaj7 Am7 Fmaj7 G7>').sound('ep').dur(0.95))
p('bell', note('<c6 ~ g5 ~>').sound('bell').gain(0.5))
setCps(0.4)`,
      ),
      table(
        'Four starting recipes, each one carrier plus one modulator. The ratio is the modulator frequency against the note; the index is the modulator amplitude.',
        ['sound', 'ratio', 'index shape'],
        [
          ['E-piano', '3:1', 'a fast decay, plus a whisper of feedback'],
          ['Bell', 'about 1.4:1', 'held low (2 to 3) so it rings rather than clangs'],
          ['FM bass', '1:1', 'a quick decay'],
          ['Brass', '1:1', 'a slow swell, so the tone grows in'],
        ],
      ),
      p("Big indexes (5+) and heavy feedback are where FM turns harsh, so reach for them deliberately. The built-in 'fm presets' example wires these up to play with."),
    ],
  },
  {
    id: 'physical',
    group: 'sound design',
    title: 'Physical modeling',
    blocks: [
      p("Some sounds are easier to model as a physical object than to build from oscillators. pluck() is a Karplus-Strong string: a rising gate plucks it, and it rings and decays on its own, no ADSR needed. modal() strikes a bank of tuned resonators like a real bell, bar, drum or glass. Both are self-enveloping, so you just give them a gate and a pitch."),
      code(
        'A plucked string ostinato under a struck bell.',
        `const string = synth(({ note, gate, pluck }) =>
  pluck(gate, note.freq, { decay: 1.4, damp: 0.35 }))
const bells = synth(({ note, gate, modal }) =>
  modal(gate, note.freq, { model: 'bell', decay: 3 }))

p('string', note('a2 e3 a3 e3 c3 e3 a3 e3').sound('string').gain(0.8))
p('bell', note('<a4 ~ c5 ~>').sound('bells').gain(0.5))
setCps(0.5)`,
      ),
    ],
  },
  {
    id: 'effects',
    group: 'effects & mix',
    title: 'Effects & the post-chain',
    blocks: [
      p('A synth can take a second function, the post-chain. The first function runs once per voice; the post-chain runs once on the summed instrument, so a reverb tail is shared across notes instead of stacking up. input is the dry signal, which you mix back with the wet.'),
      code(
        'A stab with a shared delay and reverb.',
        `const stab = synth(
  ({ note, gate, adsr, saw }) =>
    saw(note.freq).mul(adsr(gate, { a: 0.005, d: 0.18, s: 0.2, r: 0.2 })),
  ({ input, delay, reverb }) => {
    const echo = input.add(delay(input, 0.375, 0.4))
    return echo.mix(reverb(echo, { roomSize: 0.85, damp: 0.4 }), 0.35)
  },
)

p('chords', chord('<Am7 Dm7 G7 Cmaj7>').sound('stab'))`,
      ),
      p('`delay(input, 0.375, 0.4)` is 375 milliseconds, an echo that only lands on the beat at one tempo. `delay(input, 0.1875, 0.4, { sync: true })` reads the time in CYCLES instead, so it stays a dotted eighth wherever you take the tempo. The buffer is still sized in SECONDS by maxTime (0.5 s by default) and a synced time is clamped to it, so a long musical delay at a slow tempo wants `{ sync: true, maxTime: 2 }`.'),
      table(
        'A synced time or rate is a length in CYCLES. One cycle is one bar of 4/4, so these are the values worth memorizing (they read the same in `lfo(..., { sync: true })` and in rondo’s `sync:1`).',
        ['cycles', 'the musical length'],
        [
          ['1', 'a bar'],
          ['0.5', 'a half note'],
          ['0.25', 'a quarter'],
          ['0.1875', 'a dotted eighth, what every dub delay wants'],
          ['0.125', 'an eighth'],
          ['0.0833', 'an eighth triplet'],
          ['0.0625', 'a sixteenth'],
        ],
      ),
      p("A post-chain can declare `param(...)` too, and it is a live control just like a voice param: `.ctrl('wet', ...)` on the pattern automates it as the music plays. Here the reverb blend opens and closes under an LFO: the same `.ctrl` you use for a filter cutoff drives an effect deep in the post-chain."),
      code(
        'A drivable post param: .ctrl automates the reverb blend live.',
        `const lead = synth(
  ({ note, gate, adsr, saw }) =>
    saw(note.freq).mul(adsr(gate, { a: 0.005, d: 0.2, s: 0.4, r: 0.2 })).mul(0.5),
  ({ input, reverb, param }) => {
    const wet = param('wet', 0.3, { min: 0, max: 0.8 })
    return input.mix(reverb(input, { roomSize: 0.85, damp: 0.4 }), wet)
  },
)

// the LFO sweeps the wash open and shut across four cycles
p('lead', note('c4 e4 g4 e4').sound('lead').ctrl('wet', sine.range(0.1, 0.7).slow(4)))
setCps(0.5)`,
      ),
    ],
  },
  {
    id: 'sends',
    group: 'effects & mix',
    title: 'Shared send buses',
    blocks: [
      p("A post-chain lives inside one synth. A `bus(name, fx, sends)` is a shared effect that many synths feed at once, so a single reverb ties a pluck and a pad into the same space instead of each carrying its own. The send map routes each synth in by amount 0..1. Sends are pre-fader, so lowering a channel keeps its reverb; and a bus reverb sits outside the sidechain, so it does not pump."),
      code(
        'A pluck and a pad sharing one reverb, each sent in by a different amount.',
        `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.004, d: 0.14, s: 0, r: 0.12 })))
const pad = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq).add(saw(note.freq.mul(1.007))), 1600, { res: 0.2 })
    .mul(adsr(gate, { a: 0.4, d: 0.5, s: 0.8, r: 0.7 })).mul(0.35))

p('lead', note('c5 e5 g5 e5').sound('pluck'))
p('bed', chord('<Cmaj7 Am7>').sound('pad').dur(0.98))

// one reverb, fed by both synths (pluck brighter, pad deeper)
bus('space', ({ input, reverb }) => reverb(input, { roomSize: 0.9, damp: 0.3 }), { pluck: 0.35, pad: 0.6 })
setCps(0.5)`,
      ),
    ],
  },
  {
    id: 'stereo-snap',
    group: 'effects & mix',
    title: 'Width, snap & flange',
    blocks: [
      p("Three post-chain tools shape a sound's SPACE and its ATTACK rather than its pitch. width(input, amount) makes a mono instrument wide: the post-chain already runs once per stereo side, and width trades a short delayed copy between the two, adding it on the left and subtracting it on the right. Because the sides subtract back to the dry signal, the mono sum has no comb notches at all, only a flat trim (0 dB at amount 0, down to -3 dB at 1). The price is that a soloed channel is comb filtered, which is exactly what your ears read as wide. mode: 'tight' uses a shorter delay if the low end feels smeared."),
      p('transient(input, { attack, sustain }) is the drum-shaping tool. attack (-1..1) sharpens or softens the hit, sustain (-1..1) lifts or dries the tail behind it. It works off the RATIO of a fast and a slow envelope follower, so it is level independent: a quiet hit and a loud hit get exactly the same shaping. That is the whole difference from a compressor, and it also means it will not control your level, so leave headroom.'),
      p('flanger(input, { rate, depth, feedback, mix }) is the jet whoosh: one very short delay, 0.3 to 8 ms, swept by an LFO and fed back on itself. Chorus thickens with three unfed taps around 11 ms and can never exceed unity gain; the flanger resonates, building peaks between its notches, and that is the sound.'),
      code(
        'A wide, snappy stab and a flanged pad.',
        `const stab = synth(
  ({ note, gate, adsr, saw }) =>
    saw(note.freq).mul(adsr(gate, { a: 0.002, d: 0.14, s: 0.15, r: 0.12 })).mul(0.5),
  ({ input, transient, width, reverb }) => {
    // snap the onset, dry the tail, THEN spread it across the field
    const snap = transient(input, { attack: 0.6, sustain: -0.35 })
    const wide = width(snap, 0.7)
    return wide.mix(reverb(wide, { roomSize: 0.8, damp: 0.4 }), 0.22)
  },
)

const pad = synth(
  ({ note, gate, adsr, saw, svf }) =>
    svf(saw(note.freq).add(saw(note.freq.mul(1.006))), 2000, { res: 0.2 })
      .mul(adsr(gate, { a: 0.35, d: 0.4, s: 0.8, r: 0.6 })).mul(0.28),
  ({ input, flanger }) => flanger(input, { rate: 0.12, depth: 0.8, feedback: 0.75, mix: 0.45 }),
)

p('stab', note('<c4 eb4 g4 bb4>').sound('stab'))
p('pad', chord('<Cm7 Abmaj7>').sound('pad').dur(0.95))
setCps(0.5)`,
      ),
      p('The same three, in rondo: they are ordinary processor lines in a `post` block, folding from the implicit `input`.'),
      rondo(
        'Post lines: transient, then width, then a flanged pad.',
        `synth stab
  saw
  * env
  env = adsr .002 .14 .15 .12
  post
    transient attack:.6 sustain:-.35
    width .7
    reverb room:.8 mix:.22

synth pad
  saw
  + saw note*1.006
  svf 2000 res:.2
  * env
  * .3
  env = adsr .35 .4 .8 .6
  post
    flanger rate:.12 depth:.8 feedback:.75 mix:.45

play stab
  <0 2 4 6>  scale:c-min
  gain: .5

play pad
  <Cm7 Abmaj7>
  dur: .95

cps .5`,
      ),
    ],
  },
  {
    id: 'color',
    group: 'sound design',
    title: 'Fat leads & vowels',
    blocks: [
      p("A few oscillators and filters exist just for character. supersaw() stacks 7 detuned saws for the classic wide trance lead. phaser() sweeps notches through a sound for motion. formant() filters a buzzy source into a singing vowel, and noise('pink') / noise('brown') give warmer, deeper noise than plain white."),
      code(
        'A detuned supersaw lead through a phaser, over a talking formant pad.',
        `const lead = synth(({ note, gate, adsr, supersaw, phaser }) => {
  const sig = supersaw(note.freq, { detune: 0.3, mix: 0.8 })
  return phaser(sig, { rate: 0.3, feedback: 0.6 }).mul(adsr(gate, { a: 0.02, d: 0.3, s: 0.7, r: 0.3 })).mul(0.5)
})
const voice = synth(({ note, gate, adsr, saw, formant, lfo }) =>
  // the LFO scans the vowels a->e->i->o->u for a talking pad
  formant(saw(note.freq), lfo(0.15).range(0, 1)).mul(adsr(gate, { a: 0.3, d: 0.4, s: 0.8, r: 0.5 })).mul(0.4))

p('lead', note('<c4 eb4 g4 bb4>').sound('lead'))
p('voice', chord('<Cm Ab>').sound('voice').dur(0.95))
setCps(0.44)`,
      ),
    ],
  },
  {
    id: 'chiptune',
    group: 'sound design',
    title: 'Chiptune',
    blocks: [
      p("The classic 8-bit palette is all here: pulse() with a duty like 0.125/0.25 for the thin NES square, a triangle bass run through bitcrush({ bits: 4 }) for the stair-stepped sub, and lfsr() for the noise channel, the shift-register noise behind chip hats, snares and zaps ('periodic' mode gives the buzzy, pitched tone). The fake-chord trick is just a fast arpeggio, since a chip channel plays one note at a time."),
      code(
        'A pulse lead arpeggio, 4-bit triangle bass, and LFSR-noise drums.',
        `setCps(0.5)
const lead = synth(({ note, gate, adsr, pulse }) =>
  pulse(note.freq, 0.25).mul(adsr(gate, { a: 0.001, d: 0.05, s: 0.6, r: 0.04 })).mul(0.35))
const bass = synth(({ note, gate, adsr, tri, bitcrush }) =>
  bitcrush(tri(note.freq), { bits: 4 }).mul(adsr(gate, { a: 0.001, d: 0.06, s: 0.7, r: 0.05 })).mul(0.6))
const hat = synth(({ gate, adsr, lfsr }) =>
  lfsr(11000).mul(adsr(gate, { a: 0.001, d: 0.025, s: 0, r: 0.02 })).mul(0.25))

p('lead', chord('<C Am F G>').arp('up').fast(2).sound('lead'))
p('bass', note('<c2 a1 f1 g1>').sound('bass'))
p('hats', note('c5*8').sound('hat'))`,
      ),
    ],
  },
  {
    id: 'arrange',
    group: 'patterns & form',
    title: 'Layering & tempo',
    blocks: [
      p("You can register several patterns at once, and each p() plays alongside the others. stack() combines patterns into one. note('c1*4').sound('kick') triggers a synth by name."),
      p('Tempo comes in two spellings of one number. `setBpm(120)` is the unit you count in; `setCps(0.5)` is the engine unit, cycles per second. One cycle is one BAR of 4 beats everywhere in rondocode, so a bar at 120 bpm lasts 2 seconds and the cycle rate is 0.5 per second: multiply cps by 240 to get bpm. Write whichever you think in, the last call in a run wins, and the header shows both. MIDI import and export use the same convention, so an imported file keeps its tempo and one cycle stays one bar.'),
      table(
        'Tempos you already know, in both units.',
        ['bpm', 'cps', 'where it lives'],
        [
          ['`setBpm(90)`', '`setCps(0.375)`', 'hip hop, downtempo'],
          ['`setBpm(120)`', '`setCps(0.5)`', 'the round number'],
          ['`setBpm(128)`', '`setCps(0.5333)`', 'house, techno'],
          ['`setBpm(140)`', '`setCps(0.5833)`', 'dubstep at half time'],
          ['`setBpm(174)`', '`setCps(0.725)`', 'drum and bass'],
        ],
      ),
      code(
        'A short beat: kick and hats, layered. 120 bpm is the same tempo as setCps(0.5).',
        `setBpm(120)

const kick = synth(({ gate, adsr, sine }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })
  const amp = adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.08 })
  return sine(pitch.pow(2).range(45, 160)).mul(amp).tanh()
})
const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 8000, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.04, s: 0, r: 0.03 }))
    .mul(0.5))

p('drums', stack(
  note('c1 ~ c1 ~').sound('kick'),
  note('c5*8').sound('hat'),
))`,
      ),
    ],
  },
  {
    id: 'rhythm',
    group: 'patterns & form',
    title: 'Rhythm & variation',
    blocks: [
      p("A pattern is more than a fixed loop. `euclid(pulses, steps)` spreads hits as evenly as it can, `swing` bends the feel, and combinators like `every` and `off` transform the pattern on a schedule, so a loop keeps evolving without you writing every bar out."),
      code(
        'Euclidean hats with swing, and a fill every fourth bar.',
        `const kick = synth(({ gate, adsr, sine }) =>
  sine(adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 }).pow(2).range(45, 160))
    .mul(adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.08 })).tanh())
const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 8000, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.04, s: 0, r: 0.03 })).mul(0.5))

p('kick', note('c1*4').sound('kick'))
p('hats',
  note('c5*8').sound('hat')
    .euclid(5, 8)               // 5 hits across 8 steps
    .swing(4)                   // triplet swing
    .every(4, x => x.fast(2)))  // a fill every 4th bar
setCps(0.5)`,
      ),
    ],
  },
  {
    id: 'modulation',
    group: 'patterns & form',
    title: 'Modulation',
    blocks: [
      p("There are two places to modulate, and the difference matters. INSIDE a synth, lfo() (and any signal) runs at audio rate, so it moves smoothly and continuously, this is how you get a gliding filter sweep or a tremolo. From the PATTERN side, .ctrl('name', signal) samples the signal ONCE PER NOTE and holds it, great for per-note variation (a different cutoff on every hit) but stepped, not smooth, so a slow sweep sampled by a few long notes just jumps between a handful of values."),
      code(
        'A smooth in-synth filter sweep + tremolo, and a per-note random cutoff.',
        `const pad = synth(({ note, gate, adsr, saw, svf, lfo }) => {
  // SMOOTH, audio-rate: a slow LFO glides the cutoff; a fast one adds tremolo
  const sweep = lfo(0.1).range(300, 4500)
  const trem = lfo(5).range(0.7, 1)
  const env = adsr(gate, { a: 0.2, d: 0.3, s: 0.85, r: 0.6 })
  return svf(saw(note.freq), sweep, { res: 0.5 }).mul(env).mul(trem).mul(0.4)
})
const stab = synth(({ note, gate, param, adsr, saw, svf }) => {
  const cut = param('cutoff', 1500, { min: 300, max: 6000, curve: 'log' })
  return svf(saw(note.freq), cut, { res: 0.4 }).mul(adsr(gate, { a: 0.002, d: 0.15, s: 0, r: 0.1 })).mul(0.3)
})

p('pad', chord('<Am7 Dm7 G Cmaj7>').sound('pad').dur(0.96))
// .ctrl from the pattern is PER-NOTE: each 8th note gets its own sampled cutoff
p('stab', n('0 3 5 7 5 3 5 7').scale('a minor').sound('stab').ctrl('cutoff', sine.range(600, 5000).fast(3)))
setCps(0.4)`,
      ),
      p('Signals also do ORDINARY MATH, per sample: `abs ceil cos exp floor log round sign sin sqrt` take nothing, and `min max mod` take one argument. They work on control signals and audio alike. Three of them earn their keep immediately: `.floor()` quantizes a smooth sweep into steps (`lfo(0.25).range(0, 8).floor()` is an eight-step staircase, a sample-and-hold you can hear), `.max(0)` is half-wave rectification and `.abs()` is full-wave (an octave-up buzz on audio, and on an LFO it reads distance from centre rather than direction), and `.mod(1)` wraps a rising ramp back to the start, which is how you build a phasor out of anything.'),
      note('The ops that could produce a NaN or an Infinity refuse to, because a graph has no way to report a bad sample: one would spread through everything downstream and the voice would go silent with nothing to look at. `sqrt` of a negative is 0, `log` of 0 or less is about -20.7 rather than -Infinity, `exp` clamps its input so the result stays finite, and modulo by 0 is 0. `mod` is FLOORED, so it takes the sign of the divisor and `(-0.1).mod(1)` is 0.9 (JavaScript would say -0.1) -- which is what wrapping a phase actually needs.'),
      note('`sin()` is the math function on a signal, in radians, for waveshaping. `sine(freq)` is the oscillator. They are different things with confusingly similar names: `sine(note.freq).mul(3).sin()` shapes a tone, `sine(note.freq)` makes one.'),
      p("An LFO rate is in Hz, which means a wobble you tuned by ear slides out of the groove the moment the tempo changes. Pass `{ sync: true }` and the rate becomes a length in CYCLES instead, locked to the transport: `lfo(1, 'tri', { sync: true })` is one sweep per cycle, `0.25` a quarter-note wobble, `0.0625` a sixteenth. Move setCps and it re-rates itself mid-note, keeping its phase, so nothing clicks. Keep Hz for movement that is about SOUND rather than rhythm: a 5 Hz tremolo, a 0.05 Hz drift across a pad."),
      p("adsr's four stages are SIGNALS, not settings: `a`, `d`, `s` and `r` each accept a knob, an LFO or another envelope as readily as a number, and each is read per sample. So `adsr(gate, { r: relKnob })` shortens the release under your finger while a note is still ringing, and one knob can shape the filter and the envelope at once if you scale it differently for each. A plain number costs nothing extra, and because the times are no longer baked in at build time, dragging an envelope value now re-points it on the voices already sounding instead of rebuilding the synth mid-note."),
      note('In rondo, bind the expression before you pass it. `adsr .002 .08 .2 bright/12300` reads as `adsr(...) / 12300` -- the trailing operator attaches to the whole call, not to the last argument, which divides the ENVELOPE by 12300 and leaves you with silence. Write `rel = bright / 12300` on its own line and pass `rel`.'),
      p("`.overChord()` arpeggiates over a HARMONY rather than a scale: the numbers become chord degrees, 0 being the lowest note of whatever chord is sounding under them. `n('0 2 1 4').overChord(chord('<Am F>'))` plays a-e-c-a over Am and f-c-a-f over F: one figure, re-voiced by the progression, instead of two transcriptions. Degrees past the top of the chord wrap up an octave, so a four-step figure over a triad climbs instead of repeating its top note, and negatives reach below it. Everything the notation already does still applies: `~` rests, `[0,2]` stabs two degrees at once, `0(3,8)` places them euclidean, `<0 2>` alternates per cycle."),
      p("In rondo it is a modifier line on the play block: `overchord: <Am F>` under the notation, with the chord names written where you can see them. It applies before everything else on the block, so a `dur:`, a `gain:` or a `.ctrl` sweep decorates the re-voiced notes rather than the raw degrees. The over-a-chord example ships in both languages and they play identical events."),
      rondo(
        'One figure, re-voiced by the progression.',
        `synth keys
  saw note
  * env
  env = adsr .004 .18 .25 .12

play arp synth:keys
  0 2 1 4 2 3 1 5
  overchord: <Am7 Fmaj7 Cmaj7 G>
  dur: .42`,
      ),
      p("The same degrees work from a KEYBOARD. In the midi panel, switch on `arpeggiate` for the synth you are playing: your held chord becomes the harmony and the transport plays the figure over it, restarting at step 0 every time you press run. `latch` keeps the chord after you lift your hand, which is what lets you play something else on top; pressing a new chord replaces it. It is opt-in per synth, so a connected keyboard behaves exactly as it always did until you ask for the arp."),
      p("By default the arp just runs the mode dropdown's ordering over your chord. The step pattern field is where it becomes an instrument: write degrees and you get the same re-voicing a play block gets, from the keyboard. `0 2 1 4` is four steps; `~` is a rest, which is how rhythm gets written; `_` ties, so a note lasts longer than one step; `[0,2]` stabs two degrees at once; `0:.6` sets velocity and `0^-1` drops a whole octave. Negative degrees reach below the chord. Leave it empty and the mode ordering is what you get, so the simple case stays simple."),
      note("The field is read as you type, so a half-finished token drops THAT STEP and leaves the rest of the pattern playing rather than emptying it mid-performance. What the field shows is what was parsed."),
      note("An event with no chord under it is DROPPED rather than given a pitch, because silence is the honest answer to 'the third of nothing'. Non-numeric values pass straight through, so a drum pattern is unaffected if you pipe one through by accident."),
      p("When adsr's four stages are not enough, env() takes a list of [seconds, level] breakpoints for any shape you like, and drives amplitude, pitch or a filter. Here a two-stage pluck envelope shapes the amp, while a second env bends the pitch down at the very start for a synthetic 'blip' attack."),
      code(
        'A breakpoint envelope for the amp, and a fast pitch blip on the attack.',
        `const blip = synth(({ note, gate, env, saw, svf }) => {
  // pitch: start an octave up, snap down to the note in 30ms
  const pitch = note.freq.mul(env(gate, [[0.03, 1]], { release: 0.05 }).range(2, 1))
  // amp: sharp attack, two-stage decay, then a tail (curve makes it natural)
  const amp = env(gate, [[0.004, 1], [0.12, 0.5], [0.5, 0.2]], { release: 0.25, curve: 3 })
  return svf(saw(pitch), 3500, { res: 0.3 }).mul(amp)
})

p('blips', note('c4 e4 g4 c5 g4 e4').sound('blip'))
setCps(0.5)`,
      ),
    ],
  },
  {
    id: 'macros',
    group: 'patterns & form',
    title: 'Macros',
    blocks: [
      p("A param belongs to the synth that declared it. That is on purpose: two synths with a `cutoff` each are two separate controls, and moving one should not move the other. A MACRO is how you ask for the opposite. Declare it once, above your synths, and any synth or post chain can reference it by name -- one knob, reaching the whole project."),
      p("The part worth understanding is that a macro is a VALUE, not a wire. Every use site gets the same number, and each site is free to do arithmetic on it, so one knob can open a filter, close a delay and trim a level, each at its own depth. There is no fan-out syntax to learn: `param('bright').mul(0.5)` is half as much, `0.6` minus a fraction of it is the inverse. That is also why the numbers cannot drift: the only literal is on the macro line, and every destination reads it."),
      code(
        'One knob, four destinations, four different formulas.',
        `macro('energy', 0.35, { min: 0, max: 1 })

const lead = synth(({ note, gate, param, adsr, supersaw, ladder }) => {
  // 1:1 -- the filter opens straight across the knob's range
  const cut = param('energy').mul(5200).add(400)
  return ladder(supersaw(note.freq, { detune: 0.35 }), cut, { res: 0.5 })
    .mul(adsr(gate, { a: 0.003, d: 0.18, s: 0.25, r: 0.1 })).mul(0.5)
}, ({ input, param, delay }) => {
  // INVERTED -- the delay dries up as the lead brightens, so the space tightens
  return delay(input, 0.1875, param('energy').mul(-0.4).add(0.55), { sync: true })
})

const sub = synth(({ note, gate, param, adsr, sine }) => {
  // a gentler inverse: the sub steps back to make room, but never disappears
  const level = param('energy').mul(-0.45).add(1)
  return sine(note.freq).mul(adsr(gate, { a: 0.008, d: 0.12, s: 0.5, r: 0.07 })).mul(level).tanh()
}, undefined, { mono: true, glide: 0.05 })

p('lead', n('<0 3 5 7> ~ 3 ~ 5 7 ~ 3').scale('e minor').sound('lead').dur(0.22))
p('sub', note('~ e1 ~ e1 ~ e1 ~ e1').sound('sub').dur(0.18))
setBpm(126)`,
      ),
      p("In rondo it is one line and a bare name. `macro energy 0.35 0..1` at the top, then write `energy` anywhere you would write a number -- on its own for 1:1, or in any expression for a ratio. The macros example ships both spellings; drag the dial on the macro line and every destination in the document shows you what it is receiving, live, including values built out of other values."),
      rondo(
        'The same thing in rondo.',
        `macro energy 0.35 0..1

synth lead
  supersaw detune:.35
  ladder cut res:.5
  * env
  cut = 400 + energy * 5200
  env = adsr .003 .18 .25 .1
  post
    delay .1875 fb sync:1
    fb = 0.55 - energy * 0.4

play lead
  <0 3 5 7> ~ 3 ~ 5 7 ~ 3
  scale: e-min
  dur: .22`,
      ),
      note("Declare a macro ABOVE the synths that use it. A synth compiles its graph the moment you define it, and that is when `param('energy')` looks the bounds up -- the same rule a custom wavetable follows. In rondo the compiler hoists the line for you, so it works wherever you put it."),
      note("A synth that passes its own default keeps its own control, even if a macro shares the name: `param('cutoff', 800, ...)` is that synth's cutoff, not the macro's. Only the no-default form joins the macro, which is what stops two unrelated knobs from fusing because they happen to be spelled alike. And a macro cannot be used in a bus, because a bus has no notes and no .ctrl route, so nothing there could ever change."),
    ],
  },
  {
    id: 'curves',
    group: 'patterns & form',
    title: 'Curves',
    blocks: [
      p("A curve is a shape over time, and there are two clocks to draw it against. INSIDE a synth, env() runs on the note: breakpoints in seconds, retriggered by every gate. On the TIMELINE, curve() runs on the transport: breakpoints in cycles, for what a DAW calls an automation lane. Same tuple, same easing numbers, two clocks -- so `curve 4` bends identically in both and you only learn it once."),
      p("adsr covers the common shape in four numbers. env() is for everything else: `env(gate, [[0.005, 1], [0.15, 0.4], [0.5, 0.6]])` rises, falls to a plateau, then swells -- and with `loop` it repeats while the gate is held, which makes it an LFO of any shape you like."),
      p("Each breakpoint can carry its OWN bend as a third number. One exponent for the whole envelope makes every joint curve the same way, which is not how a curve gets drawn: an attack usually wants to snap and its tail to ease. `[0.005, 1, 4]` shapes that segment alone; a positive number is fast-then-slow, a negative one slow-then-fast, and 0 is a straight line. In rondo the level carries it, as `1:4`."),
      code(
        'A shaped attack against a linear decay -- one exponent could not say this.',
        `const pluck = synth(({ gate, note, saw, svf, env }) => {
  // snap up, then fall in a straight line
  const amp = env(gate, [[0.004, 1, 5], [0.4, 0]], { release: 0.2 })
  return svf(saw(note.freq), 3000, { res: 0.3 }).mul(amp)
})
p('x', n('0 3 5 7').scale('a minor').sound('pluck'))`,
      ),
      p("On the timeline, curve() takes the same list in cycles: `curve([[8, 1], [4, 0.3], [16, 1]])` opens over eight bars, sags over four, and comes back over sixteen. Past the end it holds the last level, or repeats with `loop`. rise and fall are its two-point linear special cases -- reach for them when that is all you need, and for curve() when it is not."),
      rondo(
        'The same lane, on a play block.',
        `synth pad
  saw note
  svf cut res:.2
  cut = knob 900 100..8000

play pad
  <Am F>
  cut: curve 8 1 8 .2 300..6000`,
      ),
      p("A shape you want twice gets a name. curvedef stores it NORMALISED -- the numbers are relative segment lengths, not durations -- and it is scaled where you use it, which is what lets one definition serve both clocks: `shape('swell', 0.8)` is eight tenths of a second for an env, `shape('swell', 16)` is sixteen bars for a lane. The trade is that a named curve cannot carry an absolute timing. It is a shape; how long it takes belongs to the call."),
      rondo(
        'One shape, both clocks.',
        `curvedef swell .25 1 .75 .2

synth pad
  saw note
  svf cut res:.2
  cut = knob 900 100..8000

play pad
  <Am F>
  cut: shape swell 16 300..6000`,
      ),
      note("A lane is sampled ONCE PER EVENT, like every pattern signal: moving it changes the next notes, not ones already scheduled. A control that has to move WITHIN one note belongs inside the synth, where env and lfo run per sample."),
      p("Both kinds of breakpoint list are editable in place. An `env` draws as a shape with a handle per point: drag a handle to move that point in time and level, or drag the SEGMENT between two of them to bend it -- up for fast-then-slow. Dragging a segment writes the third number, adding it if the point did not have one."),
    ],
  },
  {
    id: 'generative',
    group: 'patterns & form',
    title: 'Generative',
    blocks: [
      p("Randomness here is time-locked: `rand`, `irand` and `perlin` hash the moment, so the same cycle always plays the same way. `.degradeBy(p)` drops events, `.sometimesBy(p, f)` transforms a random share. Change a seed for a new take; the loop stays reproducible."),
      code(
        'Eight random scale degrees a bar, thinned out and ghosted.',
        `const pluck = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq), 2200, { res: 0.4 })
    .mul(adsr(gate, { a: 0.002, d: 0.16, s: 0, r: 0.1 })).mul(0.7))

p('lead',
  n(irand(8).segment(8))         // 8 degrees per bar, same every loop
    .scale('e minor')
    .sound('pluck')
    .degradeBy(0.3, 1)           // drop ~30% (seed 1)
    .sometimesBy(0.25, x => x.gain(0.4), 2))
setCps(0.5)`,
      ),
    ],
  },
  {
    id: 'sidechain',
    group: 'effects & mix',
    title: 'The pump',
    blocks: [
      p("`sidechain('kick', ...)` ducks every other channel on each kick and lets them swell back, the classic four-on-the-floor pump. `masterCompress(...)` glues the whole mix on the master bus. Together they make a loop breathe."),
      code(
        'A kick pumping a chord pad, glued with the master compressor.',
        `const kick = synth(({ gate, adsr, sine }) =>
  sine(adsr(gate, { a: 0.001, d: 0.08, s: 0, r: 0.05 }).pow(2).range(46, 190))
    .mul(adsr(gate, { a: 0.001, d: 0.2, s: 0, r: 0.06 })).tanh())
const pad = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq).add(saw(note.freq.mul(1.005))), 1900, { res: 0.2 })
    .mul(adsr(gate, { a: 0.3, d: 0.4, s: 0.85, r: 0.6 })).mul(0.4))

p('kick', note('c1*4').sound('kick'))
p('pad', chord('<Fmaj7 G Am7 G>').sound('pad').dur(0.98))
sidechain('kick', { depth: 0.8, release: 0.18 }) // the pump
masterCompress({ threshold: -12, ratio: 3, makeup: 2 })
setCps(0.5)`,
      ),
    ],
  },
  {
    id: 'mastering',
    group: 'effects & mix',
    title: 'Mixing & mastering',
    blocks: [
      p("Three effects finish a sound. `eq(sig, bands)` is a parametric EQ: carve mud with a high-pass, tame a harsh peak, add air with a high shelf. `exciter(sig, ...)` synthesizes bright harmonics for sheen without adding hiss. `ott(sig, ...)` is the multiband up-and-down compressor behind modern EDM: it squashes each band's dynamics so the sound reads louder and fuller. Reach for them in a post-chain to master one synth, or in a `bus(...)` to glue several at once."),
      p("The mix discipline underneath them: `.gain()` on a pattern is velocity, clamped 0..1; for real level use the synth's output `.mul()`. Carve with EQ before you boost. And keep reverb tails in the post-chain so they are shared, not stacked per note."),
      code(
        'A supersaw chord mastered in its post-chain: carve, excite, then glue.',
        `const chords = synth(
  ({ note, gate, adsr, saw }) => {
    const f = note.freq
    const sup = saw(f).add(saw(f.mul(1.007))).add(saw(f.mul(0.993))).mul(0.4)
    return sup.mul(adsr(gate, { a: 0.05, d: 0.3, s: 0.8, r: 0.3 })).mul(0.4)
  },
  ({ input, eq, exciter, ott }) => {
    // 1) carve: high-pass the mud + a gentle air shelf
    const shaped = eq(input, [{ type: 'hp', freq: 200 }, { type: 'highshelf', freq: 7000, gain: 3 }])
    // 2) excite for sheen, then 3) OTT for the fat modern glue (keep it gentle)
    return ott(exciter(shaped, { amount: 0.3 }), { depth: 0.4 })
  },
)

p('chords', chord('<Fmaj9 G Em9 Am9>').sound('chords').dur(0.98))
setCps(0.5)`,
      ),
    ],
  },
  {
    id: 'samples',
    group: 'sound design',
    title: 'Samples & granular',
    blocks: [
      p("`sample(gate, 'name')` plays a loaded audio sample like an oscillator: `root` is the note it plays natural at, and it pitches from there. `vox`, `riser` and `pad` ship built in; load your own with the + button in the editor, or RECORD one on the device microphone (the record button in the same popover): the take is trimmed and normalized and lands as `mic1`, ready to play from a `beat` or `play` block, feed to `granular`, or run through the `vocoder`. `granular` sprays overlapping grains from a scannable position for evolving textures."),
      p('The same popover can also RESAMPLE the track itself, which turns anything you have already written into raw material for the next layer:'),
      list(
        [
          'Write something and press Run, so the program is playing.',
          'Tap a cycle count on the resample row (1, 2, 4 or 8). That many cycles render offline into the bank as `take1`, then `take2`, and so on.',
          "Play the take back like any other sample: `sample(gate, 'take1')` in JavaScript, `sample take1` in rondo.",
          'Chop and loop it while you build the next layer on top. Chopping a sample, next, is how you cut a take into pieces.',
        ],
        true,
      ),
      p('A take lands mono, normalized, and cut to an exact loop length so it repeats seamlessly; tails ringing past the loop end are trimmed.'),
      code(
        'A granular cloud over the built-in pad sample, with a vocal on top.',
        `const cloud = synth(
  ({ gate, adsr, granular, lfo }) => {
    const env = adsr(gate, { a: 0.6, d: 0.5, s: 0.9, r: 1.2 })
    // lfo() is an audio-rate signal; it scans the read position slowly
    return granular(gate, 'pad', { root: 60, pos: lfo(0.05).range(0, 1), size: 0.12, density: 40 }).mul(env)
  },
  ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.9, damp: 0.4 }), 0.4),
  { voices: 4 },
)
const voc = synth(({ gate, adsr, sample }) =>
  sample(gate, 'vox', { root: 57 }).mul(adsr(gate, { a: 0.03, d: 0.3, s: 0.6, r: 0.4 })))

p('cloud', chord('<Cmaj7 Am7>').sound('cloud').dur(0.98))
p('voc', note('<c4 ~ e4 ~>').sound('voc').gain(0.5))
setCps(0.3)`,
      ),
    ],
  },
  {
    id: 'chopping',
    group: 'sound design',
    title: 'Chopping a sample',
    blocks: [
      p('A sample does not have to play from the top. `start` and `end` are fractions of the buffer (0 is the very beginning, 1 the very end) and they narrow playback to a WINDOW: `{ start: 0.5 }` plays the back half, and a loop wraps inside the window instead of running to the end of the file. `reverse: true` plays that window backwards. Both compose with `speed` and `root`, so a reversed half can still be pitched.'),
      p('`slices: N` is the chopper. It divides the window into N equal pieces and hands the choice to the NOTE: `root` (60 by default) plays chop 0, the next semitone up plays chop 1, and it wraps past the last one. Each chop plays at natural speed no matter which note picked it, which is the classic chopped-breakbeat behaviour: a note pattern becomes a sequencer for the pieces of a loop. Reorder the notes and you get a new beat out of the same audio. Set `root: 36` to move the whole chop keyboard down to where your drum notes live.'),
      p('Chops start and stop mid-waveform, which would click, so every sliced voice gets a 3 ms ramp at both edges of the window. Raise it with `fade` (in seconds) for softer, more blended chops, or set `fade: 0` when you want the raw edge. Whole-buffer playback is untouched by all of this.'),
      p("This is the other half of resampling. Bounce a few cycles of your own track into `take1` from the samples popover, then chop the take: `sample(gate, 'take1', { slices: 8 })` in JavaScript, `sample take1 slices:8` in rondo, and your own music becomes the source material for the next layer."),
      table(
        'Every sample option: `sample(gate, name, { … })` in JavaScript, `sample name key:value` in rondo.',
        ['option', 'what it does', 'default'],
        [
          ['`root`', 'the MIDI note the sample plays natural at; it pitches from there, and with `slices` it selects chop 0 instead', '60'],
          ['`speed`', 'the play rate, set directly instead of tracking the note', '1'],
          ['`loop`', 'loop instead of playing once, wrapping inside the window', 'off'],
          ['`start`', 'where the window opens, as a fraction of the buffer', '0'],
          ['`end`', 'where the window closes, as a fraction of the buffer', '1'],
          ['`reverse`', 'plays that window backwards', 'off'],
          ['`slices`', 'divides the window into N chops and lets the NOTE pick one', 'off'],
          ['`fade`', 'the edge ramp in seconds, so a chop does not click', '0.003 once sliced'],
        ],
      ),
      code(
        'Eight chops of the built-in break, resequenced, over a reversed tail of the same loop.',
        `const chop = synth(({ gate, adsr, sample }) =>
  sample(gate, 'break', { slices: 8 }).mul(adsr(gate, { a: 0.001, d: 0.22, s: 1, r: 0.02 })))
// the back half of the same break, reversed and looped, as a bed
const tail = synth(({ gate, adsr, sample, svf }) =>
  svf(sample(gate, 'break', { start: 0.5, reverse: true, loop: true }), 2400)
    .mul(adsr(gate, { a: 0.02, d: 0.5, s: 0.7, r: 0.4 })).mul(0.3))

// c4 is chop 0, db4 is chop 1, on up to g4 for chop 7
p('chop', note('c4 e4 f4 g4 db4 c4 gb4 e4').sound('chop').gain(0.95))
p('tail', note('c4').slow(4).sound('tail').gain(0.8))
setCps(0.5)`,
      ),
      p('In rondo the slice options are named arguments on the `sample` line, and the note pattern in the `play` block does the chopping.'),
      rondo(
        'The same chopper as a rondo program.',
        `synth chop
  sample break slices:8
  * a
  a = adsr .001 .22 1 .02

synth tail
  sample break start:.5 reverse:1 loop:1
  svf 2400
  * a
  * .3
  a = adsr .02 .5 .7 .4

play chop
  c4 e4 f4 g4 db4 c4 gb4 e4
  gain: .95

play tail
  c4
  slow 4
  gain: .8

cps .5`,
      ),
    ],
  },
  {
    id: 'singing',
    group: 'voice & visuals',
    title: 'Singing',
    blocks: [
      p('`sing(voice, lyrics, notes)` runs a neural voice entirely on your device: it sings your `lyrics` on your `notes`, both in mini-notation, one syllable per note (a hyphen splits a word, so "twin-kle" is two notes).'),
      note('The first play downloads the voice models once. It is a large one-time download, cached afterwards, so every later play is instant. You will be asked before it starts.'),
      p('The melody is real mini-notation, so `@weights` give each note its own length: `a4@6 g4@2 a4@2` is a dotted lilt, not three equal notes. And a phrase longer than a bar sets `{ cycles: N }`: the melody unrolls over N cycles (write it as an alternation, one bar per arm), the baked clip runs N bars long, and the vocal retriggers every N bars instead of every one. That is how a whole verse fits in one block without slowing the tempo down.'),
      p("It returns an ordinary pattern, so the vocal is a first-class channel: wrap it in `p(...)` and it takes the same FX, `.late()`/`.early()` timing, and bus sends as any synth. `opts.post` adds a DSP chain on the voice itself (here a little reverb), and `opts.name` lets `bus()` / `sidechain()` target it by name. Timing is aligned to the beat automatically, so `.late()` is for feel, not fixing drift."),
      code(
        'A neural voice over a pad, one syllable per note. First play downloads the models.',
        `const pad = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq).mix(saw(note.freq.mul(1.004)), 0.5),
    adsr(gate, { a: 0.4, d: 0.6, s: 0.85, r: 0.9 }).range(0.3, 1).mul(2200), { res: 0.2 })
    .mul(adsr(gate, { a: 0.4, d: 0.6, s: 0.85, r: 0.9 })).mul(0.2))

p('pad', chord('<Cmaj7 Am7 Fmaj7 G7>').voiceLead().sound('pad').dur(0.98))

p('vox', sing('barbara',
  'lo-ver come and sing with me',
  'e4 e4 g4 g4 a4 g4 e4',
  { name: 'vox', post: ({ input, reverb, mix }) => mix(input, reverb(input), 0.22) }).gain(0.95))

setCps(0.34)`,
      ),
      p('In rondo it\'s a `sing` block, written like sheet music: each LYRIC line sits above its MELODY line (pairs join up), `voice:` goes on the header, modifiers and a `post` FX chain work like everywhere else.'),
      rondo(
        'The same vocal as a rondo sing block.',
        `synth pad
  saw
  mix wide .5
  svf cut res:.2
  * env
  * .2
  wide = saw note*1.004
  cut = env -> 660..2200
  env = adsr .4 .6 .85 .9

play pad
  <Cmaj7 Am7 Fmaj7 G7>
  voiceLead
  dur: .98

sing vox voice:barbara
  lo-ver come and sing with me
  e4 e4 g4 g4 a4 g4 e4
  gain: .95
  post
    reverb mix:.22

cps .34`,
      ),
    ],
  },
  {
    id: 'live-mic',
    group: 'voice & visuals',
    title: 'Live mic',
    blocks: [
      p('`mic` is the device microphone as a LIVE signal: run your voice through the synth graph in real time. Feed it to `vocoder` as the modulator and the synth talks; hi-pass it and it whispers; `granular`-freeze it and it smears. The mic connects only while code that uses it is playing, and the browser asks permission the first time.'),
      note('USE HEADPHONES. A speaker feeding the microphone loops into howling feedback.', 'warn'),
      note('The mic reads SILENCE in offline renders: a WAV bounce and a MIDI export both run faster than real time, so there is no live input to capture. Record the session instead when you want your voice in the file.'),
      rondo(
        'A talkbox. Press play, then talk or sing.',
        `synth talkbox
  supersaw detune:.5
  vocoder mic bands:24
  * env
  * .9
  env = adsr .02 .1 .9 .2

play talkbox
  <0 3 5 3>
  scale: a-min
  dur: .98

cps .45`,
      ),
      p("The JS spelling is `mic()`: `vocoder(supersaw(note.freq), mic(), { bands: 24 })`. The shipped 'live mic' example layers this vocoder with a breathy hi-passed copy of the raw mic for intelligibility."),
    ],
  },
  {
    id: 'visuals',
    group: 'voice & visuals',
    title: 'Visuals',
    blocks: [
      p("`visual(...)` attaches a WGSL fragment shader that renders behind the code, driven by the audio: `time`, `level`, `bass`/`mid`/`treble`, `spectrum(x)`, `waveform(x)`, and a `hit_<synth>` onset envelope per synth. Press play to hear it, then open it in the editor and toggle the visuals button to see it."),
      code(
        'A spectrum ring with a kick-driven glow.',
        `const kick = synth(({ gate, adsr, sine }) =>
  sine(adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 }).pow(2).range(45, 160))
    .mul(adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.08 })).tanh())
const bass = synth(({ note, gate, adsr, saw, ladder }) =>
  ladder(saw(note.freq), 700, { res: 0.4 })
    .mul(adsr(gate, { a: 0.005, d: 0.2, s: 0.4, r: 0.2 })))

p('kick', note('c1*4').sound('kick'))
p('bass', note('<c2 c2 g1 eb2>').sound('bass'))

visual(\`
fn render(uv: vec2f) -> vec4f {
  let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
  let r = length(p);
  let ring = smoothstep(0.04, 0.0, abs(r - (0.4 + spectrum(uv.x) * 0.2)));
  let glow = (0.1 + hit_kick * 0.2) / (r * r * 5.0 + 0.25);
  let col = vec3f(0.3, 0.8, 0.7) * ring + vec3f(0.9, 0.5, 0.7) * glow;
  return vec4f(min(col, vec3f(1.0)), 1.0);
}
\`)
setCps(0.5)`,
      ),
    ],
  },
  {
    id: 'midi-hardware',
    group: 'voice & visuals',
    title: 'Playing from hardware',
    blocks: [
      p('The midi button in the header opens the input panel. Enable MIDI, pick which synth the keys play, and a connected controller plays it live: note on and note off go straight to the engine, velocity included.'),
      p('The knobs and faders on that controller can drive your params. Every `param()` you declare, in the voice or in the post chain, shows up in the map list, and so does every rondo `knob`. Pick one, tap learn, then move the control you want it on. That control is now bound to that param.'),
      code(
        'A param with a range and a curve is exactly what a knob wants. Map cutoff, then sweep it by hand while the pattern runs.',
        `const bass = synth(({ note, gate, adsr, saw, svf, param }) =>
  svf(saw(note.freq), param('cutoff', 900, { min: 80, max: 8000, curve: 'log' }), { res: 0.3 })
    .mul(adsr(gate, { a: 0.004, d: 0.2, s: 0.6, r: 0.1 })).mul(0.5))

p('line', note('c2 c2 g2 a#2').sound('bass').ctrl('cutoff', '<600 2400>'))
setCps(0.5)`,
      ),
      table(
        'How a control change becomes a param value.',
        ['the param says', 'the knob does', 'why'],
        [
          ['`{ min: 0, max: 1 }`', 'sweeps the range evenly, 0 at the bottom and 1 at the top', 'a linear param reads the same way a linear knob turns'],
          ['`{ min: 80, max: 8000, curve: "log" }`', 'multiplies by a fixed ratio per step, so halfway is 800 Hz and not 4040 Hz', 'a log param is heard in octaves, so equal turns should be equal intervals'],
          ['nothing at all', 'the row shows as stale and the knob does nothing', 'the param is not in the tune right now'],
        ],
      ),
      p('Control changes carry 7 bits, so a knob has 128 positions across the whole range. On a log cutoff from 80 Hz to 8 kHz that is about 62 cents a step, which is fine to perform with. Controllers that send high resolution do it as a pair of messages, and the pair is used when it arrives, giving 16384 positions instead.'),
      note('A mapped knob OWNS its param. While the mapping stands, a `.ctrl` sweep on that param stands down, exactly as it does while your finger is on an inline knob. Unmap the control to give the param back to the pattern. A finger and a knob are peers: whichever moved last sets the value, and lifting the finger hands the param back to the knob rather than to the sequencer.'),
      p('Mappings are saved per project on this device, so your rig is still there after a reload. They are not part of the tune: a share link or an exported project carries the music, not your controller layout. A mapping whose param you have since renamed or deleted is kept and shown as stale, and it starts working again the moment that param comes back.'),
    ],
  },
  {
    id: 'midi-clock',
    group: 'voice & visuals',
    title: 'Playing in time with other gear',
    blocks: [
      p('The clock selector in the midi panel decides where the tempo comes from. Internal is the tune, which is what you have been using. Follow takes it from a drum machine, a groovebox, a DAW or a DJ mixer over MIDI clock. Send makes that gear follow you instead.'),
      table(
        'What each mode does.',
        ['mode', 'tempo', 'transport'],
        [
          ['internal', 'from the `bpm` or `setCps` line in the tune', 'your run and stop buttons'],
          ['follow MIDI clock', 'measured from the incoming clock, and shown live in BPM', 'starts, stops and continues with the master'],
          ['send MIDI clock', 'still from the tune', 'your run and stop are sent out, so the other gear starts with you'],
        ],
      ),
      note('While you follow, the external clock owns the tempo: a `bpm` line in the tune, and the header BPM field, are both remembered but do not take over. That is deliberate. Live coding re-evaluates constantly, and without the rule every keystroke would yank the tempo off the master mid-set. Switch back to internal and your own tempo takes effect again straight away.'),
      p('One cycle is one bar of 4/4, the same as in a MIDI export, so 120 BPM is cps 0.5. Following works the tempo out from the tick rate rather than being told it: MIDI clock sends 24 ticks a quarter note and no number. Those ticks jitter by around a millisecond, which on its own would be a 5 percent tempo wobble, so the tempo is fitted over the last two beats of them. It also watches where the master is in the bar and trims the rate by a fraction of a percent to stay there, which is what stops a set drifting apart over ten minutes.'),
      p('Everything downstream of the tempo follows too, because the followed tempo is the session tempo: a `sync` LFO stays in bars, a `sync` delay stays in beats, and a `.ctrl` sweep keeps its shape.'),
      note('Ableton Link cannot work from a browser. Link is a native protocol that speaks UDP multicast on the local network, and a web page has no way to open that kind of socket. Every browser project that claims Link is really a native helper app relaying over a WebSocket. MIDI clock is the sync a browser can genuinely do, and it is what most hardware speaks anyway.'),
      p('One thing to know when following: rondocode loops rather than running along a timeline, so there is no song position to jump to. Start begins the loop from the top of the bar, continue picks a running loop back up rather than restarting it, and stop stops.'),
    ],
  },
  {
    id: 'export',
    group: 'voice & visuals',
    title: 'Export: WAV, stems, loudness',
    blocks: [
      p('The export button in the header (next to play) writes the staged track out. Every option renders the code exactly as it stands, offline and faster than real time, from the same path the editor plays.'),
      table(
        'Five ways out of the editor.',
        ['export', 'what it carries', 'reach for it when'],
        [
          ['WAV', 'the rendered audio of N cycles, as one stereo file', 'you want the SOUND: a loop, a bounce, something to resample elsewhere'],
          ['stems (.zip)', 'one WAV per synth, plus one per send bus, in a single archive', 'the track continues in a DAW, or someone else mixes it'],
          ['MIDI (.mid)', 'the notes and nothing else: one named track per synth, `.gain` as velocity, one cycle as one bar of 4/4 at the current tempo', 'you want the ARRANGEMENT in a DAW, or sheet music in MuseScore or Dorico'],
          ['measure loudness', 'integrated LUFS and true peak of that bounce, reported, never applied', 'you are about to deliver it somewhere and need the numbers'],
          ['record session', 'the live output as it plays, microphone and knob turns included', 'the take is a PERFORMANCE, not a render'],
        ],
      ),
      p('The depth picker next to the cycle count sets what the audio is written as. It applies to the WAV, the stems and the session recording alike.'),
      table(
        'Bit depth. Sample rate is 48 kHz throughout.',
        ['depth', 'what it is', 'use it for'],
        [
          ['16-bit', 'integer PCM, the CD depth, clamped to full scale', 'sharing, uploading, anything final'],
          ['24-bit', 'integer PCM with 256 times finer steps, still clamped', 'delivering stems or a master to someone else'],
          ['32-bit float', "the render's own numbers, and anything past full scale is KEPT rather than clipped", 'the track is still being worked on somewhere else'],
        ],
      ),
      p('STEMS are the parts of the finished mix, not raw voices. Each synth stem has already been through its own post-chain, has already been ducked by any `sidechain`, and carries the same master compression and level the mix got. Add the stems back up and you get the exported WAV, sample for sample. Every shared `bus` prints as its own stem, named `<project>-bus-<name>.wav`, because a bus mixes several synths through one FX chain and cannot be split per synth honestly. Reach for stems when the track is going somewhere else to be mixed; reach for the plain WAV when it is done.'),
      note('A browser cannot write a folder, and a nine file download makes Chrome ask permission and can drop files. So stems arrive as one .zip that unpacks into a folder named after your project.'),
      p('LOUDNESS is measurement, not processing. "measure loudness" renders the same bounce and reports two numbers: INTEGRATED LUFS (ITU-R BS.1770, how loud the whole thing actually sounds, gated so silence between hits does not drag it down) and TRUE PEAK in dBTP (the highest point the waveform reaches BETWEEN samples, which is what clips a converter or an MP3 encoder even when every stored sample looks safe).'),
      table(
        'What the numbers mean when you deliver.',
        ['target', 'number', 'why'],
        [
          ['streaming', '-14 LUFS', 'Spotify, Apple Music and YouTube turn everything toward this, so anything louder just gets turned down and keeps the squashing'],
          ['club or DJ', '-9 LUFS', 'loud and dense, mastered for a big system where nothing normalizes it'],
          ['peak ceiling', '-1 dBTP', 'leaves room for the overshoot lossy encoding adds, so the file never clips on playback'],
        ],
      ),
      p('No loudness processing is applied for you: nothing is compressed or limited on the way out, and a quiet render stays quiet. The one exception is a safety scale, and it is worth knowing about when you read the numbers: if the summed mix peaks above 0.89 it is scaled DOWN to 0.89 (never up), so a hot mix measures lower than the sum of its parts. If the loudness is not where you want it, change the mix rather than the export: `.mul()` the loud synth down, or reach for `masterCompress` and the tools in "Mixing & mastering".'),
    ],
  },
  {
    id: 'midi-import',
    group: 'voice & visuals',
    title: 'MIDI import & export',
    blocks: [
      p('MIDI travels both directions. The export button writes the staged notes out as a Standard MIDI File (see "Export"), and a MIDI file from anywhere else can become rondocode.'),
      p('In a MIDI export, custom-tuning notes that fall between semitones are rounded to the nearest one, with a pitch-bend written alongside so bend-aware players still hit the exact pitch. Channels that trigger samples or sing() export their trigger notes.'),
      p('A MIDI file can be turned into an editable rondocode example deterministically: the tempo, time signature, note timing and track split come straight from the file, nothing is guessed. Run the importer from the repo: `pnpm tsx packages/server/scripts/midi-to-rondocode.ts song.mid "my song"`. It picks a synth per track, derives setCps from the tempo, and prints an example you can paste here and edit.'),
      p('Imported patterns read like anything else you would write: a held note uses an `@` weight (on a 1/16 grid, `@16` is a whole bar), chords become stacked voice lines, and each track routes to its own synth. This is a small hand-written example in that same shape.'),
      code(
        'The shape of imported code: held notes with @, chords as stacked voices.',
        `const keys = synth(({ note, gate, adsr, tri, sine, svf }) =>
  svf(tri(note.freq).mix(sine(note.freq.mul(2)), 0.28),
    adsr(gate, { a: 0.004, d: 0.5, s: 0.2, r: 0.3 }).range(0.3, 1).mul(3600), { res: 0.2 })
    .mul(adsr(gate, { a: 0.004, d: 0.5, s: 0.2, r: 0.3 })).mul(0.4))
const bass = synth(({ note, gate, adsr, saw, sine, svf }) =>
  svf(saw(note.freq).mix(sine(note.freq.mul(0.5)), 0.5), 1600, { res: 0.2 })
    .mul(adsr(gate, { a: 0.006, d: 0.18, s: 0.75, r: 0.1 })).mul(0.5))

p('imported', stack(
  stack(
    note('<[c4@8 b3@8] [a3@8 d4@8]>').sound('keys'),
    note('<[e4@8 d4@8] [c4@8 f#4@8]>').sound('keys'),
  ),
  note('<[c2@8 ~@8] [d2@8 ~@8]>').sound('bass'),
))
setCps(0.5333)`,
      ),
      p('For a clean DAW MIDI, one-synth-per-track is faithful. For a noisy transcription whose instrument labels flicker, pass `--by-register` so notes are grouped by pitch (bass / keys / lead) and play continuously instead of parts popping in and out.'),
    ],
  },

  /* ---- THE RONDO LANGUAGE ------------------------------------------------ *
   * The terse, phone-first language that transpiles to the JS above. Every
   * snippet here is REAL rondo: it compiles + evals in content.test.ts and
   * plays from this page (the ▶ transpiles first). Snippets are mobile-
   * formatted: short lines, comments on their own line. */
  {
    id: 'rondo-intro',
    title: 'rondo: the language',
    group: 'the rondo language',
    blocks: [
      p('rondocode speaks two languages. Everything above is the JAVASCRIPT language, the full API. `rondo` is the second: a terser language made for phones, with no braces, no arrows, no quotes. It compiles to the same JavaScript API, so it can do everything JS can (and anything not yet in the syntax passes through a `js` escape hatch).'),
      p('Flip the editor between them with the `js | rondo` toggle in the header. The toggle CONVERTS your code both ways: rondo compiles to JavaScript, and JavaScript decompiles back to rondo (anything the decompiler cannot express survives verbatim inside `js` blocks, so conversion never loses code). Each project remembers its language, share links carry it, and phones start new projects in rondo.'),
      p('Two ideas carry the whole language. A synth is a PIPELINE: one stage per line, each line feeding the next, source then filter then amp, like a modular patch. And modulation lives in `name = …` BINDINGS beside the pipe; envelopes and knobs are CV, not plumbing. Comments start with `#`. Indentation is two spaces and delimits blocks.'),
      rondo(
        'The acid line from the top of this page, in rondo.',
        `synth acid
  saw + square note/2
  ladder cutoff * env^2 res:.85
  * env
  env    = adsr .003 .2 .3 .1
  cutoff = knob 800 80..8000 log

play acid
  0 0 3 5 0 0 7 5  scale:a-min
  cutoff: sine 200..2400 slow:4

cps .6`,
      ),
    ],
  },
  {
    id: 'rondo-synth',
    title: 'rondo: synth blocks & the pipeline',
    group: 'the rondo language',
    blocks: [
      p('A `synth NAME` block is a signal pipeline. Four kinds of body line, read top to bottom: the FIRST expression line is the source. A line starting with an OPERATOR (`* env`, `+ sub`, `- 1`) applies it between the running signal and the expression. A line starting with a PROCESSOR name (`ladder`, `svf`, `delay`, `shape`, `reverb`, …) takes the running signal as its input, then its own arguments. And a bare SIG-OP transforms in place: `tanh` saturates, `clip -1 1` hard-clips, `mix other .3` crossfades with another signal.'),
      p('Expressions use `+ - * / ^` with ordinary precedence (`^` binds tightest, then `* /`, then `+ -`). `note` is the note frequency in Hz, `gate` the envelope gate, `velocity` the note velocity, and inside a post chain `input` is the summed voice signal. `x -> lo..hi` maps a 0..1 signal into a range: `lfo 4 tri -> 200..3000` is a wobble. Number literals fold: `2 * 3` compiles to `6`, and `1 - env` rewrites algebraically.'),
      p('Arguments are space-separated. Word arguments go bare where the builtin declares them (`noise pink`, `svf 900 mode:hp`, `shape 2 type:tube`); `key:value` pairs are named options, and unknown names are compile errors, never silent drops. Sources: `saw square sine tri pulse supersaw fm noise lfsr wavetable syncsaw`, plus the gated ones `sample granular pluck modal`, plus `mic`: the LIVE microphone as a signal (vocode it, filter it; headphones advised, and it renders silent in offline exports). An oscillator (or pluck/modal) with no frequency argument plays the note.'),
      note("A call SWALLOWS the rest of its line. `adsr .002 .08 .2 bright/12300` compiles to `adsr(...) / 12300`, dividing the whole ENVELOPE rather than the last argument, and the sound goes quiet with nothing to see in the code. Same for `ladder sine 2 * 3800`, which filters with `sine(2 * 3800)`. The rule is simple: an operator after a call binds to the CALL. Bind the value on its own line first (`rel = bright / 12300`), then pass the name (`adsr .002 .08 .2 rel`), and it reads the way you meant it."),
      p('Math ops are sigops too, so they read the same way: on the spine `abs` or `min .8` applies to the running signal, and in a binding the input comes first (`a = floor wob`, `b = mod wob .25`). The full set is `abs ceil cos exp floor log round sign sin sqrt` with no arguments, and `min max mod` with one.'),
      p('Three builtins have special shapes. `eq hp 170 peak 300 -3 2 highshelf 7000 4` is the parametric EQ: each band is a type word then freq [gain] [q]. `vocoder mod bands:20` makes the pipe the carrier and `mod` the voice. And in bindings, `e = env .005 1 .15 .4 release:.3 curve:3` is the breakpoint envelope, flat time/level pairs, the flexible cousin of `adsr`.'),
      p('`sync:1` turns a rate MUSICAL instead of absolute. `cut = lfo .25 tri sync:1 -> 150..3200` is a quarter-note wobble: the number is a length in cycles, so `1` is one sweep per cycle, `.125` an eighth, `.0625` a sixteenth. `delay .1875 .25 sync:1` is the dotted-eighth echo. Both read `cps` live, so changing the tempo re-rates them mid-note. Leave `sync:1` off and the lfo rate is Hz and the delay time seconds, which is what you want for a tremolo or a fixed slapback. `maxtime:` still sizes the delay buffer in SECONDS and caps a synced time, so raise it for long musical delays at slow tempos.'),
      p('Voice options sit on the HEADER, after the name: `synth bass mono glide:.08` is the 303 mono-glide, `synth lead unison:5 detune:14 spread:.9` is a wide supersaw. They are the same options as the JavaScript `synth(fn, post, opts)` object.'),
      table(
        'Voice options, on the `synth` header.',
        ['option', 'what it does', 'typical'],
        [
          ['`mono`', 'one voice that slides from note to note instead of stacking them', '303 bass and leads'],
          ['`glide:`', 'how long that slide takes, in seconds', '`.05` to `.12`'],
          ['`unison:`', 'how many detuned copies play per note', '`3` to `7`'],
          ['`detune:`', 'how far apart those copies sit, in cents', '`10` to `20`'],
          ['`spread:`', 'how wide across the stereo field they sit, 0 to 1', '`.8`'],
          ['`curve:`', 'above 1 pulls the inner voices back toward the note', '`2`'],
          ['`blend:`', 'gain of the outermost voices, 0 to 1', '`.7`'],
          ['`octaves:`', 'every nth voice plays an octave up', '`2`'],
          ['`humanize:`', 'per-voice pitch and timing offsets, up to 8 cents and 14 ms at 1, hashed from the voice and the note so the render still repeats exactly', '`.3` to `.5`'],
          ['`voices:`', 'polyphony: how many notes may ring at once', '`8` to `12`'],
        ],
      ),
      rondo(
        'Source, filter, drive, delay, VCA, saturation.',
        `synth growl
  supersaw detune:.5 mix:.85
  + square note/2
  ladder cut res:.8
  shape 2.2 type:tube
  delay .375 .25
  * env
  tanh
  cut = lfo 4 tri -> 150..3200
  env = adsr .005 .1 .9 .06

play growl
  0 0 ~ 0 0 ~ 3 2  scale:e-min
  dur: .9

cps .55`,
      ),
      p("`wavedef NAME …` designs a custom wavetable for the `wavetable` oscillator: each `/`-separated frame is a list of harmonic partial amplitudes (harmonic 1, 2, 3, …), and the oscillator's `pos` argument morphs between the frames. Reference it with `table:NAME` anywhere in the file; the line renders as a touch editor (tap a frame, drag the partial bars, `+` adds a harmonic) and every drag rewrites the numbers, so the text stays the whole truth. The synth line below it shows the morph live, sweeping with each note."),
      p("You don't have to draw a table by hand: in the samples popover, every sample row has a wave button that FFT-resynthesizes that recording (mic take, resampled bounce, loaded file) into a `wavedef` line appended to your code. And `warp:` bends how a cycle reads ANY table: `wavetable note scan warp:sync warpamt:.7` re-runs the cycle faster and wraps (the hard-sync tear), `warp:bend` bows the phase curve, `warp:mirror` reflects it at the midpoint. `warpamt` (0..1, default .5) takes a signal, so an envelope can sweep the tear open note by note."),
      rondo(
        'A custom vowel-ish table, scanned by the envelope.',
        `wavedef vowel 1 .25 / .4 1 .5 / .3 .8 1

synth ooh
  wavetable note scan table:vowel
  * env
  env = adsr .005 .12 .8 .15
  scan = env -> .1...9

play ooh
  0 3 5 7  scale:a-min
  dur: .85

cps .5`,
      ),
    ],
  },
  {
    id: 'rondo-bindings',
    title: 'rondo: bindings, knobs & envelopes',
    group: 'the rondo language',
    blocks: [
      p('`name = expression` lines are modulation. They can appear anywhere in the block and reference each other freely; the compiler orders them by dependency (a cycle is a compile error). A binding may reuse a builtin name (`lfo = sine 2 -> 0..1`) as long as the chain does not also call that builtin, and the special refs (`note`, `gate`, `input`, `velocity`, `adsr`, `knob`) can never be binding names.'),
      p('`adsr a d s r` is the classic envelope and renders as a DRAGGABLE CURVE spanning the editor width: pull the attack, decay/sustain, and release handles. `env t lvl t lvl … release:… curve:… loop:1` is the breakpoint envelope for anything more elaborate. `knob DEF lo..hi [log]` declares a live param rendered as a DIAL: turn it and the DEF number in the text follows; patterns drive it with `name: …` modifier lines, and while a pattern drives it the dial and its readout glide along with the sweep.'),
      p('Every plain number in the buffer is scrubbable: touch it and drag SIDEWAYS to change it, vertical still scrolls. That includes ranges, euclid pulses, polymeter steps, everything.'),
      rondo(
        'A knob-driven wobble rate: turn the dial while it plays.',
        `synth wub
  saw
  ladder cut res:.75
  * env
  cut  = lfo rate tri -> 200..2600
  rate = knob 4 .5..16
  env  = adsr .004 .1 .85 .06

play wub
  0 ~ 0 3  scale:e-min

cps .5`,
      ),
    ],
  },
  {
    id: 'rondo-play',
    title: 'rondo: play blocks & notation',
    group: 'the rondo language',
    blocks: [
      p('A `play NAME` block routes notation to a synth, and NAME is also the channel (`sidechain` and `bus` target it). The FIRST body lines are notation; everything after the first modifier line is modifiers. What the notation means depends on how it is written: bare digits are scale degrees (`0 3 5` with a `scale:`), lowercase letters are note names (`c2 e2 g2`), and an UPPERCASE root means chord names (`<Em Cmaj7 G>`).'),
      p('The scale can sit inline (`0 3 5  scale:a-min`) or on its own modifier line (`scale: a-min`). Degrees resolve through it, so changing `a-min` to `c-maj` moves the whole part, and tapping the scale chip in the palette CYCLES the block through the modes, so you can hear what dorian does without typing it. Note names (`c4 f#4`) are always chromatic, scale or no scale.'),
      table(
        'Mode names. rondo takes the short form; the JavaScript `.scale()` name is the full one.',
        ['short', 'full name', 'the color it gives'],
        [
          ['`maj`', 'major', 'the bright default'],
          ['`min`', 'minor', 'the dark default'],
          ['`dor`', 'dorian', 'minor with a raised 6th: folk, funk, house'],
          ['`phr`', 'phrygian', 'minor with a flat 2nd: spanish, metal'],
          ['`lyd`', 'lydian', 'major with a raised 4th: floating, filmic'],
          ['`mix`', 'mixolydian', 'major with a flat 7th: blues, rock'],
          ['`loc`', 'locrian', 'diminished and unsettled, rarely a home key'],
          ['`pentatonic`', 'pentatonic', 'five notes, nothing clashes'],
          ['`minorpentatonic`', 'minorPentatonic', 'the blues box'],
          ['`chromatic`', 'chromatic', 'degrees 0..11 are the whole 12-tone set'],
        ],
      ),
      p('CUSTOM TUNINGS: a top-level `scaledef NAME steps...` line registers your own scale, steps in semitones from the root, floats welcome (`scaledef pelog 0 1.2 2.7 6.7 7.85`), and any `Nedo` mode divides the octave into N equal steps with no scaledef at all. Both work anywhere a scale name does: `scale: c-pelog`, `scale: c-19edo`.'),
      p('EXTRA notation lines before the modifiers stack as voices, one line per voice: a hand-built chord. Voices of different lengths cross-rhythm automatically, because every line spans exactly one cycle.'),
      p('`irand 8 seg:16` as a notation line plays random scale degrees 0..7, sixteen steps per cycle: a deterministic improviser (the same riff at the same spot every loop). The whole line pulses with the playhead while it sounds.'),
      rondo(
        'Three stacked voices, one chord progression.',
        `synth pad
  supersaw detune:.3 mix:.6
  * env
  env = adsr .2 .4 .8 .8

play pad
  <0 5 2 6>
  <2 7 4 8>
  <4 9 6 10>
  scale: c-min
  dur: .95
  gain: .5

cps .4`,
      ),
      rondo(
        'A custom five-step tuning, defined in one line.',
        `scaledef pelog 0 1.2 2.7 6.7 7.85

synth glass
  tri
  * env
  env = adsr .005 .4 .2 .4

play glass
  0 1 2 4 <3 5> 2 1 0
  scale: c-pelog

cps .45`,
      ),
    ],
  },
  {
    id: 'rondo-mini',
    title: 'rondo: mini-notation',
    group: 'the rondo language',
    blocks: [
      p('Notation lines are MINI-NOTATION, passed to the pattern engine verbatim, so the whole vocabulary applies. Alternations of different lengths phase against each other, and subgroups nest as deep as you like.'),
      table(
        'The whole operator vocabulary. It is the same in both languages.',
        ['symbol', 'what it does', 'example'],
        [
          ['`a b c`', 'steps, splitting the cycle evenly', '`0 3 5 7`'],
          ['`~`', 'a rest: a silent step', '`0 ~ 3 ~`'],
          ['`_`', 'holds the previous step for another step', '`0 _ 3 _`'],
          ['`[ ]`', 'a subgroup squeezed into one step', '`0 [3 5]`'],
          ['`[a,b]`', 'stacked at the same instant: a chord in one step', '`[0,3,7]`'],
          ['`< >`', 'one arm per cycle', '`<0 3 5>`'],
          ['`{…}%n`', 'polymeter: n steps per cycle, whatever the length', '`{0 3 5}%8`'],
          ['`*n`', 'n repeats fitted INTO the step', '`0*2`'],
          ['`/n`', 'one step stretched across n cycles', '`0/2`'],
          ['`!n`', 'the step repeated n times', '`0!3`'],
          ['`@n`', "the step given n steps' worth of time", '`0@3 5`'],
          ['`(p,s,r)`', 'a euclidean rhythm, r rotating the hits', '`0(3,8)`'],
          ['`?`', 'drops the step at random (seeded per cycle)', '`0 3? 5`'],
          ['`|`', 'picks one alternative per cycle', '`0 | 5`'],
        ],
      ),
      p('Two rhythm generators: `0(3,8)` is a EUCLIDEAN rhythm, 3 hits spread as evenly as 8 steps allow (the tresillo). Add a rotation with `(3,8,2)`. `{0 3 5}%8` is POLYMETER: the figure steps at 8 per cycle regardless of its own length, so it rotates against the bar and comes back around.'),
      p('One difference from other dialects: `.` is not a grouping shorthand here (it belongs to decimals and note spellings). Use brackets.'),
      p('The editor draws what it can. A simple degree line is a TAPPABLE GRID. A `{…}%n` polymeter figure gets the same editable grid, scoped to the braces, with the `%n` left as a scrubbable number. Rich single-cycle lines (euclid, nesting) render a compact read-only preview roll with a sweeping playhead, and when the line has exactly one euclid group the preview roll becomes a CONTROL SURFACE: drag it up and down to add or remove pulses, sideways to rotate the hits. A MULTI-CYCLE line (a `<…>` alternation spanning several bars) renders a full-width clip overview below the line instead: every bar of the repeating figure side by side, with the playhead riding through the correct bar as the alternation advances. Patterns with no honest picture (they never settle into a repeating period, or they would need too many cells) draw nothing at all. Both roll forms carry a narrow grab strip on their left edge: drag it up or down to transpose the whole pattern, one roll row per scale degree, written into the block as an `add N` line.'),
      rondo(
        'Polymeter bells drifting over a euclidean bass.',
        `synth bell
  modal model:bell decay:.35
  * env
  env = adsr .001 .12 0 .1

synth bass mono glide:.05
  saw
  onepole 700
  * env
  tanh
  env = adsr .005 .1 .6 .08

play bell
  {0 3 5 7 9}%8
  scale: a-min
  dur: .5

play bass
  0(5,8)
  scale: a-min
  add -7

cps .55`,
      ),
    ],
  },
  {
    id: 'rondo-beat',
    title: 'rondo: beat blocks (the drum machine)',
    group: 'the rondo language',
    blocks: [
      p('A `beat` block is the drum line: its notation words ARE synth names, each word an event routed straight to that synth. The block takes an optional channel name (`beat fills`) and the same modifiers as `play`. All mini-notation applies to the words too (`kick*4`, `[~ hat]*3`, euclid, alternation).'),
      p('A `kick:.6` suffix sets that step’s velocity. It compiles to a per-voice gain pattern, so every stacked row keeps its own accents.'),
      p('Simple rows (one word plus rests) render as a STEP SEQUENCER: one widget per block, instrument labels on the left, lanes aligned in musical time (a 4-step row’s cells are twice as wide as an 8-step row’s, so downbeats line up). Tap a cell to place a hit; drag across cells, and across rows, to paint; tap an active step to cycle its velocity full, soft, ghost, off; or drag an active step UP and DOWN to scrub its velocity continuously. Erasing a row’s last hit keeps the instrument as a `# word` comment so the lane survives.'),
      rondo(
        'A kit in one block. Tap the grid.',
        `synth kick
  sine drop
  * amp
  tanh
  drop = adsr .001 .09 0 .05 ^ 2 -> 45..160
  amp = adsr .001 .2 0 .07

synth hat
  noise
  svf 7500 mode:hp
  * env
  env = adsr .001 .03 0 .01

beat
  kick ~ kick ~ kick ~ kick ~
  ~ hat:.6 ~ hat ~ hat:.6 ~ hat

cps .55`,
      ),
    ],
  },
  {
    id: 'rondo-modifiers',
    title: 'rondo: modifiers',
    group: 'the rondo language',
    blocks: [
      p('Lines under the notation shape the pattern. `gain: dur: pan:` are the note controls. Any other `name: value` drives that synth param through `.ctrl`. Values come in three kinds: a NUMBER (`gain: .8`), a MINI pattern (`depth: <1 2.5>` changes per cycle), or a SIGNAL (`cutoff: sine 200..2400 slow:4` sweeps continuously; `wet: rise 8` ramps a build over 8 bars, `fall 8` drains one).'),
      p('Signal-driven lines apply in ABSOLUTE time no matter where you write them: `every 4: rev` remixes the notes and never runs the sweep backwards. Number and mini values keep their written order, so step-tied accents travel with the notes they decorate.'),
      p('Bare combinators chain directly: `rev`, `fast 2`, `slow 2`, `euclid 3 8`, `struct ~ t ~ t`, `arp updown`, `ply 2`, `swing`, `degradeby .3`, `add -7`, `octave 1`, `linger .25`, `palindrome`, and friends. Function-taking combinators use a colon: `every 4: rev`, `jux: rev` (left dry, right transformed), `off .25: gain .3` (an echoing copy), `superimpose: late .125`, `sometimesby .3: fast 2`, `chunk 4: fast 2`.'),
      rondo(
        'A line that remixes itself.',
        `synth keys
  tri
  + shim * .2
  * env
  shim = sine note*2
  env = adsr .004 .3 .3 .3

play keys
  0 3 5 7 <10 12> 7 5 3
  scale: c-min
  every 4: rev
  jux: fast 2
  gain: .8

cps .45`,
      ),
    ],
  },
  {
    id: 'rondo-sing',
    title: 'rondo: sing blocks',
    group: 'the rondo language',
    blocks: [
      p('A `sing NAME` block is a neural vocal, written like sheet music: each LYRIC line sits above its MELODY line, and the pairs join up. Hyphens split a word into syllables, one syllable per note. `voice:` goes on the header (`barbara`, `kizuna`, `rise`; omit it for the default). NAME is the channel, so buses and sidechain can target the vocal.'),
      p('Modifier lines work as in `play` (`gain: .95`), and a trailing `post` sub-block puts FX on the voice itself. Melodies are absolute note names, so `scale:` does not apply here. The first play downloads the voice models once (cached afterwards) and the vocal bakes in the background, looping in time when ready.'),
      p('Melody lines take `@weights` like any mini notation (`a4@6 g4@2` is a dotted pair), and `cycles: N` makes the phrase span N bars: write the melody as an alternation with one bar per arm, and the vocal bakes as an N-bar clip that retriggers every N bars. A whole verse becomes one block at the tune\'s own tempo.'),
      rondo(
        'A verse in one block. First play downloads the voice.',
        `synth pad
  saw
  mix wide .5
  svf cut res:.2
  * env
  * .2
  wide = saw note*1.004
  cut = env -> 660..2200
  env = adsr .4 .6 .85 .9

play pad
  <Cmaj7 Am7 Fmaj7 G7>
  voiceLead
  dur: .98

sing vox voice:barbara
  lo-ver come and sing with me
  e4 e4 g4 g4 a4 g4 e4
  gain: .95
  post
    reverb mix:.22

cps .34`,
      ),
    ],
  },
  {
    id: 'rondo-post',
    title: 'rondo: post chains & buses',
    group: 'the rondo language',
    blocks: [
      p('A `post` sub-block at the end of a synth runs ONCE over the summed voices (stereo-decorrelated), the right home for space and glue: `reverb room:.85 mix:.3` blends wet over dry, `chorus`, `eq`, `exciter`, `ott`, `compress` all chain the same way, folding from the implicit `input`. A `knob` declared in a post chain is a drivable post param: `wet: …` on the pattern automates it.'),
      p('A `bus NAME` block is a SHARED effect: its lines fold from `input` exactly like a post chain, and `send SYNTH AMT` lines route synths in (0..1, pre-fader). One reverb for the whole kit instead of one per synth.'),
      rondo(
        'A mono glide bass with a drivable post reverb.',
        `synth bass mono glide:.07
  saw
  onepole 500
  * env
  tanh
  env = adsr .006 .15 .7 .08
  post
    reverb room:.7 mix:wet
    wet = knob .2 0..0.6

play bass
  0 0 3 0 5 0 3 2  scale:e-min
  wet: rise 4 0..0.5

cps .5`,
      ),
    ],
  },
  {
    id: 'rondo-track',
    title: 'rondo: sections, song & the mix bus',
    group: 'the rondo language',
    blocks: [
      p('Full tracks: a `section NAME LEN` holds `play` and `beat` blocks, LEN in cycles; `song intro drop drop intro` sequences the sections (omit `song` to play them in definition order). Note-flash and grids keep working inside sections.'),
      p('`sidechain kick depth:.8 release:.12 sub:.95` is the pump: every kick ducks the other channels, and extra `name:amount` pairs set per-channel duck depth. `master threshold:-6 ratio:2 makeup:1` is the glue compressor on the mix bus.'),
      p('Tempo is one line, in either unit: `bpm 128` is the unit you count in, `cps .5333` the engine unit. One cycle is one BAR of 4 beats, so multiplying cps by 240 gives bpm, and the two lines above are the same tempo. The unit you write is the unit that stays: switching a track to JavaScript and back keeps `bpm 128` as `bpm 128`. MIDI import and export share the convention, so an imported file keeps its tempo and one cycle stays one bar.'),
      table(
        'Tempos you already know, in both units.',
        ['bpm', 'cps', 'where it lives'],
        [
          ['`bpm 90`', '`cps .375`', 'hip hop, downtempo'],
          ['`bpm 120`', '`cps .5`', 'the round number'],
          ['`bpm 128`', '`cps .5333`', 'house, techno'],
          ['`bpm 140`', '`cps .5833`', 'dubstep at half time'],
          ['`bpm 174`', '`cps .725`', 'drum and bass'],
        ],
      ),
      p('A `visual` block holds a WGSL fragment shader, verbatim, the same contract as the JS `visual(...)`: audio-reactive uniforms (`level`, `bass`, `spectrum(x)`, per-synth `hit_*`) drive a shader behind the code.'),
      rondo(
        'A miniature arrangement: intro, drop, out.',
        `synth kick
  sine drop
  * amp
  tanh
  drop = adsr .001 .09 0 .05 ^ 2 -> 45..160
  amp  = adsr .001 .2 0 .07

synth stab
  supersaw detune:.4 mix:.7
  ladder cut res:.6
  * env
  cut = env ^ 2 -> 300..3400
  env = adsr .002 .16 0 .09

section intro 4
  play stab
    <Em Em Cmaj7 G>
    dur: .95
    gain: .4

section drop 8
  play kick
    c2 c2 c2 c2
  play stab
    <Em Em Cmaj7 G>
    struct ~ t ~ t t ~ ~ t
    dur: .2
    gain: .6

song intro drop drop intro

sidechain kick depth:.8 release:.15 stab:.6

master threshold:-6 ratio:2 makeup:1

bpm 132`,
      ),
    ],
  },
  {
    id: 'editing',
    group: 'start here',
    title: 'Editing: touch, keys, tidy',
    blocks: [
      p('EVERY NUMBER IS A CONTROL. Drag one sideways to scrub it (hold Alt with a mouse); the value follows your finger and the code rewrites as it moves, so what you hear and what is written never disagree. On touch, press and hold first: the value floats above your finger in a lens, because a fingertip covers the very digits it is changing.'),
      p('While you drag, the VERTICAL axis picks the step size. Near the line you get normal speed; drag UP for x10 then x100, so a cutoff can sweep from 80 to 8000 in one gesture; drag DOWN for a tenth then a hundredth, for the last two decimal places. The lens shows the active tier, and crossing tiers never jumps the value.'),
      p('KEYS: `Cmd/Ctrl + Enter` runs (and hot-updates a running program), `Cmd/Ctrl + .` stops, `Cmd/Ctrl + /` comments a line or selection, and `Cmd/Ctrl + Shift + F` formats the whole document in either language. `Cmd/Ctrl + click` a name to jump to its definition: a binding jumps within its synth, a name in a play or beat block jumps to the synth, a song name to its section, a `table:` or `scale:` to its wavedef or scaledef. On a phone the chip bar at the bottom carries undo, redo, comment and format, so none of it needs a keyboard.'),
      p('The formatter is deliberately conservative: it fixes indentation and spacing, never rewraps your notation or touches an escape hatch, and it can never change what your code compiles to. Turn on "format on newline" in options if you would rather it tidy each line as you leave it.'),
    ],
  },
  {
    id: 'rondo-widgets',
    title: 'rondo: live controls in the code',
    group: 'the rondo language',
    blocks: [
      p('Rondo code grows CONTROL SURFACES inline. Nothing is hidden in a panel: the widget sits on the line that made it.'),
      note("The controls are not a rondo feature -- they read the SOURCE, so they work in JavaScript too, on the same code they always described. `param('cut', 900, { min: 100, max: 8000 })` grows a dial, `adsr(gate, { a: 0.005, ... })` and `env(gate, [[0.005, 1], ...])` grow envelopes, `n('0 3 5 7')` a grid, `stack(s('kick ~ kick ~'), ...)` a step sequencer, `svf(x, 900, { res: 0.4 })` grows a response curve, and a quoted enum like `{ mode: 'lp' }` cycles on a tap. A gesture writes back inside the string or the array literal it came from. A filter line grows its own response curve, in either language. A test compiles a rondo program and requires both scanners to find the same widgets, so the two cannot drift apart quietly."),
      table(
        'The inventory: what you write, and what it becomes.',
        ['in the code', 'the control it grows'],
        [
          ['a `knob` binding', 'a dial. Drag to set it. A pattern-driven dial glides with the sweep and shows a live readout, and grabbing it overrides the drive until you let go.'],
          ['an `adsr` binding', 'a full-width draggable envelope: pull the attack, the decay and sustain, the release.'],
          ['an `env` breakpoint list', 'a shape with a handle per point. Drag a handle to move that point in time and level; drag the SEGMENT between two of them to bend it, up for fast-then-slow. Bending writes the third number, adding it if the point had none.'],
          ['a simple degree line', 'a tappable piano-roll grid.'],
          ['a `{…}%n` figure', 'the same grid, scoped to the braces, with the `%n` left as a scrubbable number.'],
          ['`beat` rows', 'a step sequencer: paint across cells and rows, tap an active step to cycle its velocity, drag one up and down to scrub velocity. In JavaScript the same grid comes from `stack(s(\'kick ~ kick ~\'), ...)`, and velocity is written into the parallel `.gain()` pattern rather than inline.'],
          ['a single-euclid line', 'a preview roll that takes drags: up and down for pulses, sideways to rotate the hits.'],
          ['a multi-cycle line', 'a full-width clip overview below it, every bar of the figure side by side, the playhead riding the right one.'],
          ["a preview roll's left edge", 'a grab strip: drag it up or down to transpose the whole pattern, written back into the block as an `add N` line.'],
          ['any plain number', 'a slider: drag it sideways.'],
          ['an enum word', 'a soft underline. Noise colors, filter modes, shape and warp types, table names: tap one to cycle it to the next legal value.'],
          ['`svf` `ladder` `dualsvf` `eq`', 'the exact frequency response. Drag a handle sideways for cutoff or band frequency, vertically for res or gain (signal-driven args stay handle-less).'],
          ['a `warp:` wavetable line', "a ribbon of every frame through the kernel's real phase map (the sync tear, the bend tilt, the mirror palindrome) at the written `warpamt` or its .5 default."],
          ['`unison:` above 1', 'a small fan glyph on the `synth` header, one stroke per voice at its curved detune position, stroke height following `blend`, octave voices tinted.'],
        ],
      ),
      p('The text is always the source of truth: every gesture rewrites the code (watch it change as you drag), so anything you can touch you can also type, undo, and share. Undo and redo live as chips at the left of the bottom bar, in both languages, so history is one thumb-tap away on a phone.'),
      p('While the transport runs, everything lights: notation characters flash as their notes sound (including inside `js` escapes), grids sweep a playhead, envelopes fire a marker per note, and lines built from signals (like `irand`) pulse whole.'),
      p('For playing live, the PERFORMANCE LOCK (the padlock in the header) freezes the text while every widget stays live: a stray tap cannot place a caret, open the keyboard, or convert the buffer, but knobs, grids, scrubs, undo and redo all keep working. Tap it again to edit.'),
    ],
  },
  {
    id: 'rondo-escape',
    title: 'rondo: the escape hatch & parity',
    group: 'the rondo language',
    blocks: [
      p('ANYTHING the syntax lacks passes through the escape hatch: `js{ … }` inline is a raw JavaScript expression (inside a synth it sees the ctx names it mentions), and a top-level `js` block is raw statements, verbatim. That is the parity guarantee: everything the JS API can say, rondo can say today. Mini strings inside escapes still flash with the playhead.'),
      p('The other direction holds too: switching the editor to rondo DECOMPILES JavaScript into rondo, and whatever cannot be expressed stays wrapped in `js` blocks rather than being dropped. Round trips are exact: compile then decompile then compile again produces identical JavaScript.'),
      rondo(
        'A rondo synth with a js-block pattern beside it.',
        `synth harp
  pluck decay:3.5
  * .8

play harp
  0 3 5 7  scale:d-dor

# any JS statements, verbatim
js
  p('extra', n('7 ~ 12 ~').scale('d dorian').sound('harp').gain(0.4))

cps .5`,
      ),
      table(
        'Cheat sheet: every block shape in the language.',
        ['shape', 'what it is'],
        [
          ['`synth NAME [mono glide:… unison:…]`', 'a voice, built from pipeline lines: a source, then `* env`, a processor, a sig-op'],
          ['`name = expr`', 'a binding: an envelope, an LFO, a knob, any CV beside the pipe'],
          ['`knob DEF lo..hi [log]`', 'a live param, rendered as a dial'],
          ['`post`', 'a chain run once over that synth’s summed voices'],
          ['`play NAME`', 'notation lines, extra lines as voices, `scale:`, then modifier lines'],
          ['`beat [NAME]`', 'drum rows whose words ARE synth names (`word:v` sets that step’s velocity)'],
          ['`sing NAME voice:…`', 'lyric and melody line pairs, plus an optional `post`'],
          ['`section NAME LEN` + `song …`', 'the arrangement: blocks per section, then the section order'],
          ['`bus NAME` + `send SYNTH AMT`', 'one shared effect, fed by several synths'],
          ['`sidechain SRC depth:… name:duck`', 'the pump: one source ducking the other channels'],
          ['`master name:value`', 'the glue compressor on the mix bus'],
          ['`scaledef NAME steps…`', 'a custom tuning, in semitones from the root'],
          ['`wavedef NAME …`', 'a custom wavetable, as frames of harmonic amplitudes'],
          ['`visual`', 'a WGSL fragment shader behind the code'],
          ['`js{ … }` and `js`', 'the escape hatch: a raw JavaScript expression, or raw statements'],
          ['`cps N` and `bpm N`', 'the tempo: cycles per second, or beats per minute (one cycle is one 4-beat bar)'],
          ['`# …`', 'a comment'],
        ],
      ),
    ],
  },
]

/* ---- the cookbook -------------------------------------------------------- *
 * Recipes become ordinary Sections rather than a parallel content type, so
 * they inherit the nav, the search index, the "open in editor" deep link and
 * the llms.txt export without any of it being written twice. What makes them
 * recipes is the SHAPE, which cookbook.ts owns and cookbook.test.ts enforces:
 * one complete program that is proven to run, plus the single move that makes
 * it work.
 * -------------------------------------------------------------------------- */

/** One recipe as a guide section: the code first, because that is what you
 *  came for, then the one move as a callout. The tags ride in the caption so
 *  the search index finds a recipe by words its title never uses. */
export const recipeSection = (r: Recipe): Section => ({
  id: `recipe-${r.id}`,
  group: 'cookbook',
  title: r.title,
  blocks: [rondo(r.tags.join(' \u00b7 '), r.code), note(r.why)],
})

for (const r of RECIPES) SECTIONS.push(recipeSection(r))
