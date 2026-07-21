/* ------------------------------------------------------------------------- *
 * DSL documentation data: the single source of truth describing every name
 * in the rondocode surface, scope globals, Pattern methods, synth-builder
 * context members, Sig methods, and mini-notation operators.
 *
 * Pure data, no DOM: the editor's completions and hover tooltips render
 * from it, the MCP docs endpoint will serve it, and LLM autocomplete will
 * prompt with it. Coverage is pinned bidirectionally against the LIVE
 * objects (baseScope keys, Pattern.prototype, a probed SynthCtx/Sig) by
 * test/docs.test.ts, adding a method without documenting it, or
 * documenting a name that does not exist, fails the suite.
 *
 * Style rules for entries:
 * - `signature` reads like a TS declaration head: "euclid(pulses: number,
 *   steps: number, rotation?: number)". Plain values have no parens.
 * - `summary` is ONE sentence, musical, plain language, what it sounds
 *   like / does to the music, not how it is implemented.
 * - `example` is a one-liner of real rondocode (idioms follow
 *   src/examples/index.ts).
 * ------------------------------------------------------------------------- */

export interface DocEntry {
  name: string
  kind: 'global' | 'pattern-method' | 'synth-ctx' | 'sig-method' | 'mini-syntax'
  /** e.g. "euclid(pulses: number, steps: number, rotation?: number)" */
  signature: string
  /** One sentence, musical, plain language. */
  summary: string
  /** One-liner in real DSL syntax. */
  example?: string
}

const entry = (
  kind: DocEntry['kind'],
  name: string,
  signature: string,
  summary: string,
  example?: string,
): DocEntry => (example === undefined ? { name, kind, signature, summary } : { name, kind, signature, summary, example })

// --------------------------------------------------------------- globals

const g = (name: string, signature: string, summary: string, example?: string): DocEntry =>
  entry('global', name, signature, summary, example)

