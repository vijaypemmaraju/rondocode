/* ------------------------------------------------------------------------- *
 * The hand-written guide: short sections, each ending in a COMPLETE program
 * you can hear. Every snippet defines its own synth so pressing play always
 * makes sound and every block is copy-paste ready. Signatures here match
 * dsl-docs.ts.
 * ------------------------------------------------------------------------- */

export interface Block {
  kind: 'p' | 'code'
  /** paragraph text (kind 'p') or program source (kind 'code') */
  text: string
  /** short caption shown above a code block */
  caption?: string
  /** code language: omitted = JavaScript; 'rondo' = the rondo language
   *  (rendered with rondo highlighting, transpiled before play). */
  lang?: 'rondo'
}

export interface Section {
  id: string
  title: string
  /** nav group heading; consecutive sections sharing one render under it. */
  group: string
  blocks: Block[]
}

const p = (text: string): Block => ({ kind: 'p', text })
const code = (caption: string, text: string): Block => ({ kind: 'code', caption, text })
/** a runnable RONDO-language block (transpiled before play). */
const rondo = (caption: string, text: string): Block => ({ kind: 'code', caption, text, lang: 'rondo' })

export const HERO = {
  title: 'rondocode',
  tagline: 'Live-codeable synths and mini-notation patterns, in your browser.',
  blurb:
    'There are two kinds of code here: synths, which turn oscillators, filters, and envelopes into a sound, and patterns, which trigger those sounds in time. And two languages to write them in: JavaScript (the full API, below) and rondo (the terse phone-first language; see \u201cthe rondo language\u201d). Press play on any example to hear it, or open it in the editor to change it.',
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
      p("Speed changes and randomness keep a loop alive: `*n` fits n repeats INTO a step, `/n` stretches a step over n cycles, `?` drops a step at random, and `a | b` picks one alternative each cycle. All randomness is seeded per cycle, so a loop is different bar to bar but identical every time you replay it."),
      code(
        '*n / /n speed, ? maybe, | random choice.',
        `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.12, s: 0, r: 0.1 })))

p('seq', note('c4*2 e4? <g4 a4>/2 [c5 b4 | e5 d5]').scale('c major').sound('pluck'))`,
      ),
      p("Write a Euclidean rhythm inline with (pulses, steps): it spreads the pulses as evenly as it can, so (3,8) is the tresillo. And `{a b c, d e}%n` is polymeter, several voices running at n steps per cycle so they drift against each other."),
      code(
        'Euclid (p,s) and polymeter {…}%n.',
        `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })))

p('euclid', note('c4(3,8)').sound('pluck'))
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
      p("Chords sit in root position by default. Reshape them with .invert(k) (inversions), .octave(n), and .voicing('drop2') (open/jazz spreads). Best of all, .voiceLead() nudges each chord onto the octaves nearest the previous one, so a progression glides smoothly instead of leaping, the difference between a beginner and a pro-sounding comp."),
      code(
        'The same progression, voice-led so the chords barely move.',
        `const pad = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq), 2200, { res: 0.2 }).mul(adsr(gate, { a: 0.3, d: 0.4, s: 0.8, r: 0.6 })).mul(0.3))

p('pad', chord('<Cmaj7 Fmaj7 Bm7b5 E7>').voiceLead().sound('pad').dur(0.98))
setCps(0.4)`,
      ),
    ],
  },
  {
    id: 'synths',
    group: 'sound design',
    title: 'Designing synths',
    blocks: [
      p('Inside the synth function you build a signal graph out of oscillators (sine, saw, square, tri, pulse, wavetable, noise), filters (svf, ladder, onepole), and envelopes (adsr, lfo). Signals combine with .mul, .add, .mix, and .range.'),
      p('This is an acid bass: a sawtooth through a ladder filter, with the envelope opening the cutoff on each note. param() declares a knob you can automate later.'),
      code(
        'A ladder bass with a resonant filter sweep.',
        `const acid = synth(({ note, gate, param, adsr, saw, square, ladder }) => {
  const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })
  const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
  const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)
  return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)
})

