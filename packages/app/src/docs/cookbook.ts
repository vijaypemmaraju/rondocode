/* ------------------------------------------------------------------------- *
 * The cookbook: recipes, not lessons.
 *
 * The guide is organised by CONCEPT — here is what a pattern is, here is what
 * a filter is — which is the right shape when you are learning the system and
 * the wrong one when you already know what you want and cannot find how to say
 * it. A recipe is indexed by the WANT.
 *
 * Three rules make it a different content type rather than another guide
 * group, and all three are enforced by cookbook.test.ts:
 *
 *   1. COMPLETE. A recipe is one whole program you can paste and hear, never a
 *      fragment with the synth left as an exercise. A guide snippet teaches an
 *      idea; a recipe hands you a working thing.
 *   2. RUNNABLE, and proven so. Every recipe is compiled, staged and rendered
 *      by the test suite, and must produce audible output. A cookbook of
 *      recipes that do not run is worse than no cookbook: it costs the reader
 *      their trust in everything else on the page.
 *   3. ONE MOVE. `why` names the single thing that makes it work — the bit you
 *      could not have guessed. Not a walkthrough of every line.
 *
 * Written in rondo because a recipe is meant to be read at a glance, and the
 * terse form is where that pays. Every one round-trips to JavaScript.
 * ------------------------------------------------------------------------- */

export interface Recipe {
  id: string
  /** The want, phrased the way a reader would say it to themselves. */
  title: string
  /** Scannable, and the search index reads them. */
  tags: string[]
  /** ONE complete program. Paste it, press play, hear the thing. */
  code: string
  /** The single move that makes it work, and why it is not obvious. */
  why: string
}

