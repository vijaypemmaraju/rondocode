/* Preloaded example documents. Plain strings of REAL rondocode source:
 * each one must eval clean against the live scope (pinned by
 * test/examples.test.ts, which also proves every pattern produces sounding
 * events). The FIRST example ("acid") is what a first visit loads: a gentle,
 * self-documenting tutorial. */

import { compile } from '@rondocode/rondo'

export interface Example {
  name: string
  /** rondocode (JS DSL) source. */
  code: string
  /** optional rondo-language source — the same tune in the terse language.
   *  Shown when the editor is in rondo mode. Added as rondo gains the features
   *  to express each example faithfully. */
  rondo?: string
}

const acid = `// rondocode, live-codeable synths + mini-notation patterns.
// Press ▶ run (or Cmd/Ctrl+Enter) to hear it. Edit anything, run again:
// the sound changes without stopping.

// synth() builds a per-voice DSP graph. Assigning it to a top-level
// const registers it under that name, so patterns can .sound('acid').
const acid = synth(({ note, gate, param, adsr, saw, square, ladder }) => {
  // param() declares a live control, patterns drive it via .ctrl('cutoff', ...)
  const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })
  // snappy envelope: fast attack, short decay, a little sustain
  const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
  // saw blended with a sub-octave square for body
  const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)
  // moog-style ladder filter; the squared envelope kicks the cutoff open
  return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)
})

// p(name, pattern) registers a pattern. n('...') is mini-notation scale
// degrees; .scale() resolves them to notes (the sub-octave square in the
// synth supplies the low end).
p('bass',
  n('0 0 3 5 0 0 7 5')
    .scale('a minor')
    .sound('acid')
    // sweep the filter with a slow sine: 0..1 mapped onto 200..2400 Hz
    .ctrl('cutoff', sine.range(200, 2400).slow(4))
    // ...or take the wheel yourself: uncomment the next line and it renders
    // as a DRAGGABLE SLIDER right here in the code. (Plain numbers are live
    // too, Alt+drag one on desktop, touch and drag it sideways on a phone.)
    // .ctrl('cutoff', slider(1200, 200, 2400))
    // every 4th cycle, play the line backwards
    .every(4, x => x.rev()),
)

setCps(0.6) // tempo, in cycles per second
`

const ambientBells = `// ambient bells, long tails, lots of space.

const bell = synth(({ note, gate, adsr, tri, sine, delay }) => {
  // slow strike, very long release
  const env = adsr(gate, { a: 0.01, d: 1.2, s: 0, r: 2.5 })
  // an inharmonic upper partial gives the metallic shimmer
  const partial = sine(note.freq.mul(3.01)).mul(0.25)
  const tone = tri(note.freq).mul(0.6).add(partial).mul(env)
  // short feedback delay smears each strike into a wash
  return tone.add(delay(tone, 0.28, 0.45)).mul(0.6)
})

// sparse pentatonic phrase: <> alternates one value per cycle, ~ is a rest
p('bells',
  n('<0 4 ~ 2> <7 ~ 9 ~>')
    .scale('c pentatonic')
    .sound('bell')
    .gain(0.8)
    // ghost echo: the same notes again, later and quieter
    .superimpose(x => x.late(0.25).gain(0.3)),
)

setCps(0.25) // very slow: one chord change every 4 seconds
`

const drumGroove = `// drum groove, three tiny percussion synths, three patterns.
// Drums ignore pitch, but every event still needs a note to fire a voice, // note('c2') is just the trigger.

const kick = synth(({ gate, adsr, sine }) => {
  // the classic trick: a sine whose pitch drops fast (160 -> 45 Hz)
  const pitch = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })
  const amp = adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.08 })
  return sine(pitch.pow(2).range(45, 160)).mul(amp).tanh()
})

const hat = synth(({ gate, adsr, noise, svf }) => {
  const env = adsr(gate, { a: 0.001, d: 0.04, s: 0, r: 0.03 })
  return svf(noise(), 8000, { mode: 'hp' }).mul(env).mul(0.5)
})

const clap = synth(({ gate, adsr, noise, svf }) => {
  const env = adsr(gate, { a: 0.002, d: 0.12, s: 0, r: 0.08 })
  return svf(noise(), 1500, { mode: 'bp', res: 0.6 }).mul(env).mul(0.8)
})

// four-on-the-floor
p('kick', note('c2*4').sound('kick'))

// euclid(5,8) spreads 5 hits over 8 steps; swing + a few dropped hits
p('hats',
  note('c5*8').sound('hat')
    .euclid(5, 8)
    .swing(4)
    .degradeBy(0.1, 7) // drop ~10% (seed 7, deterministic, same every loop)
    .gain(0.7),
)

// backbeat clap on 2 and 4
p('clap', note('~ c4 ~ c4').sound('clap'))

setCps(0.5) // 4 beats per cycle at 0.5 cps = 120 bpm
`

const fmKeys = `// fm keys, audio-rate frequency modulation, two operators.

const keys = synth(({ note, gate, param, adsr, sine }) => {
  const ratio = param('ratio', 2, { min: 0.5, max: 8 })   // modulator ratio
  const index = param('index', 1.4, { min: 0, max: 6 })   // brightness
  // modulator: a sine at ratio x the note; its DEPTH has its own envelope,
  // so notes start bright and mellow out (the FM piano trick)
  const modEnv = adsr(gate, { a: 0.002, d: 0.35, s: 0.15, r: 0.3 })
  const mod = sine(note.freq.mul(ratio)).mul(note.freq.mul(index)).mul(modEnv)
  // carrier: the modulator wobbles the carrier's frequency at audio rate
  // (loudness follows the note's .gain(), velocity is auto-applied by the voice)
  const carEnv = adsr(gate, { a: 0.004, d: 0.5, s: 0.5, r: 0.4 })
  return sine(note.freq.add(mod)).mul(carEnv).mul(0.5)
})

// chords: stack() plays all three degree lines at once; <> moves the
// voicing one step per cycle
p('keys',
  stack(
    n('<0 2 -1 4>'),
    n('<2 4 1 6>'),
    n('<4 6 3 8>'),
  )
    .scale('d dorian')
    .sound('keys')
    .dur(0.8)
    .gain(0.8)
    // open the brightness on alternating cycles
    .ctrl('index', '<1 2.5>'),
)

setCps(0.4)
`

const generative = `// generative, the machine improvises, but DETERMINISTICALLY:
// rand/perlin/irand hash the event's exact time position, so the same
// cycle always plays the same way. Reload and it's identical. The seed
// arguments pick independent random streams, change one for a new take.

const pluck = synth(({ note, gate, param, adsr, saw, svf }) => {
  const cutoff = param('cutoff', 1800, { min: 150, max: 6000, curve: 'log' })
  const env = adsr(gate, { a: 0.002, d: 0.16, s: 0, r: 0.2 })
  return svf(saw(note.freq), cutoff, { res: 0.4 }).mul(env).mul(0.7)
})

const bass = synth(({ note, gate, adsr, square, onepole }) => {
  const env = adsr(gate, { a: 0.004, d: 0.3, s: 0.4, r: 0.15 })
  return onepole(square(note.freq), 900).mul(env).mul(0.6)
})

// melody: 8 random scale degrees per cycle (irand draws 0..7),
// thinned out and sometimes played as quiet ghost notes
p('melody',
  n(irand(8).segment(8))
    .scale('e minor')
    .sound('pluck')
    .degradeBy(0.3, 1)                       // drop ~30% (seed 1)
    .sometimesBy(0.25, x => x.gain(0.3), 2)  // ghost some hits (seed 2)
    // perlin noise = smooth wandering: the filter drifts, never jumps
    .ctrl('cutoff', perlin.range(400, 4000).slow(2)),
)

// bass: one root per cycle via <> alternation, spread as a 3-against-8
// euclid rhythm (note names pick the register directly: e2 = low E)
p('bassline',
  note('<e2 e2 d2 g2>')
    .sound('bass')
    .euclid(3, 8)
    .dur(0.6),
)

setCps(0.5)
`

