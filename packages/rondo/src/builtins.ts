/* The rondo builtin registry — ONE table describing how each synth-ctx
 * builtin parses (positional count/kinds, named args) and how it emits
 * (JS call shape). The parser reads arg shapes; codegen reads emission
 * specs; the parity scoreboard counts the keys. Adding a builtin = one row.
 *
 * Kinds:
 *   osc   — a source; positionals as declared (freq defaults to the note).
 *   gated — engine call takes the voice gate as its FIRST arg (samplers,
 *           physical models); rondo omits it (`sample vox root:57`).
 *   proc  — a processor; the RUNNING SIGNAL is the first arg. Usable as a
 *           spine line (`delay .375 .4`) with the pipe as input.
 *   sigop — a Sig method on the running signal (`tanh`, `clip -1 1`).
 *
 * Positional kinds: 'sig' = expression; 'enum' = a bare word emitted quoted
 * ('pink', 'tri'); named kinds add 'num' (plain number) and 'bool'
 * (`loop:1` → `loop: true`). `alias` renames rondo arg → JS opts key. */

export type PosKind = 'sig' | 'enum'
export type NamedKind = 'sig' | 'num' | 'enum' | 'bool'

export interface BuiltinSpec {
  kind: 'osc' | 'gated' | 'proc' | 'sigop'
  /** positional args AFTER the implicit one (gate / running signal). */
  pos: PosKind[]
  /** the first positional defaults to the note's freq when omitted. */
  freqDefault?: boolean
  /** named args accepted (rondo name → value kind). */
  named?: Record<string, NamedKind>
  /** rondo named-arg → JS opts key (room → roomSize). */
  alias?: Record<string, string>
  /** always-emitted opts defaults (ladder's res). */
  defaults?: Record<string, string>
  /** literal JS values for POSITIONALS the call omitted. Needed whenever a
   *  builtin has an optional positional AND named args: without it,
   *  `width mode:tight` would emit `width(input, { mode: 'tight' })` and the
   *  opts object would land in the positional slot. */
  posDefault?: string[]
  /** emit named args as an opts OBJECT (default true when `named` present);
   *  false = positionals only (lfo's shape is positional). */
  optsObject?: boolean
}