export const RECIPES: Recipe[] = [
  {
    id: 'mic-strip',
    title: 'Make a microphone usable on stage',
    tags: ['mic', 'live', 'gate', 'de-esser', 'compressor', 'limiter', 'vocal'],
    code: `synth voice
  mic
  noisegate threshold:-42 range:-35 hold:60 release:120
  eq hp 90 peak 3000 2 1.2
  deess freq:6200 threshold:-28 ratio:5
  compress threshold:-20 ratio:3 attack:8 release:120 makeup:6
  post
    reverb room:.5 damp:.4 mix:.14
    limiter ceiling:-1 lookahead:5

# ONE held note holds the channel open
play voice
  c3
  dur: .99

cps .5`,
    why: 'The ORDER is the recipe: each line fixes something the one above it cannot. Gate FIRST, so nothing downstream amplifies the room you were about to remove -- that single choice is most of the difference between a usable mic and a noisy one. The eq peak adds presence where words live, which is usually what made the sibilance sharp, so the de-esser follows it rather than preceding it, and the limiter is last because a ceiling is only a ceiling if nothing comes after. These numbers are a starting point tuned against a synthetic voice; the gate threshold depends entirely on your room.',
  },
  {
    id: 'harmoniser',
    title: 'Add a harmony line without writing one',
    tags: ['pitchshift', 'harmony', 'voice', 'mic', 'effect'],
    code: `synth lead
  saw note
  ladder 2800 res:.3
  * env
  * .35
  pitchshift semitones:7 window:40 mix:.45
  env = adsr .01 .12 .7 .2
  post
    reverb room:.5 mix:.2

play lead
  0 3 5 7 5 3
  scale:a-min
  dur: .9

cps .5`,
    why: 'The interval is FIXED, which is the thing to know before you reach for it. This is a hardware harmoniser, not a diatonic one: every note gets a fifth above it, so it stays in key here only because a fifth above the minor scale degrees used happens to land in the scale. `mix` is what makes it a harmony rather than a transposition -- at 1 you have simply moved the part, at 0.45 the original is still underneath. `window` is the artefact and cannot be turned off, because the read head has to wrap somewhere: 40 ms is short enough to keep the attacks and long enough not to warble. And at 0 semitones the node returns the input untouched, so it is safe to leave in a chain you are auditioning.',
  },
  {
    id: 'mono-bass',
    title: 'Stop the low end wandering on a big system',
    tags: ['stereo', 'mid/side', 'mix', 'mastering', 'bass'],
    code: `synth sub
  sine
  * adsr .005 .1 .9 .1
  * .5
  post
    width .7

synth stab
  supersaw note detune:.35 mix:.8
  ladder cut res:.5
  * env
  cut = env ^ 2 -> 400..3600
  env = adsr .002 .18 0 .1
  post
    width .9

play sub
  <c2 c2 g1 a1>
  dur: .95

play stab
  <Cmaj9 Cmaj9 Gadd9 Am9>
  struct t ~ t t ~ t ~ t
  dur: .2

# the sides get wider, and everything
# under 120 Hz folds to the middle
stereo width:1.25 monobelow:120

cps .5`,
    why: 'Widening a mix widens the BASS too, and a wide low end is the one thing that will not survive the room: on a system with a single sub the sides are summed, and anything hard-panned down there either cancels or wanders. `monobelow` collapses just that band and leaves the width above it. Both halves are mono-safe by construction -- scaling the sides never touches the middle, and the middle IS the mono sum -- so folding the whole mix to mono comes out bit-identical whatever `width` is set to. That is what `width` in a post chain cannot promise: it invents stereo out of mono by combing the two channels, so a soloed side sounds phasey.',
  },
  {
    id: 'note-expression',
    title: 'Give every note its own feel',
    tags: ['expression', 'velocity', 'probability', 'notes', 'humanize'],
    code: `synth lead
  saw note*bend
  ladder cut res:.35
  * amp
  amp = adsr .01 .12 .7 .18
  cut = amp ^ 2 -> 500..4200
  expr = knob 0 -1..1
  shape = env .07 .06 .2 0 .3 0
  bend = shape * expr + 1

# each note carries its OWN values:
#   '1 / '-1   bend up / down into it
#   'gain:      that note's velocity
#   'chance:   the odds it plays
play lead
  0'1'gain:.9 3'gain:.5 5'-1'gain:.8 7'gain:.4'chance:.5
  9'1'gain:.85 7'gain:.45 5'0'gain:.7 3'gain:.4'chance:.6
  scale: a-min

cps .5`,
    why: 'A modifier line is a PATTERN, so it lines up by TIME: `vel: .9 .5 .8` against a flat row looks per-note and stops corresponding the moment the notation grows a rest or a subgroup. A value written ON the note cannot drift, because it never leaves the note. `chance` is reproducible rather than random -- it draws from the same time-locked stream `degradeBy` uses, so a note that fires on cycle 3 fires on cycle 3 every time round, which is what lets a probabilistic line live in a piece instead of only in a jam.',
  },
  {
    id: 'auto-wah',
    title: 'Make a sound react to how loud something is',
    tags: ['follow', 'envelope', 'mic', 'filter', 'dynamics', 'sidechain'],
    code: `synth wah
  supersaw note detune:.25
  ladder cut res:.55
  * adsr .01 .12 .85 .25
  * .35
  amp = follow mic attack:8 release:160 mode:rms
  cut = amp ^ .6 -> 350..6500
  post
    reverb room:.6 mix:.2

play wah
  <a1 f1 c2 g1>/2
  dur: .95

cps .5`,
    why: 'This is the half `sidechain` does not cover. Sidechain ducks on note ONSETS -- which is why the pump keeps working when you mute the kick -- so nothing in the engine reacted to how loud anything actually IS. `follow` returns the level as an ordinary signal, so it composes: multiply by it, subtract it from 1 to duck, or map it through `->` into a cutoff like this. The asymmetry is the craft: a fast attack catches the transient, a slow release stops the control chattering between syllables. Equal times give a tremolo of the source waveform, which is the classic way to make a follower useless.', },
  {
    id: 'pump',
    title: 'Make everything duck under the kick',
    tags: ['sidechain', 'mix', 'pump', 'house'],
    code: `synth kick
  sine drop
  * amp
  tanh
  drop = adsr .001 .09 0 .05 ^ 3 -> 48..190
  amp = adsr .001 .16 0 .06

synth pad
  supersaw note detune:.2
  * adsr .4 .3 .8 .6

play kick
  c2 c2 c2 c2

play pad
  <c3 a2 f2 g2>/4

sidechain kick depth:.8 release:400

cps .5`,
    why: 'The duck is triggered by the kick\'s note ONSETS, not by how loud it is. So the pump keeps working if you turn the kick down, and it keeps working if you mute the kick entirely, which is usually a surprise. If you want them to stop together, put both on one control: `switch drums 1 0`, then `gain: drums * 0.9` on the kick and `depth:drums` on the sidechain.',
  },
  {
    id: 'real-room',
    title: 'Put a sound in a real space, not an approximation of one',
    tags: ['convolve', 'reverb', 'impulse response', 'space', 'sample'],
    code: `synth keys
  (saw note) * .5
  svf 2400 res:.15
  * adsr .01 .25 .5 .35
  convolve hall mix:.45

play keys
  <Cmaj7 Am7 Fmaj7 G>
  dur: .95

cps .4`,
    why: 'An impulse response is what a room does to a single click, and it turns out that IS the room -- convolving with it reproduces the space completely, where `reverb` approximates one with a network of delays. The trade is the knob: `reverb` lets you move `room` and `damp` while it plays, and a convolution can only ever be the measurement you handed it. The IR is a SAMPLE, so anything you can load is a space: `hall` ships built in, and convolving with something that is not a room at all -- a snare hit, a struck pipe -- is a standard way to get a sound nothing else makes. It is normalised to unit energy, so `mix` means the same thing whatever you point it at.',
  },
  {
    id: 'sweeping-modulation',
    title: 'Make a chorus or flanger move on its own',
    tags: ['chorus', 'flanger', 'phaser', 'lfo', 'automation', 'modulation'],
    code: `synth pad
  supersaw note detune:.22
  svf 3200 res:.15
  * adsr .3 .3 .8 .5
  * .3
  post
    flanger rate:sweep depth:.8 feedback:.75 mix:.45
    reverb room:.7 damp:.4 mix:.2
    sweep = lfo .05 -> .06..1.4

play pad
  <Cmaj9 Am9>/2
  dur: .95

cps .4`,
    why: 'The RATE is the thing being automated, not the depth. A flanger already sweeps -- that is what it is -- so moving its depth just makes the sweep deeper, while moving its rate changes the character of the sweep itself, from a slow jet-plane arc to a shimmer and back. That was impossible until these three nodes read their controls per sample: `rate`, `depth`, `feedback` and `mix` were construction values on chorus, phaser and flanger, so an LFO on them compiled and did nothing. Use a very slow LFO (0.05 Hz is a twenty-second cycle) or the movement stops sounding like an effect and starts sounding like a fault.',
  },
  {
    id: 'supersaw',
    title: 'Build a wide supersaw lead',
    tags: ['synth', 'lead', 'supersaw', 'unison', 'trance'],
    code: `synth lead unison:9 detune:22 spread:1 curve:4
  saw note
  ladder cut * env ^ 2 res:.35
  * env
  * .5
  env = adsr .01 .3 .6 .4
  cut = knob 1200 200..9000 log
  post
    width .8
    reverb room:.6 mix:.25

play lead
  <0 3 5 7> 3 5 7
  scale:a-min
  dur: .9

cps .5`,
    why: 'Unison WITHOUT detune is nine copies of the same pitch, which sounds identical to one copy and costs nine times the CPU. The width IS the detune, in cents. `curve:4` then pulls the inner voices back toward the centre so the stack keeps a definite pitch instead of smearing into a chord.',
  },
  {
    id: 'tape',
    title: 'Stop a part sounding perfectly in tune',
    tags: ['tape', 'wow', 'flutter', 'saturation', 'lofi', 'character'],
    code: `synth keys
  (saw note) * .4
  svf 2100 res:.2
  * adsr .02 .25 .6 .3
  tape wow:.5 flutter:.3 sat:.35 tone:8500

play keys
  <Cmaj7 Am7 Dm7 G7>
  dur: .95

cps .4`,
    why: 'WOW is the one doing the work, and it is not the saturator. An oscillator holds a pitch perfectly and nothing physical ever has -- so a held chord that drifts a fraction of a percent stops sounding synthesised, and that is most of what people mean by "tape". `flutter` is the same thing about ten times faster, too quick to hear as pitch, so it lands as texture instead. Both are TWO oscillators at unrelated rates, because a single one is a vibrato and sounds like one. `tone` matters more than it looks: taking the top off is most of why a saturator alone sounds harsh where tape sounds warm.', },
  {
    id: 'talkbox',
    title: 'Sing through a synth with the microphone',
    tags: ['vocoder', 'mic', 'talkbox', 'voice'],
    code: `synth talkbox
  supersaw note detune:.4
  * 3
  vocoder v bands:48
  * env
  env = adsr .02 .4 .9 .4
  v = svf voice 140 mode:hp
  voice = mic * 4
  post
    reverb room:.7 mix:.25

play talkbox
  <[0 3 5 3]*2 [-2 2 4 2]*2>
  scale:d-min
  dur: 1.4

cps .45`,
    why: 'Clean the microphone BEFORE it drives the vocoder. `mic` is an ordinary signal, so it takes gain and filters like anything else, and the high-pass at 140 Hz is what stops plosives and desk rumble opening the low bands on every "p". Headphones, or the mic hears the synth and the whole thing runs away.',
  },
  {
    id: 'one-knob',
    title: 'Control several things with one knob',
    tags: ['macro', 'knob', 'performance'],
    code: `macro bright 1400 300..7000 log

synth stab
  saw note
  ladder bright res:.3
  * env
  env = adsr .005 .18 .3 .2
  post
    delay .1875 .3 mix:mx
    norm = bright / 7000
    mx = .35 - norm * .3

play stab
  0 ~ 3 5 ~ 7 ~ 3
  scale:c-min
  dur: .6
  gain: bright / 9000 + .5

cps .52`,
    why: 'A macro is a VALUE, so ratios and formulas come free: the same knob opens the filter, shortens the delay as it brightens, and lifts the level, each by its own arithmetic. There is no wiring step and no depth setting. Note the delay mix runs BACKWARDS on purpose, so the darker the patch the longer the tail.',
  },
  {
    id: 'ab-switch',
    title: 'Flip between two settings while playing',
    tags: ['switch', 'performance', 'arrangement'],
    code: `switch drive .9 .15
switch cut 6500 900

synth lead unison:7 detune:18
  saw note
  shape drive type:tube
  ladder cut res:.3
  * adsr .01 .2 .5 .3
  * .4

play lead
  0 3 5 3 7 5 3 0
  scale:e-min
  dur: .8

cps .5`,
    why: 'A switch is a knob with two values instead of a range, so tapping it swaps them IN THE SOURCE: `switch drive .9 .15` becomes `switch drive .15 .9`. The value it rests on is always the one written first, so the file alone tells you what you are hearing and the state survives a reload. Note it drives the SPINE, not the header: voice options like `unison:` are read once when the synth is built, so they take a literal number rather than a control.',
  },
  {
    id: 'acid',
    title: 'Get a 303 acid line with slides',
    tags: ['303', 'acid', 'slide', 'bass'],
    code: `synth acid mono glide:.06
  saw + square note/2 * .3
  ladder cut * env ^ 2 res:.85
  * env
  env = adsr .003 .2 .3 .1
  cut = knob 700 80..7000 log

play acid
  0 0 7 0 3 0 10 7
  scale:a-min
  dur: .9
  slide: 0 1 0 0 1 0 1 0

cps .55`,
    why: 'Glide only bends between notes that are LEGATO, and `slide:` is what decides which steps are legato. A step marked 1 slides into the next note instead of retriggering it, so the envelope does not restart and the pitch bends. Without `mono` there is nothing to slide from, because each note gets its own voice.',
  },
  {
    id: 'outside-scale',
    title: 'Play a note that is not in the scale',
    tags: ['scale', 'accidental', 'chromatic', 'notation'],
    code: `synth keys
  tri note
  mix saw note .3
  svf 2200 res:.2
  * adsr .01 .25 .4 .3
  * .5

play keys
  0 2 4 3# 4 2 0 -1b
  scale:c-maj
  dur: .8

cps .5`,
    why: 'Put a `#` or `b` AFTER the degree. `3#` is the fourth degree raised a semitone, which in C major is the F sharp that the scale does not contain. It is postfix rather than prefix because a `#` after a space starts a comment. A fractional degree does NOT work: `2.5` rounds to 3 rather than landing between.',
  },
  {
    id: 'arrangement',
    title: 'Arrange an intro, a drop and an outro',
    tags: ['arrangement', 'sections', 'song', 'form'],
    code: `synth kick
  sine drop
  * adsr .001 .16 0 .06
  drop = adsr .001 .09 0 .05 ^ 3 -> 48..190

synth lead
  saw note
  ladder 2600 res:.3
  * adsr .01 .2 .5 .2
  * .4

section intro 4
  play lead
    0 ~ 3 ~
    scale:a-min

section drop 8
  play kick
    c2 c2 c2 c2
  play lead
    0 3 5 7 5 3 0 -2
    scale:a-min

song intro drop drop intro

cps .5`,
    why: 'A section is a named span of N cycles holding whole play blocks, and `song` lists the order they run in. Repeating a name repeats the section, which is how you get eight bars of drop without writing it twice. The lengths are in cycles, so `section drop 8` is eight bars whatever the tempo.',
  },
  {
    id: 'euclid',
    title: 'Spread hits evenly over a bar',
    tags: ['euclid', 'rhythm', 'percussion'],
    code: `synth hat
  noise
  svf 7000 mode:hp
  * adsr .001 .03 0 .02
  * .4

synth clave
  sine 1100
  * adsr .001 .04 0 .02
  * .5

play hat
  c4(7,16)

play clave
  c6(3,8)

cps .5`,
    why: 'A bare degree needs a scale to become a pitch, so percussion is written as a NOTE NAME: `c4(7,16)` rather than `0(7,16)`, which would produce no sounding events at all. `(pulses,steps)` then spaces the pulses as evenly as the steps allow, which is where most world rhythms come from: (3,8) is the tresillo, (5,8) the cinquillo, (7,16) a steady shaker with a limp. Layering two different euclids over the same bar is how you get a groove that takes several bars to repeat.',
  },
  {
    id: 'wavetable-morph',
    title: 'Make a pad that keeps moving',
    tags: ['wavetable', 'pad', 'movement', 'lfo'],
    code: `synth pad unison:5 detune:14
  wavetable note scan table:harmonic
  svf 3400 res:.2
  * env
  env = adsr .6 .4 .85 .9
  base = env -> 0.1..0.6
  drift = lfo .07 -> -0.06..0.06
  scan = base + drift
  post
    width 1
    reverb room:.85 mix:.4

play pad
  <[0,2,4] [-3,0,2] [-1,1,3] [-3,0,2]>/4
  scale:d-min

cps .4

# a held chord that never sits still: the envelope sweeps the table
# and the slow LFO keeps wandering after the envelope has settled`,
    why: 'Two modulators on the same wavetable position, summed. The envelope makes the note ARRIVE somewhere, and the slow LFO keeps it moving after the envelope has finished. With only the envelope a long chord freezes the moment it reaches sustain, which is the thing that makes a pad sound synthetic.',
  },
]