const edm = `// EDM, progressive house. A classic emotional chord progression
// (i–VI–III–VII in C minor = Cm–Ab–Eb–Bb, one chord per bar) carried by a
// lush sidechained PAD and an offbeat plucky STAB, over a driving
// four-on-the-floor. Everything is synthesized, no samples.
//
// The genre-defining "pump" is a REAL sidechain: sidechain('kick', ...) below
// makes every kick duck all the other channels and swell them back.

// --- drums ---
const kick = synth(({ gate, adsr, sine, noise, svf }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })
  const amp = adsr(gate, { a: 0.001, d: 0.16, s: 0, r: 0.06 }) // tight, punchy
  const body = sine(pitch.pow(3).range(48, 190)).mul(amp)
  // a tiny high-passed noise click on the transient gives the beater "snap"
  const click = svf(noise(), 4000, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.0004, d: 0.012, s: 0, r: 0.004 }))
    .mul(0.45)
  return body.add(click).tanh()
})

const clap = synth(({ gate, adsr, noise, svf }) => {
  const env = adsr(gate, { a: 0.003, d: 0.15, s: 0, r: 0.09 })
  return svf(noise(), 1800, { mode: 'bp', res: 0.5 }).mul(env).mul(1.3).tanh()
})

const hat = synth(({ gate, adsr, noise, svf }) => {
  const env = adsr(gate, { a: 0.001, d: 0.035, s: 0, r: 0.02 })
  return svf(noise(), 9000, { mode: 'hp' }).mul(env).mul(0.5)
})

const openhat = synth(({ gate, adsr, noise, svf }) => {
  const env = adsr(gate, { a: 0.001, d: 0.18, s: 0.1, r: 0.12 })
  return svf(noise(), 8000, { mode: 'hp' }).mul(env).mul(0.4)
})

// --- bass: round sub, driven for warmth, plays the ROLLING OFFBEAT ---
const bass = synth(({ note, gate, adsr, sine, saw, onepole }) => {
  const env = adsr(gate, { a: 0.004, d: 0.14, s: 0.4, r: 0.08 })
  const tone = sine(note.freq).mix(saw(note.freq), 0.22) // sub + a little edge
  // gentle overdrive: push into tanh for harmonics that cut on small speakers
  return onepole(tone, 440).mul(env).mul(0.95).tanh().mul(0.78)
})

// --- pad: lush 7-voice supersaw. No self-pump, the real sidechain (below)
// ducks it against the kick, so the pad just holds the chord and breathes.
// The reverb lives in the POST chain (2nd arg) so it runs ONCE over the summed
// chord, stereo-decorrelated — not once per voice. ---
const pad = synth(({ note, gate, adsr, saw, svf, lfo }) => {
  const env = adsr(gate, { a: 0.18, d: 0.5, s: 0.9, r: 1.2 }) // slow swell in
  const f = note.freq
  // seven detuned saws (successive crossfades) = the wide Pryda-style chord
  const wide = saw(f)
    .mix(saw(f.mul(1.004)), 0.5)
    .mix(saw(f.mul(0.996)), 0.4)
    .mix(saw(f.mul(1.009)), 0.34)
    .mix(saw(f.mul(0.991)), 0.34)
    .mix(saw(f.mul(1.016)), 0.28)
    .mix(saw(f.mul(0.984)), 0.28)
  return svf(wide, lfo(0.07).range(1200, 2800), { res: 0.16 }).mul(env).mul(0.62)
}, ({ input, reverb, eq }) => {
  // eq high-passes the pad so it leaves the low end to kick + bass; then one
  // big Anjunadeep reverb (large room, gently damped) is the shared space.
  const clean = eq(input, [{ type: 'hp', freq: 180 }])
  return clean.mix(reverb(clean, { roomSize: 0.85, damp: 0.4 }), 0.35)
})

// --- pluck: bright stab, resonant, with a drivable wash. The exciter adds
// sheen; 'wet' is a POST param — .ctrl('wet', ...) automates the reverb blend
// live, exactly like a voice param. That drivable-post-param is the point. ---
const pluck = synth(({ note, gate, param, adsr, saw, svf }) => {
  const bright = param('bright', 4000, { min: 500, max: 9000, curve: 'log' })
  const env = adsr(gate, { a: 0.002, d: 0.12, s: 0, r: 0.08 })
  const osc = saw(note.freq).mix(saw(note.freq.mul(1.006)), 0.45)
  return svf(osc, bright.mul(env.range(0.45, 1)), { res: 0.45 }).mul(env).mul(0.62)
}, ({ input, reverb, exciter, param }) => {
  const air = exciter(input, { freq: 4000, amount: 0.25 })
  const wet = param('wet', 0.35, { min: 0, max: 0.7 })
  // smaller, brighter room keeps the stab tight while smearing it into the wash
  return air.mix(reverb(air, { roomSize: 0.6, damp: 0.3 }), wet)
})

// The chord progression as stacked scale degrees. <> moves one chord per
// cycle: Cm (0 2 4) → Ab (5 7 9) → Eb (2 4 6) → Bb (6 8 10).
const chords = stack(
  n('<0 5 2 6>'),   // roots
  n('<2 7 4 8>'),   // thirds
  n('<4 9 6 10>'),  // fifths
).scale('c minor')

// the chord roots an octave-and-a-bit down, for the bass
const chordRoot = note('<c2 ab1 eb2 bb1>')

// --- kit ---
p('kick', note('c2*4').sound('kick').gain(0.78))       // four on the floor
p('clap', note('~ c2 ~ c2').sound('clap'))             // backbeat
p('hats',
  note('c5*8').sound('hat')
    .euclid(5, 8).swing(4)
    .gain(rand.range(0.5, 1))
    .degradeBy(0.08, 3),
)
p('open', note('~ c5 ~ c5').sound('openhat').gain(0.5))

// --- bass: the ROLLING OFFBEAT, the engine of progressive house. The kick
// hits on the beat, the bass answers on the "and" (offbeat 8ths). They
// interlock into the driving groove; the short envelope keeps it tight.
p('bass',
  chordRoot
    .struct(mini('~ t ~ t ~ t ~ t'))   // offbeats only
    .sound('bass')
    .dur(0.16),
)
// --- pad: sustained chords, one held across each bar. The sidechain ducks it
// against the kick for the pump.
p('pad', chords.sound('pad').dur(0.98))
// --- pluck: the offbeat stab, doubled with the pad's chord tones. TWO live
// controls: 'bright' sweeps the voice filter, 'wet' opens the post reverb —
// a voice param and a post param, driven identically from the pattern.
p('stab',
  chords
    .struct(mini('~ t ~ t ~ t ~ t'))
    .sound('pluck')
    .ctrl('bright', slider(4000, 500, 9000))
    .ctrl('wet', slider(0.35, 0, 0.7))
    .gain(0.85)
    .dur(0.16),
)

// THE PUMP: every kick ducks all the other channels ~70% and lets them swell
// back over 180ms, the smooth sidechain that defines progressive house.
sidechain('kick', { depth: 0.7, release: 0.18 })
// glue the whole mix with a gentle master compressor (the last thing in chain)
masterCompress({ threshold: -6, ratio: 2, attack: 25, release: 150, makeup: 1 })

setCps(0.52) // ~125 bpm
`