export const BUILTINS: Record<string, BuiltinSpec> = {
  // ---- oscillators / sources ----
  sine: { kind: 'osc', pos: ['sig'], freqDefault: true },
  saw: { kind: 'osc', pos: ['sig'], freqDefault: true },
  square: { kind: 'osc', pos: ['sig'], freqDefault: true },
  tri: { kind: 'osc', pos: ['sig'], freqDefault: true },
  pulse: { kind: 'osc', pos: ['sig', 'sig'], freqDefault: true },
  syncsaw: { kind: 'osc', pos: ['sig', 'sig'], freqDefault: true },
  fm: { kind: 'osc', pos: ['sig', 'sig'], freqDefault: true, named: { feedback: 'sig', wave: 'enum' } },
  // warp bends the phase read (sync/bend/mirror), warpamt (0..1, sig) drives it
  wavetable: {
    kind: 'osc', pos: ['sig', 'sig'], freqDefault: true,
    named: { table: 'enum', warp: 'enum', warpamt: 'sig' }, alias: { warpamt: 'warpAmt' },
  },
  supersaw: { kind: 'osc', pos: ['sig'], freqDefault: true, named: { detune: 'sig', mix: 'sig' } },
  noise: { kind: 'osc', pos: ['enum'] },
  lfsr: { kind: 'osc', pos: ['sig'], freqDefault: true, named: { mode: 'enum' } },
  // `sync:1` re-reads the rate as a length in transport CYCLES (1 = one sweep
  // per cycle, .25 = a quarter note) instead of Hz — it follows the tempo
  lfo: { kind: 'osc', pos: ['sig', 'enum'], named: { sync: 'bool' } },
  // the LIVE microphone as a source (silence offline / when unconnected)
  // `device` names which input to open — an id, or any part of the label.
  // Config the GRAPH never reads: the capture is opened on the main thread,
  // so this is how a program tells the host what to open. This once broke
  // `vocoder mic bands:24` (mic swallowed `bands:`); named args now bind to
  // the nearest call that ACCEPTS them, so a nested builtin declaring one
  // no longer changes how a following one binds.
  mic: { kind: 'osc', pos: [], named: { device: 'enum' } },

  // ---- gated sources (samplers, physical models) ----
  // start/end window the buffer (fractions 0..1), slices chops that window and
  // the NOTE picks a chop, reverse plays it backwards, fade softens the edges.
  // variant picks among a sample FAMILY (`bd`, `bd:1`, `bd:2`) per note, and
  // is a signal so a pattern can drive it: that is a round-robin kit.
  sample: {
    kind: 'gated', pos: ['enum'],
    named: {
      root: 'num', speed: 'sig', loop: 'bool', variant: 'sig',
      start: 'num', end: 'num', reverse: 'bool', slices: 'num', fade: 'num',
    },
  },
  granular: {
    kind: 'gated', pos: ['enum'],
    named: { pos: 'sig', root: 'num', rate: 'sig', size: 'num', density: 'num', spray: 'num', loop: 'bool' },
  },
  pluck: { kind: 'gated', pos: ['sig'], freqDefault: true, named: { decay: 'num', damp: 'num', seed: 'num' } },
  modal: { kind: 'gated', pos: ['sig'], freqDefault: true, named: { model: 'enum', decay: 'num', damp: 'num', stretch: 'num', keyScale: 'num' } },
  // trained neural instrument: `ddsp violin`. Pitch/velocity wire themselves
  // (the builder defaults freq/vel to the note); breath is the expressive
  // loudness offset (dB, drives TIMBRE), vib/vibrate the built-in vibrato.
  ddsp: {
    kind: 'gated', pos: ['enum'],
    named: {
      breath: 'sig', vib: 'sig', vibrate: 'sig', vel: 'sig',
      air: 'sig', bright: 'sig', scoop: 'sig', fall: 'sig',
      level: 'num', dyn: 'num', gain: 'num', attack: 'num', release: 'num', punch: 'num', vibdelay: 'num', flow: 'num', seed: 'num',
    },
  },
  // breakpoint envelope — flat time/level pairs, special-parsed (variadic):
  // `e = env .005 1 .15 .4 .5 .6 release:.3 curve:3 loop:1`
  env: { kind: 'gated', pos: [], named: { release: 'num', curve: 'num', loop: 'bool' } },

  // ---- processors (running signal first) ----
  ladder: { kind: 'proc', pos: ['sig'], named: { res: 'sig' }, defaults: { res: '0.5' } },
  svf: { kind: 'proc', pos: ['sig'], named: { res: 'sig', mode: 'enum' } },
  // dual filter: two svf stages — positionals are the two cutoffs
  // (`dualsvf 400 4000 mode:parallel a:lp b:hp res:.3`)
  dualsvf: { kind: 'proc', pos: ['sig', 'sig'], named: { res: 'sig', mode: 'enum', a: 'enum', b: 'enum' } },
  onepole: { kind: 'proc', pos: ['sig'] },
  // `sync:1` re-reads the time as transport CYCLES (.1875 = a dotted eighth)
  // instead of seconds; maxtime still sizes the buffer in SECONDS
  delay: { kind: 'proc', pos: ['sig', 'sig'], named: { maxtime: 'num', sync: 'bool', mix: 'sig' }, alias: { maxtime: 'maxTime' } },
  comb: { kind: 'proc', pos: ['sig', 'sig'], named: { damp: 'num' } },
  shape: { kind: 'proc', pos: ['sig'], named: { type: 'enum' } },
  formant: { kind: 'proc', pos: ['sig'] },
  pan: { kind: 'proc', pos: ['sig'] },
  bitcrush: { kind: 'proc', pos: [], named: { bits: 'num', downsample: 'num' } },
  // `key` is an EXTERNAL SIDECHAIN: the detector listens to that signal rather
  // than to the input, so what gets turned down and what decides when are
  // separate. A signal, so it can be any node or binding in the synth.
  compress: {
    kind: 'proc', pos: [],
    named: { threshold: 'num', ratio: 'num', attack: 'num', release: 'num', knee: 'num', makeup: 'num', key: 'sig' },
  },
  // rate/depth/feedback/mix are SIGNALS (per-sample inputs); `stages` sizes
  // the allpass array, so it stays a construction number
  phaser: { kind: 'proc', pos: [], named: { rate: 'sig', depth: 'sig', feedback: 'sig', stages: 'num', mix: 'sig' } },
  reverb: { kind: 'proc', pos: [], named: { room: 'num', damp: 'num', mix: 'sig' }, alias: { room: 'roomSize' } },
  chorus: { kind: 'proc', pos: [], named: { rate: 'sig', depth: 'sig', mix: 'sig' } },
  // pseudo-stereo widener — the positional is `amount` 0..1 (`width .8 mode:tight`)
  width: { kind: 'proc', pos: ['sig'], posDefault: ['0.5'], named: { mode: 'enum' } },
  transient: { kind: 'proc', pos: [], named: { attack: 'num', sustain: 'num' } },
  // the live-mic node: turns QUIET things down (bleed, hiss), the opposite
  // problem to compress. hold + hysteresis are what stop it chattering.
  limiter: {
    kind: 'proc',
    pos: [],
    named: { ceiling: 'num', lookahead: 'num', release: 'num' },
  },
  deess: {
    kind: 'proc',
    pos: [],
    named: { freq: 'num', threshold: 'num', ratio: 'num', attack: 'num', release: 'num' },
  },
  tape: { kind: 'proc', pos: [], named: { wow: 'num', flutter: 'num', sat: 'num', tone: 'num' } },
  convolve: { kind: 'proc', pos: ['enum'], named: { mix: 'sig' } },
  pitchshift: { kind: 'proc', pos: [], named: { semitones: 'sig', window: 'num', mix: 'sig' } },
  follow: { kind: 'proc', pos: [], named: { attack: 'num', release: 'num', mode: 'enum' } },
  noisegate: {
    kind: 'proc',
    pos: [],
    named: { threshold: 'num', range: 'num', attack: 'num', hold: 'num', release: 'num', hysteresis: 'num' },
  },
  flanger: { kind: 'proc', pos: [], named: { rate: 'sig', depth: 'sig', feedback: 'sig', mix: 'sig' } },
  // LOOP PEDAL on the running signal: the positional is the RECORD gate
  // (`looper rec` with `rec = knob 0 0..1`) — the first press defines the
  // loop length, later presses overdub onto it. feedback < 1 fades old
  // layers per overdub pass; a rising edge on clear: wipes the loop.
  looper: {
    kind: 'proc',
    pos: ['sig'],
    posDefault: ['0'],
    named: { feedback: 'sig', mix: 'sig', clear: 'sig', maxtime: 'num', name: 'enum' },
    alias: { maxtime: 'maxTime' },
  },
  exciter: { kind: 'proc', pos: [], named: { freq: 'num', amount: 'num', drive: 'num' } },
  ott: { kind: 'proc', pos: [], named: { depth: 'num', low: 'num', high: 'num', makeup: 'num' } },
  // parametric EQ — bands are special-parsed word-then-numbers groups:
  // `eq hp 170 highshelf 7000 4` / `eq peak 300 -3 2` (freq gain q)
  eq: { kind: 'proc', pos: [] },
  // pipe = carrier, positional = modulator: `vocoder vox bands:20`
  vocoder: { kind: 'proc', pos: ['sig'], named: { bands: 'num', low: 'num', high: 'num', q: 'num', response: 'num' } },

  // ---- Sig methods on the running signal ----
  tanh: { kind: 'sigop', pos: [] },
  fold: { kind: 'sigop', pos: [] },
  clip: { kind: 'sigop', pos: ['sig', 'sig'] },
  mix: { kind: 'sigop', pos: ['sig', 'sig'] },
  // ---- elementary math (Sig methods, same shape as tanh/fold) ----
  abs: { kind: 'sigop', pos: [] },
  floor: { kind: 'sigop', pos: [] },
  ceil: { kind: 'sigop', pos: [] },
  round: { kind: 'sigop', pos: [] },
  sign: { kind: 'sigop', pos: [] },
  sqrt: { kind: 'sigop', pos: [] },
  exp: { kind: 'sigop', pos: [] },
  log: { kind: 'sigop', pos: [] },
  sin: { kind: 'sigop', pos: [] },
  cos: { kind: 'sigop', pos: [] },
  min: { kind: 'sigop', pos: ['sig'] },
  max: { kind: 'sigop', pos: ['sig'] },
  mod: { kind: 'sigop', pos: ['sig'] },
}

