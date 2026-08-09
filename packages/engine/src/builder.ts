import { GraphError, validateGraph } from './graph'
import type { GraphSpec, InputSource, NodeSpec, NodeType, ParamSpec } from './graph'
import { RESERVED_PARAM_NAMES, lookupMacro, validateSwitchValues } from './macro'
import { compileGraph, compilePost } from './compile'
import type { VoiceOpts } from './voice'
import type { EqBand } from './dsp/eq'

/** What param() accepts. `values` makes it a SWITCH — two fixed values instead
 *  of a range — and is mutually exclusive with min/max/curve (see
 *  validateSwitchValues, which owns that rule for params and macros alike). */
export interface ParamOpts {
  min?: number
  max?: number
  curve?: 'lin' | 'log'
  values?: readonly number[]
}
import type { Math2Op, MathOp } from './dsp/math'
import type { EnvPoint } from './dsp/env'

/* ------------------------------------------------------------------------- *
 * Synth builder DSL: the user-facing API for defining synths. A build
 * function receives a SynthCtx whose constructors (all destructurable —
 * they are bound closures, not methods) create graph nodes and return Sig
 * handles; Sig methods chain further nodes. synth() wraps the result in an
 * `out` node, then runs validateGraph AND compileGraph (at a default 48 kHz)
 * so malformed graphs fail at definition time, not at play time.
 *
 * Design decisions (v1):
 * - `note` exposes only `freq`. There is no notemidi NodeType, so a midi Sig
 *   would need a fake backing value — omitted (YAGNI; freq covers the design
 *   examples).
 * - Numbers passed as SigIn become constant InputSources directly, NOT const
 *   nodes — compile.ts pools identical constants into shared buffers.
 * - param() default bounds when opts.min/max are omitted: min = 0,
 *   max = def > 0 ? def * 4 : 1. A negative default with an omitted min
 *   throws immediately (the implicit min = 0 could never contain it) —
 *   declare explicit bounds for anything real. A duplicate param name
 *   inside one synth() throws immediately.
 * - delay() defaults maxTime to 0.5 s (per-voice delays are for short
 *   feedback-loop synthesis; echo-scale delays belong in the future
 *   post-chain, see compile.ts header).
 * - Feedback: the DSL is structurally acyclic — a Sig can only reference an
 *   already-created node, so a delay-free cycle is inexpressible. Delayed
 *   feedback loops (Karplus-Strong etc.) need a dedicated feedback()
 *   combinator, deferred to v2.
 * - Sigs are scoped to their synth() build: using a Sig (as an argument or
 *   via its methods) outside the build that created it throws GraphError.
 * ------------------------------------------------------------------------- */

export type SigIn = Sig | number

export type LfoShapeName = 'sine' | 'tri' | 'square' | 'saw' | 'rand'

/** TEMPO SYNC opts, shared by lfo() and delay(): `sync: true` re-reads the
 *  builtin's rate/time argument as a length in transport CYCLES instead of
 *  Hz/seconds, and the kernel follows the tempo live. */
export interface LfoOpts {
  sync?: boolean
}

export interface DelayOpts {
  /** Ring-buffer length in SECONDS (default 0.5). Also the ceiling a synced
   *  time is clamped to. */
  maxTime?: number
  /** Read `time` as transport cycles rather than seconds. */
  sync?: boolean
  /** Wet amount, 0..1. Default 0.35 — the DRY signal is mixed back in, so a
   *  delay adds echoes rather than replacing the sound with them. Set 1 for
   *  wet-only, which is what you want in a send bus. */
  mix?: SigIn
}

/** Handle to a node's output inside a synth() build. Immutable: every method
 *  creates a new node and returns a new Sig. */
export interface Sig {
  readonly id: number
  mul(x: SigIn): Sig
  add(x: SigIn): Sig
  sub(x: SigIn): Sig
  div(x: SigIn): Sig
  pow(x: SigIn): Sig
  /** Clamp to [lo, hi]; defaults [-1, 1]. */
  clip(lo?: SigIn, hi?: SigIn): Sig
  tanh(): Sig
  fold(): Sig
  /** Crossfade: this·(1−amount) + other·amount. */
  mix(other: SigIn, amount: SigIn): Sig
  /** Map a unipolar 0..1 signal (lfo/adsr) to [lo, hi]: lo + this·(hi−lo). */
  range(lo: SigIn, hi: SigIn): Sig

  /* ---- elementary math ------------------------------------------------- *
   * Per-sample, on control signals or audio alike. The ones that could
   * produce a NaN or an Infinity are guarded instead (a bad sample would
   * spread through the graph and silence the voice with nothing to see). */

  /** |x| — full-wave rectification: an octave-up buzz on audio, and the way
   *  to read an LFO's DISTANCE from centre rather than its direction. */
  abs(): Sig
  /** Largest integer <= x. Quantizes a sweep into steps: `lfo.range(0, 8).floor()`
   *  is an 8-step staircase. */
  floor(): Sig
  /** Smallest integer >= x. */
  ceil(): Sig
  /** Nearest integer, halves away from zero. */
  round(): Sig
  /** -1, 0 or +1 — squares a signal off, hard. */
  sign(): Sig
  /** Square root, and 0 for a negative input (never NaN). Useful as a curve:
   *  it lifts the quiet half of a 0..1 envelope without touching the top. */
  sqrt(): Sig
  /** e^x, input clamped to +-80 so the result stays finite. */
  exp(): Sig
  /** Natural log, input floored at 1e-9 so log(0) is about -20.7 rather than
   *  -Infinity. Pairs with exp() for decibel-shaped curves. */
  log(): Sig
  /** sin(x), x in RADIANS. This is the math function, not the oscillator —
   *  use `sine(freq)` to make a tone. */
  sin(): Sig
  /** cos(x), x in radians. */
  cos(): Sig
  /** Per-sample minimum — a ceiling when the other side is a constant. */
  min(x: SigIn): Sig
  /** Per-sample maximum — a floor, and `x.max(0)` is half-wave rectification. */
  max(x: SigIn): Sig
  /** FLOORED modulo: the result takes the sign of the divisor, so
   *  `(-0.1).mod(1)` is 0.9. That is what wrapping a phase or a ramp needs;
   *  JS `%` would give -0.1. Modulo by 0 is 0. */
  mod(x: SigIn): Sig
}

