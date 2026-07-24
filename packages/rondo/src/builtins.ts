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
  wavetable: { kind: 'osc', pos: ['sig', 'sig'], freqDefault: true, named: { table: 'enum' } },
  supersaw: { kind: 'osc', pos: ['sig'], freqDefault: true, named: { detune: 'sig', mix: 'sig' } },
  noise: { kind: 'osc', pos: ['enum'] },
  lfsr: { kind: 'osc', pos: ['sig'], freqDefault: true, named: { mode: 'enum' } },
  lfo: { kind: 'osc', pos: ['sig', 'enum'] },

  // ---- gated sources (samplers, physical models) ----
  sample: { kind: 'gated', pos: ['enum'], named: { root: 'num', speed: 'sig', loop: 'bool' } },
  granular: {
    kind: 'gated', pos: ['enum'],
    named: { pos: 'sig', root: 'num', rate: 'sig', size: 'num', density: 'num', spray: 'num', loop: 'bool' },
  },
  pluck: { kind: 'gated', pos: ['sig'], freqDefault: true, named: { decay: 'num', damp: 'num', seed: 'num' } },
  modal: { kind: 'gated', pos: ['sig'], freqDefault: true, named: { model: 'enum', decay: 'num', damp: 'num' } },

  // ---- processors (running signal first) ----
  ladder: { kind: 'proc', pos: ['sig'], named: { res: 'sig' }, defaults: { res: '0.5' } },
  svf: { kind: 'proc', pos: ['sig'], named: { res: 'sig', mode: 'enum' } },
  onepole: { kind: 'proc', pos: ['sig'] },
  delay: { kind: 'proc', pos: ['sig', 'sig'], named: { maxtime: 'num' }, alias: { maxtime: 'maxTime' } },
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
  exciter: { kind: 'proc', pos: [], named: { freq: 'num', amount: 'num', drive: 'num' } },
  ott: { kind: 'proc', pos: [], named: { depth: 'num', low: 'num', high: 'num', makeup: 'num' } },

  // ---- Sig methods on the running signal ----
  tanh: { kind: 'sigop', pos: [] },
  fold: { kind: 'sigop', pos: [] },
  clip: { kind: 'sigop', pos: ['sig', 'sig'] },
  mix: { kind: 'sigop', pos: ['sig', 'sig'] },
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