const GLOBALS: DocEntry[] = [
  g(
    'synth',
    'synth(build: (ctx) => Sig, post?: (ctx) => Sig, opts?: { mono?: boolean; glide?: number; unison?: number; detune?: number; spread?: number })',
    'Define an instrument: the build function wires oscillators, filters and envelopes into a per-voice sound; the optional post function adds an FX chain (reverb, delay, EQ) over the summed voices, shared, not per note. opts sets voice modes, mono+glide for portamento leads, unison (with detune cents and stereo spread 0..1) for fat detuned stacks; pass opts as the 2nd arg when there is no post. Assign to a top-level const to register it under that name.',
    "const lead = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate)), { mono: true, glide: 0.08 })",
  ),
  g(
    'n',
    'n(degrees: string | number | Pattern)',
    'Melody as scale degrees: 0 is the root, 7 an octave up, pair with .scale() to turn degrees into actual notes.',
    "n('0 0 3 5').scale('a minor').sound('acid')",
  ),
  g(
    'note',
    'note(names: string | number | Pattern)',
    'Melody as absolute pitches: note names (c4, f#3, eb2) or midi numbers, no scale needed.',
    "note('c2 e2 g2 c3').sound('bass')",
  ),
  g(
    'chord',
    'chord(names: string | Pattern<string>)',
    "Named chords, each expanded to a stack of notes (root octave 3). Qualities: maj min 7 maj7 m7 dim aug sus2 sus4 6 m6 add9 9 m9 maj9 11 13 m7b5, plus slash bass (C/E). Pair with .arp() to arpeggiate.",
    "chord('<Cmaj7 Am7 Dm7 G7>').sound('keys')",
  ),
  g(
    'sound',
    'sound(name: string | Pattern<string>)',
    'Start a pattern from synth names alone, each word is an event routed to that synth.',
    "sound('kick hat kick hat')",
  ),
  g('s', 's(name: string | Pattern<string>)', 'Short alias for sound().', "s('kick hat')"),
  g(
    'mini',
    'mini(src: string)',
    'Parse a mini-notation string into a bare value pattern (no controls attached).',
    "mini('0 1 [2 3]')",
  ),
  g('m', 'm`...`', 'Tagged-template alias for mini: write patterns inline as m`0 1 2`.', 'm`bd ~ sn ~`'),
  g(
    'cat',
    'cat(...pats)',
    'Play the arguments one per cycle, in order: an easy way to build multi-bar sequences.',
    "cat(n('0 3 5'), n('7 5 3'))",
  ),
  g(
    'fastcat',
    'fastcat(...pats)',
    'Squeeze the arguments into a single cycle, equal slices each.',
    "fastcat(n('0'), n('3 5'))",
  ),
  g(
    'stack',
    'stack(...pats)',
    'Layer patterns so they all play at the same time, chords, or drum voices on one line.',
    "stack(n('0'), n('2'), n('4')).scale('d dorian')",
  ),
  g(
    'timecat',
    'timecat(pairs: [weight, pattern][])',
    'Like fastcat but each pattern gets a slice of the cycle proportional to its weight.',
    "timecat([[3, n('0')], [1, n('7')]])",
  ),
  g('silence', 'silence', 'The empty pattern: no events, ever, handy as a branch in cat() or every().', "cat(n('0 3'), silence)"),
  g(
    'reify',
    'reify(x)',
    'Wrap a bare value as a one-event-per-cycle pattern (patterns pass through unchanged).',
    'reify(60)',
  ),
  g(
    'arrange',
    'arrange(...sections: [cycleCount, pattern][])',
    'Sequence whole sections over cycle ranges, intro then build then drop, each playing for its cycleCount, then the song loops.',
    'arrange([4, intro], [8, build], [16, drop])',
  ),
  g(
    'rise',
    'rise(cycles?: number)',
    'A build-up ramp climbing 0→1 over `cycles` bars (default 8), aim it with .range() to sweep a filter open or swell a volume.',
    "build.ctrl('cutoff', rise(16).range(200, 8000))",
  ),
  g(
    'fall',
    'fall(cycles?: number)',
    'A downlifter ramp draining 1→0 over `cycles` bars (default 8), the mirror of rise, for filters closing into a breakdown.',
    "outro.ctrl('cutoff', fall(8).range(200, 8000))",
  ),
  g('sine', 'sine', 'A smooth wave gliding 0→1→0 once per cycle, the classic slow sweep for filters and gains.', "n('0 3').sound('acid').ctrl('cutoff', sine.range(200, 2400).slow(4))"),
  g('sine2', 'sine2', 'Bipolar sine: like sine but swinging −1..1, for vibrato-style wobbles around a center.', 'sine2.mul(0.1)'),
  g('cosine', 'cosine', 'Like sine but starting at its peak: 1 at the top of each cycle.', 'cosine.range(0.2, 1)'),
  g('saw', 'saw', 'A ramp rising 0→1 over each cycle, then snapping back, rising sweeps and ratchets.', 'saw.range(200, 2000)'),
  g('isaw', 'isaw', 'A falling ramp 1→0 each cycle, decaying sweeps.', 'isaw.range(2000, 200)'),
  g('tri', 'tri', 'A triangle rising 0→1 then falling back each cycle, a sweep that goes up and comes down.', 'tri.range(0.3, 1)'),
  g('square', 'square', 'Flips between 0 (first half of the cycle) and 1 (second half), on/off gating.', 'square.range(0.2, 1)'),
  g('saw2', 'saw2', 'Bipolar saw ramp, −1..1 each cycle.', 'saw2.mul(0.5)'),
  g('tri2', 'tri2', 'Bipolar triangle, −1..1 each cycle.', 'tri2.mul(0.5)'),
  g('square2', 'square2', 'Bipolar square, flipping −1/+1 each half cycle.', 'square2.mul(0.5)'),
  g(
    'rand',
    'rand',
    'Random values 0..1 that are locked to time: the same moment always draws the same value, so every loop plays identically.',
    "n('0 3 5 7').ctrl('cutoff', rand.range(400, 4000))",
  ),
  g(
    'perlin',
    'perlin',
    'Smooth wandering noise 0..1, drifts rather than jumps, great for slow filter or gain movement.',
    ".ctrl('cutoff', perlin.range(400, 4000).slow(2))",
  ),
  g(
    'irand',
    'irand(n: number)',
    'Random whole numbers 0..n−1, time-locked like rand, sample with .segment() to improvise melodies deterministically.',
    "n(irand(8).segment(8)).scale('e minor')",
  ),
  g(
    'slider',
    'slider(value: number, min?: number, max?: number, step?: number)',
    'A live-tweakable number: the editor renders it as a draggable slider, the code just sees the value.',
    ".gain(slider(0.8, 0, 1))",
  ),
  g('xy', 'xy(x: number, y: number)', 'A 2D pad widget: evaluates to [x, y]; drag in the editor to steer two values at once.', 'xy(0.3, 0.7)'),
  g('toggle', 'toggle(on: boolean)', 'A checkbox widget: evaluates to its boolean, flip it live in the editor.', 'toggle(true)'),
  g(
    'pick',
    'pick(value, ...options)',
    'A dropdown widget: evaluates to the chosen value; the options feed the editor menu.',
    "pick('a minor', 'a minor', 'c major')",
  ),
  // Injected per-eval by evalCode (p / defineSynth / setCps), part of the
  // vocabulary even though they are not baseScope keys.
  g(
    'p',
    'p(name: string, pattern: Pattern)',
    'Register a pattern under a name so it plays: same name replaces on the next run, so edits swap in without stopping.',
    "p('bass', n('0 0 3 5').scale('a minor').sound('acid'))",
  ),
  g(
    'defineSynth',
    "defineSynth(name: string, def: SynthDef)",
    'Register a synth under an explicit name, the manual form of assigning synth() to a top-level const.',
    "defineSynth('acid', synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate))))",
  ),
  g(
    'setCps',
    'setCps(cps: number)',
    'Set the tempo in cycles per second (0.5 cps with 4 beats per cycle is 120 bpm).',
    'setCps(0.6)',
  ),
  g(
    'sidechain',
    'sidechain(source: string, opts?: { depth?: number; release?: number; duck?: Record<string, number> })',
    "The classic house pump: every note of the source synth ducks all the other channels' level and lets it swell back, depth 0..1 (default 0.6), release in seconds (default 0.18). Optional duck map sets per-synth response 0..1 (1 = full, 0 = ignore); unlisted synths duck fully.",
    "sidechain('kick', { depth: 0.7, release: 0.18, duck: { arp: 1, pad: 0.4 } })",
  ),
  g(
    'masterCompress',
    'masterCompress(opts?: { threshold?; ratio?; attack?; release?; knee?; makeup? })',
    'A glue compressor on the whole master bus (stereo-linked, after master gain, before the limiter). threshold dB (def -18), ratio (def 4), attack/release ms (def 10/120), knee dB (def 6), makeup dB (def 0). Call again to change it; omit to remove.',
    'masterCompress({ threshold: -14, ratio: 3, attack: 10, release: 100, makeup: 2 })',
  ),
  g(
    'bus',
    'bus(name: string, fx: (ctx) => Sig, sends?: Record<string, number>, opts?: { gain?: number })',
    'A shared send bus: one FX chain (written like a synth post-chain) that many synths feed, so a single reverb or delay is shared instead of duplicated per voice. The sends map routes synths in by amount 0..1, tapped pre-fader so a reverb send does not pump with the sidechain. gain (def 1) scales the return; the bus sums into the master before the glue compressor.',
    "bus('space', ({ input, reverb }) => reverb(input, { roomSize: 0.9 }), { pad: 0.4, arp: 0.2 })",
  ),
]