export interface SynthCtx {
  /** Per-note voice state. midi is deliberately absent in v1 (see header). */
  note: { freq: Sig }
  gate: Sig
  /** How hard the note was played, 0..1. AMPLITUDE is already auto-scaled by
   *  velocity at the voice — a pattern's .gain() affects loudness without any
   *  wiring. This signal is for TIMBRE (e.g. velocity→filter brightness);
   *  multiplying your output by it double-applies velocity. */
  velocity: Sig
  /** Declare a live-controllable parameter. Omitted bounds default to
   *  min = 0, max = def > 0 ? def*4 : 1. */
  param(name: string, def?: number, opts?: ParamOpts): Sig
  sine(freq: SigIn): Sig
  saw(freq: SigIn): Sig
  square(freq: SigIn): Sig
  tri(freq: SigIn): Sig
  pulse(freq: SigIn, width?: SigIn): Sig
  /** Hard-synced sawtooth for screaming leads: a slave saw at freq*ratio whose
   *  phase resets every master (freq) cycle. `ratio` (>= 1, default 2) is the
   *  sync amount — sweep it for the classic sync sweep. Anti-aliased. */
  syncsaw(freq: SigIn, ratio?: SigIn): Sig
  /** FM / phase-modulation operator: a sine at `freq` (Hz) whose phase is offset
   *  by `mod` (another operator's output — its amplitude is the modulation
   *  index, in cycles) plus self-`feedback` (0..~1). This is the FM building
   *  block: chain operators as each other's `mod` for DX-style algorithms, and
   *  raise feedback for the self-modulating operator a plain graph can't express.
   *  `wave` sets the operator waveform ('sine' default and warmest; 'tri' soft;
   *  'saw'/'square' brighter, naive). Output [-1, 1] — shape it with an ADSR. */
  fm(freq: SigIn, mod?: SigIn, opts?: { feedback?: SigIn; wave?: 'sine' | 'tri' | 'saw' | 'square' }): Sig
  /** Morphing, anti-aliased wavetable oscillator. `pos` (0..1, default 0) scans
   *  through a bank of single-cycle waveforms; `table` names a built-in bank
   *  ('basic' | 'harmonic' | 'pwm', default 'basic') or a CUSTOM one registered
   *  with defineWavetable(). Band-limited via mipmaps, so it stays clean at
   *  high notes. `warp` bends the phase read pre-lookup ('sync' = hard-sync
   *  tear, 'bend' = bowed transfer tilt, 'mirror' = palindromic reflection),
   *  driven by `warpAmt` (0..1, default 0.5, audio-rate — sweep it with an
   *  envelope or LFO). The warped read keeps the mipmap anti-aliasing. */
  wavetable(freq: SigIn, pos?: SigIn, opts?: { table?: string; warp?: 'sync' | 'bend' | 'mirror'; warpAmt?: SigIn }): Sig
  /** SUPERSAW: 7 detuned saws for a fat trance/EDM lead. `detune` (0..1, def
   *  0.2) spreads them; `mix` (0..1, def 0.7) is the side-saw level vs centre.
   *  Anti-aliased. */
  supersaw(freq: SigIn, opts?: { detune?: SigIn; mix?: SigIn }): Sig
  /** Noise. `color`: 'white' (default), 'pink' (warmer, −3 dB/oct) or 'brown'
   *  (deep, −6 dB/oct). */
  noise(color?: 'white' | 'pink' | 'brown'): Sig
  /** NES/Game-Boy LFSR noise (the chiptune noise channel). `freq` is the clock
   *  rate in Hz (the noise "pitch": low = coarse, high = bright). `mode`
   *  'white' (default) is hiss; 'periodic' is a buzzy, metallic pitched tone.
   *  1-bit output — shape it with an ADSR for chip drums and zaps. */
  lfsr(freq: SigIn, opts?: { mode?: 'white' | 'periodic' }): Sig
  /** Play a loaded audio sample. `name` is a sample loaded via loadSample. A
   *  rising edge on `gate` retriggers from the start (one-shot); pass
   *  `{ loop: true }` to loop. Pitch: `{ root }` plays at natural pitch when the
   *  note equals that MIDI root and tracks the note otherwise; `{ speed }` sets
   *  an explicit rate multiplier (overrides root). No root/speed → natural rate
   *  (drums). Output is mono — shape amplitude with an ADSR like an oscillator.
   *  Unknown/not-yet-loaded name → silence.
   *
   *  SLICING: `{ start, end }` (fractions 0..1, end must exceed start) narrow
   *  playback to a window; loop, speed and reverse then act on the window only.
   *  `{ slices: N }` divides that window into N equal chops and the NOTE picks
   *  one (root = slice 0, root+1 = slice 1, wrapping) at natural speed, so a
   *  note pattern sequences the chops. `{ reverse: true }` plays the window
   *  backwards. `{ fade }` (seconds, def 0.003 once sliced) ramps the window
   *  edges so a chop does not click. */
  sample(
    gate: SigIn,
    name: string,
    opts?: {
      root?: number
      speed?: SigIn
      loop?: boolean
      start?: number
      end?: number
      reverse?: boolean
      slices?: number
      fade?: number
    },
  ): Sig
  /** GRANULAR synthesis over a loaded sample: sprays short windowed grains from
   *  a scannable position, pitched independently. Grains spawn while `gate` is
   *  high. `pos` (0..1) is the read centre — freeze it for a drone, sweep it to
   *  scrub. Pitch: `{ root }` tracks the note relative to a MIDI root, or
   *  `{ rate }` a direct multiplier. Config: grain `size` (s, def 0.08),
   *  `density` (grains/s, def 25), `spray` (position jitter s, def 0.01),
   *  `loop` (def true). Shape the amplitude with an ADSR. */
  granular(gate: SigIn, name: string, opts?: { pos?: SigIn; root?: number; rate?: SigIn; size?: number; density?: number; spray?: number; loop?: boolean }): Sig
  /** Karplus-Strong PLUCKED STRING: a rising `gate` edge plucks a string tuned
   *  to `freq` (Hz). `decay` (s, def 1.5) is the ring time; `damp` (0..0.95,
   *  def 0.5) darkens the tone and shortens the highs. Output ~[-1, 1] — no
   *  ADSR needed (the pluck IS the envelope), though you can still shape it. */
  pluck(gate: SigIn, freq: SigIn, opts?: { decay?: number; damp?: number; seed?: number }): Sig
  /** MODAL resonator bank (struck/mallet voice): a rising `gate` edge strikes a
   *  bank of tuned resonators at `freq` (Hz). `model` picks the material
   *  ('bell' default, 'bar' marimba, 'drum', 'glass'); `decay` (s, def 1.2) is
   *  the ring time; `damp` (0..1) mellows the strike by taming higher modes.
   *  Self-enveloping like pluck. */
  modal(
    gate: SigIn,
    freq: SigIn,
    opts?: {
      model?: 'bell' | 'bar' | 'drum' | 'glass' | 'piano'
      decay?: number
      damp?: number
      /** Inharmonicity: partials sit sharp of the harmonic series, which is
       *  what makes a struck STRING rather than an organ. The piano model
       *  brings its own (0.0004); raise toward 0.001 for the top octave. */
      stretch?: number
      /** How strongly ring time falls with pitch. The piano model brings its
       *  own (0.62); 0 means every pitch rings the same length. */
      keyScale?: number
    },
  ): Sig
  svf(inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn; mode?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass' }): Sig
  ladder(inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn }): Sig
  onepole(inp: SigIn, cutoff: SigIn): Sig
  /** Serum-style DUAL filter: two svf stages, each with its own cutoff and
   *  response type (a/b, 'lp' default), one shared res. mode 'serial' (A then
   *  B, default) cascades them; 'parallel' sums them (lp + hp leaves a hole
   *  between the cutoffs). */
  dualsvf(inp: SigIn, cutoff: SigIn, cutoff2: SigIn, opts?: { res?: SigIn; mode?: 'serial' | 'parallel'; a?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass'; b?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass' }): Sig
  /** ADSR envelope. Every stage accepts a SIGNAL as well as a number, so a
   *  knob, an LFO or another envelope can shape the shape: `adsr(gate, { a:
   *  attackKnob })` reads the attack per sample and changes the ramp rate
   *  under your finger. Times are seconds, clamped to [0.0005, 30]; `s` is a
   *  level, clamped to [0, 1]. d/r are one-pole time constants. */
  adsr(gate: SigIn, opts?: { a?: SigIn; d?: SigIn; s?: SigIn; r?: SigIn }): Sig
  /** Multi-segment (breakpoint) envelope — the flexible cousin of adsr.
   *  `points` are [timeSec, level] pairs: while the gate is held it ramps
   *  through them in order (each from the previous level), then HOLDS the last
   *  level, or with `loop` repeats them (a function generator). Gate-off
   *  releases from the current level to 0 over `release` (def 0.1 s). `curve`
   *  (def 0) shapes every segment: > 0 fast-then-slow, < 0 slow-then-fast.
   *  Levels are not clamped, so it drives amplitude, pitch or any modulation. */
  env(gate: SigIn, points: EnvPoint[], opts?: { release?: number; curve?: number; loop?: boolean }): Sig
  /** Slow oscillator, output 0..1. `freq` is Hz unless `sync` is set, and then
   *  it is a period length in transport CYCLES: 1 = one sweep per cycle,
   *  0.25 = a quarter note at four beats to the cycle, 0.0625 = a sixteenth.
   *  A synced LFO re-rates itself when the tempo changes, phase-continuously. */
  lfo(freq: SigIn, shape?: LfoShapeName | LfoOpts, opts?: LfoOpts): Sig
  /** Feedback delay. `time` is seconds unless `sync` is set, and then it is a
   *  length in transport CYCLES (0.1875 = a dotted eighth at four beats to the
   *  cycle) that follows the tempo live. The buffer is sized by `maxTime`
   *  SECONDS either way, so a synced time is clamped to it at slow tempi. */
  delay(inp: SigIn, time: SigIn, feedback?: SigIn, opts?: DelayOpts): Sig
  /** Freeverb-style algorithmic reverb. Output is WET only — mix it back with
   *  the dry signal (e.g. `tone.mix(reverb(tone), 0.3)`). roomSize/damp are
   *  0..1 and are fixed at build time (not per-sample). */
  reverb(inp: SigIn, opts?: { roomSize?: number; damp?: number }): Sig
  /** Three-voice modulated-delay ensemble — thickens and widens. Runs mono per
   *  call; stereo width comes from the post-chain running it twice (L/R). */
  chorus(inp: SigIn, opts?: { rate?: SigIn; depth?: SigIn; mix?: SigIn }): Sig
  /** Tuned feedback comb: resonates at `freq` (Hz) with a metallic ring;
   *  feedback 0..0.98 (default 0.5) sets the ring length, opts.damp darkens it. */
  comb(inp: SigIn, freq: SigIn, feedback?: SigIn, opts?: { damp?: number }): Sig
  /** Lo-fi bit-depth + sample-rate reducer (bits 1..16, downsample 1..64). */
  bitcrush(inp: SigIn, opts?: { bits?: number; downsample?: number }): Sig
  /** Drive waveshaper (distortion): drive >= 1, curve `type` soft/hard/sine/tube. */
  shape(inp: SigIn, drive?: SigIn, opts?: { type?: 'soft' | 'hard' | 'sine' | 'tube' }): Sig
  /** Feed-forward peak compressor — glue/punch/control. threshold (dB, def
   *  -18), ratio (def 4), attack/release (ms, def 10/120), knee (dB, def 6),
   *  makeup (dB, def 0). For PARALLEL compression mix the dry back:
   *  `input.mix(compress(input, { ratio: 10 }), 0.5)`. */
  compress(inp: SigIn, opts?: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number }): Sig
  /** NOISE GATE / downward expander — turns QUIET things down, which is the
   *  opposite of a compressor and the problem a stage has: kit bleed into a
   *  vocal mic, amp hiss, room tone that becomes feedback once you add gain.
   *  `threshold` dB to open (def -40), `range` dB of attenuation when closed
   *  (def -60; -20..-40 removes bleed without leaving an audible hole),
   *  `attack` ms (def 1), `hold` ms it stays open after the level drops (def
   *  50), `release` ms (def 100), `hysteresis` dB below threshold before it
   *  closes (def 3). Hold and hysteresis are what stop it chattering on a
   *  signal sitting at the threshold, or chopping up a sung word. */
  noisegate(inp: SigIn, opts?: { threshold?: number; range?: number; attack?: number; hold?: number; release?: number; hysteresis?: number }): Sig
  /** DE-ESSER — a compressor that only hears the sibilance. Splits at `freq`
   *  (Hz, def 6000) and compresses the HIGH band alone, so the vowels are not
   *  merely un-ducked, they never enter the detector's path. `threshold` dB
   *  (def -30), `ratio` (def 4), `attack` ms (def 1 — sibilance is a
   *  transient), `release` ms (def 60). Use 4000-6000 for a low voice,
   *  6000-9000 for a bright one. */
  deess(inp: SigIn, opts?: { freq?: number; threshold?: number; ratio?: number; attack?: number; release?: number }): Sig
  /** Envelope follower: audio in, a 0..1 control signal out. */
  follow(inp: SigIn, opts?: { attack?: number; release?: number; mode?: 'peak' | 'rms' }): Sig
  /** Shift a signal in semitones without changing its length. */
  pitchshift(inp: SigIn, opts?: { semitones?: number; window?: number; mix?: SigIn }): Sig
  /** Convolve a signal with an impulse response held as a sample. */
  convolve(inp: SigIn, name: string, opts?: { mix?: SigIn }): Sig
  /** Tape character: wow, flutter, saturation and the top coming off. */
  tape(inp: SigIn, opts?: { wow?: number; flutter?: number; sat?: number; tone?: number }): Sig
  /** LOOK-AHEAD BRICKWALL LIMITER — holds a ceiling by turning DOWN, not by
   *  distorting. It delays the audio by `lookahead` ms (def 5) so the gain is
   *  already reduced when the peak arrives; that delay is the latency it adds.
   *  `ceiling` dBFS (def -0.3), `release` ms (def 60). There is no attack
   *  control on purpose: the attack IS the lookahead. The ceiling is a
   *  guarantee, not a target — no sample leaves above it. */
  limiter(inp: SigIn, opts?: { ceiling?: number; lookahead?: number; release?: number }): Sig
  pan(inp: SigIn, pos: SigIn): Sig
  /** Swept-allpass PHASER: moving notches. `rate` Hz (def 0.5), `depth` 0..1
   *  (def 0.7), `feedback` 0..0.9 (def 0.4), `stages` 2..12 (def 4), `mix` 0..1
   *  (def 0.5). */
  phaser(inp: SigIn, opts?: { rate?: SigIn; depth?: SigIn; feedback?: SigIn; stages?: number; mix?: SigIn }): Sig
  /** Vowel/FORMANT filter: three band-passes at a vowel's formants, so a buzzy
   *  source sings. `morph` 0..1 scans a→e→i→o→u (sweepable). */
  formant(inp: SigIn, morph?: SigIn): Sig
  /** VOCODER: impose the `modulator`'s spectral envelope on the `carrier` via a
   *  bank of bandpass filters — talking/singing synths. `bands` 2..64 (def 16),
   *  `low`/`high` the band range in Hz (def 120/7500), `q` band-Q scale (def 1),
   *  `response` envelope time in s (def 0.012). Carrier should be harmonically
   *  rich (saw/supersaw); modulator a voice sample, noise, or another synth. */
  vocoder(carrier: SigIn, modulator: SigIn, opts?: { bands?: number; low?: number; high?: number; q?: number; response?: number }): Sig
  /** Parametric EQ: a cascade of bands run in series. Each band: `type`
   *  'peak' (bell) | 'lowshelf' | 'highshelf' | 'lp' | 'hp', `freq` (Hz),
   *  `gain` (dB, shelf/peak only), `q` (sharpness). Carve mud, add air, tilt. */
  eq(inp: SigIn, bands?: EqBand[]): Sig
  /** Aural EXCITER: saturates the band ABOVE `freq` (def 3500) to synthesize
   *  harmonic air/sheen without hiss. `amount` 0..1 (def 0.3), `drive` (def 3). */
  exciter(inp: SigIn, opts?: { freq?: number; amount?: number; drive?: number }): Sig
  /** OTT — 3-band upward+downward multiband compressor (glue / loudness /
   *  brightness). `depth` 0..1 dry→full (def 0.5), `low`/`high` crossovers Hz
   *  (def 240 / 2500), `makeup` dB. */
  ott(inp: SigIn, opts?: { depth?: number; low?: number; high?: number; makeup?: number }): Sig
  /** WIDTH — Lauridsen pseudo-stereo. `amount` 0..1 (def 0.5, audio-rate)
   *  trades a delayed copy between the two post instances (+ on the left, − on
   *  the right), so a MONO source becomes wide stereo. `mode` 'wide' (12 ms,
   *  default) or 'tight' (3 ms). The mono sum is the DRY signal with a flat
   *  trim (0 dB at amount 0, −3.01 dB at 1) — no comb notches, nothing
   *  cancels. Each channel alone IS comb filtered (that is the trade). Belongs
   *  in a post chain or bus: in a per-voice graph there is only one instance,
   *  so it degrades to a fixed comb with no width. */
  width(inp: SigIn, amount?: SigIn, opts?: { mode?: 'wide' | 'tight' }): Sig
  /** TRANSIENT shaper: `attack` −1..1 sharpens (+) or softens (−) the onset,
   *  `sustain` −1..1 lifts (+) or cuts (−) the tail. Driven by the RATIO of a
   *  fast and a slow envelope follower, so it is LEVEL-INDEPENDENT — a quiet
   *  hit and a loud hit are shaped identically, unlike a compressor. It does
   *  not control level: leave headroom. */
  transient(inp: SigIn, opts?: { attack?: number; sustain?: number }): Sig
  /** FLANGER: one short (0.3–8 ms) modulated delay WITH feedback — the swept,
   *  resonant, jet-engine comb. `rate` Hz (def 0.3), `depth` 0..1 (def 0.7),
   *  `feedback` −0.95..0.95 (def 0.7, negative moves the notches), `mix` 0..1
   *  (def 0.5). Unlike chorus (three unfed taps around 11 ms, a thickener) the
   *  feedback builds resonant PEAKS between the notches. */
  flanger(inp: SigIn, opts?: { rate?: SigIn; depth?: SigIn; feedback?: SigIn; mix?: SigIn }): Sig
  mix(a: SigIn, b: SigIn, t: SigIn): Sig
  /** The device microphone as a LIVE signal (see the mic docs). Silence when
   *  no mic is connected and in offline renders. Headphones advised. */
  /** The live microphone. `device` names which input to open — an id or any
   *  part of the device's label ('scarlett'), matched by the host. It is
   *  config the GRAPH never reads: the capture is opened on the main thread,
   *  so this is how the program tells it what to open. */
  mic(opts?: { device?: string }): Sig
}