const synthscape = `// lush synthscape. A richer progression than the usual: // Am(add9) – Cmaj7 – Dm7 – E7 (i–III–iv–V in A minor). The E7 is a secondary
// dominant: its G# leans hard back to A, giving the loop tension and lift.
// Every level is a SLIDER, drag them to mix live. The kick pumps everything.

// --- pad: 7-voice supersaw in a big room, the emotional bed ---
// The reverb is now a POST-CHAIN (2nd synth arg): it processes the whole
// pad's summed voices ONCE, one shared tail, and it's stereo-wide (the
// engine runs it decorrelated on L/R). Much better than one reverb per note.
const pad = synth(({ note, gate, adsr, saw, svf, lfo }) => {
  const env = adsr(gate, { a: 0.35, d: 0.6, s: 0.9, r: 1.6 }) // slow swell
  const f = note.freq
  const wide = saw(f)
    .mix(saw(f.mul(1.004)), 0.5).mix(saw(f.mul(0.996)), 0.4)
    .mix(saw(f.mul(1.009)), 0.34).mix(saw(f.mul(0.991)), 0.34)
    .mix(saw(f.mul(1.015)), 0.28).mix(saw(f.mul(0.985)), 0.28)
  return svf(wide, lfo(0.05).range(900, 2400), { res: 0.15 }).mul(env).mul(0.5)
}, ({ input, chorus, reverb, exciter }) => {
  // post-chain: CHORUS (huge, wide, the engine runs it decorrelated L/R) →
  // EXCITER (a little top-end sheen so it glistens) → REVERB. This is why the
  // pad sounds enormous.
  const wide = chorus(input, { rate: 0.5, depth: 0.004, mix: 0.55 })
  const air = exciter(wide, { freq: 6000, amount: 0.2 })
  return air.mix(reverb(air, { roomSize: 0.9, damp: 0.35 }), 0.4)
})

// --- arp: bright resonant pluck, short and wet, the rolling sequence ---
const arp = synth(({ note, gate, param, adsr, saw, svf }) => {
  const bright = param('bright', 4200, { min: 600, max: 9000, curve: 'log' })
  const env = adsr(gate, { a: 0.002, d: 0.13, s: 0.05, r: 0.14 })
  const osc = saw(note.freq).mix(saw(note.freq.mul(1.005)), 0.4)
  return svf(osc, env.range(0.4, 1).mul(bright), { res: 0.4 }).mul(env).mul(0.52)
}, ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.7, damp: 0.3 }), 0.4))

// --- bass: deep round sub ---
const bass = synth(({ note, gate, adsr, sine, saw, onepole }) => {
  const env = adsr(gate, { a: 0.02, d: 0.3, s: 0.8, r: 0.2 })
  const tone = sine(note.freq).mix(saw(note.freq), 0.12)
  return onepole(tone, 320).mul(env).mul(0.85).tanh().mul(0.42)
})

// --- kick: soft, deep, a gentle pulse ---
const kick = synth(({ gate, adsr, sine }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.1, s: 0, r: 0.06 })
  const amp = adsr(gate, { a: 0.001, d: 0.2, s: 0, r: 0.08 })
  return sine(pitch.pow(3).range(45, 150)).mul(amp).tanh().mul(0.42)
})

// chords as four voices (exact note names so the E7's G# rings true)
const chords = stack(
  note('<a2 c3 d3 e3>'),   // Am(add9)  Cmaj7  Dm7  E7, lowest voice
  note('<c3 e3 f3 g#3>'),  // (the g# = E7's major third, the tension note)
  note('<e3 g3 a3 b3>'),
  note('<b3 b3 c4 d4>'),
)

// rolling arp: exact chord tones per bar, up-and-back (8ths). Note names keep
// the E7's g# in the arp too, so arp and pad agree on the color chord.
const arpLine = note(
  '<[a3 c4 e4 a4 b4 a4 e4 c4] [c4 e4 g4 c5 b4 c5 g4 e4]' +
  ' [d4 f4 a4 d5 c5 d5 a4 f4] [e4 g#4 b4 e5 d5 e5 b4 g#4]>',
)

// --- the mixer: every level is a live slider ---
p('pad', chords.sound('pad').gain(slider(0.85, 0, 1)).dur(0.98))
p('arp',
  arpLine.sound('arp')
    .ctrl('bright', slider(4200, 600, 9000))
    .gain(slider(0.9, 0, 1)).dur(0.22),
)
p('bass', note('<a1 c2 d2 e2>').sound('bass').gain(slider(0.85, 0, 1)).dur(0.9))
p('kick', note('c1*4').sound('kick').gain(slider(0.75, 0, 1)))

// strong pump, the arp and pad breathe hard on every kick (drag the depth)
// per-channel duck: the arp pumps HARD (1.0), the pad only breathes (0.4),
// the bass sits between, a real mix move, not one global depth
sidechain('kick', { depth: slider(0.85, 0, 1), release: 0.22, duck: { arp: 1, pad: 0.4, bass: 0.7 } })
masterCompress({ threshold: -6, ratio: 2, attack: 25, release: 150, makeup: 1 }) // master glue

setCps(0.5)
`

const arrangement = `// arrangement, a FULL track with sections, not just a loop. arrange()
// sequences blocks of cycles: intro (4) -> build (4) -> drop (8), then loops.
// Each section is a stack of the parts playing then. rise(n) ramps 0..1 over
// n cycles (here the riser's long envelope does the sweep instead).

const kick = synth(({ gate, adsr, sine, noise, svf }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })
  const amp = adsr(gate, { a: 0.001, d: 0.16, s: 0, r: 0.06 })
  const body = sine(pitch.pow(3).range(48, 190)).mul(amp)
  const click = svf(noise(), 4000, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.0004, d: 0.012, s: 0, r: 0.004 })).mul(0.4)
  return body.add(click).tanh().mul(0.9)
})
const hat = synth(({ gate, adsr, noise, svf }) => {
  const env = adsr(gate, { a: 0.001, d: 0.04, s: 0, r: 0.02 })
  return svf(noise(), 9000, { mode: 'hp' }).mul(env).mul(0.4)
})
const clap = synth(({ gate, adsr, noise, svf }) => {
  const env = adsr(gate, { a: 0.003, d: 0.15, s: 0, r: 0.09 })
  return svf(noise(), 1800, { mode: 'bp', res: 0.5 }).mul(env).mul(1.2).tanh()
})
const bass = synth(({ note, gate, adsr, sine, saw, onepole }) => {
  const env = adsr(gate, { a: 0.004, d: 0.14, s: 0.5, r: 0.08 })
  const tone = sine(note.freq).mix(saw(note.freq), 0.2)
  return onepole(tone, 420).mul(env).mul(0.9).tanh().mul(0.6)
})
// reverb lives in the POST chain (2nd arg): one shared tail over the summed
// chord, stereo-wide — the standard for lush synths (see synthscape).
const pad = synth(({ note, gate, adsr, saw, svf, lfo }) => {
  const env = adsr(gate, { a: 0.12, d: 0.5, s: 0.9, r: 1.0 })
  const f = note.freq
  const wide = saw(f).mix(saw(f.mul(1.005)), 0.5).mix(saw(f.mul(0.995)), 0.4)
    .mix(saw(f.mul(1.011)), 0.3).mix(saw(f.mul(0.989)), 0.3)
  return svf(wide, lfo(0.06).range(1100, 2600), { res: 0.16 }).mul(env).mul(0.5)
}, ({ input, reverb, eq }) => {
  const clean = eq(input, [{ type: 'hp', freq: 180 }]) // leave room for kick+bass
  return clean.mix(reverb(clean, { roomSize: 0.85, damp: 0.4 }), 0.35)
})
const pluck = synth(({ note, gate, param, adsr, saw, svf }) => {
  const bright = param('bright', 3800, { min: 500, max: 9000, curve: 'log' })
  const env = adsr(gate, { a: 0.002, d: 0.13, s: 0, r: 0.1 })
  const osc = saw(note.freq).mix(saw(note.freq.mul(1.005)), 0.4)
  return svf(osc, bright.mul(env.range(0.5, 1)), { res: 0.4 }).mul(env).mul(0.5)
}, ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.6, damp: 0.3 }), 0.3))
// riser: white noise whose highpass + level swell over the whole build, the
// long attack IS the sweep, so it rises smoothly with no automation
const riser = synth(({ gate, adsr, noise, svf }) => {
  const env = adsr(gate, { a: 3.4, d: 0, s: 1, r: 0.2 })
  return svf(noise(), env.range(400, 7000), { mode: 'hp', res: 0.4 }).mul(env.pow(2)).mul(0.3)
})
// snare for the build fill
const snare = synth(({ gate, adsr, noise, svf }) => {
  const env = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.04 })
  return svf(noise(), 2500, { mode: 'bp', res: 0.4 }).mul(env).mul(0.8).tanh()
})

// progression Cm-Ab-Eb-Bb (i-VI-III-VII); chord as three stacked voices
const chords = stack(n('<0 5 2 6>'), n('<2 7 4 8>'), n('<4 9 6 10>')).scale('c minor')
const roots = note('<c2 ab1 eb2 bb1>')

// the sections, each a stack of the layers active in that block
const intro = stack(
  chords.sound('pad').dur(0.98),
  note('c1*4').sound('kick').gain(0.55),
)
const build = stack(
  chords.sound('pad').dur(0.98),
  note('c1*4').sound('kick').gain(0.8),
  note('c5*8').sound('hat').euclid(5, 8).gain(rand.range(0.4, 0.9)),
  note('c4').slow(4).sound('riser'),        // one 4-cycle swell across the build
  // the FILL: only the build's last bar (<~ ~ ~ c4>) becomes an accelerating
  // 16-hit snare roll (roll(16, 3)) that crescendos (saw gain) into the drop
  note('<~ ~ ~ c4>').roll(16, 3).sound('snare').gain(saw.range(0.25, 1)),
)
const drop = stack(
  chords.sound('pad').dur(0.98),
  note('c1*4').sound('kick').gain(0.9),
  note('~ c2 ~ c2').sound('clap'),
  note('c5*8').sound('hat').euclid(5, 8).swing(4).gain(rand.range(0.5, 1)).degradeBy(0.08, 3),
  roots.struct(mini('~ t ~ t ~ t ~ t')).sound('bass').dur(0.16),
  chords.struct(mini('~ t ~ t ~ t ~ t')).sound('pluck')
    .ctrl('bright', slider(3800, 500, 9000)).dur(0.16),
)

p('track', arrange([4, intro], [4, build], [8, drop]))
sidechain('kick', { depth: 0.6, release: 0.18 })
masterCompress({ threshold: -6, ratio: 2, attack: 25, release: 150, makeup: 1 }) // master glue
setCps(0.52)
`

