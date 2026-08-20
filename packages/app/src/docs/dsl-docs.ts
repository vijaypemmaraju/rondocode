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
    'synth(build: (ctx) => Sig, post?: (ctx) => Sig, opts?: { mono?: boolean; glide?: number; unison?: number; detune?: number; spread?: number; curve?: number; blend?: number; octaves?: number; humanize?: number })',
    'Define an instrument: the build function wires oscillators, filters and envelopes into a per-voice sound; the optional post function adds an FX chain (reverb, delay, EQ) over the summed voices, shared, not per note. opts sets voice modes, mono+glide for portamento leads, unison (with detune cents and stereo spread 0..1) for fat detuned stacks, then shape the stack: curve (>1 pulls inner voices toward the note), blend (edge-voice gain 0..1) and octaves (every Nth voice +12) sculpt Serum-style supersaws; humanize (0..1) nudges every voice off the grid by a hair, up to ±8 cents and 14 ms late, hashed per voice so the render still repeats exactly, so a stack stops sounding like N identical copies; pass opts as the 2nd arg when there is no post. Assign to a top-level const to register it under that name.',
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
    "Named chords, each expanded to a stack of notes (root octave 3). Triads: maj (also major, M, or a bare root), min (also minor, m), dim, aug, and 5 for the bare fifth. Sevenths: 7 (dom7), maj7 (M7), m7 (min7), m7b5, dim7. Sixths: 6, m6 (min6). Extensions: 9, maj9, m9, 11, m11, 13, m13. Suspended: sus2, sus4 (sus), 7sus4. Added tones, which keep the third: 2/add2, 4/add4, add9, add11, each with a minor form (m2/madd2, m4/madd4, madd9, madd11). Plus slash bass (C/E). Pair with .arp() to arpeggiate.",
    "chord('<Cmaj7 Am7 Dm7 G7>').sound('keys')",
  ),
  g(
    'sound',
    'sound(name: string | Pattern<string>)',
    'Start a pattern from synth names alone, each word is an event routed to that synth (with a default note of 60; pitch with n(…).sound(…) instead when it matters).',
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
    'A live-tweakable number. At EVAL it is just the value -- slider(0.6, 0, 1) is 0.6 and nothing else -- so a program full of sliders renders identically headless. min, max and step exist only for the WIDGET: they set the drag range and how far each nudge moves, and changing them cannot change what the code computes. Reach for it to find a number by ear; once you know it, type the number. Unlike param/macro it is per-occurrence and not addressable by name, so a pattern cannot drive it.',
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
    'defineScale',
    "defineScale(name: string, spec: number[] | { cents: number[]; periodCents?: number } | { ratios: number[]; periodRatio?: number })",
    "Register a custom tuning for .scale(): step offsets in semitones from the root (floats are microtones), cents, or frequency ratios, with an optional period for non-octave tunings; the arrays are plain values, so adding or removing a note is editing the array. Any 'Nedo' name (c 19edo) works without defining anything.",
    "defineScale('pelog', { cents: [0, 120, 270, 540, 670, 785, 950] })",
  ),
  g(
    'defineWavetable',
    'defineWavetable(name: string, frames: number[][])',
    "Register a custom wavetable for wavetable(freq, pos, { table: name }): each frame is a list of harmonic partial amplitudes (frames[f][i] = harmonic i+1, up to 32 partials), and pos morphs between the frames. The engine synthesizes band-limited single-cycle waves from the partials, so custom tables stay as clean up high as the built-ins. Call it BEFORE the synth that uses the table; the numbers are the sound, so editing an amplitude is sound design.",
    "defineWavetable('vox', [[1, 0.25], [0.4, 1, 0.5], [0.3, 0.8, 1, 0.7]])",
  ),
  g(
    'macro',
    "macro(name: string, def: number, opts?: { min?: number; max?: number; curve?: 'lin' | 'log' })",
    "Declare a project-wide macro: one control that reaches across every synth. Any synth or post chain below the declaration says param('name') with NO default to use it, and every use site reads these numbers, so one knob moves them all and nothing can drift. A macro is a VALUE, not a wire, so each site can scale it however it likes (param('bright').mul(0.5), or 0.6 minus a fraction of it for an inverse) and one knob drives several destinations at different ratios. A synth that passes its own default keeps a separate control of the same name. Declare it before the synths that use it.",
    "macro('bright', 1480, { min: 500, max: 7300, curve: 'log' })",
  ),
  g(
    'curvedef',
    'curvedef(name: string, points: ([fraction, level] | [fraction, level, curve])[])',
    "Register a named curve SHAPE. Stored normalised -- the fractions are relative segment lengths, not durations -- and scaled where it is used, which is what lets one definition serve both layers: shape('swell', 0.8) is 0.8 seconds for env(), shape('swell', 16) is 16 cycles for curve(). The cost, plainly: a named curve cannot carry an absolute timing. It is a shape, and how long it takes belongs to the call.",
    "curvedef('swell', [[0.25, 1], [0.75, 0.2]])",
  ),
  g(
    'shape',
    'shape(name: string, length: number)',
    "Look up a `curvedef` by name and scale it to `length`, returning an ordinary points array -- so env() and curve() consume it without either knowing a registry exists. The UNIT of `length` follows the consumer: seconds for env(), cycles for curve(), so the same named shape is a 200 ms envelope in one place and a four-bar automation ramp in another. That reuse is the point: define the shape once, scale it wherever. An unknown name THROWS and lists what is registered rather than returning an empty array, because a silent [] is a synth that makes no sound and shows nothing to look at.",
    "env(gate, shape('swell', 0.8))",
  ),
  g(
    'curve',
    'curve(points: ([cycles, level] | [cycles, level, curve])[], opts?: { curve?, from?, loop? })',
    "A breakpoint automation lane, measured in CYCLES: curve([[8, 1], [4, 0.3], [16, 1]]) opens over 8 bars, sags over 4, and comes back over 16. The same shape as a synth's env() and the same easing numbers, run against the transport instead of a note's gate -- rise/fall are the two-point linear special cases of it. A third number on a breakpoint gives that leg its own curve; `from` sets the level before the first one (default 0); `loop` repeats instead of holding the last level. Sampled once per event like any signal, so a control that must move WITHIN one note belongs in the synth.",
    "p('pad', chord('<Am F>').sound('pad').ctrl('cutoff', curve([[8, 1], [8, 0.2]]).range(300, 6000)))",
  ),
  g(
    'macroval',
    'macroval(name: string)',
    "Read a project-wide macro from the PATTERN side, as a signal: macroval('bright').div(7300). A macro is normally a synth param, and dur/gain/pan are structural -- the scheduler consumes them per event and they never reach the engine -- so a param could not drive one. This mirrors the same macro across, sampled once per note like any signal-driven control. In rondo you just write the macro's name in the modifier (dur: bright / 7300) and this is what it compiles to.",
    "p('lead', n('0 3 5').sound('lead').dur(macroval('bright').div(7300)))",
  ),
  g(
    'macroNum',
    'macroNum(name: string)',
    "A project-wide macro or switch as a plain NUMBER, read once at eval. For the places that capture a value rather than reading a signal per sample -- sidechain()'s duck depth is the one that matters, since the pump was the only project control a macro could not reach. It resolves the DECLARED value, so it follows a switch tap (which rewrites the source and re-evals) but not a knob mid-drag. Use macroval where a signal will do: that one is live. In rondo, write the control's name where a number goes: sidechain kick depth:drums.",
    "sidechain('kick', { depth: macroNum('drums'), release: 500 })",
  ),
  g(
    'setCps',
    'setCps(cps: number)',
    'Set the tempo in cycles per second, the engine unit: one cycle is one bar, so 0.5 cps is a two-second bar, which at 4 beats to the bar is 120 bpm. setBpm is the same tempo in the unit you count in.',
    'setCps(0.6)',
  ),
  g(
    'setBpm',
    'setBpm(bpm: number)',
    'Set the tempo in beats per minute, counted in QUARTER notes (one cycle is one bar, so at 4/4 128 bpm is 0.5333 cps; under setTimeSig(3, 4) the same 128 bpm is 0.7111 cps, because the bar is shorter). Same tempo slot as setCps, the same convention MIDI import and export use, and the last call in a run wins.',
    'setBpm(128)',
  ),
  g(
    'setTimeSig',
    'setTimeSig(beats: number, unit: number)',
    'Set the meter: beats per bar, then the beat unit. A cycle is one BAR, so this is what makes a bar three quarters long instead of four -- it scales setBpm, the header tempo readout, the MIDI clock and the bar lines of an exported MIDI file. It does NOT change your notation: a line still fills one cycle, which is now a 3/4 bar. Order does not matter, so timesig and bpm can go in either order. The unit must be a power of two (5/4 and 7/8 are fine, 4/6 is not a time signature). Without it a project is in 4/4.',
    'setTimeSig(3, 4)',
  ),
  g(
    'sidechain',
    'sidechain(source: string, opts?: { depth?: number; release?: number; duck?: Record<string, number> })',
    "The classic house pump: every note of the source synth ducks all the other channels' level and lets it swell back, depth 0..1 (default 0.6), release in MILLISECONDS (default 180), the same unit every other release in the language uses. Optional duck map sets per-synth response 0..1 (1 = full, 0 = ignore); unlisted synths duck fully.",
    "sidechain('kick', { depth: 0.7, release: 180, duck: { arp: 1, pad: 0.4 } })",
  ),
  g(
    'masterCompress',
    'masterCompress(opts?: { threshold?; ratio?; attack?; release?; knee?; makeup? })',
    'A glue compressor on the whole master bus (stereo-linked, after master gain, before the limiter). threshold dB (def -18), ratio (def 4), attack/release ms (def 10/120), knee dB (def 6), makeup dB (def 0). Call again to change it; omit to remove.',
    'masterCompress({ threshold: -14, ratio: 3, attack: 10, release: 100, makeup: 2 })',
  ),
  g(
    'stereo',
    'stereo(opts?: { width, monoBelow })',
    'MID/SIDE on the master bus. width scales the SIDE against the mid: 0 collapses the mix to mono, 1 leaves it alone, above 1 widens. monoBelow collapses everything under that frequency in Hz to mono -- the standard mastering move, and the one that matters on a system with a single sub, where stereo bass either cancels or wanders. Both are MONO-SAFE by construction: scaling the side never touches the mid, and the mid IS the mono sum, so a mix folded to mono is bit-identical whatever the width. That is what a Haas or Lauridsen widener cannot offer, and why this exists as well as width(). It lives on the master bus rather than in a post chain because every kernel in the engine is mono -- a post chain gets its stereo by running the same graph once per side, so no node can see both channels at once.',
    "stereo({ width: 1.3, monoBelow: 120 })",
  ),
  entry(
    'global',
    'masterGain',
    'masterGain(db: number)',
    "Overall output level in dB (0 = unity, negative = quieter), clamped to -60..+12. The one control that scales EVERY part equally, so it changes the level without touching the balance. Reach for it when a bounce reports 'normalized -N dB': above that ceiling the render scales the whole mix back down, which makes per-part gains inert, and only a uniform trim brings it back under. Call again to change it.",
    'masterGain(-4)',
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
  pm('overChord', 'overChord(chords: Pattern)', "Read this pattern's numbers as CHORD DEGREES of another pattern: 0 is the lowest note of whatever chord is sounding, and degrees past the top wrap up an octave. One figure re-voices itself as the harmony moves, so the same line is Am then F without rewriting it.", "n('0 2 1 4').overChord(chord('<Am F G Em>'))"),
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
    'Euclidean rhythm: spread `pulses` hits as evenly as possible over `steps` slots. There is exactly one such spacing for any pair, which is why so many traditional rhythms turn out to be Euclidean -- (3,8) is the tresillo, (5,8) the cinquillo, (7,16) a West African bell. `rotation` shifts the pattern LEFT by that many steps (Tidal rotL direction), so the same hits start elsewhere in the bar: (3,8,2) is the tresillo displaced, which grooves completely differently while being the same rhythm. It sets STRUCTURE, deciding where events happen rather than what they are.',
    ".euclid(5, 8)",
  ),
  pm(
    'euclidInv',
    'euclidInv(pulses: number, steps: number, rotation?: number)',
    'The complement of a Euclidean rhythm: hits exactly where `euclid` with the same arguments rests, and rests where it hits. Same pulses/steps/rotation meanings. The pair is how one idea becomes an interlocking two-part groove -- put the kick on euclid(3,8) and the shaker on euclidInv(3,8) and every slot is covered exactly once, with neither line having to know where the other sits.',
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
  pm('superimpose', 'superimpose(f: (p) => p)', 'Layer f(pattern) on top of the original: ghost echoes, octave doublings, and -- with `add` on a scaled pattern -- DIATONIC harmony, since `add` counts scale degrees, so `superimpose(x => x.add(2))` is a third that is minor or major depending on where in the key it lands.', '.superimpose(x => x.late(0.25).gain(0.3))'),
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
  pm(
    'humanizeBy',
    'humanizeBy(amount: number, n: number, seed?: number)',
    'Deterministic timing jitter on swing’s ruler: every onset moves late by its own random amount below amount/(2n) of a cycle, drawn from the exact onset time so a render repeats bit for bit. Late-only, and independent of the degradeBy/chance stream.',
    "note('c5*8').sound('hat').humanizeBy(.2, 4)",
  ),
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
  pm('dur', 'dur(x: number | string | Pattern)', "Note length as a share of the step: under 1 is staccato, near 1 legato. It MULTIPLIES the note's own length, so it is not a count of bars -- .slow(16).dur(16) is not sixteen bars, it is sixteen times a sixteen-bar note. Past its own next trigger the extra length cannot sound (the retrigger takes the voice back), and the editor warns.", '.dur(0.8)'),
  pm('slide', 'slide(x: number | string | Pattern)', '303-style per-note slide: a note with slide > 0 ties into the NEXT note so it glides in; others retrigger cleanly, snapping to pitch. Needs `mono` AND a `glide` time on the synth -- glide supplies the bend and slide decides which steps get it, so neither does anything alone. A tie only reaches the ADJACENT step: a sliding note followed by a rest releases at the end of its own step rather than holding across the gap, because a rest is not a note to glide into.', ".slide('0 1 0 1')"),
  pm('cutoff', 'cutoff(x: number | string | Pattern)', "Set the synth's 'cutoff' parameter per event, shorthand for .ctrl('cutoff', x).", '.cutoff(sine.range(200, 2400))'),
  pm('res', 'res(x: number | string | Pattern)', "Set the synth's 'res' (resonance) parameter per event, shorthand for .ctrl('res', x).", '.res(0.85)'),
  pm(
    'scale',
    "scale(name: string | Pattern<string>)",
    "Turn scale degrees (from n()) into actual notes in a scale like `a minor` or `f# mixolydian`; degrees past the top wrap up an octave. The name can also be a PATTERN, which modulates the key: `<c-maj f-min>` plays the same degrees in C major one cycle and F minor the next, so a line written once changes colour instead of being rewritten. Inside mini notation the two words are hyphen-joined, because atoms are space-delimited -- `c-maj`, `f#-min`, `c-19edo`, and the long spellings too. The scale that applied is STAMPED on each event, which is what lets `add` transpose in degrees of whichever key is sounding at that moment rather than the first one. A bad name still throws when the pattern is built, not when it plays.",
    "n('0 0 3 5').scale('a minor')",
  ),
  pm(
    'echo',
    'echo(count: number, time: number, feedback?: number)',
    'A delay made of PATTERN rather than audio: it lays down `count` copies of the events, each `time` later than the last and `feedback` (def 0.5) times as loud. `count` INCLUDES the dry one, so echo(3, 0.125) is the original plus two repeats. `time` is in CYCLES, not seconds, so the repeats stay locked to the tempo when you change it -- which is the whole reason to do it here instead of with the `delay` node. The gain multiplies whatever gain is already set rather than replacing it. Because the taps are real events they retrigger the envelope and can be transposed or filtered per repeat, which an audio delay cannot do; what you give up is a feedback tail that smears, since nothing is fed back through a filter.',
    ".sound('pluck').echo(3, 0.125, 0.5)",
  ),
  pm(
    'ping',
    'ping(count: number, time: number, feedback?: number)',
    '`echo` with the taps alternating right and left: repeat one hard right, repeat two hard left, and so on -- the classic ping-pong delay. Same arguments and meanings: `count` includes the dry copy, `time` is in cycles so it follows the tempo, `feedback` (def 0.5) is the gain each tap loses. Because it pans the EVENTS, a mono synth ping-pongs with no stereo processing in the voice at all, and the dry hit stays centred.',
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
    "param(name: string, def?: number, opts?: { min, max, curve })",
    "Declare a named control the outside world can move: the editor gives it a knob, and a pattern drives it per note with .ctrl(name, ...), which is how one synth plays differently on every hit. `min`/`max` bound the knob and `curve` is `lin` or `log` -- use `log` for anything in Hz, because a linear cutoff knob spends most of its travel in the top octave where you can barely hear it move. `values` makes it a SWITCH instead: two fixed settings you tap between rather than a range, and it is mutually exclusive with min/max/curve. OMIT THE DEFAULT and it stops being this synth's own knob and becomes a reference to a project-wide macro() of the same name, so several synths share one control -- the difference between a knob per voice and a knob for the track.",
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
    "wavetable(freq: Sig | number, pos?: Sig | number, opts?: { table?: string; warp?: 'sync' | 'bend' | 'mirror'; warpAmt?: Sig | number })",
    'A morphing wavetable oscillator: pos (0..1) scans through a bank of single-cycle waves for an evolving, sweepable timbre, anti-aliased, so it stays clean up high. Built-in tables: basic (sine→saw→square), harmonic (moving formant), pwm (widening pulses), or name your own table registered with defineWavetable. warp bends how each cycle READS the table: sync re-runs it faster and wraps (the hard-sync tear), bend bows the phase curve (tilts the harmonic balance), mirror reflects it at the midpoint (palindromic symmetry). warpAmt (0..1, default 0.5) is audio-rate: sweep it with an envelope for the classic sync scream.',
    "wavetable(note.freq, 0.5, { table: 'basic', warp: 'sync', warpAmt: adsr(gate, { d: 0.3, s: 0.2 }) })",
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
    'sample(gate, name, opts?: { root, speed, loop, variant, zones, start, end, reverse, slices, fade })',
    'Play a loaded audio sample (drums, vocal chops, risers, your own bounced takes). A rising gate edge retriggers from the start; one-shot by default, loop:true to loop. Pitch: root plays natural at that MIDI note and tracks otherwise, or set speed directly. SLICING: start and end (fractions 0..1 of the buffer) play only that window, and a loop wraps inside it; reverse:true plays it backwards; slices:N divides the window into N chops and the NOTE picks one at natural speed (root selects chop 0, root+1 the next, wrapping), so a note pattern sequences the chops; fade (seconds, def 0.003 once sliced) ramps the chop edges so they do not click. FAMILIES: `bd`, `bd:1` and `bd:2` are one family with three slots. Name a slot directly (`bd:2`), or set variant to pick one PER NOTE, which is round robin: the index wraps, so a pattern counting past the last loaded sample starts over rather than falling silent. KEY ZONES: `zones: [{ lo, hi, name, root }]` gives each range of the keyboard its own recording, pitched from its own root, so a piano is not one buffer stretched four octaves. The zone is latched on the gate edge like a slice, a note outside every zone is silent rather than borrowing a neighbour, and a zone name may itself be a family member (`piano_mid:2`) so round robin still applies inside it. JavaScript only for now: rondo has no syntax for a list of zones yet. Mono out, shape it with an ADSR like an oscillator. An unloaded name is silent, and the editor now warns which one.',
    "sample(gate, 'break', { slices: 8 }).mul(adsr(gate, { r: 0.02 }))",
  ),
  sc(
    'granular',
    'granular(gate, name, opts?: { pos, root, rate, size, density, spray, loop })',
    'Granular synthesis over a loaded sample: short Hann-windowed grains, sprayed from a scannable read position. THE POINT IS THAT POSITION AND PITCH COME APART. `pos` (0..1 through the buffer) says WHERE you are reading and the note says at what pitch, so a slow LFO on pos walks through a sample while the notes stay in tune, and holding pos on a number freezes one moment open indefinitely. `sample speed:` cannot do that -- it ties them together like a record at the wrong rpm. Pitch comes from `root` (the MIDI note the sample plays naturally at, so the pattern transposes it) or from `rate` directly (1 = natural). DENSITY TIMES SIZE IS THE OVERLAP, and it is the number that decides what you hear: `density` 25 grains/s (1..400) at `size` 0.08 s (0.002..0.5) is about two grains sounding at once, which is a stream you can hear the individual grains in; push the product past ~4 and it fuses into continuous tone. Output is loudness-normalised by about 1/sqrt(overlap), so turning density up thickens the texture without blowing up the level. `spray` (seconds of per-grain position jitter, def 0.01, max 0.5) stops every grain starting at the same point and combing against its neighbours -- at 0 a dense cloud sounds metallic. Grains spawn while the gate is above 0.5, so a held note is a sustained cloud. `loop` is ON by default here, unlike `sample`: a grain whose start falls past the end WRAPS to the beginning, so a scan near the edge stays dense; `loop: false` clamps instead, and the cloud thins out as pos approaches 1. A name that is not loaded is silence, and it resolves each block, so a sample that arrives later just starts working. Shape the whole thing with an ADSR.',
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
    "modal(gate, freq, opts?: { model?: 'bell' | 'bar' | 'drum' | 'glass' | 'piano', decay?, damp?, stretch?, keyScale? })",
    "A struck modal resonator bank: a rising gate edge strikes a bank of tuned resonators at freq, ringing like a physical object. model picks the material (bell default, bar for marimba, drum, glass, piano); decay (s, def 1.2) is the ring time, measured at middle C when the model scales with pitch; damp (0..1) mellows the strike by taming the higher modes. Self-enveloping like pluck. stretch is INHARMONICITY -- partials pushed sharp of the harmonic series, which is what makes a struck string rather than an organ, and the whole of why 'piano' sounds like one (it brings 0.0004; the top octave of a real piano is nearer 0.001). keyScale is how fast the ring shortens with pitch, so a bass note can hold while the top of the keyboard is gone in a breath.",
    "modal(gate, note.freq, { model: 'piano', decay: 6 })",
  ),
  sc(
    'svf',
    "svf(input, cutoff, opts?: { res, mode: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass' })",
    'A clean multimode filter: low-pass by default, high-pass for hats, band-pass for claps, notch to scoop a band out, peak for a resonant bell that boosts at cutoff, allpass to swirl the phase without touching the level (stack a few for phaser motion); res adds a resonant peak.',
    "svf(noise(), 1500, { mode: 'bp', res: 0.6 })",
  ),
  sc(
    'dualsvf',
    "dualsvf(input, cutoff, cutoff2, opts?: { res, mode: 'serial' | 'parallel', a, b })",
    'A Serum-style dual filter: two svf stages, each with its OWN cutoff and its own response type (a and b, lp default, any svf mode), sharing one res. mode serial (default) cascades A into B, hp into lp carves a steep band, lp into lp is a 24 dB/oct low-pass; parallel sums the two, lp + hp leaves a spectral hole between the cutoffs. Sweep the cutoffs against each other for talking, morphing motion a single filter cannot do.',
    "dualsvf(saw(note.freq), 400, 4000, { mode: 'parallel', a: 'lp', b: 'hp', res: 0.3 })",
  ),
  sc(
    'ladder',
    'ladder(input, cutoff, opts?: { res })',
    'A Moog-style four-pole ladder low-pass: 24 dB/octave, warmer and growlier than `svf` and the reason an acid line sounds like one. `cutoff` is a signal (Hz, per sample, clamped to 1..just under half the sample rate), so this is the filter you sweep with an envelope. `res` 0..1 (def 0.5) is the resonance peak at the cutoff, clamped internally to 0.98 because 1 would be zero damping; high settings emphasise the cutoff so strongly that the sweep becomes the melody, which is the whole 303 trick. Pair it with an envelope on the cutoff and a short decay: `ladder(saw(note.freq), env.pow(2).range(300, 4000), { res: 0.7 })`.',
    'ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 })',
  ),
  sc('onepole', 'onepole(input, cutoff)', 'A gentle one-pole low-pass, just softens the top end, no resonance.', 'onepole(square(note.freq), 900)'),
  sc(
    'adsr',
    'adsr(gate, opts?: { a, d, s, r })',
    'An attack/decay/sustain/release envelope, 0..1, driven by the gate -- the workhorse for loudness, brightness and pitch. a/d/r are SECONDS and s is a level 0..1; defaults are a 0.01, d 0.1, s 0.7, r 0.2. THE SURPRISING PART: decay and release are one-pole exponentials, so `d` and `r` are TIME CONSTANTS rather than durations. After `d` seconds the level is 63% of the way from the peak to sustain, not at it, and it keeps converging -- which is why a decay that measures right on paper can still sound long, and why the editor draws the handle on the curve rather than where the curve lands. Gate-off releases from the CURRENT level whatever stage it was in, so a note cut during its attack fades from where it got to instead of clicking, and a retrigger resumes upward from the current level for the same reason. Every stage takes a signal as well as a number, read per sample, so a knob or an LFO can move the envelope while it is running -- including the sustain, which glides at the decay rate rather than jumping.',
    "adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: param('rel', 0.2, { min: 0.02, max: 2 }) })",
  ),
  sc(
    'env',
    'env(gate, points: ([time, level] | [time, level, curve])[], opts?: { release?, curve?, loop? })',
    'A multi-segment (breakpoint) envelope, the flexible cousin of adsr. points are [seconds, level] pairs: while the gate is held it ramps through them in order (each from the previous level), then holds the last level, or with loop repeats them like a function generator. Gate-off releases from the current level to 0 over release (def 0.1s). curve (def 0) shapes every segment: >0 fast-then-slow, <0 slow-then-fast. A THIRD number on a breakpoint overrides it for that segment alone, so an attack can snap while its tail eases -- one exponent for the whole envelope bends every joint the same way, which is not how a curve is drawn. Levels are not clamped, so aim it at amplitude, pitch or any modulation.',
    "env(gate, [[0.005, 1, 4], [0.15, 0.4], [0.5, 0.6, -2]], { release: 0.3 })",
  ),
  sc(
    'lfo',
    "lfo(freq, shape?: 'sine' | 'tri' | 'square' | 'saw' | 'rand', opts?: { sync })",
    'A slow oscillator 0..1 for movement, wobble a filter, a pulse width, a pan. Shapes sine/tri/square/saw, plus rand: a sample-and-hold that jumps to a new random level each cycle and holds it, for stepped random modulation. freq is in Hz, or with sync it is a length in CYCLES that follows the tempo: 1 is one sweep per cycle, 0.25 a quarter-note wobble, 0.0625 a sixteenth.',
    "lfo(0.25, 'tri', { sync: true }).range(400, 2000)",
  ),
  sc(
    'mic',
    'mic(opts?: { device })',
    'The device microphone as a LIVE signal: run your voice through the synth graph in real time. device names which input to open -- an id, or any part of the device label (device:scarlett matches a Scarlett 2i2 USB) -- and beats the input chosen in options; if that device is not connected the app falls back and says so rather than silently opening the wrong one. Feed it to vocoder() as the modulator (a talkbox), filter it, granular-freeze it. It reads silence until the code using it runs (the mic connects lazily, with a permission prompt) and in offline renders/exports. Use headphones: a speaker feeding the mic loops into howling feedback.',
    "vocoder(supersaw(note.freq), mic(), { bands: 24 })",
  ),
  sc(
    'delay',
    'delay(input, time, feedback?, opts?: { maxTime, sync, mix })',
    'A per-voice echo: repeats the input after `time` seconds, feedback making the repeats trail off. `mix` is the WET amount, default 0.35, so the dry signal comes through and the delay adds echoes instead of replacing your sound with them; use mix 1 for wet-only, which is what a send bus wants. With sync, time is read in CYCLES instead and the echo rides the tempo: 0.25 is a quarter note, 0.1875 the dotted eighth every dub delay wants. maxTime still sizes the buffer in seconds and caps a synced time, so raise it for slow tempos or long musical delays.',
    'saw(note.freq).mul(env), delay(tone, 0.1875, 0.45, { sync: true, mix: 0.4 })',
  ),
  sc(
    'reverb',
    'reverb(input, opts?: { roomSize, damp })',
    'Freeverb-style algorithmic reverb: a network of comb and allpass delays tuned to sound like a room. It returns the WET TAIL ONLY, which is the thing to know -- put it in a chain unmixed and the dry signal disappears. In rondo `mix` blends it back for you; in JS use `x.mix(reverb(x), 0.3)`. roomSize 0..1 (def 0.7) is the tail length, damp 0..1 (def 0.5) rolls the top off the tail so it sits behind the source instead of hissing over it. It is cheap and it is tweakable while it runs, which is what it has over `convolve`; what it cannot do is BE a particular room, because it is a model rather than a measurement.',
    'tone.mix(reverb(tone, { roomSize: 0.85, damp: 0.4 }), 0.35)',
  ),
  sc(
    'chorus',
    'chorus(input, opts?: { rate, depth, mix })',
    'A three-voice ensemble that thickens and widens: slow detuned pitch-wobbles blur one voice into many, lush pads, shimmering keys. In a post-chain it runs per stereo side, so it also spreads the sound wide. rate, depth and mix are SIGNALS, so an LFO or a knob can ride them.',
    'input.mix(chorus(input, { rate: 0.6, depth: 0.004 }), 1)',
  ),
  sc(
    'limiter',
    'limiter(input, opts?: { ceiling, lookahead, release })',
    'A LOOK-AHEAD BRICKWALL LIMITER: it holds a ceiling by turning DOWN, not by distorting. It delays the audio by lookahead ms (def 5) so the gain reduction is already in place when the peak arrives -- that delay is the latency it adds, which is why it is short. ceiling in dBFS (def -0.3, a hair under 0 so inter-sample peaks have somewhere to go), release ms (def 60). There is no attack control on purpose: the attack IS the lookahead, and exposing both invites a setting where the gain has not finished moving when the transient lands. The ceiling is a guarantee rather than a target -- no sample leaves above it -- which is what makes it safe on a PA feed. Below the ceiling it is a pure delay and changes nothing.',
    "limiter(input, { ceiling: -1, lookahead: 5 })",
  ),
  sc(
    'deess',
    'deess(input, opts?: { freq, threshold, ratio, attack, release })',
    'A DE-ESSER: a compressor that only hears the sibilance. "s", "sh" and "t" carry far more energy than the vowels around them, and a close mic plus a compressor turns them into blades -- but a broadband compressor cannot fix it, because ducking enough to tame the "s" ducks the whole word with it. This splits the signal at freq (Hz, def 6000; 4000-6000 for a low voice, 6000-9000 for a bright one) and compresses the HIGH band alone, so the vowels are not merely un-ducked, they never enter the detector path. threshold dB (def -30), ratio (def 4), attack ms (def 1, because sibilance is a transient), release ms (def 60). The two bands sum back to the input exactly, so below the threshold it is a bit-for-bit passthrough.',
    "deess(mic(), { freq: 6500, threshold: -28, ratio: 5 })",
  ),
  sc(
    'tape',
    'tape(input, opts?: { wow, flutter, sat, tone })',
    'TAPE, which is four things and not one -- shipping only the saturator is why most attempts at this sound like distortion instead of like tape. wow 0..1 (def 0.35) is slow pitch drift, well under 2 Hz, from a capstan that is not quite round: it is what stops a held chord sounding like a synthesiser, because an oscillator holds a pitch perfectly and nothing physical ever does. flutter 0..1 (def 0.3) is the same thing about ten times faster, too quick to hear as pitch, so it reads as texture. sat 0..1 (def 0.3) is soft saturation -- normalised to unity at full scale, so it LIFTS quiet material toward the peak rather than turning anything down (a 0.6 peak comes back near 0.71). tone Hz (def 11000) takes the top off, and it is the part everyone forgets: it is most of why a saturator alone sounds harsh where tape sounds warm. Each of wow and flutter is TWO oscillators at unrelated rates, because a single one is a vibrato and sounds like one. All four have an off.',
    'tape(bus, { wow: 0.4, flutter: 0.25, sat: 0.4, tone: 9000 })',
  ),
  sc(
    'convolve',
    "convolve(input, irName, opts?: { mix })",
    "Play a signal THROUGH a recorded space. `reverb` is algorithmic -- a network of delays tuned to sound like a room, cheap and tweakable while it runs. Convolution is the other kind: you hand it the IMPULSE RESPONSE of an actual space (or a plate, or a cabinet, or a snare drum) and it reproduces that thing exactly, because the impulse response IS the space, completely. What you give up is the knob: you cannot make the room bigger, you would need a different measurement. The IR is a SAMPLE, resolved from the same bank `sample()` reads, so a loaded WAV works and so does a generated one -- `hall` ships built in. mix 0..1 (def 0.35) and it is a SIGNAL, so an LFO or a knob can ride it. The IR is normalised to unit energy, so mix means the same thing whatever you point it at. Costs one block of latency (2.67 ms at 48k) and scales with IR length; IRs are truncated at 4 seconds.",
    "convolve(voice, 'hall', { mix: 0.4 })",
  ),
  sc(
    'pitchshift',
    'pitchshift(input, opts?: { semitones, window, mix })',
    'Move a signal in SEMITONES without changing how long it lasts. The engine could already change pitch two ways and neither is this: `sample speed:` is varispeed, so pitch and time move together like a record at the wrong rpm, and `granular rate:` decouples them but is a texture generator rather than something you can put a microphone through. This takes a signal that already exists -- a mic, a bus, a voice -- and hands back the same thing a fifth higher. semitones -24..24 (def 0, which is a BIT-EXACT passthrough, not an approximation). window ms (def 50) is the artefact control and it cannot be switched off: the read head wraps around a window, and short windows warble while long ones smear transients and add an echo of up to that length. mix 0..1 (def 1, fully shifted) and it is a SIGNAL, so an LFO or a knob can ride it; use 0.5 for a harmoniser that keeps the original underneath. `semitones` is a SIGNAL too, so the interval can move: a knob to ride it by hand, or a per-note lane to write the harmony line out, one interval per note. What it cannot do is work the interval out for itself, because it hears AUDIO and the note and the scale are already gone by then. So a harmony that follows the key is one you write, note for note, rather than one it infers.',
    'pitchshift(voice, { semitones: 7, window: 40, mix: 0.5 })',
  ),
  sc(
    'follow',
    "follow(input, opts?: { attack, release, mode: 'peak'|'rms' })",
    'AN ENVELOPE FOLLOWER: audio in, a control signal out. It reports how LOUD its input is, as an ordinary signal you can multiply by, subtract from 1, or map through a range -- so any sound can drive any parameter. This is the half sidechain does not cover: `sidechain` ducks on note ONSETS, so it keeps working even if you mute the source, and nothing in the engine reacted to actual level until this. attack ms (def 5) is how fast it rises, release ms (def 100) how fast it falls, and the asymmetry is the whole craft -- a fast attack catches transients, a slow release stops the control signal chattering between them. mode `peak` (def) tracks the waveform crest and is what you want for catching hits; `rms` averages power over a 25 ms window, reads about 3 dB lower on a sine, and is far steadier, which is what you want driving a filter. Output is linear amplitude (0..1 for signals inside +-1), not dB, because every consumer wants a multiplier or a range.',
    "follow(mic(), { attack: 5, release: 120, mode: 'rms' }).range(400, 5000)",
  ),
  sc(
    'noisegate',
    'noisegate(input, opts?: { threshold, range, attack, hold, release, hysteresis })',
    'A NOISE GATE: turns QUIET things down, which is the opposite of a compressor and the problem a live stage has -- kit bleed into a vocal mic, amp hiss, room tone that becomes feedback the moment you add gain. threshold is the level it opens at in dB (def -40); range is how far it pushes the signal down when closed, in dB (def -60, but -20 to -40 is usually better on a voice: a fully muted gate is audible as a hole, a partial one just removes the bleed). attack ms (def 1, because a slow one eats the front of a consonant), release ms (def 100). Two settings stop it misbehaving: hold is the minimum time it stays open after the level drops (def 50 ms), which keeps a sung word from being chopped at every momentary dip, and hysteresis is how far BELOW threshold the level must fall before it starts closing (def 3 dB), which stops a signal parked at the threshold from stuttering open and shut.',
    "noisegate(mic(), { threshold: -38, hold: 60, range: -30 })",
  ),
  sc(
    'comb',
    'comb(input, freq, feedback?, opts?: { damp })',
    'A tuned resonator: a delay line one period long, fed back on itself, so it rings at `freq` (Hz, a signal, clamped 20..Nyquist) like a plucked string or a struck bar. `feedback` 0..0.98 is how long it sings -- 0.9 is a short pluck, 0.98 rings for seconds -- and `damp` 0..0.99 (def 0.2) rolls off the highs each time round the loop, which is what makes it sound like gut rather than steel. Excite it with a BURST rather than a held tone: a few milliseconds of noise through a comb is Karplus-Strong, and the reason it sounds plucked is that the burst is short and the ringing is all decay. For a ready-made version see `pluck`, which is this with the excitation built in.',
    'comb(noise().mul(env), note.freq, 0.95)',
  ),
  sc(
    'bitcrush',
    'bitcrush(input, opts?: { bits, downsample })',
    'Lo-fi crush, and the two knobs do different damage. `bits` 1..16 (def 8) quantises the LEVEL into steps, which adds harmonic grit that grows as the signal gets quieter -- a fade-out through a bitcrusher gets dirtier as it goes, which is the giveaway. `downsample` 1..64 (def 1 = off) holds each sample N times, dropping the effective rate: everything above the new Nyquist folds back down as ALIASING, so high content returns as inharmonic tones that do not follow the pitch. That is why a downsampled lead sounds broken in a way a bit-reduced one does not. Both are integers and both are free of any anti-aliasing on purpose.',
    'bitcrush(tone, { bits: 6, downsample: 4 })',
  ),
  sc(
    'shape',
    'shape(input, drive?, opts?: { type })',
    "A drive/distortion stage: push the level up with `drive` (>= 1) and run it through a fixed curve, so the harmonics you get depend on WHICH curve, not just how hard. `soft` is a tanh knee -- it rounds peaks and adds mostly odd harmonics, the warm one you can leave on. `hard` clips flat and adds a lot of high odd harmonics, which reads as harsh and aliases if the source is already bright. `sine` folds the waveform back on itself once it passes the peak, so pushing harder keeps CHANGING the timbre instead of just adding grit -- the wild one. `tube` is asymmetric, treating the two halves of the wave differently, which produces EVEN harmonics as well and is why it sounds fuller rather than merely dirtier. Drive multiplies before the curve, so it sets how much of the signal is in the bending part: raise it and lower the gain after, or the stage just gets louder.",
    "shape(saw(note.freq), 6, { type: 'tube' })",
  ),
  sc(
    'compress',
    'compress(input, opts?: { threshold, ratio, attack, release, knee, makeup, key })',
    'A compressor: turns down whatever crosses the threshold, taming peaks and gluing a part together. `threshold` dB (def -18) is where it starts and `ratio` (def 4) is how hard -- 4:1 means 4 dB over becomes 1 dB over. `attack`/`release` are MILLISECONDS (def 10/120) and they are the difference between a compressor you hear and one you do not: a fast attack catches the transient and flattens the punch with it, a slow one lets the hit through and clamps the body behind it. `knee` dB (def 6) is how wide a band around the threshold it eases in over -- 0 is a hard corner, and a wide knee is what makes bus compression sound like glue rather than gating. `makeup` dB (def 0) puts back what the reduction took so you hear the shaping and not just the drop. For PARALLEL (New York) compression, crush a copy and blend the dry back: input.mix(compress(input, { ratio: 10 }), 0.5) keeps the transients and lifts everything under them. `key` is an EXTERNAL SIDECHAIN: the detector listens to that signal instead of the input, so what gets turned down and what decides when are separate. That is the half `sidechain(source)` does not cover -- it fires on note ONSETS, which is why a house pump keeps working with the kick muted, but it cannot duck under a live vocal or a band-split that has no note events to read.',
    'compress(drumBus, { threshold: -20, ratio: 4, attack: 5, makeup: 4 })',
  ),
  sc(
    'phaser',
    'phaser(input, opts?: { rate?, depth?, feedback?, stages?, mix? })',
    'A swept-allpass phaser: a cascade of allpass stages moves notches through the signal for that classic sweeping, whooshing motion. rate Hz (def 0.5), depth 0..1 (def 0.7), feedback 0..0.9 (def 0.4) sharpens the notches, stages 2..12 (def 4), mix 0..1 (def 0.5). rate, depth, feedback and mix are SIGNALS, so an LFO or a knob can ride them; `stages` is not, because it sizes the allpass chain and changing it is a rebuild rather than a control.',
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
    'The classic VOCODER: a bank of band-pass filters reads the modulator’s per-band loudness (its spectral envelope) and imposes it on the carrier, so the carrier "talks" or "sings" in the modulator’s voice. Give it a harmonically rich carrier (saw/supersaw/pulse) and a modulator with formants: a voice sample, noise, or another synth. opts: bands 2..64 (def 16, more = clearer), low/high band range in Hz (def 120/7500), q band sharpness scale (def 1), response envelope time in seconds (def 0.012, smaller = crisper consonants).',
    "vocoder(supersaw(note.freq), sample(gate, 'vox'), { bands: 20 })",
  ),
  sc(
    'eq',
    'eq(input, bands?: { type, freq, gain, q }[])',
    "A parametric EQ: a cascade of bands in series, each shaping one region. `type` is `peak` (a bell that boosts or cuts around `freq`), `lowshelf`/`highshelf` (tilt everything below or above `freq`, which is how you add air or weight without picking a spot), or `lp`/`hp` (a 12 dB/oct cut, for removing rather than shaping). `freq` is Hz, `gain` is dB and applies to peaks and shelves only, and `q` is sharpness -- higher is narrower, so a high-Q cut is a surgical notch for one ringing resonance while a low-Q one is a tonal tilt you feel rather than hear. CUTTING IS USUALLY THE MOVE: a narrow cut where two parts collide makes room without adding level, where a boost just makes the collision louder. A high-pass on everything that is not the bass is the single most useful band here.",
    "eq(pad, [{ type: 'hp', freq: 120 }, { type: 'highshelf', freq: 8000, gain: 4 }])",
  ),
  sc(
    'exciter',
    'exciter(input, opts?: { freq, amount, drive })',
    'An aural exciter: it isolates the band above freq (def 3500), saturates it to synthesize harmonically-related upper partials, and mixes that back in, adding air, sheen, and presence WITHOUT the broadband hiss of added noise. amount 0..1 (def 0.3) is the blend, drive (def 3) sets how much harmonic content.',
    'exciter(lead, { freq: 5000, amount: 0.4 })',
  ),
  sc(
    'ott',
    'ott(input, opts?: { depth, low, high, makeup })',
    'The "OTT" multiband compressor: splits the signal into three bands and applies upward AND downward compression to each, squashing dynamics and pulling up detail so the sound reads as louder, fuller, and brighter: the glue behind modern EDM/future-bass. depth 0..1 (def 0.5) blends dry to fully-processed (it is aggressive), low/high are the crossover frequencies in Hz (def 240/2500), makeup is output gain in dB.',
    'ott(chordBus, { depth: 0.4 })',
  ),
  sc(
    'width',
    "width(input, amount?, opts?: { mode: 'wide' | 'tight' })",
    'A stereo widener that makes a MONO sound big: a post chain runs the graph once per side, and this trades a short delayed copy between them (added on the left, subtracted on the right), so the two channels pull apart. amount 0..1 (def 0.5) sets how wide; mode is the delay character, wide (12 ms, the default) or tight (3 ms, subtler, keeps the low end solid). It is mono safe by construction: summing the channels cancels the delayed copy exactly and gives back the dry signal with a flat trim (0 dB at amount 0, -3 dB at 1) and no comb notches. The price is that each channel ALONE is comb filtered, which is exactly what makes it sound wide. Put it in a post chain or a bus, a per-voice graph only ever has one side and there it is just a comb.',
    'width(input, 0.7)',
  ),
  sc(
    'transient',
    'transient(input, opts?: { attack, sustain })',
    'A transient designer: attack (-1..1) sharpens or softens the hit, sustain (-1..1) lifts or cuts the tail behind it. Snap a lazy kick, take the room off a snare, put the pick back on a bass. It reads the RATIO of a fast and a slow envelope follower, so it is level independent, a quiet hit and a loud hit are shaped identically, and that is what makes it not a compressor. It also does not control level, so leave headroom.',
    'transient(drumBus, { attack: 0.6, sustain: -0.3 })',
  ),
  sc(
    'flanger',
    'flanger(input, opts?: { rate, depth, feedback, mix })',
    'The jet-plane whoosh: one very short delay (0.3 to 8 ms) swept by an LFO and fed back into itself, so a comb of notches slides up and down the spectrum with resonant peaks between them. rate Hz (def 0.3), depth 0..1 (def 0.7), feedback -0.95..0.95 (def 0.7, negative shifts the notches for a hollower colour), mix 0..1 (def 0.5). Chorus thickens with three unfed taps around 11 ms; this one resonates, and that is the difference you hear. rate, depth, feedback and mix are SIGNALS, so an LFO or a knob can ride them.',
    'flanger(pad, { rate: 0.15, feedback: 0.8 })',
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
  // ---- elementary math ----
  sm('abs', 'abs()', 'Absolute value. On audio it is full-wave rectification (an octave-up buzz); on an LFO it reads DISTANCE from centre rather than direction.', 'lfo(0.5).sub(0.5).abs()'),
  sm('floor', 'floor()', 'Largest integer below the value, the way to quantize a smooth sweep into steps.', 'lfo(0.25).range(0, 8).floor()'),
  sm('ceil', 'ceil()', 'Smallest integer above the value.', 'sig.ceil()'),
  sm('round', 'round()', 'Nearest integer. Rounding a note offset snaps a glide to semitones.', 'sig.mul(12).round().div(12)'),
  sm('sign', 'sign()', 'Squares the signal off to -1, 0 or +1, a hard square-up of anything.', 'sine(note.freq).sign()'),
  sm('sqrt', 'sqrt()', 'Square root, and 0 for a negative input rather than NaN. As a curve it lifts the quiet half of a 0..1 envelope without touching the top.', 'env.sqrt()'),
  sm('exp', 'exp()', 'e to the power of the signal, input clamped to +-80 so it stays finite. Pairs with log() for decibel-shaped curves.', 'env.mul(4).exp().div(55)'),
  sm('log', 'log()', 'Natural log, input floored at 1e-9 so log(0) is about -20.7 instead of -Infinity.', 'amp.log()'),
  sm('sin', 'sin()', 'Sine of the signal in RADIANS. This is the math function for waveshaping, not the oscillator, use sine(freq) to make a tone.', 'sine(note.freq).mul(3).sin()'),
  sm('cos', 'cos()', 'Cosine of the signal in radians.', 'phase.cos()'),
  sm('min', 'min(x: Sig | number)', 'Per-sample minimum, a ceiling when the other side is constant.', 'env.min(0.8)'),
  sm('max', 'max(x: Sig | number)', 'Per-sample maximum, a floor. max(0) is half-wave rectification.', 'sine(note.freq).max(0)'),
  sm('mod', 'mod(x: Sig | number)', 'Floored modulo, so the result takes the divisor sign and a negative phase wraps forward ((-0.1).mod(1) is 0.9). Modulo by 0 is 0.', 'ramp.mod(1)'),
  sm('range', 'range(lo: Sig | number, hi: Sig | number)', 'Map a 0..1 signal (envelope, lfo) onto lo..hi, aim it at Hz, seconds, anything.', 'pitch.pow(2).range(45, 160)'),
]

// ------------------------------------------------------------ mini syntax

const ms = (name: string, signature: string, summary: string, example?: string): DocEntry =>
  entry('mini-syntax', name, signature, summary, example)

const MINI_SYNTAX: DocEntry[] = [
  ms('mini:seq', 'a b c', 'Space-separated steps share the cycle equally, four words means four quarter-notes.', "n('0 0 3 5')"),
  ms('mini:~', '~', 'A rest: this step is silent.', "note('~ c4 ~ c4')"),
  ms('mini:..', 'a .. b', 'Range: expand an inclusive run of numbers into steps, so "0 .. 3" is "0 1 2 3" and "3 .. 0" counts back down. Handy for a scale walk or a sample sweep you would otherwise type out. It is ONE step, not a row of siblings, so "0 .. 3 5" is "[0 1 2 3] 5" and lengthening the range never re-times the notes around it. The step is 1 from the start value, so "0.5 .. 2" gives 0.5 and 1.5.', "n('0 .. 7')"),
  ms('mini:.', 'a . b c', 'Group without brackets: "." splits a sequence into EQUAL-width groups, so "0 . 1 2 . 3" is three thirds of a cycle rather than four quarters, exactly like writing "[0] [1 2] [3]". Useful when a line is mostly groups and the brackets start outnumbering the notes. It binds tighter than "," and "|", which split whole sequences.', "n('0 . 1 2 . 3')"),
  ms('mini:_', 'a _', 'Elongate: the previous step holds for one more slot ("a _ b" gives a twice the length of b).', "n('0 _ 3 5')"),
  ms('mini:[]', '[a b]', 'A subgroup: everything inside fits into ONE step, subdividing it, so `[0 1] 2` is two notes in the time of one followed by another. It is also how you scope an operator to part of a line -- `[0|1] 2 3` chooses only for the first step, where `0|1 2 3` would choose between the whole sequences.', "note('c2 [e2 g2] c2 [e2, g2]')"),
  ms('mini:<>', '<a b c>', 'Alternation: one entry per cycle, cycling through them, slow harmonic movement in one step. `@n` HOLDS an entry for n cycles, so `<0@3 4>` is three bars of 0 then one of 4 (inside a sequence the same `@` divides a single cycle instead).', "note('<e2 e2 d2 g2>')"),
  ms('mini:{}', '{a b c, d e}%n', 'Polymeter: voices of different lengths run at n steps per cycle, drifting against each other.', "note('{c2 e2 g2, c4 g4}%4')"),
  ms('mini:*', 'a*n', 'Repeat the step n times faster within its slot, "c5*8" is eight hits in the step. The factor can be a PATTERN rather than a fixed number: "0*<2 3>" doubles on one cycle and triples on the next, and "0*[2 3]" changes speed halfway through the cycle. That is the usual way to make a static part breathe without writing out every bar.', "note('c5*8').sound('hat')"),
  ms('mini:/', 'a/n', 'Slow the step down by n: it takes n cycles to play once. Like "*", the divisor can be a pattern ("0/<1 2>"), so a line can stretch and contract across cycles.', "note('c2/2')"),
  ms('mini:!', 'a!n', 'Duplicate the step n times as separate steps ("a!3 b" = "a a a b"); bare ! repeats once more. Repeats ACCUMULATE, so "0 ! !" is three copies and "a!2!3" is four: each ! adds its own extras rather than replacing the count before it.', "n('0!3 5')"),
  ms('mini:@', 'a@n', 'Weight: give this step n slots’ worth of time ("a@3 b" makes a three times as long as b).', "n('0@3 5')"),
  ms('mini:(p,s,r)', 'a(pulses,steps,rotation?)', 'Euclidean rhythm written inline on the atom it applies to: bd(3,8) spreads three kicks as evenly as possible over eight slots -- the tresillo. A third number ROTATES the pattern left by that many steps (bd(3,8,2)), starting the same rhythm elsewhere in the bar, which grooves quite differently. Because it attaches to ONE atom, different words on the same line can carry different Euclidean figures, which is how an interlocking groove is written as a single line rather than three stacked patterns. Every argument accepts a pattern, so "bd(<3 5>,8)" walks between two figures cycle by cycle. A NEGATIVE pulse count is the complement: "hh(-3,8)" plays the five slots "bd(3,8)" leaves empty, so the interlocking counter-rhythm is written without restating the figure.', "sound('bd(3,8)')"),
  ms('mini:?', 'a?p', 'Maybe: drop this step at random (probability p, default 0.5), deterministic per cycle.', "note('c5*8 ?0.3')"),
  ms('mini:,', 'a, b', 'Stack: play them TOGETHER, as one chord or as parallel lines. `0,2,4` is a triad; `0 1, 2` is the two-note line against a held 2. Brackets are NOT required -- the comma used to be legal only inside `[…]`, which made a bare `0,2,4` a syntax error for no reason. Each side is a whole sequence, so the parts can carry different rhythms and the stack lasts as long as its longest member. It stacks inside an alternation too, where each side is its own rotation: `<0 1, 2 3>` plays 0 with 2, then 1 with 3. Bracket instead to alternate BETWEEN stacks: `<[0,2] [4,6]>`.', "n('0,2,4')"),
  ms('mini:$', '$a=[bd sn] $a ~ $a', 'Name a figure and reuse it in the same pattern: `$a=[bd sn] $a ~ $a $a` plays that pair three times without writing it three times, so changing it changes every use. Definitions come first and take ONE figure each, which is why a multi-step one is bracketed. The `$` is on the reference as well as the definition on purpose: a bare word is already an atom (the sample called `a`), so an unsigilled reference would turn a typo in the definition into a sample that plays instead of an error. An undefined name says so and lists what IS defined on the line.', "sound('$a=[bd sn] $a ~ $a $a')"),
  ms('mini:\'swing', "[hh*8]'swing:.6", 'GROOVE on a group: delays the second half of every subdivision, which is the shuffle. `[hh*8]\'swing:.6` leaves the on-beats where they are and pushes the off-beats late, so a hat can swing while the kick beside it stays straight -- one line instead of two patterns. `\'grid:` sets the subdivision and defaults to 4, which is shuffled eighths in four-four: `\'grid:2` swings quarters, `\'grid:8` sixteenths. It cannot be inferred, because `[hh*8]` is one term that makes eight events and `[a b c d]` is four terms that make four. Timing lanes go on a GROUP; on a bare word the `\'` suffix is a control lane instead (except `\'push:`, which moves single notes).', "sound(\"[hh*8]'swing:.6\")"),
  ms('mini:\'humanize', "[hh*8]'humanize:.2", 'Deterministic timing JITTER on a group: every hit lands a little late, each by its own random amount, so a machine-straight line breathes without a single hand edit. It shares `\'swing:`’s ruler -- the jitter stays below amount/(2·grid), so `\'humanize:1` at most moves a hit where `\'swing:1` moves the off-beats, and `\'grid:` (default 4) scales it the same way. Late-only, like a drummer who breathes rather than one who rushes. The randomness is drawn from the exact onset time, so the same line lands the same way every render and every machine, and it does NOT share the stream `?` and `\'chance:` draw from -- a note’s fire-or-not and its lateness are independent coins. Combine them: `[hh*8]\'swing:.55\'humanize:.08` shuffles first, then breathes on the shuffled grid.', "sound(\"[hh*8]'humanize:.2\")"),
  ms('mini:\'push', "sn'push:.25", 'Move ONE hit off the grid: `\'push:x` shifts that note by x of its OWN step, positive late, negative early, up to a full step either way. This is the lane for feel edits the grid cannot say -- lay a snare back with `sn\'push:.08`, rush a fill in with `sn\'push:-.1` -- one number on one note, nothing else moves. It is timing, not a param: the value is consumed at parse and never reaches the synth. It composes with euclid (`bd\'push:.1(3,8)` moves each chosen hit by a tenth of ITS step) and with `*`/`@`, scaling to whatever the note’s step becomes. On a GROUP, `[bd sn]\'push:.1` moves the whole figure late by a tenth of its slot; the group form is late-only, because an early group shift would wrap to the end of its slot.', "sound(\"bd sn'push:.08 bd sn\")"),
  ms('mini:|', 'a | b', 'Choice: each cycle picks one alternative at random, deterministically per cycle number, so a render repeats exactly. THE ALTERNATIVES ARE WHOLE SEQUENCES, which is the thing that surprises people: `5|1 4 3` chooses between the single note `5` and the three-note run `1 4 3`, not between `5` and `1` at the first step. Bracket it to choose one STEP: `[5|1] 4 3`. It does not mix with `,` at the same level -- `0|1, 2` is an error, because a stack of choices and a choice of stacks are both plausible readings and neither should be assumed. Say which: `[0|1], 2`. WEIGHT an alternative with `@` to make it more likely: `a@3 | b` picks a three times as often, and `[a b]@3 | c` weights the whole group. Without any `@` the split is even.', "n('0 3 5 | 7 5 3')"),
  ms('mini:\'', "a'n  a'name:n", 'PER-NOTE LANES: values written ON the note, so they cannot drift when the notation grows a rest or a subgroup the way a parallel control line does. A bare number is the `expr` lane, read by the synth as param(\'expr\'). A named lane rides alongside it and they chain in any order. Four names are STRUCTURAL: `gain` is that note\u2019s level, `dur` a multiplier on its length, `chance` the probability it sounds at all (reproducible, drawn from the same time-locked stream as degradeBy), and `push` moves its onset by a fraction of its own step. Any other name is an ordinary param for that note alone (`swing`, `grid` and `humanize` are refused here, because they belong on a group and a silently ignored shuffle is worse than an error). A lane OVERRIDES the block modifier for the same control, so a block-wide `cutoff:` sets the baseline and a per-note `\'cutoff:` is the exception. WRITE IT DIRECTLY AFTER THE NOTE, before any modifier: `0\'gain:.8@2` is right and `0@2\'gain:.8` is refused, because there the suffix attaches to the weight instead of the note.', "n(\"0'2 3'gain:.8 5'chance:.5\")"),
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

/** How the reference groups the JavaScript vocabulary. Lives here, beside the
 *  entries it groups, so the in-editor panel and the reference builder cannot
 *  disagree about what a group contains. */
export const BUILDER_GROUPS: { title: string; kinds: DocEntry['kind'][] }[] = [
  { title: 'globals', kinds: ['global'] },
  { title: 'pattern methods', kinds: ['pattern-method'] },
  { title: 'synth builder', kinds: ['synth-ctx', 'sig-method'] },
]