/** The post graph's build context: a SEPARATE build (its own node-id space)
 *  that processes the SUMMED voices once per synth, not once per note. It has
 *  NO per-note sources (note/gate/velocity/oscillators/adsr) — the summed mix
 *  has no single gate — and no `pan` (post output is mono; L/R independence
 *  comes from running the graph twice, see PostChain). `input` is the summed
 *  voice signal; everything else mirrors SynthCtx: filters, effects, an LFO,
 *  param(), math via Sig methods, and mix(). */
export interface PostCtx {
  /** The summed-voices signal to process (a businput source). */
  input: Sig
  param(name: string, def?: number, opts?: ParamOpts): Sig
  svf(inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn; mode?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass' }): Sig
  ladder(inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn }): Sig
  onepole(inp: SigIn, cutoff: SigIn): Sig
  /** Serum-style DUAL filter: two svf stages, each with its own cutoff and
   *  response type (a/b, 'lp' default), one shared res. mode 'serial' (A then
   *  B, default) cascades them; 'parallel' sums them (lp + hp leaves a hole
   *  between the cutoffs). */
  dualsvf(inp: SigIn, cutoff: SigIn, cutoff2: SigIn, opts?: { res?: SigIn; mode?: 'serial' | 'parallel'; a?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass'; b?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass' }): Sig
  lfo(freq: SigIn, shape?: LfoShapeName | LfoOpts, opts?: LfoOpts): Sig
  delay(inp: SigIn, time: SigIn, feedback?: SigIn, opts?: DelayOpts): Sig
  reverb(inp: SigIn, opts?: { roomSize?: number; damp?: number }): Sig
  chorus(inp: SigIn, opts?: { rate?: SigIn; depth?: SigIn; mix?: SigIn }): Sig
  comb(inp: SigIn, freq: SigIn, feedback?: SigIn, opts?: { damp?: number }): Sig
  bitcrush(inp: SigIn, opts?: { bits?: number; downsample?: number }): Sig
  shape(inp: SigIn, drive?: SigIn, opts?: { type?: 'soft' | 'hard' | 'sine' | 'tube' }): Sig
  /** Feed-forward peak compressor — glue/punch/control. threshold (dB, def
   *  -18), ratio (def 4), attack/release (ms, def 10/120), knee (dB, def 6),
   *  makeup (dB, def 0). For PARALLEL compression mix the dry back:
   *  `input.mix(compress(input, { ratio: 10 }), 0.5)`. */
  compress(inp: SigIn, opts?: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number }): Sig
  /** NOISE GATE / downward expander — turns QUIET things down, which is the
   *  opposite of a compressor and the problem a stage has: kit bleed into a
   *  vocal mic, amp hiss, room tone that becomes feedback once you add gain.
   *  `threshold` dB to open (def -40), `range` dB of attenuation when closed
   *  (def -60; -20..-40 removes bleed without leaving an audible hole),
   *  `attack` ms (def 1), `hold` ms it stays open after the level drops (def
   *  50), `release` ms (def 100), `hysteresis` dB below threshold before it
   *  closes (def 3). Hold and hysteresis are what stop it chattering on a
   *  signal sitting at the threshold, or chopping up a sung word. */
  noisegate(inp: SigIn, opts?: { threshold?: number; range?: number; attack?: number; hold?: number; release?: number; hysteresis?: number }): Sig
  /** DE-ESSER — a compressor that only hears the sibilance. Splits at `freq`
   *  (Hz, def 6000) and compresses the HIGH band alone, so the vowels are not
   *  merely un-ducked, they never enter the detector's path. `threshold` dB
   *  (def -30), `ratio` (def 4), `attack` ms (def 1 — sibilance is a
   *  transient), `release` ms (def 60). Use 4000-6000 for a low voice,
   *  6000-9000 for a bright one. */
  deess(inp: SigIn, opts?: { freq?: number; threshold?: number; ratio?: number; attack?: number; release?: number }): Sig
  /** Envelope follower: audio in, a 0..1 control signal out. */
  follow(inp: SigIn, opts?: { attack?: number; release?: number; mode?: 'peak' | 'rms' }): Sig
  /** Shift a signal in semitones without changing its length. */
  pitchshift(inp: SigIn, opts?: { semitones?: number; window?: number; mix?: SigIn }): Sig
  /** Convolve a signal with an impulse response held as a sample. */
  convolve(inp: SigIn, name: string, opts?: { mix?: SigIn }): Sig
  /** Tape character: wow, flutter, saturation and the top coming off. */
  tape(inp: SigIn, opts?: { wow?: number; flutter?: number; sat?: number; tone?: number }): Sig
  /** LOOK-AHEAD BRICKWALL LIMITER — holds a ceiling by turning DOWN, not by
   *  distorting. It delays the audio by `lookahead` ms (def 5) so the gain is
   *  already reduced when the peak arrives; that delay is the latency it adds.
   *  `ceiling` dBFS (def -0.3), `release` ms (def 60). There is no attack
   *  control on purpose: the attack IS the lookahead. The ceiling is a
   *  guarantee, not a target — no sample leaves above it. */
  limiter(inp: SigIn, opts?: { ceiling?: number; lookahead?: number; release?: number }): Sig
  /** Swept-allpass PHASER: moving notches. `rate` Hz (def 0.5), `depth` 0..1
   *  (def 0.7), `feedback` 0..0.9 (def 0.4), `stages` 2..12 (def 4), `mix` 0..1
   *  (def 0.5). */
  phaser(inp: SigIn, opts?: { rate?: SigIn; depth?: SigIn; feedback?: SigIn; stages?: number; mix?: SigIn }): Sig
  /** Vowel/FORMANT filter: three band-passes at a vowel's formants, so a buzzy
   *  source sings. `morph` 0..1 scans a→e→i→o→u (sweepable). */
  formant(inp: SigIn, morph?: SigIn): Sig
  /** VOCODER: impose the `modulator`'s spectral envelope on the `carrier` via a
   *  bank of bandpass filters — talking/singing synths. `bands` 2..64 (def 16),
   *  `low`/`high` the band range in Hz (def 120/7500), `q` band-Q scale (def 1),
   *  `response` envelope time in s (def 0.012). Carrier should be harmonically
   *  rich (saw/supersaw); modulator a voice sample, noise, or another synth. */
  vocoder(carrier: SigIn, modulator: SigIn, opts?: { bands?: number; low?: number; high?: number; q?: number; response?: number }): Sig
  /** Parametric EQ: a cascade of bands run in series. Each band: `type`
   *  'peak' (bell) | 'lowshelf' | 'highshelf' | 'lp' | 'hp', `freq` (Hz),
   *  `gain` (dB, shelf/peak only), `q` (sharpness). Carve mud, add air, tilt. */
  eq(inp: SigIn, bands?: EqBand[]): Sig
  /** Aural EXCITER: saturates the band ABOVE `freq` (def 3500) to synthesize
   *  harmonic air/sheen without hiss. `amount` 0..1 (def 0.3), `drive` (def 3). */
  exciter(inp: SigIn, opts?: { freq?: number; amount?: number; drive?: number }): Sig
  /** OTT — 3-band upward+downward multiband compressor (glue / loudness /
   *  brightness). `depth` 0..1 dry→full (def 0.5), `low`/`high` crossovers Hz
   *  (def 240 / 2500), `makeup` dB. */
  ott(inp: SigIn, opts?: { depth?: number; low?: number; high?: number; makeup?: number }): Sig
  /** WIDTH — Lauridsen pseudo-stereo. `amount` 0..1 (def 0.5, audio-rate)
   *  trades a delayed copy between the two post instances (+ on the left, − on
   *  the right), so a MONO source becomes wide stereo. `mode` 'wide' (12 ms,
   *  default) or 'tight' (3 ms). The mono sum is the DRY signal with a flat
   *  trim (0 dB at amount 0, −3.01 dB at 1) — no comb notches, nothing
   *  cancels. Each channel alone IS comb filtered (that is the trade). Belongs
   *  in a post chain or bus: in a per-voice graph there is only one instance,
   *  so it degrades to a fixed comb with no width. */
  width(inp: SigIn, amount?: SigIn, opts?: { mode?: 'wide' | 'tight' }): Sig
  /** TRANSIENT shaper: `attack` −1..1 sharpens (+) or softens (−) the onset,
   *  `sustain` −1..1 lifts (+) or cuts (−) the tail. Driven by the RATIO of a
   *  fast and a slow envelope follower, so it is LEVEL-INDEPENDENT — a quiet
   *  hit and a loud hit are shaped identically, unlike a compressor. It does
   *  not control level: leave headroom. */
  transient(inp: SigIn, opts?: { attack?: number; sustain?: number }): Sig
  /** FLANGER: one short (0.3–8 ms) modulated delay WITH feedback — the swept,
   *  resonant, jet-engine comb. `rate` Hz (def 0.3), `depth` 0..1 (def 0.7),
   *  `feedback` −0.95..0.95 (def 0.7, negative moves the notches), `mix` 0..1
   *  (def 0.5). Unlike chorus (three unfed taps around 11 ms, a thickener) the
   *  feedback builds resonant PEAKS between the notches. */
  flanger(inp: SigIn, opts?: { rate?: SigIn; depth?: SigIn; feedback?: SigIn; mix?: SigIn }): Sig
  mix(a: SigIn, b: SigIn, t: SigIn): Sig
  /** The device microphone as a LIVE signal (see the mic docs). Silence when
   *  no mic is connected and in offline renders. Headphones advised. */
  /** The live microphone. `device` names which input to open — an id or any
   *  part of the device's label ('scarlett'), matched by the host. It is
   *  config the GRAPH never reads: the capture is opened on the main thread,
   *  so this is how the program tells it what to open. */
  mic(opts?: { device?: string }): Sig
}