/** Names usable at the head of a spine transform line (input = the pipe). */
export const isTransform = (name: string): boolean => {
  const s = BUILTINS[name]
  return s !== undefined && (s.kind === 'proc' || s.kind === 'sigop')
}

/** Names a chain binding may NOT take — the special refs the grammar itself
 *  leans on (a binding named `adsr` or `note` is unusable). Registry builtin
 *  names (lfo, delay, …) ARE allowed as bindings; codegen errors only if the
 *  same chain also calls the builtin (the one case that truly collides).
 *  The parser errors on these; the decompiler refuses to emit them (bailing
 *  the synth to a js block instead). */
export const isReservedBinding = (name: string): boolean =>
  name === 'note' || name === 'gate' || name === 'input' || name === 'velocity' ||
  name === 'adsr' || name === 'knob' || name === 'switch' ||
  // `sum k 1..16` opens a block, so a binding of that name would make the
  // line ambiguous to a reader even where the parser can tell them apart.
  // The decompiler reads this list when it invents names, so it stops
  // generating `sum` the moment the word means something.
  name === 'sum'

/* ------------------------------------------------------------------------- *
 * NAMES A SYNTH CANNOT TAKE.
 *
 * `synth lead` compiles to `const lead = synth(…)` in a scope where the
 * pattern functions already live. So `synth note` compiles to
 * `const note = …` next to the existing `note`, and the program dies with a
 * raw `Identifier 'note' has already been declared` — no line, no column, no
 * mention of the word that caused it. Measured: `p`, `n`, `note`, `sound`,
 * `chord`, `synth`, `bus`, `stack` and `sine` all did this, and `synth note`
 * is a thing anyone would type.
 *
 * DUPLICATED ON PURPOSE, AND PROVEN. The authority is `baseScope` +
 * `STAGING_NAMES` in packages/app, which rondo cannot import — app depends on
 * rondo, not the reverse. So this is a copy, and reserved-names.test.ts fails
 * the moment app adds a scope name that is not here. A copy that is checked is
 * a cache; a copy that is not is the bug this repo keeps finding.
 * ------------------------------------------------------------------------- */
export const RESERVED_TOP_LEVEL: ReadonlySet<string> = new Set([
  'arrange', 'bus', 'cat', 'chord', 'cosine', 'curve', 'curvedef',
  'defineScale', 'defineSynth', 'defineWavetable', 'fall', 'fastcat',
  'irand', 'isaw', 'm', 'macro', 'macroNum', 'macroval', 'masterCompress',
  'masterGain', 'mini', 'n', 'note', 'p', 'perlin', 'pick', 'rand', 'reify',
  'rise', 's', 'saw', 'saw2', 'setBpm', 'setCps', 'setTimeSig', 'shape',
  'sidechain', 'silence', 'sine', 'sine2', 'sing', 'slider', 'sound',
  'square', 'square2', 'stack', 'stereo', 'synth', 'timecat', 'toggle',
  'tri', 'tri2', 'visual', 'xy',
])