// -------------------------------------------------------- pattern methods

const pm = (name: string, signature: string, summary: string, example?: string): DocEntry =>
  entry('pattern-method', name, signature, summary, example)

const PATTERN_METHODS: DocEntry[] = [
  // time
  pm('fast', 'fast(k: number)', 'Speed up: fit k cycles of the pattern into one.', "n('0 3 5 7').fast(2)"),
  pm('slow', 'slow(k: number)', 'Slow down: stretch the pattern over k cycles.', 'sine.range(200, 2400).slow(4)'),
  pm('early', 'early(t: number)', 'Nudge everything earlier by t cycles (0.25 = a quarter cycle sooner).', "n('0 3').early(0.125)"),
  pm('late', 'late(t: number)', 'Nudge everything later by t cycles, echoes and laid-back feels.', '.superimpose(x => x.late(0.25).gain(0.3))'),
  pm('rev', 'rev()', 'Play each cycle backwards.', '.every(4, x => x.rev())'),
  pm('arp', "arp(mode?: 'up'|'down'|'updown'|'downup'|'updowninc'|'converge')", 'Arpeggiate: spread the notes that sound together (a chord) across their step, in mode order. Great on chord().', "chord('<Cmaj7 Am7>').arp('updown')"),
  pm('invert', 'invert(k: number)', 'Invert a chord: positive k lifts the lowest voices up an octave (1 = first inversion, 2 = second...), negative drops the highest voices down. Wraps past the chord size. Smooths the jump between chords.', "chord('<C F G>').invert(1)"),
  pm('octave', 'octave(n: number)', 'Transpose whole chords/notes by n octaves (n×12 semitones); negative goes down.', "chord('Cmaj7').octave(-1)"),
  pm('voicing', "voicing(name?: 'close'|'open'|'drop2'|'drop3'|'spread')", 'Re-space a chord: close (default), open (2nd voice up an octave), drop2/drop3 (drop the 2nd/3rd voice from the top for a wider jazz spread), or spread (alternate voices up an octave).', "chord('<Cmaj7 Am7>').voicing('drop2')"),
  pm('voiceLead', 'voiceLead(center?: number)', 'Voice-lead a progression: nudge each chord onto the octaves nearest the previous chord, so the harmony glides instead of leaping between root positions. center (MIDI, def 60) sets the first chord register. Deterministic. Pair with a sustained pad.', "chord('<Cmaj7 Fmaj7 Bm7b5 E7>').voiceLead()"),
  pm(
    'every',
    'every(n: number, f: (p) => p)',
    'Every n-th cycle, transform the pattern with f, a fill or variation on a schedule.',
    '.every(4, x => x.rev())',
  ),
  pm(
    'whenCycle',
    'whenCycle(test: (cycle) => boolean, f: (p) => p)',
    'Transform only the cycles whose number passes the test, arbitrary song structure.',
    '.whenCycle(c => c % 8 >= 6, x => x.fast(2))',
  ),
  pm('iter', 'iter(n: number)', 'Rotate the starting point one step later each cycle, coming home after n cycles.', "n('0 3 5 7').iter(4)"),
  pm('iterBack', 'iterBack(n: number)', 'Like iter but rotating the other way: cycle 1 starts from the last step.', "n('0 3 5 7').iterBack(4)"),
  pm(
    'off',
    'off(t: number, f: (p) => p)',
    'Layer a transformed copy on top, shifted t cycles later, instant call-and-response.',
    '.off(0.25, x => x.gain(0.4))',
  ),
  // arithmetic
  pm('add', 'add(x: number | Pattern)', 'Add to every value, shift scale degrees or notes up (12 = an octave in note space).', "n('0 3 5').add(7)"),
  pm('sub', 'sub(x: number | Pattern)', 'Subtract from every value, shift degrees or notes down.', "n('7 5 3').sub(7)"),
  pm('mul', 'mul(x: number | Pattern)', 'Multiply every value.', 'saw.mul(0.5)'),
  pm('div', 'div(x: number | Pattern)', 'Divide every value.', 'saw.div(2)'),
  pm('range', 'range(lo: number, hi: number)', 'Map a 0..1 signal onto lo..hi, the standard way to aim a sweep at real units.', 'sine.range(200, 2400)'),
  pm(
    'rangex',
    'rangex(lo: number, hi: number)',
    'Like range but exponential, so frequency sweeps sound even from bottom to top (lo and hi must be > 0).',
    'sine.rangex(100, 3200)',
  ),
  // structure
  pm(
    'struct',
    'struct(bools: Pattern<boolean>)',
    'Re-rhythm the pattern: true steps of the boolean pattern become events carrying this pattern’s values, false steps are silent.',
    "note('c3').struct(mini('1 0 1 1'))",
  ),
  pm(
    'euclid',
    'euclid(pulses: number, steps: number, rotation?: number)',
    'Euclidean rhythm: spread `pulses` hits as evenly as possible over `steps` slots, euclid(3,8) is the classic tresillo.',
    ".euclid(5, 8)",
  ),
  pm(
    'euclidInv',
    'euclidInv(pulses: number, steps: number, rotation?: number)',
    'The offbeats of a Euclidean rhythm: hits exactly where euclid rests.',
    '.euclidInv(3, 8)',
  ),
  // randomness
  pm(
    'degradeBy',
    'degradeBy(p: number, seed?: number)',
    'Drop events at random with probability p, deterministic per position, so the same ones drop every loop (change seed for a different take).',
    '.degradeBy(0.3, 1)',
  ),
  pm('degrade', 'degrade()', 'Drop ~50% of events at random (deterministic per cycle).', "note('c5*8').degrade()"),
  pm('undegradeBy', 'undegradeBy(p: number, seed?: number)', 'Keep exactly the events degradeBy(p) would drop, the complementary take.', '.undegradeBy(0.3, 1)'),
  pm(
    'sometimesBy',
    'sometimesBy(p: number, f: (p) => p, seed?: number)',
    'Transform a random p-share of events with f, leaving the rest untouched, e.g. ghost a quarter of the hits.',
    '.sometimesBy(0.25, x => x.gain(0.3), 2)',
  ),
  pm('sometimes', 'sometimes(f: (p) => p)', 'Transform about half the events with f, at random (deterministic per cycle).', '.sometimes(x => x.gain(0.3))'),
  pm('often', 'often(f: (p) => p)', 'Transform about three quarters of the events with f.', '.often(x => x.gain(0.3))'),
  pm('rarely', 'rarely(f: (p) => p)', 'Transform about a quarter of the events with f.', '.rarely(x => x.fast(2))'),
  pm('always', 'always(f: (p) => p)', 'Apply f to everything, the p=1 end of the sometimes family, handy when patterning the choice.', '.always(x => x.rev())'),
  pm('never', 'never(f: (p) => p)', 'Apply f to nothing, keep the code in place, switched off.', '.never(x => x.rev())'),
  // layering
  pm('superimpose', 'superimpose(f: (p) => p)', 'Layer f(pattern) on top of the original, ghost echoes, octave doublings.', '.superimpose(x => x.late(0.25).gain(0.3))'),
  pm('palindrome', 'palindrome()', 'Alternate forward and reversed cycles: there, and back again.', "n('0 3 5 7').palindrome()"),
  pm('ply', 'ply(n: number)', 'Ratchet: repeat each event n times within its own slot.', "note('c5*4').ply(3)"),
  pm(
    'roll',
    'roll(n: number, accel?: number)',
    'Accelerating fill: replace each event with n hits, accel > 1 crowding them toward the downbeat for a snare-roll build-up (accel 1 is an even ratchet).',
    "note('c2').roll(16, 2).sound('sn')",
  ),
  pm(
    'segment',
    'segment(n: number)',
    'Chop a continuous signal into n notes per cycle, how rand/perlin/sine become melodies.',
    'n(irand(8).segment(8))',
  ),
  pm(
    'chunk',
    'chunk(n: number, f: (p) => p)',
    'Divide the cycle into n parts and transform a different part each cycle, a variation that walks through the bar.',
    '.chunk(4, x => x.fast(2))',
  ),
  pm('linger', 'linger(t: number)', 'Loop just the first t of each cycle to fill it, linger(0.25) stutters the first quarter.', "n('0 3 5 7').linger(0.25)"),
  pm(
    'swingBy',
    'swingBy(amount: number, n: number)',
    'Swing feel: with the cycle in n slices, push the second half of each slice late by amount/(2n) of a cycle (amount 1/3 gives classic triplet swing).',
    "note('c5*8').swingBy(1/3, 4)",
  ),
  pm('swing', 'swing(n: number)', 'Classic triplet swing over n slices per cycle, swingBy(1/3, n).', ".euclid(5, 8).swing(4)"),
  // value/hap plumbing (public)
  pm('withValue', 'withValue(f: (v) => v)', 'Transform every value with a function, the general-purpose map.', "n('0 3 5').withValue(v => v * 2)"),
  pm('filterHaps', 'filterHaps(f: (hap) => boolean)', 'Keep only the events the predicate accepts (sees full event objects with timing).', '.filterHaps(h => h.value.n !== 0)'),
  pm('filterValues', 'filterValues(f: (v) => boolean)', 'Keep only events whose value passes the test.', "n('0 3 5 7').filterValues(v => v > 2)"),
  pm('onsetsOnly', 'onsetsOnly()', 'Keep only events that actually begin here, what a scheduler would fire, no clipped tails.', '.onsetsOnly()'),
  pm(
    'appLeft',
    'appLeft(other: Pattern, combine: (a, b) => c)',
    'Combine with another pattern, keeping THIS pattern’s rhythm; the other only supplies values.',
    "n('0 3 5').appLeft(mini('0 12'), (a, b) => a + b)",
  ),
  pm(
    'appRight',
    'appRight(other: Pattern, combine: (a, b) => c)',
    'Combine with another pattern, taking the OTHER pattern’s rhythm.',
    "n('0 3 5').appRight(mini('1 1 1 1'), (a, b) => a)",
  ),
  pm(
    'appBoth',
    'appBoth(other: Pattern, combine: (a, b) => c)',
    'Combine with another pattern, events pairing up wherever both are sounding at once.',
    "mini('0 3').appBoth(mini('0 12'), (a, b) => a + b)",
  ),
  pm(
    'innerBind',
    'innerBind(f: (v) => Pattern)',
    'For each event, play the pattern f(value) in its place, keeping the inner pattern’s own rhythm.',
    "mini('2 4').innerBind(k => n('0 3').fast(k))",
  ),
  pm(
    'outerBind',
    'outerBind(f: (v) => Pattern)',
    'For each event, play the pattern f(value) in its place, keeping the outer event’s rhythm.',
    "mini('2 4').outerBind(k => n('0 3').fast(k))",
  ),
  // controls
  pm(
    'ctrl',
    "ctrl(name: string, x: number | string | Pattern)",
    'Set a named synth parameter on every event, patterns and signals modulate it per event.',
    ".ctrl('cutoff', sine.range(200, 2400).slow(4))",
  ),
  pm('sound', "sound(name: string | Pattern<string>)", 'Route the events to a named synth.', ".scale('a minor').sound('acid')"),
  pm('gain', 'gain(x: number | string | Pattern)', 'Event loudness 0..1 (missing means full volume).', '.gain(0.7)'),
  pm('pan', 'pan(x: number | string | Pattern)', 'Stereo position 0..1, 0 left, 0.5 center, 1 right.', ".pan('0 1')"),
  pm('dur', 'dur(x: number | string | Pattern)', 'Note length as a share of the step: under 1 is staccato, near 1 legato.', '.dur(0.8)'),
  pm('slide', 'slide(x: number | string | Pattern)', '303-style per-note slide: a note with slide > 0 ties into the NEXT note so it glides in (needs a mono + glide synth). Others retrigger cleanly.', ".slide('0 1 0 1')"),
  pm('cutoff', 'cutoff(x: number | string | Pattern)', "Set the synth's 'cutoff' parameter per event, shorthand for .ctrl('cutoff', x).", '.cutoff(sine.range(200, 2400))'),
  pm('res', 'res(x: number | string | Pattern)', "Set the synth's 'res' (resonance) parameter per event, shorthand for .ctrl('res', x).", '.res(0.85)'),
  pm(
    'scale',
    "scale(name: string)",
    "Turn scale degrees (from n()) into actual notes in a scale like 'a minor' or 'f# mixolydian', degrees past the top wrap up an octave.",
    "n('0 0 3 5').scale('a minor')",
  ),
  pm(
    'echo',
    'echo(count: number, time: number, feedback?: number)',
    'Tempo-synced delay: layer count copies, each time cycles later and feedback (default 0.5) quieter — a musical echo, since time is in cycles.',
    ".sound('pluck').echo(3, 0.125, 0.5)",
  ),
  pm(
    'ping',
    'ping(count: number, time: number, feedback?: number)',
    'Like echo, but the taps alternate right/left for a ping-pong stereo delay.',
    ".sound('pluck').ping(4, 0.1875, 0.6)",
  ),
  pm('jux', 'jux(f: (p) => p)', 'Stereo split: the original hard left, f(copy) hard right.', '.jux(x => x.rev())'),
  pm('juxBy', 'juxBy(amount: number, f: (p) => p)', 'jux with adjustable width: 0 keeps both centered, 1 is a full split.', '.juxBy(0.5, x => x.rev())'),
]