/** User-facing voice options passed to synth() — every field optional. See
 *  VoiceOpts (voice.ts) for the normalized shape and semantics. */
export interface VoiceOptsInput {
  /** Monophonic (one reused voice) with portamento. Default false (poly). */
  mono?: boolean
  /** Portamento time in seconds (mono only). Default 0 (instant). */
  glide?: number
  /** Detuned sub-voices per note, 1..9. Default 1 (off). */
  unison?: number
  /** Total unison detune spread in cents. Default 15. */
  detune?: number
  /** Unison stereo width, 0..1. Default 0.6. */
  spread?: number
  /** Unison detune-curve exponent: 1 (default) spaces sub-voices evenly,
   *  > 1 pulls the inner voices toward the center (Serum-style focus),
   *  < 1 pushes them out toward the edges. Clamped to [0.2, 5]. */
  curve?: number
  /** Edge-voice gain, 0..1: 1 (default) keeps all sub-voices equal, lower
   *  values fade the outer voices relative to the center. */
  blend?: number
  /** Octave stacking: every Nth unison sub-voice plays +12 semitones
   *  (N >= 2; 0/1 = off, the default). */
  octaves?: number
  /** Per-voice HUMANIZE, 0..1 (default 0 = off): a small deterministic pitch
   *  and timing offset per voice, so a unison stack or a stacked chord is not
   *  N machine-identical copies. At 1 the pitch spreads ±8 cents and the onset
   *  is held back 0..14 ms; the offsets are hashed from the voice slot and the
   *  note (never Math.random), so a render is reproducible. */
  humanize?: number
  /** Max simultaneous notes (voice-pool size), 1..64. Default 8. Right-size it
   *  to save the shared voice budget and CPU: drums/leads want 2-4, a mono
   *  bass 1, a held pad or chord stack 8-12. */
  voices?: number
}

