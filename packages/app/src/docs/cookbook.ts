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
  <c3 a2 f2 g2>
  dur: 4

sidechain kick depth:.8 release:.4

cps .5`,
    why: 'The duck is triggered by the kick\'s note ONSETS, not by how loud it is. So the pump keeps working if you turn the kick down, and it keeps working if you mute the kick entirely, which is usually a surprise. If you want them to stop together, put both on one control: `switch drums 1 0`, then `gain: drums * 0.9` on the kick and `depth:drums` on the sidechain.',
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
  <[0,2,4] [-3,0,2] [-1,1,3] [-3,0,2]>
  scale:d-min
  dur: 4

cps .4

# a held chord that never sits still: the envelope sweeps the table
# and the slow LFO keeps wandering after the envelope has settled`,
    why: 'Two modulators on the same wavetable position, summed. The envelope makes the note ARRIVE somewhere, and the slow LFO keeps it moving after the envelope has finished. With only the envelope a long chord freezes the moment it reaches sustain, which is the thing that makes a pad sound synthetic.',
  },
]