// Sampler, play LOADED audio, not just synthesis. 'vox' (a vocal aah) and
// 'riser' ship by default; the ＋ sample button loads your own files.
const sampler = `// SAMPLER, play loaded audio samples, not just oscillators.
// 'vox' and 'riser' are built in. Load your OWN drums/vox/breaks with the
// ＋ sample button in the header, then play them: sample(gate, 'yourfile').

// A pitched vocal chop. root:57 = A3 (the sample's natural pitch), so the
// pattern's notes transpose it melodically. Shape + space it like any synth.
const vox = synth(({ note, gate, adsr, sample, svf, reverb }) => {
  const env = adsr(gate, { a: 0.01, d: 0.3, s: 0.7, r: 0.35 })
  const v = svf(sample(gate, 'vox', { root: 57 }), 4200).mul(env).mul(0.9)
  return v.mix(reverb(v, { roomSize: 0.88, damp: 0.4 }), 0.32)
})
// A one-shot noise riser for the build (plays through, gated by its long env).
const riser = synth(({ gate, adsr, sample }) =>
  sample(gate, 'riser').mul(adsr(gate, { a: 0.005, d: 2.2, s: 0, r: 0.3 })).mul(0.7))
// A synth kick to pulse under it.
const kick = synth(({ gate, adsr, sine }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })
  const amp = adsr(gate, { a: 0.001, d: 0.16, s: 0, r: 0.06 })
  return sine(pitch.pow(3).range(48, 190)).mul(amp).tanh()
})

// a vocal-chop melody in A minor (each bracket is one bar of 4)
const melody = note('<[a3 c4 e4 a4] [g3 b3 d4 g4] [f3 a3 c4 f4] [e3 g3 b3 e4]>')
p('vox', melody.sound('vox').dur(0.22).gain(slider(0.9, 0, 1.5)))
p('drums', stack(
  note('c1*4').sound('kick').gain(slider(0.9, 0, 1.5)),
  note('c4').slow(8).sound('riser').gain(slider(0.7, 0, 1.5)), // a riser every 8 bars
))
setCps(0.5)
`

// Granular, an ambient grain cloud over the built-in 'pad' sample.
const granular = `// GRANULAR done DREAMY, smooth harmonic source, big overlapping grains, almost
// no spray, a consonant chord = an ambient wash instead of a horror choir.
const cloud = synth(({ note, gate, adsr, granular, lfo, reverb, chorus }) => {
  const env = adsr(gate, { a: 1.2, d: 1, s: 0.9, r: 2.2 })
  const g = granular(gate, 'pad', {
    root: 57,                          // pad tone is A3
    pos: lfo(0.03).range(0.2, 0.6),    // gentle drift
    size: 0.22, density: 70, spray: 0.004,   // big + dense + tight = smooth
  })
  const w = chorus(g.mul(env).mul(0.5), { rate: 0.3, depth: 0.005, mix: 0.4 })
  return w.mix(reverb(w, { roomSize: 0.94, damp: 0.35 }), 0.5)
}, undefined, { voices: 12 })

// a lush progression: A - E - F#m - D (chord() voices these in octave 3,
// exactly the notes hand-stacked before)
const chords = chord('<A E F#m D>')
p('amb', chords.sound('cloud').dur(0.98).gain(0.9))
setCps(0.16)
`

const chordsArp = `// chords & arps, name chords instead of hand-stacking notes.
// chord('<...>') expands each name to a STACK of notes (root octave 3);
// .arp() spreads a chord's notes across its step. Qualities: maj m 7 maj7 m7
// dim aug sus2 sus4 6 m6 add9 9 maj9 m9 11 13 m7b5, plus slash bass (C/E).

const keys = synth(({ note, gate, adsr, saw, svf, lfo }) => {
  const env = adsr(gate, { a: 0.008, d: 0.3, s: 0.5, r: 0.5 })
  const cut = lfo(0.1).range(900, 2600) // slow filter drift
  return svf(saw(note.freq), cut, { res: 0.3 }).mul(env).mul(0.5)
}, ({ input, reverb }) =>
  // a post chain (2nd synth arg) adds ONE shared reverb tail over all the
  // notes — the right way to space a synth, vs a reverb per voice
  input.mix(reverb(input, { roomSize: 0.7, damp: 0.4 }), 0.25))

// a ii-V-I-vi in C, one named chord per bar, held as a pad
p('pad',
  chord('<Dm7 G7 Cmaj7 Am7>')
    .sound('keys')
    .dur(0.95)
    .gain(0.4),
)

// the SAME chords, arpeggiated up-and-down (try 'up' 'down' 'converge')
p('arp',
  chord('<Dm7 G7 Cmaj7 Am7>')
    .arp('updown')
    .sound('keys')
    .dur(0.12)
    .gain(0.55),
)

setCps(0.42)
`

const visuals = `// VISUALS: write a WGSL fragment shader with visual(\`…\`) and it renders
// live BEHIND the code, driven by the audio. Toggle it with the "visuals"
// button in the header. Inside the shader you get, updated every frame:
//   time  level  bass  mid  treble  cps  phase  hit  beat  res
//   spectrum(x) -> FFT 0..1 at x(0..1)    waveform(x) -> sample -1..1
//   hit_<synth> -> that synth's note-onset envelope (hit_kick, hit_bass, hit_lead)
// Write fn render(uv: vec2f) -> vec4f  (uv is 0..1, origin bottom-left).

const kick = synth(({ gate, adsr, sine }) =>
  sine(adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 }).pow(2).range(45, 160))
    .mul(adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.08 })).tanh())
const bass = synth(({ note, gate, adsr, saw, ladder }) =>
  ladder(saw(note.freq), 900, { res: 0.5 })
    .mul(adsr(gate, { a: 0.005, d: 0.2, s: 0.5, r: 0.2 })))
const lead = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.01, d: 0.25, s: 0.3, r: 0.2 })))

setCps(0.5)
p('drums', note('c1*4').sound('kick'))
p('bass', note('c2 [eb2 g2] c2 g1').sound('bass'))
p('lead', n('0 3 5 7 <10 12> 7 5 3').scale('c minor').sound('lead'))

visual(\`
fn render(uv: vec2f) -> vec4f {
  let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
  let r = length(p);
  let a = atan2(p.y, p.x) / 6.2831853 + 0.5;
  // spectrum ring: its radius eases outward on the KICK (motion, not a flash)
  let s = spectrum(fract(a * 2.0));
  let ring = smoothstep(0.05, 0.0, abs(r - (0.42 + s * 0.4 + hit_kick * 0.1)));
  // core glow: a steady floor with only a small kick swell
  let core = (0.12 + hit_kick * 0.18) / (r * r * 6.0 + 0.3);
  // LEAD notes throw a soft cyan spark on an outer ring
  let spark = hit_lead * 0.5 * pow(max(0.0, 1.0 - abs(r - 0.72) * 5.0), 2.0);
  // a waveform ribbon across the middle
  let ribbon = smoothstep(0.02, 0.0, abs(p.y - waveform(uv.x) * 0.35));
  let col = vec3f(0.95, 0.35, 0.6) * ring
          + vec3f(0.25 + treble * 0.4, 0.7, 0.6) * core
          + vec3f(0.35, 0.9, 1.0) * spark
          + vec3f(0.3, 0.85, 0.7) * ribbon * (0.5 + level * 0.5)
          + vec3f(0.12, 0.05, 0.18) * (0.4 + hit_bass * 0.3);
  return vec4f(min(col, vec3f(1.0)), 1.0);
}
\`)
`