export interface SynthDef {
  graph: GraphSpec
  /** Optional per-synth FX chain over the summed voices (see PostCtx). Absent
   *  when synth() was called with no postFn. */
  post?: GraphSpec
  /** Normalized voice-allocation options (mono/glide/unison/detune/spread,
   *  the unison shaping curve/blend/octaves, and humanize).
   *  ABSENT when synth() was called with no opts — the pool then takes its
   *  neutral defaults (poly, unison 1), preserving pre-feature behavior. */
  voiceOpts?: VoiceOpts
  /** Voice-pool size (max simultaneous notes) from opts.voices; ABSENT when
   *  unset (the engine then uses its default 8). */
  maxVoices?: number
  /** Voice-graph node id → source char-range [from, to) of the expression that
   *  produced it (captured by tapLoc). EDITOR-ONLY metadata for live-value
   *  readouts: it is deliberately NOT sent to the engine and NOT part of the
   *  synth's structural identity (Session fingerprints graph/post/voiceOpts/
   *  maxVoices only), so it never triggers a rebuild or voice drop. */
  nodeLocs?: Record<number, [number, number]>
}

/** Normalize + clamp user VoiceOptsInput into a full VoiceOpts. */
/** Clamp `voices` the way synth() does when it becomes maxVoices. Exported so
 *  the editor can show the effective value without copying the numbers. */
export const clampMaxVoices = (v: number): number =>
  Math.floor(Math.min(64, Math.max(1, v)))

/** Normalize + clamp voice options exactly as synth() will. EXPORTED so the
 *  editor can report what a written value actually becomes: a second copy of
 *  these bounds in the UI would drift from these the first time one changed. */
export const normalizeVoiceOpts = (o: VoiceOptsInput): VoiceOpts => {
  const num = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def)
  return {
    mono: o.mono === true,
    glide: Math.max(0, num(o.glide, 0)),
    unison: Math.floor(Math.min(9, Math.max(1, num(o.unison, 1)))),
    detune: Math.max(0, num(o.detune, 15)),
    spread: Math.min(1, Math.max(0, num(o.spread, 0.6))),
    curve: Math.min(5, Math.max(0.2, num(o.curve, 1))),
    blend: Math.min(1, Math.max(0, num(o.blend, 1))),
    octaves: Math.floor(Math.min(9, Math.max(0, num(o.octaves, 0)))),
    humanize: Math.min(1, Math.max(0, num(o.humanize, 0))),
  }
}

/** The builder whose synth() build function is currently executing. Node
 *  creation on any other builder (a leaked Sig or ctx) is an error. */
let activeBuilder: Builder | null = null

class Builder {
  readonly nodes: NodeSpec[] = []
  readonly params: ParamSpec[] = []
  /** node id → its source char-range [from, to), captured by tapLoc during the
   *  build so the editor can show a live value on a modulation expression. Kept
   *  OFF the GraphSpec (never diffed or fingerprinted). */
  readonly locs = new Map<number, [number, number]>()
  private nextId = 0

  node(type: NodeType, inputs: Record<string, InputSource>, config?: Record<string, unknown>): SigImpl {
    if (this !== activeBuilder) {
      throw new GraphError(
        `cannot create '${type}' node: Sig from another synth() build ` +
          `(Sigs and ctx cannot be shared across synth() calls or used after synth() returns)`,
      )
    }
    const id = this.nextId++
    this.nodes.push(config ? { id, type, inputs, config } : { id, type, inputs })
    return new SigImpl(this, id)
  }

  /** Resolve a SigIn to an InputSource: finite numbers stay constants
   *  (compile.ts pools them); Sigs must belong to THIS builder. Anything
   *  else fails here, at definition time, naming the port. */
  src(x: SigIn, what: string): InputSource {
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) {
        throw new GraphError(`${what}: constant must be a finite number, got ${x}`)
      }
      return x
    }
    if (!(x instanceof SigImpl)) {
      const kind = x === null ? 'null' : typeof x
      const detail = x === undefined || x === null ? '' : ` (${valuePreview(x)})`
      throw new GraphError(`${what}: expected a Sig or number, got ${kind}${detail}`)
    }
    if (x.builder !== this) {
      throw new GraphError(`${what}: Sig from another synth() build — Sigs cannot cross synth() boundaries`)
    }
    return { node: x.id }
  }
}

/** Tag the node a signal expression produced with its source char-range, so
 *  the editor can show a live value on it (the value-probe feature). TRANSPARENT
 *  — returns `val` unchanged — so the evaluator can wrap any expression with it.
 *  Only Sigs from the synth() build currently running are tagged; numbers,
 *  patterns, the SynthDef itself and anything else pass straight through. */
export function tapLoc<T>(from: number, to: number, val: T): T {
  if (activeBuilder !== null && val instanceof SigImpl && val.builder === activeBuilder) {
    activeBuilder.locs.set(val.id, [from, to])
  }
  return val
}

/** Short printable preview of a rejected input value for error messages. */
const valuePreview = (v: unknown): string => {
  let s: string
  try {
    s = typeof v === 'string' ? `'${v}'` : String(v)
  } catch {
    s = '<unprintable>'
  }
  return s.length > 30 ? `${s.slice(0, 27)}...` : s
}

class SigImpl implements Sig {
  constructor(
    readonly builder: Builder,
    readonly id: number,
  ) {}

  private bin(type: NodeType, x: SigIn): Sig {
    return this.builder.node(type, { a: { node: this.id }, b: this.builder.src(x, `${type} operand`) })
  }

  mul(x: SigIn): Sig {
    return this.bin('mul', x)
  }
  add(x: SigIn): Sig {
    return this.bin('add', x)
  }
  sub(x: SigIn): Sig {
    return this.bin('sub', x)
  }
  div(x: SigIn): Sig {
    return this.bin('div', x)
  }
  pow(x: SigIn): Sig {
    return this.bin('pow', x)
  }

  clip(lo?: SigIn, hi?: SigIn): Sig {
    const inputs: Record<string, InputSource> = { in: { node: this.id } }
    if (lo !== undefined) inputs['lo'] = this.builder.src(lo, 'clip lo')
    if (hi !== undefined) inputs['hi'] = this.builder.src(hi, 'clip hi')
    return this.builder.node('clip', inputs)
  }

