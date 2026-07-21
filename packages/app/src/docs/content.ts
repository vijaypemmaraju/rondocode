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
    id: 'fm',
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
    id: 'sends',
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
    id: 'rhythm',
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
    title: 'Modulation',
    blocks: [
      p("Signals are shapes that run 0 to 1: `sine`, `saw`, `perlin` and friends. `.range(lo, hi)` maps one onto real units, and `.ctrl('name', signal)` drives a synth parameter with it per event. Inside a synth, `lfo()` moves things per voice."),
      code(
        'A slow sine sweeps the filter; an LFO adds per-voice tremolo.',
        `const pad = synth(({ note, gate, param, adsr, saw, svf, lfo }) => {
  const cutoff = param('cutoff', 800, { min: 200, max: 6000, curve: 'log' })
  const trem = lfo(4).range(0.6, 1) // per-voice tremolo
  const env = adsr(gate, { a: 0.2, d: 0.3, s: 0.85, r: 0.6 })
  return svf(saw(note.freq), cutoff, { res: 0.5 }).mul(env).mul(trem)
})

p('pad',
  chord('<Am7 Dm7 G Cmaj7>').sound('pad').dur(0.96)
    // sweep the filter from the pattern side, over 4 cycles
    .ctrl('cutoff', sine.range(300, 4500).slow(4)))
setCps(0.4)`,
      ),
    ],
  },
  {
    id: 'generative',
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
    id: 'samples',
    title: 'Samples & granular',
    blocks: [
      p("`sample(gate, 'name')` plays a loaded audio sample like an oscillator: `root` is the note it plays natural at, and it pitches from there. `vox`, `riser` and `pad` ship built in; load your own with the + button in the editor. `granular` sprays overlapping grains from a scannable position for evolving textures."),
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
    id: 'visuals',
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
