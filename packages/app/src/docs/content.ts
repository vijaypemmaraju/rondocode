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
}

export interface Section {
  id: string
  title: string
  blocks: Block[]
}

const p = (text: string): Block => ({ kind: 'p', text })
const code = (caption: string, text: string): Block => ({ kind: 'code', caption, text })

export const HERO = {
  title: 'rondocode',
  tagline: 'Live-codeable synths and mini-notation patterns, in your browser.',
  blurb:
    'There are two kinds of code here. Synths are functions that turn oscillators, filters, and envelopes into a sound. Patterns are sequences that trigger those sounds in time. Press play on any example to hear it, or open it in the editor to change it.',
}

export const SECTIONS: Section[] = [
  {
    id: 'first-sound',
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
    title: 'Patterns & mini-notation',
    blocks: [
      p('Steps separated by spaces split the cycle evenly. Nest them in brackets to subdivide a step, use angle brackets to change the step each cycle, and add *n to repeat it faster.'),
      code(
        '[ ] fits into one step. <> changes each cycle. *n repeats.',
        `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })))

p('seq', note('c4 [e4 g4] <b4 a4> c5*2').sound('pluck'))`,
      ),
      p('Write a Euclidean rhythm in the string with (pulses, steps). It spreads the pulses as evenly as it can across the steps. (3,8) is the tresillo.'),
      code(
        'A Euclidean rhythm in the pattern string.',
        `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })))

p('seq', note('c4(3,8)').sound('pluck'))`,
      ),
    ],
  },
  {
    id: 'notes',
    title: 'Notes, scales & chords',
    blocks: [
      p("note() takes absolute pitches like c4 or f#3. n() takes scale degrees, where 0 is the root and 7 is the octave, and .scale('c minor') puts them in a key, so you can move a whole line by changing one word. chord() turns a name like Cm7 into a stack of notes."),
      code(
        'Scale degrees and named chords.',
        `const keys = synth(({ note, gate, adsr, saw }) =>
  saw(note.freq).mul(adsr(gate, { a: 0.01, d: 0.3, s: 0.4, r: 0.3 })))

p('lead', n('0 2 4 <7 6> 4 2').scale('c minor').sound('keys'))
p('pad', chord('<Cm7 Abmaj7>').sound('keys'))`,
      ),
    ],
  },
  {
    id: 'synths',
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
    id: 'effects',
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
    ],
  },
  {
    id: 'arrange',
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
    id: 'midi-import',
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
]
