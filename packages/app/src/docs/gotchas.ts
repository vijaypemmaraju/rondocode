/* ------------------------------------------------------------------------- *
 * Troubleshooting: things that look right and are not.
 *
 * A recipe answers "how do I say X". This answers "why didn't that work",
 * which is a different question with a different shape: you already wrote
 * something, it did not do what you expected, and the docs have to be
 * reachable from the SYMPTOM rather than from the feature you did not know
 * you needed.
 *
 * Every entry is a pair — the code that disappoints, and the same intent
 * working — because the diff IS the explanation. Prose describing a trap you
 * cannot see beside its fix is much harder to act on.
 *
 * THE TEST IS THE INTERESTING PART. gotchas.test.ts asserts that `fixed`
 * works AND that `broken` is still broken, in the specific way `fails` names.
 * So if the language later closes one of these traps, the suite fails and
 * says to delete the entry. A troubleshooting page that has quietly outlived
 * its problems is worse than none: it teaches workarounds for bugs that no
 * longer exist.
 *
 * Every entry here is a mistake that was actually made, most of them while
 * building this project.
 * ------------------------------------------------------------------------- */

/** How the broken version fails, which decides what the test asserts. */
export type FailureMode =
  /** rejected by the compiler */
  | 'compile'
  /** compiles, then rejected when the program is staged */
  | 'stage'
  /** runs and is accepted, and produces no sounding events */
  | 'silent'
  /** runs and sounds, and does something other than what was meant */
  | 'wrong'

export interface Gotcha {
  id: string
  /** What you SEE, phrased the way you would report it. */
  symptom: string
  tags: string[]
  /** The code that disappoints. Must still disappoint; the test checks. */
  broken: string
  /** The same intent, working. */
  fixed: string
  fails: FailureMode
  /** Why it happens. The mechanism, not a restatement of the fix. */
  why: string
}