const techno = `// TECHNO: dark, hypnotic, driving. Punchy saturated kick, a deep sustained
// sub, backbeat clap, offbeat open hat, and a resonant detuned stab moving
// Am7 - Fmaj7 - Am7 - G. Sub + stab duck hard under the kick.

const kick = synth(({ gate, adsr, sine, noise, svf }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.07, s: 0, r: 0.04 })
  const sub = sine(pitch.pow(2).range(42, 200)).mul(adsr(gate, { a: 0.001, d: 0.26, s: 0, r: 0.07 }))
  const click = svf(noise(), 3500, { mode: 'hp' }).mul(adsr(gate, { a: 0.0004, d: 0.02, s: 0, r: 0.01 })).mul(0.6)
  return sub.add(click).mul(1.4).tanh()
})
const clap = synth(({ gate, adsr, noise, svf }) => {
  const crack = svf(noise(), 1800, { mode: 'bp', res: 0.5 }).mul(adsr(gate, { a: 0.002, d: 0.12, s: 0, r: 0.08 }))
  const air = svf(noise(), 6000, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.05, s: 0, r: 0.04 })).mul(0.5)
  return crack.add(air).mul(1.3).tanh()
})
const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 9500, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.028, s: 0, r: 0.02 })).mul(0.22))
const ohat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 8500, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.14, s: 0.1, r: 0.1 })).mul(0.2))
const sub = synth(({ note, gate, adsr, sine, tri }) =>
  sine(note.freq).add(tri(note.freq).mul(0.12)).mul(adsr(gate, { a: 0.01, d: 0.2, s: 0.9, r: 0.15 })).tanh())
const stab = synth(
  ({ note, gate, adsr, saw, square, ladder }) => {
    const env = adsr(gate, { a: 0.002, d: 0.16, s: 0, r: 0.09 })
    const f = note.freq
    const sup = saw(f).add(saw(f.mul(1.006))).add(saw(f.mul(0.994))).add(square(f.mul(0.5))).mul(0.3)
    return ladder(sup, env.pow(2).range(320, 3600), { res: 0.62 }).mul(env)
  },
  ({ input, reverb, delay, eq }) => {
    // eq keeps the stab surgical + dark: high-pass out the low end (that's the
    // sub's job) and shave the harsh 3k so it sits back in the hypnotic groove.
    const shaped = eq(input, [
      { type: 'hp', freq: 260 },
      { type: 'peak', freq: 3000, gain: -3, q: 1 },
    ])
    const e = shaped.add(delay(shaped, 0.28, 0.35))
    return e.mix(reverb(e, { roomSize: 0.7, damp: 0.4 }), 0.3)
  },
)

setCps(0.552)
const dKick = note('c1*4').sound('kick').gain(1.0)
const dClap = note('~ c3 ~ c3').sound('clap').gain(0.7)
const dHat = note('c5*8').sound('hat').gain(rand.range(0.5, 0.9))
const dOhat = note('~ c5 ~ c5 ~ c5 ~ c5').sound('ohat').gain(0.6)
const bSub = note('<a1 f1 c2 g1>').sound('sub').gain(0.5).dur(0.98)
const mStab = chord('<Am F C G>').struct(mini('~ t ~ t t ~ ~ t')).sound('stab').gain(0.5).dur(0.2)
const intro = stack(dKick, dHat, bSub)
const full = stack(dKick, dClap, dHat, dOhat, bSub, mStab)
const brk = stack(dHat, bSub, mStab)
p('song', arrange([8, full], [4, brk], [8, full], [4, intro]))
sidechain('kick', { depth: 0.9, release: 0.2, duck: { sub: 0.95, stab: 0.6 } })
masterCompress({ threshold: -6, ratio: 2, attack: 25, release: 150, makeup: 1 })

visual(\`
fn render(uv: vec2f) -> vec4f {
  let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
  // scanlines drift with time; the kick gives a gentle swell, not a strobe
  let scan = smoothstep(0.5, 0.92, fract(uv.y * 22.0 + time * 0.35)) * (0.3 + hit_kick * 0.2);
  let sp = spectrum(abs(p.x) * 0.8);
  let cols = smoothstep(0.03, 0.0, abs(fract(uv.x * 18.0) - 0.5) - sp * 0.45);
  let col = vec3f(0.95, 0.2, 0.35) * scan
          + vec3f(0.1, 0.85, 0.95) * cols * (0.4 + hit_stab * 0.4)
          + vec3f(0.08, 0.1, 0.12) * (0.3 + level * 0.5);
  return vec4f(min(col, vec3f(1.0)), 1.0);
}
\`)
`

const dubstep = `// DUBSTEP: the litmus test. Punchy kick, cracking snare, a clean sub, a dark
// Fm pad, and a FILTHY wobble: detuned saws + square sub through a resonant
// ladder, hard-clipped and bit-crushed, wobble rate patterned per step.

const kick = synth(({ gate, adsr, sine, noise, svf }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })
  const sub = sine(pitch.pow(2).range(42, 200)).mul(adsr(gate, { a: 0.001, d: 0.24, s: 0, r: 0.07 }))
  const click = svf(noise(), 4200, { mode: 'hp' }).mul(adsr(gate, { a: 0.0004, d: 0.02, s: 0, r: 0.01 })).mul(0.6)
  return sub.add(click).mul(1.5).tanh()
})
const snare = synth(({ gate, adsr, noise, sine, svf }) => {
  const body = sine(180).mul(adsr(gate, { a: 0.001, d: 0.13, s: 0, r: 0.06 }))
  const crack = svf(noise(), 2600, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.12 }))
  const snap = svf(noise(), 6500, { mode: 'bp', res: 0.4 }).mul(adsr(gate, { a: 0.0005, d: 0.05, s: 0, r: 0.03 })).mul(0.7)
  return body.add(crack).add(snap).mul(1.3).tanh()
})
const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 10500, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.03, s: 0, r: 0.02 })).mul(0.2))
const sub = synth(({ note, gate, adsr, sine }) =>
  sine(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.95, r: 0.08 })).mul(1.2).tanh())
const pad = synth(
  ({ note, gate, adsr, saw, ladder, svf }) => {
    const f = note.freq
    const sup = saw(f).add(saw(f.mul(1.006))).add(saw(f.mul(0.994))).mul(0.4)
    const tone = ladder(sup, 620, { res: 0.2 })
    return svf(tone, 150, { mode: 'hp' }).mul(adsr(gate, { a: 0.6, d: 0.4, s: 0.6, r: 0.9 }))
  },
  ({ input, chorus, reverb }) => {
    const w = chorus(input, { rate: 0.3, depth: 0.006, mix: 0.8 })
    return w.mix(reverb(w, { roomSize: 0.92, damp: 0.5 }), 0.5)
  },
)
const wob = synth(
  ({ note, gate, param, adsr, saw, square, ladder, lfo }) => {
    const rate = param('wob', 4, { min: 0.5, max: 16 })
    const f = note.freq
    const osc = saw(f).add(saw(f.mul(1.007))).add(saw(f.mul(0.993))).add(square(f.mul(0.5)).mul(1.2)).mul(0.4)
    const cut = lfo(rate, 'tri').range(160, 4400)
    return ladder(osc, cut, { res: 0.88 }).mul(adsr(gate, { a: 0.004, d: 0.1, s: 0.95, r: 0.06 }))
  },
  ({ input, shape, bitcrush, ott, eq }) => {
    const dirty = shape(input, 2.6, { type: 'hard' })
    const crushed = bitcrush(dirty, { bits: 10, downsample: 1 }).mix(dirty, 0.5)
    // eq scoops the boxy low-mid the hard-clip piles up, then OTT slams the
    // multiband dynamics flat — the aggressive, in-your-face modern wob glue.
    const carved = eq(crushed, [{ type: 'peak', freq: 450, gain: -4, q: 1.2 }])
    return ott(carved, { depth: 0.6 })
  },
)

setCps(0.582)
const dKick = note('c1 ~ ~ ~ ~ ~ c1 ~').sound('kick').gain(1.0)
const dSnare = note('~ ~ ~ ~ c2 ~ ~ ~').sound('snare').gain(0.95)
const dHat = note('~ c5 ~ c5 ~ c5 ~ c5').sound('hat').gain(0.4)
const mPad = chord('<Em Em Cmaj7 G>').sound('pad').gain(0.25).dur(0.98)
const bSub = note('<e1 e1 c1 g1>').sound('sub').gain(0.95).dur(0.9)
const bWob = note('<e2 e2 c2 g1>').struct(mini('t t t t')).sound('wob').ctrl('wob', '<2 4 8 4>').gain(0.85)
const intro = stack(mPad, bSub)
const full = stack(dKick, dSnare, dHat, mPad, bSub, bWob)
const half = stack(dKick, dSnare, mPad, bSub)
p('song', arrange([8, full], [4, half], [8, full], [4, intro]))
sidechain('kick', { depth: 0.75, release: 0.16, duck: { sub: 1, wob: 0.55, pad: 0.8 } })
masterCompress({ threshold: -6, ratio: 2, attack: 25, release: 150, makeup: 1 })

visual(\`
fn render(uv: vec2f) -> vec4f {
  let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
  let r = length(p);
  // the wob warps the geometry (smooth motion); the ring stays evenly lit
  let warp = hit_wob * 0.35 * sin(r * 14.0 - time * 6.0);
  let rr = r + warp;
  let s = spectrum(fract(rr * 1.5));
  let ring = smoothstep(0.08, 0.0, abs(rr - (0.35 + s * 0.5)));
  // kick bloom is warm and capped, not a pure-white flash
  let slam = hit_kick * exp(-r * 3.0) * 0.6;
  let sn = hit_snare * 0.5 * smoothstep(0.4, 0.0, abs(r - 0.85));
  let col = vec3f(0.6, 0.2, 0.95) * ring * (0.6 + hit_wob * 0.3)
          + vec3f(0.9, 0.7, 0.5) * slam
          + vec3f(0.1, 0.9, 0.7) * sn
          + vec3f(0.05, 0.02, 0.1);
  return vec4f(min(col, vec3f(1.0)), 1.0);
}
\`)
`