  abs(): Sig { return this.#math('abs') }
  floor(): Sig { return this.#math('floor') }
  ceil(): Sig { return this.#math('ceil') }
  round(): Sig { return this.#math('round') }
  sign(): Sig { return this.#math('sign') }
  sqrt(): Sig { return this.#math('sqrt') }
  exp(): Sig { return this.#math('exp') }
  log(): Sig { return this.#math('log') }
  sin(): Sig { return this.#math('sin') }
  cos(): Sig { return this.#math('cos') }
  min(x: SigIn): Sig { return this.#math2('min', x) }
  max(x: SigIn): Sig { return this.#math2('max', x) }
  mod(x: SigIn): Sig { return this.#math2('mod', x) }

  #math(op: MathOp): Sig {
    return this.builder.node('math', { in: { node: this.id } }, { op })
  }

  #math2(op: Math2Op, x: SigIn): Sig {
    return this.builder.node('math2', { a: { node: this.id }, b: this.builder.src(x, `${op} operand`) }, { op })
  }

  tanh(): Sig {
    return this.builder.node('tanh', { in: { node: this.id } })
  }

  fold(): Sig {
    return this.builder.node('fold', { in: { node: this.id } })
  }

  mix(other: SigIn, amount: SigIn): Sig {
    return this.builder.node('mix', {
      a: { node: this.id },
      b: this.builder.src(other, 'mix other'),
      t: this.builder.src(amount, 'mix amount'),
    })
  }

  range(lo: SigIn, hi: SigIn): Sig {
    if (typeof lo === 'number' && typeof hi === 'number') {
      return this.mul(hi - lo).add(lo)
    }
    const span = this.builder.node('sub', {
      a: this.builder.src(hi, 'range hi'),
      b: this.builder.src(lo, 'range lo'),
    })
    return this.mul(span).add(lo)
  }
}

/** Object with only the defined entries of `obj`; undefined if none remain.
 *  Keeps NodeSpec.config free of undefined-valued keys (and absent when a
 *  kernel should use its own defaults). */
const definedConfig = (obj: Record<string, unknown>): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {}
  let any = false
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v
      any = true
    }
  }
  return any ? out : undefined
}

/** The constructors shared by the voice ctx (SynthCtx) and the post ctx
 *  (PostCtx): declared params, filters, an LFO, the two time-based effects, and
 *  mix(). Sourced once so both contexts stay in lockstep. */
const makeShared = (b: Builder) => {
  const src = (x: SigIn, what: string): InputSource => b.src(x, what)
  return {
    param: (name: string, def?: number, opts?: ParamOpts): Sig => {
      if (RESERVED_PARAM_NAMES.has(name)) {
        throw new GraphError(
          `param '${name}' shadows a structural control key — it can never be driven by .ctrl('${name}', …) (those are consumed as note/gain/pan/dur/…). Rename the param.`,
        )
      }
      if (b.params.some((p) => p.name === name)) {
        throw new GraphError(`duplicate param name '${name}' in synth()`)
      }
      // No default given: this is a MACRO reference. The numbers live on the
      // macro() declaration, which is the whole point — one literal, so no use
      // site can drift from another.
      const mac = def === undefined ? lookupMacro(name) : undefined
      if (def === undefined && mac === undefined) {
        throw new GraphError(
          `param('${name}') has no default and no macro named '${name}' is declared — pass a default, or declare macro('${name}', …) above this synth`,
        )
      }
      if (mac !== undefined) {
        const spec: ParamSpec = { name, default: mac.default, min: mac.min, max: mac.max, macro: true }
        if (mac.curve !== undefined) spec.curve = mac.curve
        // a switch macro stays a switch at every use site — otherwise the
        // project-wide toggle would render as a dial inside the synth
        if (mac.values !== undefined) spec.values = mac.values
        b.params.push(spec)
        return b.node('param', {}, { name })
      }
      const pair = validateSwitchValues(`param '${name}'`, def!, opts)
      if (pair !== undefined) {
        b.params.push({ name, default: def!, min: Math.min(...pair), max: Math.max(...pair), values: pair })
        return b.node('param', {}, { name })
      }
      if (def! < 0 && opts?.min === undefined) {
        throw new GraphError(
          `param '${name}': negative default (${def}) requires an explicit min (omitted min defaults to 0)`,
        )
      }
      const spec: ParamSpec = {
        name,
        default: def!,
        min: opts?.min ?? 0,
        max: opts?.max ?? (def! > 0 ? def! * 4 : 1),
      }
      if (opts?.curve !== undefined) spec.curve = opts.curve
      b.params.push(spec)
      return b.node('param', {}, { name })
    },
    svf: (inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn; mode?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass' }): Sig => {
      const inputs: Record<string, InputSource> = {
        in: src(inp, 'svf in'),
        cutoff: src(cutoff, 'svf cutoff'),
      }
      if (opts?.res !== undefined) inputs['res'] = src(opts.res, 'svf res')
      return b.node('svf', inputs, definedConfig({ mode: opts?.mode }))
    },
    ladder: (inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn }): Sig => {
      const inputs: Record<string, InputSource> = {
        in: src(inp, 'ladder in'),
        cutoff: src(cutoff, 'ladder cutoff'),
      }
      if (opts?.res !== undefined) inputs['res'] = src(opts.res, 'ladder res')
      return b.node('ladder', inputs)
    },
    onepole: (inp: SigIn, cutoff: SigIn): Sig =>
      b.node('onepole', { in: src(inp, 'onepole in'), cutoff: src(cutoff, 'onepole cutoff') }),
    dualsvf: (
      inp: SigIn,
      cutoff: SigIn,
      cutoff2: SigIn,
      opts?: { res?: SigIn; mode?: 'serial' | 'parallel'; a?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass'; b?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' | 'allpass' },
    ): Sig => {
      const inputs: Record<string, InputSource> = {
        in: src(inp, 'dualsvf in'),
        cutoff: src(cutoff, 'dualsvf cutoff'),
        cutoff2: src(cutoff2, 'dualsvf cutoff2'),
      }
      if (opts?.res !== undefined) inputs['res'] = src(opts.res, 'dualsvf res')
      return b.node('dualsvf', inputs, definedConfig({ mode: opts?.mode, a: opts?.a, b: opts?.b }))
    },
    // shape is positional but optional, so `lfo(2, { sync: true })` (the shape
    // omitted, opts in its slot) has to be accepted — that is exactly what
    // rondo's `lfo 2 sync:1` emits.
    lfo: (freq: SigIn, shape?: LfoShapeName | LfoOpts, opts?: LfoOpts): Sig => {
      const shapeName = typeof shape === 'string' ? shape : undefined
      const o = typeof shape === 'object' && shape !== null ? shape : opts
      return b.node(
        'lfo',
        { freq: src(freq, 'lfo freq') },
        definedConfig({ shape: shapeName, sync: o?.sync === true ? true : undefined }),
      )
    },
    delay: (inp: SigIn, time: SigIn, feedback?: SigIn, opts?: DelayOpts): Sig => {
      const inputs: Record<string, InputSource> = {
        in: src(inp, 'delay in'),
        time: src(time, 'delay time'),
      }
      if (feedback !== undefined) inputs['feedback'] = src(feedback, 'delay feedback')
      if (opts?.mix !== undefined) inputs['mix'] = src(opts.mix, 'delay mix')
      const config: Record<string, unknown> = { maxTime: opts?.maxTime ?? 0.5 }
      if (opts?.sync === true) config['sync'] = true
      return b.node('delay', inputs, config)
    },
    reverb: (inp: SigIn, opts?: { roomSize?: number; damp?: number }): Sig =>
      b.node(
        'reverb',
        { in: src(inp, 'reverb in') },
        definedConfig({ roomSize: opts?.roomSize, damp: opts?.damp }),
      ),
    chorus: (inp: SigIn, opts?: { rate?: SigIn; depth?: SigIn; mix?: SigIn }): Sig => {
      // rate/depth/mix are per-sample INPUTS, so an LFO or knob can ride them
      const inputs: Record<string, InputSource> = { in: src(inp, 'chorus in') }
      if (opts?.rate !== undefined) inputs['rate'] = src(opts.rate, 'chorus rate')
      if (opts?.depth !== undefined) inputs['depth'] = src(opts.depth, 'chorus depth')
      if (opts?.mix !== undefined) inputs['mix'] = src(opts.mix, 'chorus mix')
      return b.node('chorus', inputs)
    },
    comb: (inp: SigIn, freq: SigIn, feedback?: SigIn, opts?: { damp?: number }): Sig => {
      const inputs: Record<string, InputSource> = {
        in: src(inp, 'comb in'),
        freq: src(freq, 'comb freq'),
      }
      if (feedback !== undefined) inputs['feedback'] = src(feedback, 'comb feedback')
      return b.node('comb', inputs, definedConfig({ damp: opts?.damp }))
    },
    bitcrush: (inp: SigIn, opts?: { bits?: number; downsample?: number }): Sig =>
      b.node(
        'bitcrush',
        { in: src(inp, 'bitcrush in') },
        definedConfig({ bits: opts?.bits, downsample: opts?.downsample }),
      ),
    shape: (inp: SigIn, drive?: SigIn, opts?: { type?: 'soft' | 'hard' | 'sine' | 'tube' }): Sig => {
      const inputs: Record<string, InputSource> = { in: src(inp, 'shape in') }
      if (drive !== undefined) inputs['drive'] = src(drive, 'shape drive')
      return b.node('shape', inputs, definedConfig({ type: opts?.type }))
    },
    compress: (
      inp: SigIn,
      opts?: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number },
    ): Sig =>
      b.node(
        'compress',
        { in: src(inp, 'compress in') },
        definedConfig({
          threshold: opts?.threshold,
          ratio: opts?.ratio,
          attack: opts?.attack,
          release: opts?.release,
          knee: opts?.knee,
          makeup: opts?.makeup,
        }),
      ),
    noisegate: (
      inp: SigIn,
      opts?: { threshold?: number; range?: number; attack?: number; hold?: number; release?: number; hysteresis?: number },
    ): Sig =>
      b.node(
        'noisegate',
        { in: src(inp, 'noisegate in') },
        definedConfig({
          threshold: opts?.threshold,
          range: opts?.range,
          attack: opts?.attack,
          hold: opts?.hold,
          release: opts?.release,
          hysteresis: opts?.hysteresis,
        }),
      ),
    tape: (
      inp: SigIn,
      opts?: { wow?: number; flutter?: number; sat?: number; tone?: number },
    ): Sig =>
      b.node(
        'tape',
        { in: src(inp, 'tape in') },
        definedConfig({ wow: opts?.wow, flutter: opts?.flutter, sat: opts?.sat, tone: opts?.tone }),
      ),
    convolve: (inp: SigIn, name: string, opts?: { mix?: SigIn }): Sig => {
      const inputs: Record<string, InputSource> = { in: src(inp, 'convolve in') }
      // mix is a SIGNAL, not construction config: it was declared `sig` in the
      // rondo registry while the kernel read it as a number, so an LFO there
      // was silently dropped back to the default
      if (opts?.mix !== undefined) inputs['mix'] = src(opts.mix, 'convolve mix')
      return b.node('convolve', inputs, definedConfig({ name }))
    },
    pitchshift: (
      inp: SigIn,
      opts?: { semitones?: number; window?: number; mix?: SigIn },
    ): Sig => {
      const inputs: Record<string, InputSource> = { in: src(inp, 'pitchshift in') }
      if (opts?.mix !== undefined) inputs['mix'] = src(opts.mix, 'pitchshift mix')
      return b.node(
        'pitchshift',
        inputs,
        definedConfig({ semitones: opts?.semitones, window: opts?.window }),
      )
    },
    follow: (
      inp: SigIn,
      opts?: { attack?: number; release?: number; mode?: 'peak' | 'rms' },
    ): Sig =>
      b.node(
        'follow',
        { in: src(inp, 'follow in') },
        definedConfig({ attack: opts?.attack, release: opts?.release, mode: opts?.mode }),
      ),
    deess: (
      inp: SigIn,
      opts?: { freq?: number; threshold?: number; ratio?: number; attack?: number; release?: number },
    ): Sig =>
      b.node(
        'deess',
        { in: src(inp, 'deess in') },
        definedConfig({
          freq: opts?.freq,
          threshold: opts?.threshold,
          ratio: opts?.ratio,
          attack: opts?.attack,
          release: opts?.release,
        }),
      ),
    limiter: (inp: SigIn, opts?: { ceiling?: number; lookahead?: number; release?: number }): Sig =>
      b.node(
        'limiter',
        { in: src(inp, 'limiter in') },
        definedConfig({ ceiling: opts?.ceiling, lookahead: opts?.lookahead, release: opts?.release }),
      ),
    phaser: (
      inp: SigIn,
      opts?: { rate?: SigIn; depth?: SigIn; feedback?: SigIn; stages?: number; mix?: SigIn },
    ): Sig => {
      const inputs: Record<string, InputSource> = { in: src(inp, 'phaser in') }
      if (opts?.rate !== undefined) inputs['rate'] = src(opts.rate, 'phaser rate')
      if (opts?.depth !== undefined) inputs['depth'] = src(opts.depth, 'phaser depth')
      if (opts?.feedback !== undefined) inputs['feedback'] = src(opts.feedback, 'phaser feedback')
      if (opts?.mix !== undefined) inputs['mix'] = src(opts.mix, 'phaser mix')
      // `stages` sizes the allpass array: a per-sample count is a rebuild, not
      // a control, so it stays construction config
      return b.node('phaser', inputs, definedConfig({ stages: opts?.stages }))
    },
    formant: (inp: SigIn, morph?: SigIn): Sig => {
      const inputs: Record<string, InputSource> = { in: src(inp, 'formant in') }
      if (morph !== undefined) inputs['morph'] = src(morph, 'formant morph')
      return b.node('formant', inputs)
    },
    vocoder: (
      carrier: SigIn,
      modulator: SigIn,
      opts?: { bands?: number; low?: number; high?: number; q?: number; response?: number },
    ): Sig =>
      b.node(
        'vocoder',
        { carrier: src(carrier, 'vocoder carrier'), modulator: src(modulator, 'vocoder modulator') },
        definedConfig({ bands: opts?.bands, low: opts?.low, high: opts?.high, q: opts?.q, response: opts?.response }),
      ),
    eq: (inp: SigIn, bands?: EqBand[]): Sig =>
      b.node('eq', { in: src(inp, 'eq in') }, { bands: Array.isArray(bands) ? bands : [] }),
    exciter: (inp: SigIn, opts?: { freq?: number; amount?: number; drive?: number }): Sig =>
      b.node(
        'exciter',
        { in: src(inp, 'exciter in') },
        definedConfig({ freq: opts?.freq, amount: opts?.amount, drive: opts?.drive }),
      ),
    ott: (inp: SigIn, opts?: { depth?: number; low?: number; high?: number; makeup?: number }): Sig =>
      b.node(
        'ott',
        { in: src(inp, 'ott in') },
        definedConfig({ depth: opts?.depth, low: opts?.low, high: opts?.high, makeup: opts?.makeup }),
      ),
    width: (inp: SigIn, amount?: SigIn, opts?: { mode?: 'wide' | 'tight' }): Sig => {
      const inputs: Record<string, InputSource> = { in: src(inp, 'width in') }
      if (amount !== undefined) inputs['amount'] = src(amount, 'width amount')
      return b.node('width', inputs, definedConfig({ mode: opts?.mode }))
    },
    transient: (inp: SigIn, opts?: { attack?: number; sustain?: number }): Sig =>
      b.node(
        'transient',
        { in: src(inp, 'transient in') },
        definedConfig({ attack: opts?.attack, sustain: opts?.sustain }),
      ),
    flanger: (
      inp: SigIn,
      opts?: { rate?: SigIn; depth?: SigIn; feedback?: SigIn; mix?: SigIn },
    ): Sig => {
      const inputs: Record<string, InputSource> = { in: src(inp, 'flanger in') }
      if (opts?.rate !== undefined) inputs['rate'] = src(opts.rate, 'flanger rate')
      if (opts?.depth !== undefined) inputs['depth'] = src(opts.depth, 'flanger depth')
      if (opts?.feedback !== undefined) inputs['feedback'] = src(opts.feedback, 'flanger feedback')
      if (opts?.mix !== undefined) inputs['mix'] = src(opts.mix, 'flanger mix')
      return b.node('flanger', inputs)
    },
    mix: (a: SigIn, bb: SigIn, t: SigIn): Sig =>
      b.node('mix', { a: src(a, 'mix a'), b: src(bb, 'mix b'), t: src(t, 'mix t') }),
    // LIVE MIC: the device microphone as a signal (silence offline / when no
    // mic is connected). Use headphones — a speaker feeding the mic howls.
    mic: (opts?: { device?: string }): Sig => b.node('mic', {}, definedConfig({ device: opts?.device })),
  }
}

const makePostCtx = (b: Builder): PostCtx => ({
  input: b.node('businput', {}),
  ...makeShared(b),
})

const makeCtx = (b: Builder): SynthCtx => {
  const src = (x: SigIn, what: string): InputSource => b.src(x, what)
  const shared = makeShared(b)
  const noteFreq = b.node('notefreq', {})
  return {
    note: { freq: noteFreq },
    gate: b.node('gate', {}),
    velocity: b.node('velocity', {}),

    param: shared.param,
    svf: shared.svf,
    ladder: shared.ladder,
    onepole: shared.onepole,
    dualsvf: shared.dualsvf,
    lfo: shared.lfo,
    delay: shared.delay,
    reverb: shared.reverb,
    chorus: shared.chorus,
    comb: shared.comb,
    bitcrush: shared.bitcrush,
    shape: shared.shape,
    compress: shared.compress,
    noisegate: shared.noisegate,
    deess: shared.deess,
    follow: shared.follow,
    pitchshift: shared.pitchshift,
    convolve: shared.convolve,
    tape: shared.tape,
    limiter: shared.limiter,
    phaser: shared.phaser,
    formant: shared.formant,
    vocoder: shared.vocoder,
    eq: shared.eq,
    exciter: shared.exciter,
    ott: shared.ott,
    width: shared.width,
    transient: shared.transient,
    flanger: shared.flanger,
    mix: shared.mix,
    mic: shared.mic,

    sine: (freq) => b.node('sine', { freq: src(freq, 'sine freq') }),
    saw: (freq) => b.node('saw', { freq: src(freq, 'saw freq') }),
    square: (freq) => b.node('square', { freq: src(freq, 'square freq') }),
    tri: (freq) => b.node('tri', { freq: src(freq, 'tri freq') }),
    pulse: (freq, width) => {
      const inputs: Record<string, InputSource> = { freq: src(freq, 'pulse freq') }
      if (width !== undefined) inputs['width'] = src(width, 'pulse width')
      return b.node('pulse', inputs)
    },
    syncsaw: (freq, ratio) => {
      const inputs: Record<string, InputSource> = { freq: src(freq, 'syncsaw freq') }
      if (ratio !== undefined) inputs['ratio'] = src(ratio, 'syncsaw ratio')
      return b.node('syncsaw', inputs)
    },
    fm: (freq, mod, opts) => {
      const inputs: Record<string, InputSource> = { freq: src(freq, 'fm freq') }
      if (mod !== undefined) inputs['mod'] = src(mod, 'fm mod')
      if (opts?.feedback !== undefined) inputs['feedback'] = src(opts.feedback, 'fm feedback')
      return b.node('fm', inputs, definedConfig({ wave: opts?.wave }))
    },
    wavetable: (freq, pos, opts) => {
      const inputs: Record<string, InputSource> = { freq: src(freq, 'wavetable freq') }
      if (pos !== undefined) inputs['pos'] = src(pos, 'wavetable pos')
      if (opts?.warpAmt !== undefined) inputs['warpAmt'] = src(opts.warpAmt, 'wavetable warpAmt')
      return b.node('wavetable', inputs, definedConfig({ table: opts?.table, warp: opts?.warp }))
    },
    supersaw: (freq, opts) => {
      const inputs: Record<string, InputSource> = { freq: src(freq, 'supersaw freq') }
      if (opts?.detune !== undefined) inputs['detune'] = src(opts.detune, 'supersaw detune')
      if (opts?.mix !== undefined) inputs['mix'] = src(opts.mix, 'supersaw mix')
      return b.node('supersaw', inputs)
    },
    noise: (color) => b.node('noise', {}, definedConfig({ color })),
    lfsr: (freq, opts) => b.node('lfsr', { freq: src(freq, 'lfsr freq') }, definedConfig({ mode: opts?.mode })),

    sample: (gate, name, opts) => {
      const inputs: Record<string, InputSource> = { gate: src(gate, 'sample gate') }
      const frac = (v: number | undefined, what: string): void => {
        if (v !== undefined && !(Number.isFinite(v) && v >= 0 && v <= 1)) {
          throw new GraphError(`sample ${what}: must be a fraction of the buffer in 0..1, got ${v}`)
        }
      }
      frac(opts?.start, 'start')
      frac(opts?.end, 'end')
      const start = opts?.start ?? 0
      const end = opts?.end ?? 1
      if (end <= start) {
        throw new GraphError(`sample window: end (${end}) must be greater than start (${start})`)
      }
      if (opts?.slices !== undefined && !(Number.isInteger(opts.slices) && opts.slices >= 1)) {
        throw new GraphError(`sample slices: must be a whole number of slices >= 1, got ${opts.slices}`)
      }
      if (opts?.fade !== undefined && !(Number.isFinite(opts.fade) && opts.fade >= 0)) {
        throw new GraphError(`sample fade: must be a length in seconds >= 0, got ${opts.fade}`)
      }
      // `root` is the reference note either way: WITHOUT slices it is the note
      // that plays at natural pitch (the note tracks the speed); WITH slices
      // the note picks the chop instead, so root is the note that picks slice 0
      // and playback stays at natural speed unless an explicit speed is given.
      const rootFreq = 440 * Math.pow(2, ((opts?.root ?? 60) - 69) / 12)
      let speed: SigIn | undefined = opts?.speed
      if (speed === undefined && opts?.root !== undefined && opts.slices === undefined) {
        speed = noteFreq.div(rootFreq)
      }
      if (speed !== undefined) inputs['speed'] = src(speed, 'sample speed')
      if (opts?.slices !== undefined) inputs['pitch'] = src(noteFreq.div(rootFreq), 'sample pitch')
      return b.node(
        'sample',
        inputs,
        definedConfig({
          name,
          loop: opts?.loop,
          start: opts?.start,
          end: opts?.end,
          reverse: opts?.reverse,
          slices: opts?.slices,
          fade: opts?.fade,
        }),
      )
    },

    granular: (gate, name, opts) => {
      const inputs: Record<string, InputSource> = { gate: src(gate, 'granular gate') }
      if (opts?.pos !== undefined) inputs['pos'] = src(opts.pos, 'granular pos')
      // pitch: explicit rate wins; else root -> track note.freq / freq(root)
      let rate: SigIn | undefined = opts?.rate
      if (rate === undefined && opts?.root !== undefined) {
        rate = noteFreq.div(440 * Math.pow(2, (opts.root - 69) / 12))
      }
      if (rate !== undefined) inputs['rate'] = src(rate, 'granular rate')
      return b.node(
        'granular',
        inputs,
        definedConfig({ name, size: opts?.size, density: opts?.density, spray: opts?.spray, loop: opts?.loop }),
      )
    },

    pluck: (gate, freq, opts) =>
      b.node(
        'pluck',
        { gate: src(gate, 'pluck gate'), freq: src(freq, 'pluck freq') },
        definedConfig({ decay: opts?.decay, damp: opts?.damp, seed: opts?.seed }),
      ),

    modal: (gate, freq, opts) =>
      b.node(
        'modal',
        { gate: src(gate, 'modal gate'), freq: src(freq, 'modal freq') },
        definedConfig({
          model: opts?.model,
          decay: opts?.decay,
          damp: opts?.damp,
          stretch: opts?.stretch,
          keyScale: opts?.keyScale,
        }),
      ),

    adsr: (gate, opts) =>
      b.node('adsr', {
        gate: src(gate, 'adsr gate'),
        // omitted stages are left unconnected so PORTS supplies the default
        ...(opts?.a !== undefined ? { a: src(opts.a, 'adsr a') } : {}),
        ...(opts?.d !== undefined ? { d: src(opts.d, 'adsr d') } : {}),
        ...(opts?.s !== undefined ? { s: src(opts.s, 'adsr s') } : {}),
        ...(opts?.r !== undefined ? { r: src(opts.r, 'adsr r') } : {}),
      }),

    env: (gate, points, opts) =>
      b.node(
        'env',
        { gate: src(gate, 'env gate') },
        // points is required config (the kernel rejects an empty list at compile);
        // definedConfig drops the optional keys when absent.
        { points, ...(definedConfig({ release: opts?.release, curve: opts?.curve, loop: opts?.loop }) ?? {}) },
      ),

    pan: (inp, pos) => b.node('pan', { in: src(inp, 'pan in'), pos: src(pos, 'pan pos') }),
  }
}

/** Build one graph (voice or post) in its own node-id space: run `build` with
 *  a fresh context, wrap the returned Sig in `out`, then validate AND compile
 *  (48 kHz check pass, result discarded) so malformed graphs fail HERE with the
 *  offending node named — not later on the audio thread. `compile` differs so
 *  the voice graph checks the stereo/pan contract and the post graph the mono
 *  contract. */
const buildGraph = <C>(
  make: (b: Builder) => C,
  isImpl: (result: unknown, b: Builder) => boolean,
  build: (ctx: C) => Sig,
  compile: (g: GraphSpec) => void,
): { graph: GraphSpec; locs: Map<number, [number, number]> } => {
  const b = new Builder()
  const prev = activeBuilder
  activeBuilder = b
  let outId: number
  try {
    const result = build(make(b))
    if (!isImpl(result, b)) {
      throw new GraphError('synth() build must return a Sig created in this synth() context')
    }
    outId = b.node('out', { in: { node: (result as SigImpl).id } }).id
  } finally {
    activeBuilder = prev
  }
  const graph: GraphSpec = { nodes: b.nodes, out: outId, params: b.params }
  validateGraph(graph)
  compile(graph)
  return { graph, locs: b.locs }
}

const returnsOwnSig = (result: unknown, b: Builder): boolean =>
  result instanceof SigImpl && result.builder === b

/** Define a synth. `voiceFn` wires the PER-VOICE sound (SynthCtx). The optional
 *  `postFn` wires a PER-SYNTH FX chain (PostCtx) that processes the SUMMED
 *  voices ONCE — shared reverb/delay/EQ instead of one-per-note. `opts` sets
 *  voice-allocation modes (mono/glide/unison/detune/spread, the unison
 *  shaping curve/blend/octaves, and humanize); it may be passed
 *  as the SECOND argument when there is no post chain — a plain object there is
 *  read as opts, a function as the post fn. Both graphs are validated +
 *  compiled here so errors surface at definition time; a synth with no postFn
 *  has `post` undefined and one with no opts has `voiceOpts` undefined and
 *  behaves exactly as before. */
export function synth(voiceFn: (ctx: SynthCtx) => Sig, opts: VoiceOptsInput): SynthDef
export function synth(
  voiceFn: (ctx: SynthCtx) => Sig,
  postFn?: (ctx: PostCtx) => Sig,
  opts?: VoiceOptsInput,
): SynthDef
export function synth(
  voiceFn: (ctx: SynthCtx) => Sig,
  postOrOpts?: ((ctx: PostCtx) => Sig) | VoiceOptsInput,
  maybeOpts?: VoiceOptsInput,
): SynthDef {
  // Second arg: a function is the post chain; a plain object is opts (no post).
  let postFn: ((ctx: PostCtx) => Sig) | undefined
  let optsInput: VoiceOptsInput | undefined
  if (typeof postOrOpts === 'function') {
    postFn = postOrOpts
    optsInput = maybeOpts
  } else if (postOrOpts !== undefined && postOrOpts !== null) {
    optsInput = postOrOpts
  }

  const voice = buildGraph(makeCtx, returnsOwnSig, voiceFn, (g) => {
    compileGraph(g, { sampleRate: 48000 }) // validation pass; graphs are tiny
  })
  const def: SynthDef = { graph: voice.graph }
  // Modulation-expression source spans for the editor's live-value readouts.
  // Voice graph only (per-note modulation lives here); metadata, never part of
  // the synth's structural identity — see SynthDef.nodeLocs.
  if (voice.locs.size > 0) def.nodeLocs = Object.fromEntries(voice.locs)
  if (postFn !== undefined) {
    def.post = buildGraph(makePostCtx, returnsOwnSig, postFn, (g) => {
      compilePost(g, { sampleRate: 48000 })
    }).graph
  }
  if (optsInput !== undefined) def.voiceOpts = normalizeVoiceOpts(optsInput)
  if (optsInput?.voices !== undefined && Number.isFinite(optsInput.voices)) {
    def.maxVoices = Math.floor(Math.min(64, Math.max(1, optsInput.voices)))
  }
  return def
}

/** Build a shared send-bus FX graph. `fxFn` is a POST-style chain — it takes
 *  the summed sends as `input` and returns the processed signal — compiled
 *  exactly like a synth's post chain, so bus FX behave identically. */
export function busGraph(fxFn: (ctx: PostCtx) => Sig): GraphSpec {
  const graph = buildGraph(makePostCtx, returnsOwnSig, fxFn, (g) => {
    compilePost(g, { sampleRate: 48000 })
  }).graph
  // A bus has no notes and no .ctrl() route, so a param() in its FX chain could
  // never be changed — it'd be a silent dead knob. Reject it at build time.
  if (graph.params.length > 0) {
    throw new GraphError(
      `bus(): param('${graph.params[0]!.name}') can't be used in a bus FX chain — a bus has no notes or .ctrl() route, so it could never change. Use a fixed value.`,
    )
  }
  return graph
}