export const GOTCHAS: Gotcha[] = [
  {
    id: 'stacked-lines',
    symptom: 'My four bars all play at once instead of one after another',
    tags: ['pattern', 'sequence', 'bars', 'stack', 'form'],
    fails: 'wrong',
    broken: `synth lead
  saw note
  * adsr .01 .2 .5 .2

play lead
  0 3 5 7
  2 5 7 9
  scale:a-min

cps .5`,
    fixed: `synth lead
  saw note
  * adsr .01 .2 .5 .2

play lead
  <[0 3 5 7] [2 5 7 9]>
  scale:a-min

cps .5`,
    why: 'A second notation line in one play block is a second LAYER, not the next bar. Both play at the same time, which is what you want for a chord voicing and never what you want for a four bar figure. Angle brackets are how you say "one of these per cycle": `<[a] [b]>` steps through them. This is the single most common way a transcription comes out as a wall of sound.',
  },
  {
    id: 'degree-no-scale',
    symptom: 'My pattern of numbers makes no sound at all',
    tags: ['scale', 'degrees', 'silence', 'notation'],
    fails: 'silent',
    broken: `synth hat
  noise
  svf 7000 mode:hp
  * adsr .001 .03 0 .02

play hat
  0(7,16)

cps .5`,
    fixed: `synth hat
  noise
  svf 7000 mode:hp
  * adsr .001 .03 0 .02

play hat
  c4(7,16)

cps .5`,
    why: 'A bare number is a scale DEGREE, and a degree is a position, not a pitch. Without a `scale:` there is nothing to resolve it against, so the events never get a note and the scheduler has nothing to play. It is silent rather than an error because the same pattern is perfectly valid the moment a scale arrives. For percussion, where the pitch is irrelevant, a note name is the shorter answer.',
  },
  {
    id: 'fractional-degree',
    symptom: 'Writing 4.5 to get a note between two degrees plays the wrong note',
    tags: ['scale', 'accidental', 'chromatic', 'rounding'],
    fails: 'wrong',
    broken: `synth keys
  tri note
  * adsr .01 .25 .4 .3

play keys
  0 2 4.5 5
  scale:c-maj

cps .5`,
    fixed: `synth keys
  tri note
  * adsr .01 .25 .4 .3

play keys
  0 2 4# 5
  scale:c-maj

cps .5`,
    why: 'A degree indexes the scale, so there is no halfway position for a fraction to land on: 4.5 is ROUNDED to degree 5 and you hear the next scale note, a whole tone above what you meant. Nothing warns you, because rounding is the sensible thing to do with a degree that arrived from a signal. To leave the scale, put the accidental after the degree: `4#`.',
  },
  {
    id: 'silent-kick-still-pumps',
    symptom: 'I muted the kick and everything still pumps',
    tags: ['sidechain', 'duck', 'pump', 'mute'],
    fails: 'wrong',
    broken: `synth kick
  sine 60
  * adsr .001 .16 0 .06

synth pad
  supersaw note detune:.2
  * adsr .4 .3 .8 .6

play kick
  c2 c2 c2 c2
  gain: 0

play pad
  <c3 a2>
  dur: 4

sidechain kick depth:.9 release:400

cps .5`,
    fixed: `switch drums 1 0

synth kick
  sine 60
  * adsr .001 .16 0 .06

synth pad
  supersaw note detune:.2
  * adsr .4 .3 .8 .6

play kick
  c2 c2 c2 c2
  gain: drums * .9

play pad
  <c3 a2>
  dur: 4

sidechain kick depth:drums release:400

cps .5`,
    why: 'The duck is triggered by the source synth\'s note ONSETS, not by how loud it is. A kick at gain 0 still emits notes, so it still ducks, and you get the hole without the hit. Put both on one control so they cannot disagree: a switch reaches the pattern gain and the sidechain depth alike.',
  },
  {
    id: 'unison-no-detune',
    symptom: 'unison:9 sounds exactly like one voice, only quieter',
    tags: ['unison', 'detune', 'supersaw', 'width'],
    fails: 'wrong',
    broken: `synth lead unison:9
  saw note
  * adsr .01 .3 .6 .4
  * .3

play lead
  0 3 5 7
  scale:a-min

cps .5`,
    fixed: `synth lead unison:9 detune:20 spread:1
  saw note
  * adsr .01 .3 .6 .4
  * .3

play lead
  0 3 5 7
  scale:a-min

cps .5`,
    why: 'Unison stacks N copies of the voice; DETUNE is what makes them different from each other. Without it you are paying nine times the CPU for nine identical saws, which sum to one saw. The number is in cents, so 20 is a fifth of a semitone. `spread` then places them across the stereo field, which is the other half of what makes a supersaw sound wide.',
  },
  {
    id: 'slide-needs-mono',
    symptom: 'slide: does nothing, the notes still retrigger',
    tags: ['slide', 'glide', '303', 'mono', 'legato'],
    fails: 'wrong',
    broken: `synth bass glide:.06
  saw note
  ladder 900 res:.7
  * adsr .003 .2 .3 .1

play bass
  0 7 0 3
  scale:a-min
  slide: 0 1 0 1

cps .5`,
    fixed: `synth bass mono glide:.06
  saw note
  ladder 900 res:.7
  * adsr .003 .2 .3 .1

play bass
  0 7 0 3
  scale:a-min
  slide: 0 1 0 1

cps .5`,
    why: 'A slide bends one note into the next, which requires them to be the same voice. Polyphonically each note takes a fresh voice and there is nothing to bend from, so `glide:` and `slide:` both have no effect and no error. `mono` is what makes the notes share a voice. This is why every 303 emulation is monophonic.',
  },
  {
    id: 'input-on-a-chain-line',
    symptom: 'reverb input room:.7 will not compile in a post chain',
    tags: ['post', 'input', 'bus', 'effects'],
    fails: 'compile',
    broken: `synth pad
  saw note
  * adsr .3 .3 .7 .5
  post
    reverb input room:.7

play pad
  <c3 a2>
  dur: 4

cps .5`,
    fixed: `synth pad
  saw note
  * adsr .3 .3 .7 .5
  post
    reverb room:.7

play pad
  <c3 a2>
  dur: 4

cps .5`,
    why: 'A chain line already has a running signal and each line feeds the next, so a processor takes its input implicitly. `reverb` wants exactly one signal, so naming `input` too is one argument more than it has room for. Note this is about arity, not about `input` being forbidden: `vocoder` takes TWO signals, so `vocoder input bands:32` on a bus line is correct and fills the modulator slot. `input` is otherwise for bindings, where you need the incoming signal by name to use it twice (`rv = reverb input room:.7` then `mix rv .3`).',
  },
  {
    id: 'synth-as-signal',
    symptom: 'I cannot use one synth as the input to another',
    tags: ['routing', 'bus', 'send', 'vocoder', 'architecture'],
    fails: 'compile',
    broken: `synth pad
  supersaw note
  * adsr .3 .3 .8 .5

synth voc
  vocoder pad bands:32

play pad
  c3

play voc
  c3

cps .5`,
    fixed: `synth pad
  supersaw note
  * adsr .3 .3 .8 .5

bus voc
  vocoder input bands:32
  send pad 1

play pad
  c3

cps .5`,
    why: 'A synth is a per VOICE graph: it runs once per note, so nine unison voices on a chord are nine separate instances and there is no single output for another synth to read. A bus is the level where a synth\'s output exists as one signal, which is why routing lives there. Send into a bus and process `input`.',
  },
]