// ------------------------------------------------------------- synth ctx

const sc = (name: string, signature: string, summary: string, example?: string): DocEntry =>
  entry('synth-ctx', name, signature, summary, example)

const SYNTH_CTX: DocEntry[] = [
  sc(
    'input',
    'input: Sig',
    'The summed voices, inside a post-chain: synth(voiceFn, ({ input, reverb }) => input.mix(reverb(input), 0.3)) processes the whole instrument once, a shared reverb tail, not one per note.',
    'input.mix(reverb(input), 0.3)',
  ),
  sc('note', 'note: { freq: Sig }', 'The note being played: note.freq is its frequency in Hz, ready to feed an oscillator.', 'saw(note.freq)'),
  sc('gate', 'gate: Sig', 'High while the note is held, low after release, the signal envelopes listen to.', 'adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })'),
  sc('velocity', 'velocity: Sig', 'How hard the note was played, 0..1. Amplitude is already auto-scaled by velocity at the voice, so .gain() just works, use this signal for TIMBRE (e.g. brighten the filter); multiplying your output by it double-applies velocity.', 'svf(saw(note.freq), velocity.range(400, 4000))'),
  sc(
    'param',
    "param(name: string, def: number, opts?: { min, max, curve })",
    "Declare a live-controllable knob with a default and range; patterns drive it via .ctrl(name, ...).",
    "const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })",
  ),
  sc('sine', 'sine(freq: Sig | number)', 'A pure sine oscillator, smooth and round, the building block of FM and subs.', 'sine(note.freq)'),
  sc('saw', 'saw(freq: Sig | number)', 'A bright, buzzy sawtooth oscillator, the classic filter-sweep material.', 'saw(note.freq)'),
  sc('square', 'square(freq: Sig | number)', 'A hollow-sounding square-wave oscillator, great an octave down for body.', 'square(note.freq.mul(0.5))'),
  sc('tri', 'tri(freq: Sig | number)', 'A soft triangle oscillator, mellower than saw or square.', 'tri(note.freq)'),
  sc('pulse', 'pulse(freq: Sig | number, width?: Sig | number)', 'A rectangle oscillator with adjustable width, modulate width for a moving, chorused color.', 'pulse(note.freq, lfo(0.5).range(0.2, 0.8))'),
  sc(
    'syncsaw',
    'syncsaw(freq: Sig | number, ratio?: Sig | number)',
    'A hard-synced sawtooth for screaming, aggressive leads: a bright slave saw runs at freq×ratio but is force-restarted every freq cycle, so the pitch stays put while the timbre tears, sweep ratio (>= 1, default 2) for the classic sync sweep. Anti-aliased, so it stays clean up high.',
    'syncsaw(note.freq, lfo(0.2).range(1, 5)).mul(adsr(gate))',
  ),
  sc(
    'fm',
    "fm(freq: Sig | number, mod?: Sig | number, opts?: { feedback?: Sig | number; wave?: 'sine' | 'tri' | 'saw' | 'square' })",
    'FM / phase-modulation operator: a sine at freq whose phase is bent by mod (another operator, its amplitude is the modulation index in cycles) plus self-feedback (0..~1). The FM building block, chain operators as each other mod for DX-style bells, e-pianos and metallic basses; raise feedback for a self-modulating operator that grows toward a saw. Keep the index modest (1 to 3) for a warm tone; big indexes and heavy feedback turn harsh. Shape it with an ADSR like any oscillator.',
    'fm(note.freq, fm(note.freq.mul(3)).mul(adsr(gate, { d: 0.4, s: 0 }).mul(2))).mul(adsr(gate))',
  ),
  sc(
    'wavetable',
    "wavetable(freq: Sig | number, pos?: Sig | number, opts?: { table: 'basic' | 'harmonic' | 'pwm' })",
    'A morphing wavetable oscillator: pos (0..1) scans through a bank of single-cycle waves for an evolving, sweepable timbre, anti-aliased, so it stays clean up high. Tables: basic (sine→saw→square), harmonic (moving formant), pwm (widening pulses).',
    "wavetable(note.freq, lfo(0.25).range(0, 1), { table: 'basic' })",
  ),
  sc('noise', "noise(color?: 'white' | 'pink' | 'brown')", 'Noise, the raw material of hats, claps, wind and breath. white (default) is flat and bright; pink (−3 dB/oct) is warmer and more natural; brown (−6 dB/oct) is deep and rumbly.', "svf(noise('pink'), 8000, { mode: 'hp' })"),
  sc(
    'lfsr',
    "lfsr(freq, opts?: { mode?: 'white' | 'periodic' })",
    'The chiptune noise channel (NES/Game Boy): a 15-bit shift register clocked at freq, so freq is the noise "pitch", low is a coarse rumble, high a bright hiss. mode white (default) is classic hiss; periodic is a short 93-step loop that buzzes into a metallic pitched tone. 1-bit output, shape it with an ADSR for chip drums, hats and zaps.',
    "lfsr(8000).mul(adsr(gate, { d: 0.08, s: 0, r: 0.02 }))",
  ),
  sc('supersaw', 'supersaw(freq, opts?: { detune?, mix? })', 'The fat trance/EDM lead: 7 detuned sawtooths in one oscillator. detune (0..1, def 0.2) spreads them apart; mix (0..1, def 0.7) is how loud the 6 side saws are versus the centre. Anti-aliased, so it stays clean up high.', "supersaw(note.freq, { detune: 0.3, mix: 0.8 })"),
  sc(
    'sample',
    'sample(gate, name, opts?: { root, speed, loop })',
    'Play a loaded audio sample (drums, vocal chops, risers). A rising gate edge retriggers from the start; one-shot by default, loop:true to loop. Pitch: root plays natural at that MIDI note and tracks otherwise, or set speed directly. Mono out, shape it with an ADSR like an oscillator. Unknown name → silence.',
    "sample(gate, 'break', { root: 60 }).mul(adsr(gate, { r: 0.1 }))",
  ),
  sc(
    'granular',
    'granular(gate, name, opts?: { pos, root, rate, size, density, spray, loop })',
    'Granular synthesis over a loaded sample: sprays short windowed grains from a scannable position, pitched independently. Grains spawn while gate is high. pos (0..1) is the read centre, freeze for a drone, sweep to scrub. Pitch via root (tracks the note) or rate. size (grain seconds, def 0.08), density (grains/s, def 25), spray (jitter s, def 0.01). Shape with an ADSR.',
    "granular(gate, 'pad', { root: 60, pos: lfo(0.05).range(0, 1), size: 0.1, density: 40 })",
  ),
  sc(
    'pluck',
    'pluck(gate, freq, opts?: { decay?, damp?, seed? })',
    'Karplus-Strong plucked string: a rising gate edge plucks a string tuned to freq. A one-period noise burst recirculates through a tuned delay with a damping lowpass, the natural string decay. decay (s, def 1.5) is the ring time; damp (0..0.95, def 0.5) darkens it. The pluck IS the envelope, so no ADSR needed (you can still shape it).',
    "pluck(gate, note.freq, { decay: 2, damp: 0.4 })",
  ),
  sc(
    'modal',
    "modal(gate, freq, opts?: { model?: 'bell' | 'bar' | 'drum' | 'glass', decay?, damp? })",
    'A struck modal resonator bank: a rising gate edge strikes a bank of tuned resonators at freq, ringing like a physical object. model picks the material (bell default, bar for marimba, drum, glass); decay (s, def 1.2) is the ring time; damp (0..1) mellows the strike by taming the higher modes. Self-enveloping like pluck.',
    "modal(gate, note.freq, { model: 'bell', decay: 3 })",
  ),
  sc(
    'svf',
    "svf(input, cutoff, opts?: { res, mode: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' })",
    'A clean multimode filter: low-pass by default, high-pass for hats, band-pass for claps, notch to scoop a band out, peak for a resonant bell that boosts at cutoff; res adds a resonant peak.',
    "svf(noise(), 1500, { mode: 'bp', res: 0.6 })",
  ),
  sc(
    'ladder',
    'ladder(input, cutoff, opts?: { res })',
    'A Moog-style ladder low-pass, warmer and growlier than svf, the acid filter.',
    'ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 })',
  ),
  sc('onepole', 'onepole(input, cutoff)', 'A gentle one-pole low-pass, just softens the top end, no resonance.', 'onepole(square(note.freq), 900)'),
  sc(
    'adsr',
    'adsr(gate, opts?: { a, d, s, r })',
    'An attack/decay/sustain/release envelope 0..1 driven by the gate, shape loudness, brightness, pitch.',
    'adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })',
  ),
  sc(
    'env',
    'env(gate, points: [time, level][], opts?: { release?, curve?, loop? })',
    'A multi-segment (breakpoint) envelope, the flexible cousin of adsr. points are [seconds, level] pairs: while the gate is held it ramps through them in order (each from the previous level), then holds the last level, or with loop repeats them like a function generator. Gate-off releases from the current level to 0 over release (def 0.1s). curve (def 0) shapes every segment: >0 fast-then-slow, <0 slow-then-fast. Levels are not clamped, so aim it at amplitude, pitch or any modulation.',
    "env(gate, [[0.005, 1], [0.15, 0.4], [0.5, 0.6]], { release: 0.3, curve: 3 })",
  ),
  sc(
    'lfo',
    "lfo(freq, shape?: 'sine' | 'tri' | 'square' | 'saw' | 'rand')",
    'A slow oscillator 0..1 for movement, wobble a filter, a pulse width, a pan. Shapes sine/tri/square/saw, plus rand: a sample-and-hold that jumps to a new random level each cycle and holds it, for stepped random modulation.',
    'lfo(0.5).range(400, 2000)',
  ),
  sc(
    'delay',
    'delay(input, time, feedback?, opts?: { maxTime })',
    'A per-voice echo: repeats the input after `time` seconds, feedback making the repeats trail off.',
    'tone.add(delay(tone, 0.28, 0.45))',
  ),
  sc(
    'reverb',
    'reverb(input, opts?: { roomSize, damp })',
    'Freeverb-style algorithmic reverb. Returns the WET tail only, mix it back with the dry signal. roomSize (0..1) sets the tail length, damp (0..1) darkens it.',
    'tone.mix(reverb(tone, { roomSize: 0.85, damp: 0.4 }), 0.35)',
  ),
  sc(
    'chorus',
    'chorus(input, opts?: { rate, depth, mix })',
    'A three-voice ensemble that thickens and widens: slow detuned pitch-wobbles blur one voice into many, lush pads, shimmering keys. In a post-chain it runs per stereo side, so it also spreads the sound wide.',
    'input.mix(chorus(input, { rate: 0.6, depth: 0.004 }), 1)',
  ),
  sc(
    'comb',
    'comb(input, freq, feedback?, opts?: { damp })',
    'A tuned resonator that rings at freq (Hz) like a plucked string or a metal bar, feedback (0..0.98) sets how long it sings, damp softens the highs. Great for physical, metallic, Karplus-Strong tones.',
    'comb(noise().mul(env), note.freq, 0.95)',
  ),
  sc(
    'bitcrush',
    'bitcrush(input, opts?: { bits, downsample })',
    'Lo-fi crush: bits (1..16) coarsens the resolution into gritty steps, downsample (1..64) drops the sample rate for aliased, retro-digital edge.',
    'bitcrush(tone, { bits: 6, downsample: 4 })',
  ),
  sc(
    'shape',
    'shape(input, drive?, opts?: { type })',
    "A drive/distortion stage: push the level with drive (>= 1) through a curve, 'soft' warm, 'hard' harsh, 'sine' bright folding, 'tube' asymmetric with even harmonics.",
    "shape(saw(note.freq), 6, { type: 'tube' })",
  ),
  sc(
    'compress',
    'compress(input, opts?: { threshold, ratio, attack, release, knee, makeup })',
    'A compressor: tames peaks and glues a signal together. threshold (dB, def -18), ratio (def 4), attack/release (ms, def 10/120), knee (dB, def 6), makeup (dB, def 0). For PARALLEL (New York) compression, blend the dry back: input.mix(compress(input, { ratio: 10 }), 0.5).',
    'compress(drumBus, { threshold: -20, ratio: 4, attack: 5, makeup: 4 })',
  ),
  sc(
    'phaser',
    'phaser(input, opts?: { rate?, depth?, feedback?, stages?, mix? })',
    'A swept-allpass phaser: a cascade of allpass stages moves notches through the signal for that classic sweeping, whooshing motion. rate Hz (def 0.5), depth 0..1 (def 0.7), feedback 0..0.9 (def 0.4) sharpens the notches, stages 2..12 (def 4), mix 0..1 (def 0.5).',
    'phaser(pad, { rate: 0.3, feedback: 0.6 })',
  ),
  sc(
    'formant',
    'formant(input, morph?)',
    'A vowel filter: three band-pass resonators at a vowel’s formant frequencies, so a buzzy source (saw, pulse, supersaw) turns into a singing "aah/eee/ooo". morph (0..1) scans the vowels a to e to i to o to u, sweep it for a talking, vocal effect.',
    "formant(saw(note.freq), lfo(0.2).range(0, 1))",
  ),
  sc(
    'vocoder',
    'vocoder(carrier, modulator, opts?)',
    'The classic VOCODER: a bank of band-pass filters reads the modulator’s per-band loudness (its spectral envelope) and imposes it on the carrier, so the carrier "talks" or "sings" in the modulator’s voice. Give it a harmonically rich carrier (saw/supersaw/pulse) and a modulator with formants — a voice sample, noise, or another synth. opts: bands 2..64 (def 16, more = clearer), low/high band range in Hz (def 120/7500), q band sharpness scale (def 1), response envelope time in seconds (def 0.012, smaller = crisper consonants).',
    "vocoder(supersaw(note.freq), sample(gate, 'vox'), { bands: 20 })",
  ),
  sc('pan', 'pan(input, pos)', 'Place the signal in the stereo field: 0 left, 0.5 center, 1 right.', 'pan(osc, 0.3)'),
  sc('mix', 'mix(a, b, t)', 'Crossfade between two signals: t=0 is all a, t=1 all b.', 'mix(saw(note.freq), square(note.freq), 0.3)'),
]