p('bass', note('c2 c2 g2 c2 eb2 c2 g1 c2').sound('acid'))`,
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
  const mod = fm(note.freq.mul(1.4)).mul(adsr(gate, { a: 0.001, d: 1.2, s: 0, r: 0.5 }).mul(2.2))
  return fm(note.freq, mod).mul(adsr(gate, { a: 0.001, d: 1.6, s: 0, r: 0.6 })).mul(0.35)
})

p('keys', chord('<Cmaj7 Am7 Fmaj7 G7>').sound('ep').dur(0.95))
p('bell', note('<c6 ~ g5 ~>').sound('bell').gain(0.5))
setCps(0.4)`,
      ),
      p("A few starting recipes (all carrier + one modulator): a warm E-PIANO is a 3:1 ratio with a fast index decay and a whisper of feedback; a BELL is a ~1.4 ratio kept at a low index (2 to 3) so it rings rather than clangs; an FM BASS is 1:1 with a quick index decay; BRASS is 1:1 with a slow index swell so the tone grows in. Big indexes (5+) and heavy feedback are where FM turns harsh, reach for them deliberately. The built-in 'fm presets' example wires these up to play with."),
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
      p("You can register several patterns at once, and each p() plays alongside the others. stack() combines patterns into one. note('c1*4').sound('kick') triggers a synth by name. setCps sets the tempo in cycles per second."),
      code(
        'A short beat: kick and hats, layered.',
        `setCps(0.5)

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
    id: 'singing',
    group: 'voice & visuals',
    title: 'Singing',
    blocks: [
      p("`sing(voice, lyrics, notes)` runs a neural voice entirely on your device: it sings your `lyrics` on your `notes`, both in mini-notation, one syllable per note (a hyphen splits a word, so \"twin-kle\" is two notes). The first play downloads the voice models once (a large one-time download, cached afterwards), so later plays are instant. You'll be asked before it starts."),
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
      p('`mic` is the device microphone as a LIVE signal: run your voice through the synth graph in real time. Feed it to `vocoder` as the modulator and the synth talks; hi-pass it and it whispers; `granular`-freeze it and it smears. The mic connects only while code that uses it is playing (the browser asks permission the first time) and it reads silence in offline renders and exports. USE HEADPHONES: a speaker feeding the mic loops into howling feedback.'),
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
    id: 'midi-import',
    group: 'voice & visuals',
    title: 'Importing MIDI',
    blocks: [
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
      p('Three builtins have special shapes. `eq hp 170 peak 300 -3 2 highshelf 7000 4` is the parametric EQ: each band is a type word then freq [gain] [q]. `vocoder mod bands:20` makes the pipe the carrier and `mod` the voice. And in bindings, `e = env .005 1 .15 .4 release:.3 curve:3` is the breakpoint envelope, flat time/level pairs, the flexible cousin of `adsr`.'),
      p('Voice options sit on the header: `synth bass mono glide:.08` is the 303 mono-glide, `unison:5 detune:14 spread:.9` widens a lead, `voices:12` raises polyphony.'),
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
      p('The scale can sit inline (`0 3 5  scale:a-min`) or on its own modifier line (`scale: a-min`). Short mode names: `maj min dor phr lyd mix loc`. Degrees resolve through the scale, so changing `a-min` to `c-maj` moves the whole part.'),
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
    ],
  },
  {
    id: 'rondo-mini',
    title: 'rondo: mini-notation',
    group: 'the rondo language',
    blocks: [
      p('Notation lines are MINI-NOTATION, passed to the pattern engine verbatim, so the whole vocabulary applies. `~` is a rest. `[a b]` squeezes a subgroup into one step (nest freely). `<a b c>` alternates per cycle, and alternations of different lengths phase against each other. `a*2` repeats within its step; `a/2` stretches across cycles. `a@3` weights a step three times as long. `a!` duplicates a step; `a?` randomly drops it half the time. `[a,b,c]` stacks simultaneously (a chord in one step).'),
      p('Two rhythm generators: `0(3,8)` is a EUCLIDEAN rhythm, 3 hits spread as evenly as 8 steps allow (the tresillo). Add a rotation with `(3,8,2)`. `{0 3 5}%8` is POLYMETER: the figure steps at 8 per cycle regardless of its own length, so it rotates against the bar and comes back around.'),
      p('One difference from other dialects: `.` is not a grouping shorthand here (it belongs to decimals and note spellings). Use brackets.'),
      p('The editor draws what it can. A simple degree line is a TAPPABLE GRID. A `{…}%n` polymeter figure gets the same editable grid, scoped to the braces, with the `%n` left as a scrubbable number. Other rich lines (euclid, alternation, nesting) render a read-only preview roll with a sweeping playhead, and when the line has exactly one euclid group the preview roll becomes a CONTROL SURFACE: drag it up and down to add or remove pulses, sideways to rotate the hits.'),
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
      p('`sidechain kick depth:.8 release:.12 sub:.95` is the pump: every kick ducks the other channels, and extra `name:amount` pairs set per-channel duck depth. `master threshold:-6 ratio:2 makeup:1` is the glue compressor on the mix bus. `cps N` sets the tempo in cycles per second.'),
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

cps .55`,
      ),
    ],
  },
  {
    id: 'rondo-widgets',
    title: 'rondo: live controls in the code',
    group: 'the rondo language',
    blocks: [
      p('Rondo code grows CONTROL SURFACES inline. The inventory: `knob` bindings render dials (drag to set; pattern-driven dials glide with the sweep and show a live readout; grabbing one overrides the drive until release). `adsr` renders a full-width draggable envelope. Simple degree lines and polymeter figures render tappable piano-roll grids. `beat` rows render a step sequencer (paint, velocity tap-cycle, vertical velocity scrub). Single-euclid preview rolls take drags for pulses and rotation. Every plain number scrubs sideways.'),
      p('The text is always the source of truth: every gesture rewrites the code (watch it change as you drag), so anything you can touch you can also type, undo, and share. Undo and redo live as chips at the left of the bottom bar, in both languages, so history is one thumb-tap away on a phone.'),
      p('While the transport runs, everything lights: notation characters flash as their notes sound (including inside `js` escapes), grids sweep a playhead, envelopes fire a marker per note, and lines built from signals (like `irand`) pulse whole.'),
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
      p('Cheat sheet, the shapes at a glance: `synth NAME [mono glide:… unison:…]` · pipeline lines (source / `* env` / processor / sig-op) · `name = expr` · `knob DEF lo..hi [log]` · `post` · `play NAME` (notation, voices, `scale:`, modifiers) · `beat [NAME]` (words are synth names, `word:v` velocity) · `sing NAME voice:…` (lyric/melody pairs + `post`) · `section NAME LEN` + `song …` · `bus NAME` + `send SYNTH AMT` · `sidechain SRC depth:… name:duck` · `master name:value` · `visual` · `js{ … }` / `js` · `cps N`. Comments start with `#`.'),
    ],
  },
]
