import { GraphError, validateGraph } from './graph'
import type { GraphSpec, InputSource, NodeSpec, NodeType, ParamSpec } from './graph'
import { compileGraph, compilePost } from './compile'
import type { VoiceOpts } from './voice'

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
  param(name: string, def: number, opts?: { min?: number; max?: number; curve?: 'lin' | 'log' }): Sig
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
   *  ('basic' | 'harmonic' | 'pwm', default 'basic'). Band-limited via mipmaps,
   *  so it stays clean at high notes. */
  wavetable(freq: SigIn, pos?: SigIn, opts?: { table?: string }): Sig
  noise(): Sig
  /** Play a loaded audio sample. `name` is a sample loaded via loadSample. A
   *  rising edge on `gate` retriggers from the start (one-shot); pass
   *  `{ loop: true }` to loop. Pitch: `{ root }` plays at natural pitch when the
   *  note equals that MIDI root and tracks the note otherwise; `{ speed }` sets
   *  an explicit rate multiplier (overrides root). No root/speed → natural rate
   *  (drums). Output is mono — shape amplitude with an ADSR like an oscillator.
   *  Unknown/not-yet-loaded name → silence. */
  sample(gate: SigIn, name: string, opts?: { root?: number; speed?: SigIn; loop?: boolean }): Sig
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
  modal(gate: SigIn, freq: SigIn, opts?: { model?: 'bell' | 'bar' | 'drum' | 'glass'; decay?: number; damp?: number }): Sig
  svf(inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn; mode?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' }): Sig
  ladder(inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn }): Sig
  onepole(inp: SigIn, cutoff: SigIn): Sig
  adsr(gate: SigIn, opts?: { a?: number; d?: number; s?: number; r?: number }): Sig
  /** Multi-segment (breakpoint) envelope — the flexible cousin of adsr.
   *  `points` are [timeSec, level] pairs: while the gate is held it ramps
   *  through them in order (each from the previous level), then HOLDS the last
   *  level, or with `loop` repeats them (a function generator). Gate-off
   *  releases from the current level to 0 over `release` (def 0.1 s). `curve`
   *  (def 0) shapes every segment: > 0 fast-then-slow, < 0 slow-then-fast.
   *  Levels are not clamped, so it drives amplitude, pitch or any modulation. */
  env(gate: SigIn, points: [number, number][], opts?: { release?: number; curve?: number; loop?: boolean }): Sig
  lfo(freq: SigIn, shape?: 'sine' | 'tri' | 'square' | 'saw' | 'rand'): Sig
  delay(inp: SigIn, time: SigIn, feedback?: SigIn, opts?: { maxTime?: number }): Sig
  /** Freeverb-style algorithmic reverb. Output is WET only — mix it back with
   *  the dry signal (e.g. `tone.mix(reverb(tone), 0.3)`). roomSize/damp are
   *  0..1 and are fixed at build time (not per-sample). */
  reverb(inp: SigIn, opts?: { roomSize?: number; damp?: number }): Sig
  /** Three-voice modulated-delay ensemble — thickens and widens. Runs mono per
   *  call; stereo width comes from the post-chain running it twice (L/R). */
  chorus(inp: SigIn, opts?: { rate?: number; depth?: number; mix?: number }): Sig
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
  pan(inp: SigIn, pos: SigIn): Sig
  mix(a: SigIn, b: SigIn, t: SigIn): Sig
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
  param(name: string, def: number, opts?: { min?: number; max?: number; curve?: 'lin' | 'log' }): Sig
  svf(inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn; mode?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' }): Sig
  ladder(inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn }): Sig
  onepole(inp: SigIn, cutoff: SigIn): Sig
  lfo(freq: SigIn, shape?: 'sine' | 'tri' | 'square' | 'saw' | 'rand'): Sig
  delay(inp: SigIn, time: SigIn, feedback?: SigIn, opts?: { maxTime?: number }): Sig
  reverb(inp: SigIn, opts?: { roomSize?: number; damp?: number }): Sig
  chorus(inp: SigIn, opts?: { rate?: number; depth?: number; mix?: number }): Sig
  comb(inp: SigIn, freq: SigIn, feedback?: SigIn, opts?: { damp?: number }): Sig
  bitcrush(inp: SigIn, opts?: { bits?: number; downsample?: number }): Sig
  shape(inp: SigIn, drive?: SigIn, opts?: { type?: 'soft' | 'hard' | 'sine' | 'tube' }): Sig
  /** Feed-forward peak compressor — glue/punch/control. threshold (dB, def
   *  -18), ratio (def 4), attack/release (ms, def 10/120), knee (dB, def 6),
   *  makeup (dB, def 0). For PARALLEL compression mix the dry back:
   *  `input.mix(compress(input, { ratio: 10 }), 0.5)`. */
  compress(inp: SigIn, opts?: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number }): Sig
  mix(a: SigIn, b: SigIn, t: SigIn): Sig
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
  /** Normalized voice-allocation options (mono/glide/unison/detune/spread).
   *  ABSENT when synth() was called with no opts — the pool then takes its
   *  neutral defaults (poly, unison 1), preserving pre-feature behavior. */
  voiceOpts?: VoiceOpts
  /** Voice-pool size (max simultaneous notes) from opts.voices; ABSENT when
   *  unset (the engine then uses its default 8). */
  maxVoices?: number
}