// ------------------------------------------------------------ sig methods

const sm = (name: string, signature: string, summary: string, example?: string): DocEntry =>
  entry('sig-method', name, signature, summary, example)

const SIG_METHODS: DocEntry[] = [
  sm('mul', 'mul(x: Sig | number)', 'Multiply the signal, scale a level, or apply an envelope.', 'saw(note.freq).mul(env)'),
  sm('add', 'add(x: Sig | number)', 'Add signals together, layer oscillators, or offset a modulator.', 'tone.add(partial)'),
  sm('sub', 'sub(x: Sig | number)', 'Subtract from the signal.', 'sig.sub(0.5)'),
  sm('div', 'div(x: Sig | number)', 'Divide the signal.', 'note.freq.div(2)'),
  sm('pow', 'pow(x: Sig | number)', 'Raise to a power, squaring an envelope makes its curve snappier.', 'env.pow(2)'),
  sm('clip', 'clip(lo?: Sig | number, hi?: Sig | number)', 'Hard-limit the signal to a range (default −1..1), harsh, digital-edged distortion.', 'osc.mul(3).clip()'),
  sm('tanh', 'tanh()', 'Soft saturation: rounds off peaks like an overdriven amp, warm, musical distortion.', 'sine(pitch.range(45, 160)).mul(amp).tanh()'),
  sm('fold', 'fold()', 'Wavefold: peaks fold back on themselves instead of clipping, buzzy west-coast harmonics.', 'sine(note.freq).mul(depth).fold()'),
  sm('mix', 'mix(other: Sig | number, amount: Sig | number)', 'Crossfade this signal toward another: amount 0 keeps this, 1 is all the other.', 'saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)'),
  sm('range', 'range(lo: Sig | number, hi: Sig | number)', 'Map a 0..1 signal (envelope, lfo) onto lo..hi, aim it at Hz, seconds, anything.', 'pitch.pow(2).range(45, 160)'),
]