const trance = `// TRANCE: uplifting, ~132. The classic i-VI-III-VII (Am - F - C - G): a fat
// 5-saw supersaw pad + lead, a deep sub, an offbeat plucky bass, a bright
// clap on 2 & 4, four-on-the-floor. Everything pumps under the kick.

const kick = synth(({ gate, adsr, sine, noise, svf }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.07, s: 0, r: 0.04 })
  const sub = sine(pitch.pow(2).range(44, 190)).mul(adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.06 }))
  const click = svf(noise(), 3800, { mode: 'hp' }).mul(adsr(gate, { a: 0.0004, d: 0.018, s: 0, r: 0.01 })).mul(0.5)
  return sub.add(click).mul(1.4).tanh()
})
const clap = synth(({ gate, adsr, noise, svf }) => {
  const crack = svf(noise(), 2000, { mode: 'bp', res: 0.5 }).mul(adsr(gate, { a: 0.002, d: 0.12, s: 0, r: 0.09 }))
  const air = svf(noise(), 7000, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.06, s: 0, r: 0.05 })).mul(0.6)
  return crack.add(air).mul(1.2).tanh()
})
const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 9500, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.03, s: 0, r: 0.02 })).mul(0.28))
const sub = synth(({ note, gate, adsr, sine }) =>
  sine(note.freq).mul(adsr(gate, { a: 0.01, d: 0.2, s: 0.9, r: 0.12 })).mul(1.15).tanh())
const bass = synth(({ note, gate, adsr, saw, ladder }) => {
  const f = note.freq
  const sup = saw(f).add(saw(f.mul(1.006))).mul(0.55)
  return ladder(sup, 900, { res: 0.4 }).mul(adsr(gate, { a: 0.002, d: 0.08, s: 0.1, r: 0.04 }))
})
const pad = synth(
  ({ note, gate, adsr, saw, svf }) => {
    const f = note.freq
    const sup = saw(f).add(saw(f.mul(1.006))).add(saw(f.mul(0.994))).add(saw(f.mul(1.013))).add(saw(f.mul(0.987))).mul(0.24)
    return svf(sup, 170, { mode: 'hp' }).mul(adsr(gate, { a: 0.08, d: 0.4, s: 0.7, r: 0.5 }))
  },
  ({ input, chorus, reverb }) => {
    const w = chorus(input, { rate: 0.4, depth: 0.005, mix: 0.9 })
    return w.mix(reverb(w, { roomSize: 0.9, damp: 0.35 }), 0.45)
  },
)
const lead = synth(
  ({ note, gate, adsr, saw }) => {
    const f = note.freq
    const sup = saw(f).add(saw(f.mul(1.007))).add(saw(f.mul(0.993))).add(saw(f.mul(1.014))).add(saw(f.mul(0.986))).mul(0.24)
    return sup.mul(adsr(gate, { a: 0.02, d: 0.3, s: 0.6, r: 0.3 }))
  },
  ({ input, delay, reverb, eq, param }) => {
    // eq shapes the 5-saw stack: high-pass the low mud so it doesn't fight the
    // sub, and a gentle 'air' shelf so the lead cuts OVER the pad without just
    // getting louder — carving, not boosting, is the mix move.
    const shaped = eq(input, [
      { type: 'hp', freq: 220 },
      { type: 'highshelf', freq: 6500, gain: 3 },
    ])
    const e = shaped.add(delay(shaped, 0.214, 0.35))
    // drivable post 'wet': open the reverb live for the breakdown, tighten it
    // for the drop (.ctrl('wet', ...) on the pattern below)
    const wet = param('wet', 0.4, { min: 0, max: 0.75 })
    return e.mix(reverb(e, { roomSize: 0.85, damp: 0.4 }), wet)
  },
)

setCps(0.577)
const dKick = note('c1*4').sound('kick').gain(1.0)
const dClap = note('~ c3 ~ c3').sound('clap').gain(0.65)
const dHat = note('~ c5 ~ c5 ~ c5 ~ c5').sound('hat').gain(0.4)
const bSub = note('<g#1 e1 b1 f#1>').sound('sub').gain(0.55).dur(0.98)
const bBass = note('<g#2 e2 b2 f#2>').struct(mini('~ t ~ t ~ t ~ t')).sound('bass').gain(0.6)
const mPad = chord('<G#m E B F#>').sound('pad').gain(0.32).dur(0.98)
const mLead = n('<7 ~ 11 ~ 14 12 11 9>').scale('g# minor').sound('lead')
  .ctrl('wet', slider(0.4, 0, 0.75)).gain(0.42).dur(0.85)
const intro = stack(mPad, bSub)
const build = stack(dKick, dHat, bSub, bBass, mPad)
const full = stack(dKick, dClap, dHat, bSub, bBass, mPad, mLead)
p('song', arrange([8, full], [4, build], [8, full], [4, intro]))
sidechain('kick', { depth: 0.9, release: 0.16, duck: { sub: 0.95, pad: 1, bass: 0.55, lead: 0.45 } })
masterCompress({ threshold: -6, ratio: 2, attack: 25, release: 150, makeup: 1 })

visual(\`
fn render(uv: vec2f) -> vec4f {
  let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
  let r = length(p);
  let a = atan2(p.y, p.x);
  let rays = pow(0.5 + 0.5 * sin(a * 8.0 + phase * 6.2831853), 3.0);
  let s = spectrum(fract(r));
  let col = vec3f(0.3, 0.6, 1.0) * rays * (0.35 + hit_lead * 0.4)
          + vec3f(0.2, 0.9, 0.9) * smoothstep(0.05, 0.0, abs(r - 0.5 - s * 0.3)) * (0.5 + level * 0.4)
          + vec3f(0.5, 0.7, 1.0) * hit_kick * exp(-r * 3.5) * 0.5;
  return vec4f(min(col, vec3f(1.0)), 1.0);
}
\`)
`

