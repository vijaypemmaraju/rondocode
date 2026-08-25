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

/** The shelf a recipe sits on. Thirty-six in one flat list is a wall; these
 *  are the questions someone actually arrives with. Required, so a new recipe
 *  has to choose one rather than landing at the bottom by default. */
export type RecipeGroup =
  | 'instruments'
  | 'rhythm'
  | 'notes & harmony'
  | 'mix & space'
  | 'live & performance'
  | 'arrangement'
  | 'visuals'

export interface Recipe {
  id: string
  group: RecipeGroup
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
    group: 'live & performance',
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
    id: 'modulate',
    group: 'notes & harmony',
    title: 'Change key without rewriting the notes',
    tags: ['scale', 'key', 'modulation', 'degrees', 'harmony'],
    code: `synth keys
  (saw note) * .3
  svf 2600 res:.2
  * adsr .01 .18 .6 .3
  post
    reverb room:.6 damp:.4 mix:.2

synth bass
  (sine note) * .5
  * adsr .005 .12 .7 .14

play keys
  0 2 4 6 4 2
  scale: <c-maj a-min f-maj g-mix>
  dur: .9

play bass
  0 ~ 4 ~
  scale: <c-maj a-min f-maj g-mix>
  dur: .9

cps .45`,
    why: 'The DEGREES never change -- `0 2 4 6 4 2` is one shape, written once -- and the KEY moves under them, so the same figure is major, then minor, then major again without a note being rewritten. That is the difference from transposing: transposition moves the whole thing a fixed distance and keeps its colour, while changing the scale keeps the position and changes the colour. Both parts name the same scale pattern, which is what keeps them in the same key as it moves. Inside mini notation the two words are hyphen-joined (`c-maj`) because atoms are space-delimited.',
  },
  {
    id: 'diatonic-harmony',
    group: 'notes & harmony',
    title: 'Add a harmony that stays in the key',
    tags: ['harmony', 'superimpose', 'scale', 'degrees', 'diatonic'],
    code: `synth lead
  saw note
  ladder cut res:.3
  * env
  * .3
  env = adsr .01 .12 .7 .2
  cut = env ^ 2 -> 600..4200
  post
    reverb room:.5 damp:.4 mix:.2

play lead
  0 2 4 5 4 2 1 0
  scale:a-min
  superimpose: add 2

cps .5`,
    why: '`add` counts in SCALE DEGREES, not semitones, and that is the whole trick. `add 2` is two steps up the scale, so it lands a MINOR third above some notes and a MAJOR third above others -- measured on this line, 3 4 3 4 3 4 3 3 semitones -- which is what a second singer does and what a fixed interval cannot. `superimpose` keeps the original underneath rather than replacing it. Compare the `harmoniser` recipe: `pitchshift` works on AUDIO, where the note and the key are already gone, so it can only move everything by the same amount.',
  },
  {
    id: 'harmoniser',
    group: 'notes & harmony',
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
    why: 'The interval is a SIGNAL, so it moves. `semitones:iv` with `iv = knob 7 -12..12` puts it under a finger, and an `iv:` lane on the play line writes the harmony out note for note. What it cannot do is work the interval out for itself: it hears AUDIO, where the note and the scale are already gone, so a harmony that follows the key is one you write rather than one it infers. `mix` is what makes it a harmony rather than a transposition: at 1 you have simply moved the part, at 0.45 the original is still underneath. `window` is the artefact and cannot be turned off.',
  },
  {
    id: 'mono-bass',
    group: 'mix & space',
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
    group: 'notes & harmony',
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
    group: 'live & performance',
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
    id: 'band-key',
    group: 'mix & space',
    title: 'Tame harshness only when it actually bites',
    tags: ['compress', 'sidechain', 'key', 'de-ess', 'dynamics', 'mix'],
    code: `synth lead
  src
  svf 4200 res:.3
  * adsr .01 .12 .7 .2
  * .5
  src = saw note
  # the DETECTOR is a high band of the same signal, so the compressor only
  # reacts when the top end spikes -- and turns down the WHOLE note when it does
  bite = svf src 3500 mode:hp
  compress threshold:-26 ratio:8 attack:2 release:90 key:bite

play lead
  <0 4 7 11>*2
  scale: a-min
  dur: .9

cps .5`,
    why: 'A static filter cut is always cutting, including on the notes that were fine. `key` gives the compressor its own detector input, so it listens to a high-band split of the signal and turns the whole note down only when that band spikes. That is what a de-esser is, generalised: the thing being turned down and the thing deciding when are separated. Note the key must live in the SAME synth -- a synth runs once per voice, so it has no single output another synth could read. Ducking one instrument under another is `sidechain`, which fires on note onsets instead.', },
  {
    id: 'section-sweep',
    group: 'arrangement',
    title: 'Open a filter once across a whole section',
    tags: ['curve', 'automation', 'arrangement', 'build', 'filter'],
    code: `synth pad
  supersaw note detune:.25
  svf cut res:.35
  * adsr .3 .3 .8 .4
  * .4
  cut = knob 500 200..9000 log

section build 16
  play pad
    <0 3 5 7>
    scale: a-min
    dur: .95
    # ONE pass over 16 bars: 8 opening, 8 easing back. It does not loop.
    cut: curve 8 1 8 .35 400..7000

song build

cps .5`,
    why: '`lfo` and `saw` are CYCLIC -- they restart every bar, or every n bars, so a filter written with one can never simply open across a section and stay open. `curve` is measured in cycles against the transport and holds its last level instead of looping, which makes it a timeline automation lane rather than a modulator. The pairs are duration-then-level, so `curve 8 1 8 .35` is eight bars up to full and eight easing back to a third. A third number on a pair gives that leg its own easing, `from:` sets the level before the first one, and `loop:1` opts back into repeating.', },
  {
    id: 'pump',
    group: 'mix & space',
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
    group: 'mix & space',
    title: 'Put a sound in a real space, not an approximation of one',
    tags: ['convolve', 'reverb', 'impulse response', 'space', 'sample'],
    code: `synth keys
  (saw note) * .5
  svf 2400 res:.15
  * adsr .01 .25 .5 .35
  # in POST, not on a spine line. A convolver there is one per VOICE,
  # and this chord has four notes: measured 3.1x the cost for a
  # sample-for-sample identical result, because convolution is linear
  # and convolving the sum is the same as summing the convolutions.
  # It also keeps the tails, which a stolen voice would cut off.
  post
    convolve hall mix:.45

play keys
  <Cmaj7 Am7 Fmaj7 G>
  dur: .95

cps .4`,
    why: 'An impulse response is what a room does to a single click, and it turns out that IS the room -- convolving with it reproduces the space completely, where `reverb` approximates one with a network of delays. The trade is the knob: `reverb` lets you move `room` and `damp` while it plays, and a convolution can only ever be the measurement you handed it. The IR is a SAMPLE, so anything you can load is a space: `hall` ships built in, and convolving with something that is not a room at all -- a snare hit, a struck pipe -- is a standard way to get a sound nothing else makes. Keep it in `post`, for the reason in the code: one shared space costs a third of one space per voice.',
  },
  {
    id: 'sweeping-modulation',
    group: 'mix & space',
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
    id: 'drums',
    group: 'rhythm',
    title: 'Program a drum pattern',
    tags: ['beat', 'drums', 'rhythm', 'kick', 'snare', 'hat'],
    code: `synth kick
  sine drop
  * amp
  tanh
  drop = adsr .001 .08 0 .04 ^ 3 -> 48..180
  amp = adsr .001 .15 0 .05

synth snare
  noise white
  svf 1900 res:.3
  * 2
  + tone
  * adsr .001 .12 0 .06
  * .35
  tone = tri 190

synth hat
  noise white
  svf 7000 mode:hp
  * adsr .001 .03 0 .02
  * .4

beat
  kick ~ ~ kick ~ ~ kick ~
  ~ ~ snare ~ ~ ~ snare ~
  hat:.5 hat hat:.4 hat hat:.5 hat hat:.4 hat

cps .5`,
    why: 'A `beat` block is a GRID, not a melody: one line per voice, one column per step, and the columns line up down the page so you read the groove vertically the way a drum machine shows it. That is the whole reason it exists beside `play` -- three separate `play` blocks would sound identical and you could not see the pattern. A word is a synth name and `~` is a rest, so the line IS the part. `hat:.5` is that hit\'s own gain, which is what keeps a straight eighth-note hat from sounding like a machine: alternate loud and soft and the bar starts to swing without a single timing change.',
  },
  {
    id: 'shared-room',
    group: 'mix & space',
    title: 'Put several parts in the same space',
    tags: ['bus', 'send', 'reverb', 'mix', 'space'],
    code: `synth keys
  (saw note) * .3
  svf 2400 res:.2
  * adsr .01 .2 .6 .3

synth bell
  sine note
  * 3
  + partial
  * adsr .002 .5 0 .4
  * .12
  partial = sine note*2.7

play keys
  <Cmaj7 Am7>
  dur: .9

play bell
  ~ 12 ~ 7
  scale:c-maj
  dur: .5

bus room
  reverb room:.88 damp:.35 mix:1
  send keys .35
  send bell .6

cps .45`,
    why: 'One reverb, fed by both parts, is not the same as a reverb on each -- and the difference is the point. Separate reverbs put each instrument in its own room, which is why a mix can sound like several recordings stacked. A `bus` is one room that several parts are standing in, and the send amount is how far back each one stands. Set `mix:1` on the bus reverb: the dry signal is already in the mix, so anything less than fully wet just sends a quieter copy of the original along with the tail.',
  },
  {
    id: 'chop',
    group: 'rhythm',
    title: 'Chop a break and rebuild the beat',
    tags: ['sample', 'slices', 'chop', 'break', 'sampler'],
    code: `synth chop
  sample break slices:8
  * adsr .001 .22 1 .02
  * 1.1

synth sub
  (sine note) * .55
  * adsr .004 .12 .7 .12

play chop
  c4 e4 c4 g4 db4 c4 f4 e4
  dur: .95

play sub
  <c2 c2 f1 g1>
  dur: .9

cps .5`,
    why: '`slices:8` hands the CHOICE to the note. It cuts the window into eight equal pieces, and `root` (c4 by default) plays piece 0 with each semitone up picking the next -- so a note pattern becomes a sequencer for the pieces of a loop, and reordering the notes gives you a new beat out of the same two seconds of audio. Every piece plays at its natural speed whatever note picked it, which is what separates chopping from transposing: the break keeps its own groove and only its ORDER changes.',
  },
  {
    id: 'striate',
    group: 'rhythm',
    title: 'Shuffle a break without rewriting it',
    tags: ['sample', 'striate', 'chop', 'break', 'sampler'],
    code: `synth breaks
  sample break
  * adsr .001 .3 1 .05

synth sub
  (sine note) * .55
  * adsr .004 .12 .7 .12

play breaks
  c4 c4 c4 c4
  striate <4 8>
  dur: .95

play sub
  <c2 c2 f1 g1>
  dur: .9

cps .5`,
    why: "`striate` is chop's interleaved twin, and the difference is the recipe. `chop 8` walks ONE hit through its eight pieces in order, so the loop plays through and stutters. `striate 4` plays the whole LINE four times, pass i taking piece i of every event -- the first pass is all openings, the last all tails, which is the classic break shuffle. Neither needs `slices:` on the synth: the pattern carries each event's begin/end window as note data, so a plain `sample break` plays whatever piece it is handed. And the count is a pattern too, so `<4 8>` shuffles twice as fine every other cycle.",
  },
  {
    id: 'looper',
    group: 'live & performance',
    title: 'Loop a riff and layer it live',
    tags: ['looper', 'live', 'overdub', 'performance'],
    code: `synth riff
  saw
  onepole 1400
  * env
  env = adsr .005 .12 .5 .1
  post
    looper rec feedback:decay
    rec = knob 0 0..1
    decay = knob 1 0..1

play riff
  0 3 5 <7 10> ~ 5 3 ~
  scale: a-min
  dur: .8

cps .5`,
    why: "The looper lives in the POST chain, and that placement is the recipe: a spine runs once per VOICE, so a looper there would give every note its own empty pedal that dies with the voice. The post chain runs once over the summed synth, so it hears the whole riff and survives every retrigger. Dial `rec` to 1 and the pedal records -- the time it stays up IS the loop length -- back to 0 and the loop plays, up again and you overdub a layer on top. `decay` below 1 fades the older layers a step per overdub pass, so a jam renews itself instead of piling up; parked at 1 every layer holds forever. Editing the code rebuilds the graph and empties the pedal, which is also the escape hatch.",
  },
  {
    id: 'bowing',
    group: 'instruments',
    title: 'Bow a violin line like a player',
    tags: ['ddsp', 'violin', 'slur', 'legato', 'strings'],
    code: `synth violin mono
  ddsp violin vib:.25
  post
    convolve violinbody mix:.5
    reverb room:.8 damp:.5 mix:.2

play violin
  0 2 4 5 4 2 0 ~
  scale: d-min
  slur .85
  dur: .98

cps .4`,
    why: "Three choices make it a player instead of a preset. `mono` plus `slur` is the bowing: `slur .85` derives slide ties from the notes, tying a boundary only into a note that starts exactly where this one ends AND changes pitch -- rests breathe, repeats re-articulate, like a real slur -- and on a mono synth a tie holds the gate, so the model plays true legato with no re-attack. `dur: .98` is what makes boundaries tieable at all: a note that ends early leaves a gap, and a gap is a bow lift. And the post chain is the BODY: `convolve violinbody` puts back the wood resonances the model cannot make, room reverb after it. The model downloads on first use -- a moment of silence, then it sounds.",
  },
  {
    id: 'loudness',
    group: 'mix & space',
    title: 'Make it louder without making it worse',
    tags: ['master', 'level', 'loudness', 'mastering', 'mix'],
    code: `synth pad
  supersaw note detune:.2
  svf 2600 res:.15
  * adsr .3 .3 .8 .5
  * .3

synth kick
  sine drop
  * adsr .001 .14 0 .05
  tanh
  drop = adsr .001 .07 0 .04 ^ 3 -> 45..170

play pad
  <Cmaj9 Am9>
  dur: .95

play kick
  c2 ~ c2 ~

master threshold:-8 ratio:2 attack:20 release:140 makeup:1
level -1.5

cps .45`,
    why: '`level` is the only lever that scales EVERYTHING, and that is why it is the one to reach for. Per-part gains stop helping once a mix is pushed hard, because the master stage is already holding the peak down -- turning one part up just takes room from the others and nothing gets louder. Set the whole mix under the ceiling with `level`, then let `master` glue it: a gentle 2:1 with a slow attack lets transients through and pulls the body together. Offline renders normalize the result, so check the reported peak rather than trusting that a gain edit did anything.',
  },
  {
    id: 'plucked',
    group: 'instruments',
    title: 'Make something that is struck or plucked',
    tags: ['pluck', 'modal', 'physical', 'string', 'bell'],
    code: `synth harp
  pluck note decay:2.2 damp:.35
  * .5
  post
    reverb room:.7 damp:.4 mix:.25

synth bells
  modal note model:bar decay:2.6 damp:.2 stretch:1.01
  * .35

play harp
  0 4 7 11 7 4 2 0
  scale:d-maj
  dur: .9

play bells
  ~ ~ 7 ~ ~ ~ 11 ~
  scale:d-maj
  dur: .9

cps .45`,
    why: 'These are PHYSICAL models, so they are excited and then left alone -- there is no envelope shaping the tail, because the tail is the model ringing down on its own. `pluck` is a string: `decay` is how long it rings and `damp` is how much of the top comes off as it does, which is the difference between a nylon string and a steel one. `modal` is a struck object, and `stretch` is why it sounds like a bar rather than a string: real metal partials sit slightly SHARP of the harmonic series, so a stretch just above 1 is what makes a bell sound like metal instead of an organ.',
  },
  {
    id: 'fm-bell',
    group: 'instruments',
    title: 'Get a bell or electric piano out of two sine waves',
    tags: ['fm', 'bell', 'electric piano', 'synth'],
    code: `synth ep
  fm note 3.01 feedback:.12 wave:sine
  * env
  * .35
  env = adsr .002 .5 .25 .5

synth chime
  fm note 7.02 feedback:.05
  * adsr .001 1.4 0 .8
  * .18

play ep
  <Cmaj9 Fmaj9>
  dur: .95

play chime
  ~ ~ ~ 12
  scale:c-maj
  dur: .9

cps .4`,
    why: 'The RATIO is the instrument. `fm note 3.01` is a modulator at just over three times the pitch, and that near-miss is the whole sound: exact whole-number ratios give harmonic, organ-like tones, while a ratio slightly off one beats against itself and reads as metal. Push it to 7.02 and the partials spread far enough apart to become a chime. The envelope does the rest of the work -- the same patch is an electric piano with a short decay and a bell with a long one, because in FM the brightness follows the level.',
  },
  {
    id: 'granular-freeze',
    group: 'instruments',
    title: 'Stretch or freeze a sound without changing its pitch',
    tags: ['granular', 'sample', 'texture', 'ambient', 'timestretch'],
    code: `synth cloud voices:8
  granular vox root:57 pos:scrub size:.13 density:60 spray:.005
  * env
  * 1.15
  env = adsr .7 .5 .9 1.2
  scrub = lfo .02 -> 0..1
  post
    reverb room:.9 damp:.4 mix:.38

play cloud
  <c3 g2 a2 f2>/2
  dur: .98

cps .3`,
    why: '`pos` and pitch are INDEPENDENT, and that is the one thing granular does that nothing else can. `sample speed:` ties them together: play a loop slower and it drops in pitch, like a record at the wrong rpm. Here the NOTE sets the pitch and `pos` sets where in the file the grains are read from, so a very slow LFO walks through the sample while the chords stay in tune, and freezing `pos` on a number holds one moment open indefinitely. `density` times `size` is the overlap: 60 grains a second at 0.13s each means about eight sounding at once, which is what makes a continuous tone instead of a stutter.', },
  {
    id: 'supersaw',
    group: 'instruments',
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
    group: 'instruments',
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
    group: 'live & performance',
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
    group: 'live & performance',
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
    group: 'live & performance',
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
    group: 'instruments',
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
    group: 'notes & harmony',
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
    group: 'arrangement',
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
    group: 'rhythm',
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
    group: 'instruments',
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
  {
    id: 'endless-drone',
    group: 'arrangement',
    title: 'Make a drone that never repeats',
    tags: ['drone', 'ambient', 'generative', 'lfo', 'evolving', 'pad', 'endless'],
    code: `synth drone unison:5 detune:8 voices:4
  wavetable note pos table:harmonic
  ladder cut res:.26
  * adsr 6 3 .9 8
  pan sway
  pos = lfo .037 -> .10..0.66
  cut = 240 + open + creep
  open = lfo .061 -> 0..1200
  creep = lfo .023 -> 0..800
  sway = lfo .013 -> -.5..0.5
  post
    width .9
    reverb room:.92 damp:.35 mix:.42

synth sub voices:2
  sine note
  * adsr 4 2 .95 8

# 4 steps of 7 cycles, against 3 steps of 11: coprime, so they
# realign after 924 cycles and not once before. dur: is longer than
# the step on purpose, so a note is still sounding when the next
# arrives and the gate never closes between them
play drone
  <0 4 2 7>/7
  scale:d-min
  dur: 7

play sub
  <0 -3 1>/11
  scale:d-min
  dur: 11
  gain: .35

cps .25

level -3`,
    why: 'Nothing shares a period with anything else. The instinct is to write a long pattern, but a loop is a loop however long you make it. Instead two short figures run at coprime lengths, 4 steps of 7 cycles against 3 steps of 11, which realign after 924 cycles and not once before: about an hour at this tempo. The LFOs are set in SECONDS while the notes move in cycles, so they drift across the note grid rather than locking to it. Staying seamless is a separate job, done by two things that each cover for the other: a `dur:` longer than the step, and a release measured in seconds. Shorten either alone and nothing changes; shorten both and it gaps.',
  },
  {
    id: 'generative-beat',
    group: 'rhythm',
    title: 'Make a beat that plays itself',
    tags: ['generative', 'ambient', 'beat', 'probability', 'degrade', 'percussion', 'endless'],
    code: `synth pulse
  sine note
  * adsr .01 1.6 .25 1.4
  * .22

synth thud
  sine drop
  * adsr .002 .25 0 .18
  drop = adsr .001 .1 0 .05 ^ 2 -> 42..105

synth tick
  noise
  svf 6200 mode:hp
  * adsr .001 .035 0 .04
  * .28

synth bowl
  fm note 3.5
  * adsr .002 1.6 0 1.2
  * .3

# the one certain voice: everything else is a coin toss
play pulse
  c1

# written DENSE and thinned, not written sparse
play thud
  c2*16
  degradeby .84

play tick
  c4*16
  degradeby .72

play bowl
  c5(5,16)
  degradeby .5

cps .34

level -4`,
    why: 'Write the pattern DENSE and let probability thin it. A sparse figure is a loop: play it twice and you have heard it. Sixteen hits at `degradeby .84` keep about three, a different three each bar, and every one of them still lands on a grid position you chose rather than somewhere random. Measured over sixteen bars: the ticks were unique in all sixteen, the kick in fifteen. The catch is that probability alone wanders, and one bar in the render fell to a twentieth of the loudest. So one voice never rolls the dice. That single certain pulse is the difference between a beat and a scatter.',
  },
  {
    id: 'generative-melody',
    group: 'notes & harmony',
    title: 'Let a melody write itself',
    tags: ['generative', 'melody', 'irand', 'scale', 'pentatonic', 'struct', 'ambient'],
    code: `synth lead
  tri note
  svf 2600 res:.15
  * adsr .004 .5 0 .6
  * .5
  post
    reverb room:.86 damp:.4 mix:.36

synth echo
  sine note
  * adsr .01 .9 0 1.1
  * .22
  post
    reverb room:.9 mix:.45

synth bed unison:3 detune:6
  saw note
  ladder 700 res:.15
  * adsr 3 2 .8 4
  * .16

# the pitches are a dice roll; the RHYTHM is written down
play lead
  irand 5 seg:8
  scale:d-minorpentatonic
  struct 1 ~ 1 1 ~ 1 ~ ~

play echo
  irand 5 seg:8
  scale:d-minorpentatonic
  struct ~ ~ ~ 1 ~ ~ 1 ~
  sub 7

play bed
  <0 3>/6
  scale:d-minorpentatonic

cps .42

level 2`,
    why: 'Randomise ONE dimension and write the rest down. `irand` rolls a new degree every step, and on its own that is a flat run of eighths: constant, and unmistakably a machine. `struct` replaces the run with a FIGURE, rests and all, so the same shape comes back bar after bar with different notes in it and the ear hears a melody being varied. The scale is the other half: a minor pentatonic contains no semitone, so no roll of the dice can produce the one interval that sounds like a mistake. Measured over 24 bars, a 7-note scale gave nine minor 2nds and the pentatonic gave zero, with the rhythm identical in every bar and the notes different in 21 of them.',
  },
  {
    id: 'swing-one-part',
    group: 'rhythm',
    title: 'Shuffle the hats and leave the kick straight',
    tags: ['swing', 'shuffle', 'groove', 'hats', 'feel', 'timing'],
    code: `synth hat
  noise
  svf 7200 mode:hp
  * adsr .001 .03 0 .02
  * .3

synth kick
  sine drop
  * adsr .001 .13 0 .05
  drop = adsr .001 .07 0 .04 ^ 2 -> 45..150

synth bass
  saw note
  ladder 900 res:.2
  * adsr .005 .2 .4 .15
  * .5

# the groove rides on the GROUP, so only these eight move
beat
  [hat*8]'swing:.55
  kick ~ ~ kick ~ ~ kick ~

play bass
  <0 0 3 5>
  scale:a-min
  gain: .6

cps .5

level -2`,
    why: 'Swing on the GROUP, not on the pattern. `swingBy` is a whole-pattern combinator, so shuffling the hats used to mean pulling them into their own pattern and swinging that, which splits one groove across two places. `\'swing:` attaches to `[hat*8]` and moves nothing else: the off-beat hats go late, the on-beats stay, and the kick beside them never knew. `\'grid:` is the subdivision and defaults to 4, which is shuffled eighths in four-four; `\'grid:2` swings quarters, `\'grid:8` sixteenths. It cannot be guessed from what is written, because `[hat*8]` is one term that makes eight events while `[a b c d]` is four terms that make four.',
  },
  {
    id: 'lay-back-the-snare',
    group: 'rhythm',
    title: 'Lay the snare back fifteen milliseconds',
    tags: ['push', 'humanize', 'feel', 'timing', 'lay-back', 'groove', 'pocket'],
    code: `synth hat
  noise
  svf 7200 mode:hp
  * adsr .001 .03 0 .02
  * .3

synth kick
  sine drop
  * adsr .001 .13 0 .05
  drop = adsr .001 .07 0 .04 ^ 2 -> 45..150

synth snare
  noise
  svf 1800 mode:bp res:.4
  * adsr .001 .09 0 .06
  * .7

# the snare sits BEHIND the kick's grid; the hats are loose; the kick never moves
beat
  kick ~ ~ ~ kick ~ ~ ~
  ~ ~ snare'push:.06 ~ ~ ~ snare'push:.06 ~
  [hat*8]'humanize:.12'grid:8

cps .5

level -2`,
    why: 'Feel is a TIMING edit, not a volume edit, and it is measured in milliseconds. `\'push:.06` moves that one snare 6% of its own step: at cps .5 a bar is two seconds, an eighth-note slot is 250 ms, so the snare lands 15 ms behind the kick -- the pocket, written as one number on one note. A negative push rushes instead. `\'humanize:` is the same idea applied statistically: every hat lands late by its OWN amount, up to `.12` of a sixteenth-grid subdivision (also 15 ms here), drawn deterministically from the hit\'s exact onset -- so the line breathes like a player but renders the same way every time. Both lanes are consumed as timing: no phantom param ever reaches the synth.',
  },
  {
    id: 'counter-rhythm',
    group: 'rhythm',
    title: 'Write the answer to a rhythm without restating it',
    tags: ['euclid', 'complement', 'counter-rhythm', 'interlock', 'percussion'],
    code: `synth kick
  sine drop
  * adsr .001 .14 0 .05
  drop = adsr .001 .07 0 .04 ^ 2 -> 45..150

synth shk
  noise
  svf 6800 mode:hp
  * adsr .001 .025 0 .02
  * .22

synth clave
  sine 1150
  * adsr .001 .04 0 .02
  * .35

# (3,8) and (-3,8) are the same figure, said both ways
play kick
  c2(3,8)
  gain: .9

play shk
  c5(-3,8)

play clave
  c6(5,16)
  gain: .5

cps .5

level -2`,
    why: 'A NEGATIVE pulse count is the complement: `(-3,8)` plays the five slots `(3,8)` leaves empty. Written out, the answering part is five rests and five hits that have to stay correct by hand every time the kick moves; written as the complement it cannot drift, because it is derived from the figure rather than copied from it. Every slot is covered exactly once between the pair, which is where an interlocking groove comes from. Change the 3 to a 5 and both lines follow.',
  },
  {
    id: 'lean-a-choice',
    group: 'notes & harmony',
    title: 'Make a random choice lean one way',
    tags: ['random', 'generative', 'choice', 'weight', 'probability', 'variation'],
    code: `synth pluck
  tri note
  svf 2600 res:.2
  * adsr .004 .18 .2 .2
  * .5

synth pad unison:3 detune:8
  saw note
  ladder 1400 res:.15
  * adsr .8 .5 .7 1.2
  * .18

# the home phrase four times as often as the answer
play pluck
  [0 3 5 3]@4 | [7 5 3 0]
  scale:a-min
  gain: .55
  dur: .9

play pad
  <0 -3>/4
  scale:a-min

cps .45

level -3`,
    why: 'Weight the alternative with `@`. `|` is an even choice, so the only way to make one phrase likelier used to be to repeat it (`a | b | b | b`), which caps you at whole-number ratios and reads as three copies of the same idea. `[0 3 5 3]@4 | [7 5 3 0]` says the same thing once: the home phrase four times as often as the answer. The weight belongs to the alternative as a WHOLE, so `a b@3 | c` is still an even choice between two sequences and the `@3` keeps its ordinary job inside the first one.',
  },
  {
    id: 'mic-harmony',
    group: 'live & performance',
    title: 'Sing a harmony above your own voice',
    tags: ['mic', 'harmony', 'pitchshift', 'voice', 'live', 'interval'],
    code: `synth harm
  mic
  # clean it BEFORE the shifter: plosives and rumble get harmonised too
  eq hp 140
  noisegate threshold:-44 range:-28 hold:60 release:120
  # the dry voice stays underneath at mix:.5, so this is a harmony
  pitchshift semitones:iv window:40 mix:.5
  # a knob to ride by hand; the play line writes it out instead
  iv = knob 7 -12..12
  post
    eq peak 3000 2 1.2
    reverb room:.55 damp:.4 mix:.16
    limiter ceiling:-1 lookahead:5

# ONE held note holds the channel open; the LANE moves the interval
play harm
  c3*4
  iv: <[7 7 5 5] [4 4 3 5]>
  dur: .99

cps .4`,
    why: 'The interval is a SIGNAL, so the harmony is a LINE rather than a setting: `iv:` writes one interval per step and the voice above yours moves while you hold a note. What the shifter cannot do is choose the interval itself, because it hears AUDIO and the note and the scale are gone by then, so a third that stays in the key is one you write. Clean the microphone first or the plosives get harmonised with everything else, and wear headphones: with reverb in the chain the mic hears its own harmony and the whole thing runs away.',
  },
  {
    id: 'viz-note-flash',
    group: 'visuals',
    title: 'Make the visuals fire on every note',
    tags: ['visual', 'shader', 'wgsl', 'note', 'flash', 'reactive'],
    code: `synth lead unison:3 detune:12 spread:.4
  saw note
  ladder 2600 res:.3
  * adsr .004 .14 .45 .18
  * .45

synth kick
  sine drop
  * amp
  tanh
  drop = adsr .001 .09 0 .05 ^ 3 -> 48..190
  amp = adsr .001 .16 0 .06

play kick
  c2 c2 c2 c2

play lead
  0 3 7 10 7 3 0 -2  scale:c-min

visual
  fn hue(h: f32) -> vec3f {
    let k = abs(fract(h + vec3f(0.0, 0.667, 0.333)) * 6.0 - 3.0) - 1.0;
    return clamp(k, vec3f(0.0), vec3f(1.0));
  }

  fn render(uv: vec2f) -> vec4f {
    let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
    let col = hue(fract(note_lead / 12.0));
    let ring = abs(length(p) - 0.18 - hit_lead * 0.30);
    let lit = 0.015 / (ring + 0.015) * (0.25 + lvl_lead * 2.5);
    let thump = hit_kick * 0.10 / (dot(p, p) + 0.12);
    return vec4f(col * lit + vec3f(0.5, 0.6, 1.0) * thump, 1.0);
  }

cps .5`,
    why: '`hit_` and `lvl_` are not two names for the same thing, and picking the wrong one is why a visual feels disconnected. `hit_lead` is an ONSET envelope: it spikes and decays in about a tenth of a second, so it flashes once per note and is useless for a pad. `lvl_lead` follows the voice while the note is HELD, so a swell reads as a swell. The third one is the one people miss: `note_lead` is the MIDI number, so its pitch class is a hue that changes on every note. That is the difference between a visual that answers the loudness and one that answers the melody.',
  },
  {
    id: 'viz-beams',
    group: 'visuals',
    title: 'Light a stage with beams instead of blobs',
    tags: ['visual', 'shader', 'wgsl', 'beam', '3d', 'light', 'concert'],
    code: `synth stab unison:5 detune:16 spread:.5
  saw note
  ladder cut res:.35
  * adsr .004 .2 .3 .25
  * .4
  cut = adsr .01 .3 .2 .3 ^ 2 -> 500..4200

synth kick
  sine drop
  * amp
  tanh
  drop = adsr .001 .09 0 .05 ^ 3 -> 48..190
  amp = adsr .001 .16 0 .06

play kick
  c2 c2 c2 c2

play stab
  <0 -3 5 3>  scale:f-min

visual
  fn beam(ro: vec3f, rd: vec3f, src: vec3f, dir: vec3f, len: f32, w: f32) -> f32 {
    let w0 = ro - src;
    let b = dot(rd, dir);
    let d = dot(rd, w0);
    let e = dot(dir, w0);
    let den = max(1.0 - b * b, 0.0004);
    let tc = max((b * e - d) / den, 0.0);
    let sc = clamp((e - b * d) / den, 0.0, len);
    let dist = length((ro + rd * tc) - (src + dir * sc));
    let r = w + 0.05 * sc;
    return (exp(-dist * dist / (r * r)) + 0.3 * exp(-dist * dist / (r * r * 9.0)))
         * exp(-sc * 0.1) * smoothstep(0.0, 0.6, sc);
  }

  fn render(uv: vec2f) -> vec4f {
    let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
    let ro = vec3f(0.0, 1.5, 7.0);
    let rd = normalize(vec3f(p.x * 0.6, p.y * 0.6 + 0.1, -1.0));
    var col = vec3f(0.0);
    for (var i = 0; i < 6; i = i + 1) {
      let f = f32(i);
      let src = vec3f(-3.75 + f * 1.5, 4.2, -1.5);
      let pan = sin(time * 0.4 + f) * 0.4 + fract(note_stab * 0.37 + f) - 0.5;
      let dir = normalize(vec3f(sin(pan), -0.9, -0.5));
      let tint = vec3f(0.35 + 0.65 * fract(f * 0.5), 0.65, 1.0 - 0.5 * fract(f * 0.5));
      col += tint * beam(ro, rd, src, dir, 14.0, 0.06) * (0.2 + lvl_stab * 1.6 + hit_kick * 0.7);
    }
    col += vec3f(0.05, 0.07, 0.12) * smoothstep(-1.0, 3.0, ro.y + rd.y * 8.0) * (0.3 + bass);
    return vec4f(col / (1.0 + col * 0.6), 1.0);
  }

cps .5`,
    why: 'A beam through haze is the integral of a glow around a LINE, and the closest approach between two lines is closed form. So there is no raymarching here and no loop over depth: six fixtures cost about what one screen-space blur costs, and because they are real lines in space they foreshorten when they point at you. The second move is the two gaussians. A single wide one is a soft wash, which is what a first attempt always looks like; a real shaft is a narrow hot core inside a much wider, much dimmer halo, and the RATIO between them is what reads as intensity.',
  },
  {
    id: 'viz-sections',
    group: 'visuals',
    title: 'Change the visual when the section changes',
    tags: ['visual', 'shader', 'wgsl', 'arrangement', 'section', 'cycle'],
    code: `synth pad unison:4 detune:10
  saw note
  ladder 1400 res:.2
  * adsr .5 .4 .8 .8
  * .3

synth kick
  sine drop
  * amp
  tanh
  drop = adsr .001 .09 0 .05 ^ 3 -> 48..190
  amp = adsr .001 .16 0 .06

section intro 4
  play pad
    <c3 g2>/2

section drop 4
  play pad
    <c3 g2>/2
  play kick
    c2 c2 c2 c2

song intro drop

visual
  fn act(bars: f32, a: f32, b: f32) -> f32 {
    return smoothstep(a - 0.125, a + 0.125, bars) * (1.0 - smoothstep(b - 0.125, b + 0.125, bars));
  }

  fn render(uv: vec2f) -> vec4f {
    let p = (uv * 2.0 - 1.0) * vec2f(res.x / res.y, 1.0);
    let bars = fract(cycle / 8.0) * 8.0;
    let intro = act(bars, 0.0, 4.0);
    let drop = act(bars, 4.0, 8.0);
    let rise = clamp(bars / 4.0, 0.0, 1.0);
    let glow = 0.02 / (abs(length(p) - 0.3 - drop * 0.2) + 0.02);
    let col = vec3f(0.2, 0.5, 1.0) * intro * glow * (0.2 + rise * 0.4 + lvl_pad * 1.2)
            + vec3f(1.0, 0.5, 0.2) * drop * glow * (0.6 + hit_kick * 2.0);
    return vec4f(col / (1.0 + col * 0.5), 1.0);
  }

cps .5`,
    why: '`cycle` is the bar count, and it follows the transport rather than the wall clock, so it rebases when you press play. That makes `fract(cycle / N) * N` the position inside an N-bar arrangement, and the number N has to be the SONG length. Writing the visual around a loop length you liked is the trap: a shader built for 8 bars keeps running its own 8-bar loop after the arrangement grows to 56, so its drop lands three and a half times a pass and never where the kick is. The softened edges in `act` matter too: a hard comparison changes on a frame boundary, which pops.',
  },
]