/** Normalize + clamp user VoiceOptsInput into a full VoiceOpts. */
const normalizeVoiceOpts = (o: VoiceOptsInput): VoiceOpts => {
  const num = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def)
  return {
    mono: o.mono === true,
    glide: Math.max(0, num(o.glide, 0)),
    unison: Math.floor(Math.min(9, Math.max(1, num(o.unison, 1)))),
    detune: Math.max(0, num(o.detune, 15)),
    spread: Math.min(1, Math.max(0, num(o.spread, 0.6))),
  }
}

/** The builder whose synth() build function is currently executing. Node
 *  creation on any other builder (a leaked Sig or ctx) is an error. */
let activeBuilder: Builder | null = null

class Builder {
  readonly nodes: NodeSpec[] = []
  readonly params: ParamSpec[] = []
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
    param: (name: string, def: number, opts?: { min?: number; max?: number; curve?: 'lin' | 'log' }): Sig => {
      if (b.params.some((p) => p.name === name)) {
        throw new GraphError(`duplicate param name '${name}' in synth()`)
      }
      if (def < 0 && opts?.min === undefined) {
        throw new GraphError(
          `param '${name}': negative default (${def}) requires an explicit min (omitted min defaults to 0)`,
        )
      }
      const spec: ParamSpec = {
        name,
        default: def,
        min: opts?.min ?? 0,
        max: opts?.max ?? (def > 0 ? def * 4 : 1),
      }
      if (opts?.curve !== undefined) spec.curve = opts.curve
      b.params.push(spec)
      return b.node('param', {}, { name })
    },
    svf: (inp: SigIn, cutoff: SigIn, opts?: { res?: SigIn; mode?: 'lp' | 'hp' | 'bp' | 'notch' | 'peak' }): Sig => {
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
    lfo: (freq: SigIn, shape?: 'sine' | 'tri' | 'square' | 'saw' | 'rand'): Sig =>
      b.node('lfo', { freq: src(freq, 'lfo freq') }, definedConfig({ shape })),
    delay: (inp: SigIn, time: SigIn, feedback?: SigIn, opts?: { maxTime?: number }): Sig => {
      const inputs: Record<string, InputSource> = {
        in: src(inp, 'delay in'),
        time: src(time, 'delay time'),
      }
      if (feedback !== undefined) inputs['feedback'] = src(feedback, 'delay feedback')
      return b.node('delay', inputs, { maxTime: opts?.maxTime ?? 0.5 })
    },
    reverb: (inp: SigIn, opts?: { roomSize?: number; damp?: number }): Sig =>
      b.node(
        'reverb',
        { in: src(inp, 'reverb in') },
        definedConfig({ roomSize: opts?.roomSize, damp: opts?.damp }),
      ),
    chorus: (inp: SigIn, opts?: { rate?: number; depth?: number; mix?: number }): Sig =>
      b.node(
        'chorus',
        { in: src(inp, 'chorus in') },
        definedConfig({ rate: opts?.rate, depth: opts?.depth, mix: opts?.mix }),
      ),
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
    mix: (a: SigIn, bb: SigIn, t: SigIn): Sig =>
      b.node('mix', { a: src(a, 'mix a'), b: src(bb, 'mix b'), t: src(t, 'mix t') }),
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
    lfo: shared.lfo,
    delay: shared.delay,
    reverb: shared.reverb,
    chorus: shared.chorus,
    comb: shared.comb,
    bitcrush: shared.bitcrush,
    shape: shared.shape,
    compress: shared.compress,
    mix: shared.mix,

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
      return b.node('wavetable', inputs, definedConfig({ table: opts?.table }))
    },
    noise: () => b.node('noise', {}),

    sample: (gate, name, opts) => {
      const inputs: Record<string, InputSource> = { gate: src(gate, 'sample gate') }
      // Pitch: explicit speed wins; else root -> track note.freq / freq(root);
      // else natural rate (no speed input, kernel treats as 1).
      let speed: SigIn | undefined = opts?.speed
      if (speed === undefined && opts?.root !== undefined) {
        const rootFreq = 440 * Math.pow(2, (opts.root - 69) / 12)
        speed = noteFreq.div(rootFreq)
      }
      if (speed !== undefined) inputs['speed'] = src(speed, 'sample speed')
      return b.node('sample', inputs, definedConfig({ name, loop: opts?.loop }))
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
        definedConfig({ model: opts?.model, decay: opts?.decay, damp: opts?.damp }),
      ),

    adsr: (gate, opts) =>
      b.node(
        'adsr',
        { gate: src(gate, 'adsr gate') },
        definedConfig({ a: opts?.a, d: opts?.d, s: opts?.s, r: opts?.r }),
      ),

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
): GraphSpec => {
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
  return graph
}

const returnsOwnSig = (result: unknown, b: Builder): boolean =>
  result instanceof SigImpl && result.builder === b

/** Define a synth. `voiceFn` wires the PER-VOICE sound (SynthCtx). The optional
 *  `postFn` wires a PER-SYNTH FX chain (PostCtx) that processes the SUMMED
 *  voices ONCE — shared reverb/delay/EQ instead of one-per-note. `opts` sets
 *  voice-allocation modes (mono/glide/unison/detune/spread); it may be passed
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

  const graph = buildGraph(makeCtx, returnsOwnSig, voiceFn, (g) => {
    compileGraph(g, { sampleRate: 48000 }) // validation pass; graphs are tiny
  })
  const def: SynthDef = { graph }
  if (postFn !== undefined) {
    def.post = buildGraph(makePostCtx, returnsOwnSig, postFn, (g) => {
      compilePost(g, { sampleRate: 48000 })
    })
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
  return buildGraph(makePostCtx, returnsOwnSig, fxFn, (g) => {
    compilePost(g, { sampleRate: 48000 })
  })
}