const futureBass = `// FUTURE BASS: bright and colourful. IV-V-iii-vi in C (Fmaj9 - G - Em9 - Am9)
// on a fat detuned-supersaw chord stack with an LFO filter, a clean sub,
// punchy half-time drums, and a hard sidechain pump that makes it breathe.
// The chord's POST chain is the genre in a nutshell: OTT (the multiband
// glue) + an exciter for sheen, and a live-drivable 'wet' reverb param.

const kick = synth(({ gate, adsr, sine, noise, svf }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.08, s: 0, r: 0.05 })
  const sub = sine(pitch.pow(2).range(44, 195)).mul(adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.06 }))
  const click = svf(noise(), 4000, { mode: 'hp' }).mul(adsr(gate, { a: 0.0004, d: 0.02, s: 0, r: 0.01 })).mul(0.55)
  return sub.add(click).mul(1.45).tanh()
})
const snare = synth(({ gate, adsr, noise, svf, sine }) => {
  const body = sine(190).mul(adsr(gate, { a: 0.001, d: 0.11, s: 0, r: 0.05 }))
  const crack = svf(noise(), 3000, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.2, s: 0, r: 0.1 }))
  const snap = svf(noise(), 6000, { mode: 'bp', res: 0.4 }).mul(adsr(gate, { a: 0.0005, d: 0.05, s: 0, r: 0.03 })).mul(0.6)
  return body.add(crack).add(snap).mul(1.25).tanh()
})
const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 11000, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.025, s: 0, r: 0.02 })).mul(0.28))
const sub = synth(({ note, gate, adsr, sine }) =>
  sine(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.9, r: 0.1 })).mul(1.15).tanh())
const chords = synth(
  ({ note, gate, param, adsr, saw, ladder, lfo, svf }) => {
    const f = note.freq
    const sup = saw(f).add(saw(f.mul(1.007))).add(saw(f.mul(0.993))).add(saw(f.mul(1.014))).add(saw(f.mul(0.986))).mul(0.22)
    const cut = lfo(param('wob', 1.5, { min: 0.25, max: 8 }), 'sine').range(700, 5400)
    return svf(ladder(sup, cut, { res: 0.3 }), 170, { mode: 'hp' }).mul(adsr(gate, { a: 0.05, d: 0.3, s: 0.8, r: 0.25 }))
  },
  ({ input, chorus, reverb, exciter, ott, param }) => {
    const w = chorus(input, { rate: 0.5, depth: 0.007, mix: 0.8 })
    // POST params are drivable too: .ctrl('wet', ...) automates this reverb
    // blend live, exactly like a voice param (the whole post chain runs once
    // over the summed voices, stereo-decorrelated).
    const wet = param('wet', 0.35, { min: 0, max: 0.7 })
    const spaced = w.mix(reverb(w, { roomSize: 0.85, damp: 0.4 }), wet)
    // exciter = air/sheen on top; OTT = the future-bass "glue" that makes the
    // supersaw read louder + fuller. Keep OTT gentle (depth 0.3) so it lifts
    // detail without pumping the whole chord flat.
    return ott(exciter(spaced, { freq: 5000, amount: 0.3 }), { depth: 0.3 })
  },
)

setCps(0.625)
const dKick = note('c1 ~ ~ ~ c1 ~ c1 ~').sound('kick').gain(1.0)
const dSnare = note('~ ~ c3 ~ ~ ~ c3 ~').sound('snare').gain(0.9)
const dHat = note('c5*8').sound('hat').gain(rand.range(0.35, 0.6))
const bSub = note('<a1 e1 a1 f#1>').sound('sub').gain(0.5).dur(0.9)
// .ctrl('wob') sweeps the voice filter LFO; .ctrl('wet') opens the post reverb
// (a bright drag on the drop) — two params, voice + post, driven the same way.
const mChords = chord('<Amaj9 E A6 F#m>').sound('chords')
  .ctrl('wob', '<1 2 4 2>').ctrl('wet', slider(0.35, 0, 0.7)).gain(0.5).dur(0.95)
const intro = stack(mChords, bSub)
const full = stack(dKick, dSnare, dHat, bSub, mChords)
p('song', arrange([8, full], [4, intro], [8, full], [4, intro]))
sidechain('kick', { depth: 0.92, release: 0.24, duck: { chords: 1, sub: 1 } })
masterCompress({ threshold: -6, ratio: 2, attack: 25, release: 150, makeup: 1 })

visual(\`
fn render(uv: vec2f) -> vec4f {
  let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
  var acc = 0.0;
  for (var i = 0; i < 3; i = i + 1) {
    let fi = f32(i);
    let c = vec2f(sin(time * 0.3 + fi * 2.1), cos(time * 0.24 + fi * 1.7)) * 0.5;
    acc = acc + (0.14 + hit_chords * 0.06) / (length(p - c) + 0.12);
  }
  let s = spectrum(uv.x);
  let col = vec3f(0.9, 0.4, 0.8) * acc * (0.5 + hit_chords * 0.3)
          + vec3f(0.3, 0.7, 1.0) * s * 0.6
          + vec3f(1.0, 0.9, 0.7) * hit_kick * exp(-length(p) * 3.0) * 0.5;
  return vec4f(min(col * (0.75 + level * 0.35), vec3f(1.0)), 1.0);
}
\`)
`

const fmPresets = `// FM PRESETS: classic operator-FM voices built from fm(). The recipe is
// always a carrier + a modulator: its RATIO to the note sets the harmonic
// character (whole = musical, non-whole = metallic/inharmonic) and its INDEX
// (the modulator's amplitude, in cycles) sets brightness. An envelope on the
// index makes the tone move; feedback grows an operator toward a buzzy saw.

setCps(0.44)

// BELL — inharmonic 1.4 ratio + a long index decay: metallic strike, sine tail
const bell = synth(({ note, gate, adsr, fm }) => {
  const mod = fm(note.freq.mul(1.4)).mul(adsr(gate, { a: 0.001, d: 1.6, s: 0, r: 0.6 }).mul(6))
  return fm(note.freq, mod).mul(adsr(gate, { a: 0.001, d: 2, s: 0, r: 0.8 })).mul(0.5)
})

// E-PIANO — 3:1 "tine" ratio + a touch of feedback for the Rhodes bark
const ep = synth(({ note, gate, adsr, fm }) => {
  const tine = fm(note.freq.mul(3)).mul(adsr(gate, { a: 0.001, d: 0.4, s: 0, r: 0.2 }).mul(3))
  return fm(note.freq, tine, { feedback: 0.1 }).mul(adsr(gate, { a: 0.002, d: 1.4, s: 0.15, r: 0.4 })).mul(0.5)
})

// BASS — 1:1 ratio, quick index decay, a little feedback: punchy and round
const bass = synth(({ note, gate, adsr, fm }) => {
  const mod = fm(note.freq).mul(adsr(gate, { a: 0.001, d: 0.18, s: 0.1, r: 0.1 }).mul(2))
  return fm(note.freq, mod, { feedback: 0.2 }).mul(adsr(gate, { a: 0.001, d: 0.3, s: 0.5, r: 0.1 }))
})

// BRASS — 1:1 ratio with a SLOW index swell: the horn grows into the note
const brass = synth(({ note, gate, adsr, fm }) => {
  const mod = fm(note.freq).mul(adsr(gate, { a: 0.25, d: 0.2, s: 0.8, r: 0.3 }).mul(2.2))
  return fm(note.freq, mod).mul(adsr(gate, { a: 0.12, d: 0.2, s: 0.85, r: 0.35 })).mul(0.4)
})

p('bass', note('<c2 a1 f2 g2>').sound('bass'))
p('keys', chord('<Cmaj7 Am7 Fmaj7 G7>').sound('ep').dur(0.9).gain(0.9))
p('brass', chord('<Cmaj7 Am7 Fmaj7 G7>').sound('brass').dur(0.9).gain(0.5))
p('bells', note('<c6 e6 g6 b6>').sound('bell').gain(0.4))
`

const chiptune = `// CHIPTUNE: NES-style. Two pulse voices, a bitcrushed 4-bit triangle bass,
// and LFSR noise for drums, plus the fake-chord arpeggio trick.
setCps(0.5)

// pulse lead at 25% duty (the classic thin NES square)
const lead = synth(({ note, gate, adsr, pulse }) =>
  pulse(note.freq, 0.25).mul(adsr(gate, { a: 0.001, d: 0.05, s: 0.6, r: 0.04 })).mul(0.35))

// harmony pulse with a wobbling duty for movement
const harm = synth(({ note, gate, adsr, pulse, lfo }) =>
  pulse(note.freq, lfo(4).range(0.15, 0.5)).mul(adsr(gate, { a: 0.001, d: 0.08, s: 0.4, r: 0.04 })).mul(0.28))

// triangle bass, crushed to 4 bits for the NES stair-step
const bass = synth(({ note, gate, adsr, tri, bitcrush }) =>
  bitcrush(tri(note.freq), { bits: 4 }).mul(adsr(gate, { a: 0.001, d: 0.06, s: 0.7, r: 0.05 })).mul(0.6))

// LFSR noise: bright white hiss = hats, low periodic buzz = snare
const hat = synth(({ gate, adsr, lfsr }) =>
  lfsr(11000).mul(adsr(gate, { a: 0.001, d: 0.025, s: 0, r: 0.02 })).mul(0.25))
const snare = synth(({ gate, adsr, lfsr }) =>
  lfsr(2400, { mode: 'periodic' }).mul(adsr(gate, { a: 0.001, d: 0.12, s: 0, r: 0.05 })).mul(0.4))

// fast arp = the chip fake-chord trick: cycle a chord's tones inside the step
p('lead', chord('<C Am F G>').arp('up').fast(2).sound('lead'))
p('harm', note('<g4 e4 c4 d4>').sound('harm').gain(0.8))
p('bass', note('<c2 a1 f1 g1>').sound('bass'))
p('hats', note('c5*8').sound('hat'))
p('snare', note('~ c4 ~ c4').sound('snare'))
`