// ------------------------------------------------------------ mini syntax

const ms = (name: string, signature: string, summary: string, example?: string): DocEntry =>
  entry('mini-syntax', name, signature, summary, example)

const MINI_SYNTAX: DocEntry[] = [
  ms('mini:seq', 'a b c', 'Space-separated steps share the cycle equally, four words means four quarter-notes.', "n('0 0 3 5')"),
  ms('mini:~', '~', 'A rest: this step is silent.', "note('~ c4 ~ c4')"),
  ms('mini:_', 'a _', 'Elongate: the previous step holds for one more slot ("a _ b" gives a twice the length of b).', "n('0 _ 3 5')"),
  ms('mini:[]', '[a b]', 'A subgroup: everything inside fits into one step, subdividing it; a comma inside stacks voices.', "note('c2 [e2 g2] c2 [e2, g2]')"),
  ms('mini:<>', '<a b c>', 'Alternation: one entry per cycle, cycling through them, slow harmonic movement in one step.', "note('<e2 e2 d2 g2>')"),
  ms('mini:{}', '{a b c, d e}%n', 'Polymeter: voices of different lengths run at n steps per cycle, drifting against each other.', "note('{c2 e2 g2, c4 g4}%4')"),
  ms('mini:*', 'a*n', 'Repeat the step n times faster within its slot, "c5*8" is eight hits in the step.', "note('c5*8').sound('hat')"),
  ms('mini:/', 'a/n', 'Slow the step down by n: it takes n cycles to play once.', "note('c2/2')"),
  ms('mini:!', 'a!n', 'Duplicate the step n times as separate steps ("a!3 b" = "a a a b"); bare ! repeats once more.', "n('0!3 5')"),
  ms('mini:@', 'a@n', 'Weight: give this step n slots’ worth of time ("a@3 b" makes a three times as long as b).', "n('0@3 5')"),
  ms('mini:(p,s,r)', 'a(pulses,steps,rotation?)', 'Euclidean rhythm inline: spread hits evenly, e.g. bd(3,8) is the tresillo kick.', "sound('bd(3,8)')"),
  ms('mini:?', 'a?p', 'Maybe: drop this step at random (probability p, default 0.5), deterministic per cycle.', "note('c5*8 ?0.3')"),
  ms('mini:|', 'a | b', 'Choice: each cycle picks one alternative at random (deterministic per cycle number).', "n('0 3 5 | 7 5 3')"),
]

// ----------------------------------------------------------------- export

export const DSL_DOCS: DocEntry[] = [
  ...GLOBALS,
  ...PATTERN_METHODS,
  ...SYNTH_CTX,
  ...SIG_METHODS,
  ...MINI_SYNTAX,
]

/** name → entries. Kinds can collide on a name ('n' global, 'mul' both a
 *  pattern method and a Sig method); consumers filter by kind. */
export const docsByName: Map<string, DocEntry[]> = (() => {
  const map = new Map<string, DocEntry[]>()
  for (const e of DSL_DOCS) {
    const list = map.get(e.name)
    if (list === undefined) map.set(e.name, [e])
    else list.push(e)
  }
  return map
})()

/** All entries of one kind, completion sources build their option lists here. */
export const docsOfKind = (kind: DocEntry['kind']): DocEntry[] =>
  DSL_DOCS.filter((e) => e.kind === kind)
