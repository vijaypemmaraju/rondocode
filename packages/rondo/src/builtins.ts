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
  mic: { kind: 'osc', pos: [] },

  // ---- gated sources (samplers, physical models) ----
  // start/end window the buffer (fractions 0..1), slices chops that window and
  // the NOTE picks a chop, reverse plays it backwards, fade softens the edges
  sample: {
    kind: 'gated', pos: ['enum'],
    named: {
      root: 'num', speed: 'sig', loop: 'bool',
      start: 'num', end: 'num', reverse: 'bool', slices: 'num', fade: 'num',
    },
  },
  granular: {
    kind: 'gated', pos: ['enum'],
    named: { pos: 'sig', root: 'num', rate: 'sig', size: 'num', density: 'num', spray: 'num', loop: 'bool' },
  },
  pluck: { kind: 'gated', pos: ['sig'], freqDefault: true, named: { decay: 'num', damp: 'num', seed: 'num' } },
  modal: { kind: 'gated', pos: ['sig'], freqDefault: true, named: { model: 'enum', decay: 'num', damp: 'num' } },
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
  delay: { kind: 'proc', pos: ['sig', 'sig'], named: { maxtime: 'num', sync: 'bool' }, alias: { maxtime: 'maxTime' } },
  comb: { kind: 'proc', pos: ['sig', 'sig'], named: { damp: 'num' } },
  shape: { kind: 'proc', pos: ['sig'], named: { type: 'enum' } },
  formant: { kind: 'proc', pos: ['sig'] },
  pan: { kind: 'proc', pos: ['sig'] },
  bitcrush: { kind: 'proc', pos: [], named: { bits: 'num', downsample: 'num' } },
  compress: {
    kind: 'proc', pos: [],
    named: { threshold: 'num', ratio: 'num', attack: 'num', release: 'num', knee: 'num', makeup: 'num' },
  },
  phaser: { kind: 'proc', pos: [], named: { rate: 'num', depth: 'num', feedback: 'num', stages: 'num', mix: 'num' } },
  reverb: { kind: 'proc', pos: [], named: { room: 'num', damp: 'num', mix: 'sig' }, alias: { room: 'roomSize' } },
  chorus: { kind: 'proc', pos: [], named: { rate: 'num', depth: 'num', mix: 'num' } },
  // pseudo-stereo widener — the positional is `amount` 0..1 (`width .8 mode:tight`)
  width: { kind: 'proc', pos: ['sig'], posDefault: ['0.5'], named: { mode: 'enum' } },
  transient: { kind: 'proc', pos: [], named: { attack: 'num', sustain: 'num' } },
  flanger: { kind: 'proc', pos: [], named: { rate: 'num', depth: 'num', feedback: 'num', mix: 'num' } },
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
  name === 'adsr' || name === 'knob'