const singing = `// SINGING — a neural voice sings your lyrics over a full band.
// sing(voice, lyrics, notes): both lyrics and notes are mini-notation, one
// syllable per note (hyphens split a word: "twin-kle" = 2 notes). First Run
// downloads the voice models once (cached after); the vocal bakes in the
// background and loops in time with everything else.

setCps(0.0417) // the whole verse is ONE long cycle — each note is ~120 BPM

// --- drum kit ---
const kick = synth(({ gate, adsr, sine }) => {
  const p = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 }) // pitch drop
  const a = adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.08 }) // amp
  return sine(p.pow(2).range(45, 160)).mul(a).tanh()
})
const snare = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 1800, { mode: 'bp', res: 0.5 }).mul(adsr(gate, { a: 0.002, d: 0.12, s: 0, r: 0.08 })).mul(0.6))
const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 9000, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.04, s: 0, r: 0.03 })).mul(0.4))

// --- bass + keys ---
const bass = synth(({ note, gate, adsr, saw, ladder }) =>
  ladder(saw(note.freq), 420, { res: 0.3 }).mul(adsr(gate, { a: 0.005, d: 0.35, s: 0.4, r: 0.2 })).mul(0.22))
const piano = synth(({ note, gate, adsr, tri, sine }) => {
  const env = adsr(gate, { a: 0.004, d: 0.5, s: 0.25, r: 0.5 })
  return tri(note.freq).mul(0.5).add(sine(note.freq.mul(2)).mul(0.15)).mul(env).mul(0.22)
})

// The verse is one 12-bar cycle, so .fast(12) repeats a 1-bar drum pattern
// across all 12 bars — a steady 120 BPM groove.
p('kick',  note('c2*4').fast(12).sound('kick'))
p('snare', note('~ c2 ~ c2').fast(12).sound('snare'))
p('hats',  note('c5*8').fast(12).sound('hat').gain(0.7))

// bass roots + a lush 7th/9th reharm (Cmaj9–Am7–Fmaj7–G7 with ii–V pull and
// smooth voice-leading; [a,b,c] = a stacked chord), one chord per half-bar.
p('bass', note('c2 a1 f1 g1 e2 d2 g1 g1 c2 f1 g1 c2').sound('bass'))
p('piano', note(\`[c3,e3,g3,b3,d4] [a2,e3,g3,c4] [f2,a2,c3,e3] [g2,b2,d3,f3]
                  [e2,g3,b3,d4]    [d3,f3,a3,c4] [g2,c3,e3,b3] [g2,b2,f3,a3]
                  [c3,e3,g3,b3,d4] [f2,a2,c3,e3] [g2,c3,d3,f3] [c3,e3,g3,b3]\`).sound('piano'))

// the voice. sing() returns a normal pattern, so the vocal is a first-class
// channel: chain FX, nudge its timing, route it to buses. Try another voice:
// "kizuna", "rise". opts.post is a per-synth DSP FX chain (here a touch of
// reverb ON the vocal); opts.name lets bus()/sidechain() target it by name.
p('vox', sing('barbara',
  \`twin-kle twin-kle lit-tle star how I won-der what you are
   up a-bove the world so high like a dia-mond in the sky
   twin-kle twin-kle lit-tle star how I won-der what you are\`,
  \`c4 c4 g4 g4 a4 a4 g4@2 f4 f4 e4 e4 d4 d4 c4@2
   g4 g4 f4 f4 e4 e4 d4@2 g4 g4 f4 f4 e4 e4 d4@2
   c4 c4 g4 g4 a4 a4 g4@2 f4 f4 e4 e4 d4 d4 c4@2\`,
  { name: 'vox', post: ({ input, reverb, mix }) => mix(input, reverb(input), 0.25) })
  .gain(0.95)) // (.late()/.early() are free for feel — timing is on-beat already)
`

/** Locally-added examples from the gitignored `./local/` directory — each file
 *  default-exports an Example (or Example[]). Loaded via Vite's import.meta.glob
 *  in the app + tests; a NO-OP under plain node (the tsx render tools, where
 *  glob is undefined) — render those with scripts/render-local.ts instead.
 *  Lets you keep private/WIP examples without committing them. */
const loadLocalExamples = (): Example[] => {
  let mods: Record<string, unknown> = {}
  try {
    // MUST be a direct literal call — Vite rewrites `import.meta.glob('…')` at
    // build time (reading it into a variable first defeats that and loads
    // nothing). Under plain node (the tsx render tools) import.meta.glob is
    // undefined, so the call throws and we fall back to no local examples.
    // @ts-ignore import.meta.glob is a Vite-only macro, untyped outside the app tsconfig
    mods = import.meta.glob('./local/*.{ts,js}', { eager: true }) as Record<string, unknown>
  } catch {
    return []
  }
  return Object.values(mods).flatMap((m) => {
    const v = (m as { default?: unknown }).default
    if (Array.isArray(v)) return v as Example[]
    if (v !== null && typeof v === 'object' && 'code' in (v as object)) return [v as Example]
    return []
  })
}

/* Rondo-language example sources. MOBILE-FORMATTED on purpose: rondo is the
 * phone-first surface, so lines stay under ~44 chars and comments sit on
 * their OWN line above the code — a long trailing comment wraps mid-word on
 * a phone and reads terribly. */

/** The acid example in the rondo language. */
const acidRondo = `# rondo — the terse live-coding language.
# a synth is a pipeline: one stage per
# line, each feeding the next.
# \`name = …\` lines are modulation.

synth acid
  # a saw + a sub-octave square
  saw + square note/2
  # filter; its input is the line above
  ladder cutoff * env^2 res:.85
  # the VCA
  * env
  env    = adsr .003 .2 .3 .1
  cutoff = knob 800 80..8000 log

play acid
  0 0 3 5 0 0 7 5  scale:a-min
  # sweep the filter (turns the knob)
  cutoff: sine 200..2400 slow:4
  # every 4th cycle, backwards
  every 4: rev

cps .6
`

/** Wobble bass — the registry surface in one patch. */
const wobbleRondo = `# wobble bass. supersaw + sub through an
# LFO-swept ladder, tube drive, delay,
# saturation — a mono glide bass.

synth wob mono glide:.05
  supersaw detune:.5 mix:.85
  + square note/2
  ladder cut res:.8
  shape 2.2 type:tube
  delay .375 .25
  * env
  tanh
  cut = lfo rate tri -> 150..3200
  rate = knob 4 .5..16
  env = adsr .005 .1 .9 .06

play wob
  0 0 ~ 0 0 ~ 3 2  scale:e-min
  gain: .8
  dur: .9

cps .55
`

/** A full club track — sections, chords, bus, pump, glue. Pure rondo. */
const clubRondo = `# a full club track in pure rondo.
# sections, named chords, a reverb bus,
# sidechain pump, master glue.

synth kick
  sine drop
  * amp
  tanh
  drop = adsr .001 .09 0 .05 ^ 2 -> 45..160
  amp  = adsr .001 .2 0 .07

synth sub mono glide:.04
  sine
  mix edge .15
  onepole 380
  * env
  tanh
  edge = saw note
  env = adsr .008 .12 .5 .07

synth stab
  supersaw detune:.4 mix:.7
  ladder cut res:.6
  * env
  cut = env ^ 2 -> 300..3400
  env = adsr .002 .16 0 .09
  post
    delay .28 .3
    reverb room:.7 mix:.25

section intro 4
  play stab
    <Em Em Cmaj7 G>
    dur: .95
    gain: .4

section drop 8
  play kick
    c2 c2 c2 c2
  play sub
    ~ e1 ~ e1 ~ e1 ~ e1
    dur: .18
  play stab
    <Em Em Cmaj7 G>
    struct ~ t ~ t t ~ ~ t
    dur: .2
    gain: .6

song intro drop drop intro

bus space
  reverb room:.9 damp:.35
  send stab .3

sidechain kick depth:.8 release:.15 sub:.95 stab:.6

master threshold:-6 ratio:2 attack:25 release:150 makeup:1

cps .55
`

/** Compile a rondo example to its rondocode twin at module load — ONE source
 *  of truth, and a compile failure is loud in every test run. */
const fromRondo = (src: string): string => {
  const r = compile(src)
  if (!r.ok) throw new Error(`rondo example failed to compile: ${JSON.stringify(r.errors)}`)
  return r.code
}

/** The shipped examples (stable, committed). */

export const SHIPPED_EXAMPLES: Example[] = [
  { name: 'acid', code: acid, rondo: acidRondo },
  { name: 'visuals', code: visuals },
  { name: 'techno', code: techno },
  { name: 'dubstep', code: dubstep },
  { name: 'trance', code: trance },
  { name: 'future bass', code: futureBass },
  { name: 'ambient bells', code: ambientBells },
  { name: 'drum groove', code: drumGroove },
  { name: 'fm keys', code: fmKeys },
  { name: 'fm presets', code: fmPresets },
  { name: 'chiptune', code: chiptune },
  { name: 'chords & arps', code: chordsArp },
  { name: 'generative', code: generative },
  { name: 'edm', code: edm },
  { name: 'synthscape', code: synthscape },
  { name: 'arrangement', code: arrangement },
  { name: 'sampler', code: sampler },
  { name: 'granular', code: granular },
  { name: 'singing', code: singing },
  // rondo-first examples: the JS twin is TRANSPILED from the rondo source at
  // load, so the two can never drift
  { name: 'wobble', code: fromRondo(wobbleRondo), rondo: wobbleRondo },
  { name: 'club', code: fromRondo(clubRondo), rondo: clubRondo },
]

/** Shipped examples + any local (gitignored) ones. This is what the app loads. */
export const EXAMPLES: Example[] = [...SHIPPED_EXAMPLES, ...loadLocalExamples()]
