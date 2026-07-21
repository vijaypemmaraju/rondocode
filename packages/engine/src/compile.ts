import { GraphError, validateGraph } from './graph'
import type { GraphSpec, NodeSpec, NodeType, ParamSpec } from './graph'
import type { DspContext, Kernel } from './dsp/types'
import { SineKernel, SawKernel, SquareKernel, TriKernel, PulseKernel, NoiseKernel, SyncSawKernel, FMKernel, SuperSawKernel, LFSRKernel } from './dsp/osc'
import { PhaserKernel, FormantKernel } from './dsp/fx2'
import type { PhaserConfig } from './dsp/fx2'
import { VocoderKernel } from './dsp/vocoder'
import type { VocoderConfig } from './dsp/vocoder'
import { WavetableKernel } from './dsp/wavetable'
import { SvfKernel, LadderKernel, OnePoleKernel } from './dsp/filters'
import type { SvfMode } from './dsp/filters'
import { AdsrKernel, EnvKernel } from './dsp/env'
import type { EnvConfig } from './dsp/env'
import type { AdsrConfig } from './dsp/env'
import { LfoKernel } from './dsp/lfo'
import type { LfoShape } from './dsp/lfo'
import {
  MulKernel, AddKernel, SubKernel, DivKernel, PowKernel,
  ClipKernel, FoldKernel, TanhKernel, MixKernel,
} from './dsp/math'
import { DelayKernel } from './dsp/delay'
import type { DelayConfig } from './dsp/delay'
import { ReverbKernel } from './dsp/reverb'
import { ChorusKernel } from './dsp/chorus'
import type { ChorusConfig } from './dsp/chorus'
import { CombKernel } from './dsp/comb'
import type { CombConfig } from './dsp/comb'
import { BitcrushKernel } from './dsp/bitcrush'
import type { BitcrushConfig } from './dsp/bitcrush'
import { ShapeKernel } from './dsp/shape'
import type { ShapeType } from './dsp/shape'
import { SampleKernel } from './dsp/sample'
import { GranularKernel } from './dsp/granular'
import { PluckKernel, ModalKernel } from './dsp/physical'
import type { PluckConfig, ModalConfig } from './dsp/physical'
import type { GranularConfig } from './dsp/granular'
import { CompressKernel } from './dsp/compress'
import type { CompressConfig } from './dsp/compress'

/** Samples per processing block. All node buffers are this long; Voice.process
 *  may render any n <= BLOCK. */
export const BLOCK = 128

/* ------------------------------------------------------------------------- *
 * Stereo contract (v1)
 *
 * Kernels are mono. A voice produces stereo via AT MOST ONE `pan` node, and
 * that pan must be the terminal out-feeding node (the node `out` consumes, or
 * the node `spec.out` points at directly). The compiler special-cases pan —
 * it is not a kernel: the voice reads pan's resolved `in` and `pos` buffers
 * and applies equal-power panning while summing into the stereo bus:
 *
 *   pos clamped to [0, 1];  0 = hard left, 0.5 = center, 1 = hard right
 *   L = in * cos(pos * pi/2),  R = in * sin(pos * pi/2)
 *
 * With no pan node, the mono terminal is centered at equal power:
 * L = R = in * 0.7071 (cos(pi/4)). A pan anywhere else in the graph, or more
 * than one pan, is a GraphError.
 *
 * Delay semantics: edges INTO a delay node's `in` port are excluded from the
 * topological order (that is what makes feedback loops legal). The delay's
 * `in` input still references the producer's output buffer — buffers persist
 * across blocks, the process order just doesn't guarantee freshness — so when
 * the producer is downstream of the delay in a loop, the delay reads the
 * producer's PREVIOUS block. Feedback through a delay therefore carries one
 * block (BLOCK samples) of extra latency on top of the delay time.
 *
 * One honest exception to that contract: the degenerate self-loop
 * `delay.in <- delay` resolves the delay's input to its OWN output buffer, and
 * DelayKernel writes out[i] before reading input[i], so within the shared
 * buffer each sample reads the CURRENT block's freshly written output — zero
 * blocks of latency, not one. The result is bounded (the delay's soft knee
 * still applies) and harmless, just off-contract for this one shape.
 *
 * Delays are per-voice by design (short feedback-loop synthesis, e.g.
 * Karplus-Strong flavors). Echo/reverb-style delays belong in the future
 * per-synth post-chain, not inside a voice graph (see plan doc, Task 1.6/1.9).
 * ------------------------------------------------------------------------- */

/** One kernel-backed node, ready to run: kernel instance, resolved input
 *  buffers, and its output buffer. Everything is prebuilt at compile time —
 *  running a step allocates nothing. */
export interface CompiledStep {
  /** NodeSpec id, for debugging/tests. */
  id: number
  kernel: Kernel
  inputs: Record<string, Float32Array>
  out: Float32Array
}

export interface CompiledParam {
  spec: ParamSpec
  /** Voice-owned buffer read by `param` nodes; filled with a new value on
   *  Voice.setParam. Pre-filled with the spec default at compile. */
  buf: Float32Array
}

/** A fully instantiated, single-voice runnable graph: kernel instances are
 *  stateful, so one CompiledGraph belongs to exactly one Voice. Compile once
 *  per voice (VoicePool does this). */
export interface CompiledGraph {
  /** Kernel steps in topological order (delay `in` edges excluded — see
   *  header comment on feedback latency). */
  steps: CompiledStep[]
  /** Voice-state buffers, filled by the Voice on noteOn/noteOff. */
  noteFreq: Float32Array
  gate: Float32Array
  /** Note velocity, 0..1. Available to the graph for TIMBRE only — amplitude
   *  is auto-scaled by velocity in Voice.process(), so consuming this buffer
   *  to multiply the output double-applies velocity. */
  velocity: Float32Array
  /** Param name -> spec + voice-owned buffer. */
  params: Map<string, CompiledParam>
  /** Buffer feeding the stereo stage: pan's `in` if a pan node is terminal,
   *  else the mono terminal's output buffer. */
  panIn: Float32Array
  /** Pan position buffer, or null for equal-power center. */
  panPos: Float32Array | null
}

/** Input port table per node type. `def` present = optional with that
 *  constant default; absent = required (missing -> GraphError). Derived from
 *  the kernel process() contracts in dsp/*.ts. */
const PORTS: Record<NodeType, { name: string; def?: number }[]> = {
  sine: [{ name: 'freq' }],
  saw: [{ name: 'freq' }],
  square: [{ name: 'freq' }],
  tri: [{ name: 'freq' }],
  pulse: [{ name: 'freq' }, { name: 'width', def: 0.5 }],
  syncsaw: [{ name: 'freq' }, { name: 'ratio', def: 2 }],
  fm: [{ name: 'freq' }, { name: 'mod', def: 0 }, { name: 'feedback', def: 0 }],
  supersaw: [{ name: 'freq' }, { name: 'detune', def: 0.2 }, { name: 'mix', def: 0.7 }],
  lfsr: [{ name: 'freq', def: 4000 }],
  wavetable: [{ name: 'freq' }, { name: 'pos', def: 0 }],
  noise: [],
  // gate required (retrigger edge); speed optional, 1 = natural pitch.
  sample: [{ name: 'gate' }, { name: 'speed', def: 1 }],
  // gate spawns grains; pos scans the buffer 0..1; rate is the pitch.
  granular: [{ name: 'gate' }, { name: 'pos', def: 0 }, { name: 'rate', def: 1 }],
  pluck: [{ name: 'gate' }, { name: 'freq', def: 220 }],
  modal: [{ name: 'gate' }, { name: 'freq', def: 220 }],
  svf: [{ name: 'in' }, { name: 'cutoff' }, { name: 'res', def: 0 }],
  ladder: [{ name: 'in' }, { name: 'cutoff' }, { name: 'res', def: 0 }],
  onepole: [{ name: 'in' }, { name: 'cutoff' }],
  adsr: [{ name: 'gate' }],
  env: [{ name: 'gate' }],
  lfo: [{ name: 'freq' }],
  mul: [{ name: 'a' }, { name: 'b' }],
  add: [{ name: 'a' }, { name: 'b' }],
  sub: [{ name: 'a' }, { name: 'b' }],
  div: [{ name: 'a' }, { name: 'b' }],
  pow: [{ name: 'a' }, { name: 'b' }],
  clip: [{ name: 'in' }, { name: 'lo', def: -1 }, { name: 'hi', def: 1 }],
  fold: [{ name: 'in' }],
  tanh: [{ name: 'in' }],
  mix: [{ name: 'a' }, { name: 'b' }, { name: 't', def: 0.5 }],
  delay: [{ name: 'in' }, { name: 'time', def: 0.25 }, { name: 'feedback', def: 0 }],
  reverb: [{ name: 'in' }],
  chorus: [{ name: 'in' }],
  comb: [{ name: 'in' }, { name: 'freq', def: 220 }, { name: 'feedback', def: 0.5 }],
  bitcrush: [{ name: 'in' }],
  shape: [{ name: 'in' }, { name: 'drive', def: 1 }],
  compress: [{ name: 'in' }],
  phaser: [{ name: 'in' }],
  formant: [{ name: 'in' }, { name: 'morph', def: 0 }],
  vocoder: [{ name: 'carrier' }, { name: 'modulator' }],
  pan: [{ name: 'in' }, { name: 'pos', def: 0.5 }],
  const: [],
  param: [],
  notefreq: [],
  gate: [],
  velocity: [],
  businput: [],
  out: [{ name: 'in' }],
}

/** Graph node types the compiler maps to kernel instances. Everything else
 *  (const/param/notefreq/gate/velocity/out/pan) is resolved to buffers by the
 *  compiler itself. */
const REGISTRY: Partial<Record<NodeType, (config: Record<string, unknown>, ctx: DspContext) => Kernel>> = {
  sine: () => new SineKernel(),
  saw: () => new SawKernel(),
  square: () => new SquareKernel(),
  tri: () => new TriKernel(),
  pulse: () => new PulseKernel(),
  syncsaw: () => new SyncSawKernel(),
  fm: (c) => new FMKernel(typeof c['wave'] === 'string' ? c['wave'] : undefined),
  // ctx carries the sample rate the kernel needs for mipmap selection; the
  // table's harmonic content is sample-rate-independent and cached module-level
  wavetable: (c, ctx) => new WavetableKernel(typeof c['table'] === 'string' ? c['table'] : undefined, ctx),
  noise: (c) => new NoiseKernel(typeof c['seed'] === 'number' ? c['seed'] : undefined, typeof c['color'] === 'string' ? c['color'] : undefined),
  supersaw: () => new SuperSawKernel(),
  lfsr: (c) => new LFSRKernel(typeof c['mode'] === 'string' ? c['mode'] : undefined),
  // ctx carries the shared sample bank the kernel resolves `name` against each
  // block (so samples loaded after compile still play).
  sample: (c, ctx) => new SampleKernel(String(c['name'] ?? ''), c['loop'] === true, ctx.samples),
  granular: (c, ctx) => new GranularKernel(String(c['name'] ?? ''), granularCfg(c), ctx.samples),
  // ctx sizes the delay line to the lowest note at the engine rate up front
  pluck: (c, ctx) => new PluckKernel(c as PluckConfig, ctx),
  modal: (c, ctx) => new ModalKernel(c as ModalConfig, ctx),
  svf: (c) => new SvfKernel((c['mode'] as SvfMode | undefined) ?? 'lp'),
  ladder: () => new LadderKernel(),
  onepole: () => new OnePoleKernel(),
  adsr: (c) => new AdsrKernel(c as AdsrConfig),
  env: (c) => new EnvKernel(c as unknown as EnvConfig),
  lfo: (c) => new LfoKernel((c['shape'] as LfoShape | undefined) ?? 'sine'),
  mul: () => new MulKernel(),
  add: () => new AddKernel(),
  sub: () => new SubKernel(),
  div: () => new DivKernel(),
  pow: () => new PowKernel(),
  clip: () => new ClipKernel(),
  fold: () => new FoldKernel(),
  tanh: () => new TanhKernel(),
  mix: () => new MixKernel(),
  // ctx makes the delay allocate its ring buffer NOW, not on the audio thread
  delay: (c, ctx) => new DelayKernel(c as DelayConfig, ctx),
  // ctx makes reverb allocate its comb/allpass buffers NOW, not on the audio
  // thread; only forward config keys that are present (kernel defaults otherwise)
  reverb: (c, ctx) => new ReverbKernel(num(c['roomSize'], c['damp']), ctx),
  // ctx makes chorus/comb allocate their ring buffers NOW, not on the audio
  // thread; only forward config keys that are present (kernel defaults otherwise)
  chorus: (c, ctx) => new ChorusKernel(chorusCfg(c), ctx),
  comb: (c, ctx) => new CombKernel(typeof c['damp'] === 'number' ? { damp: c['damp'] } : {}, ctx),
  bitcrush: (c) => new BitcrushKernel(bitcrushCfg(c)),
  shape: (c) => new ShapeKernel((c['type'] as ShapeType | undefined) ?? 'soft'),
  compress: (c) => new CompressKernel(compressCfg(c)),
  phaser: (c) => new PhaserKernel(c as PhaserConfig),
  formant: () => new FormantKernel(),
  vocoder: (c, ctx) => new VocoderKernel(c as VocoderConfig, ctx),
}

/** Build a { roomSize?, damp? } config, keeping only the numeric entries so the
 *  kernel falls back to its own defaults for anything absent. */
const num = (roomSize: unknown, damp: unknown): { roomSize?: number; damp?: number } => {
  const out: { roomSize?: number; damp?: number } = {}
  if (typeof roomSize === 'number') out.roomSize = roomSize
  if (typeof damp === 'number') out.damp = damp
  return out
}

/** Keep only the numeric entries of a chorus/bitcrush config so the kernel
 *  falls back to its own defaults for anything absent (mirrors num()). */
const chorusCfg = (c: Record<string, unknown>): ChorusConfig => {
  const out: ChorusConfig = {}
  if (typeof c['rate'] === 'number') out.rate = c['rate']
  if (typeof c['depth'] === 'number') out.depth = c['depth']
  if (typeof c['mix'] === 'number') out.mix = c['mix']
  return out
}

const bitcrushCfg = (c: Record<string, unknown>): BitcrushConfig => {
  const out: BitcrushConfig = {}
  if (typeof c['bits'] === 'number') out.bits = c['bits']
  if (typeof c['downsample'] === 'number') out.downsample = c['downsample']
  return out
}

const granularCfg = (c: Record<string, unknown>): GranularConfig => {
  const out: GranularConfig = {}
  for (const k of ['size', 'density', 'spray', 'seed'] as const) {
    if (typeof c[k] === 'number') out[k] = c[k] as number
  }
  if (typeof c['loop'] === 'boolean') out.loop = c['loop']
  return out
}

const compressCfg = (c: Record<string, unknown>): CompressConfig => {
  const out: CompressConfig = {}
  for (const k of ['threshold', 'ratio', 'attack', 'release', 'knee', 'makeup'] as const) {
    if (typeof c[k] === 'number') out[k] = c[k] as number
  }
  return out
}

const validateParams = (params: ParamSpec[]): void => {
  const seen = new Set<string>()
  for (const p of params) {
    if (seen.has(p.name)) throw new GraphError(`duplicate param name '${p.name}'`)
    seen.add(p.name)
    if (!(p.min < p.max)) throw new GraphError(`param '${p.name}': min (${p.min}) must be < max (${p.max})`)
    if (p.default < p.min || p.default > p.max) {
      throw new GraphError(`param '${p.name}': default ${p.default} outside [${p.min}, ${p.max}]`)
    }
    if (p.curve === 'log' && p.min <= 0) {
      throw new GraphError(`param '${p.name}': log curve requires min > 0 (got ${p.min})`)
    }
  }
}

/** A compiled POST graph: the per-synth FX chain that processes the SUMMED
 *  voices (one instance per stereo side — see PostChain). DSP kernels are mono,
 *  so `out` here is MONO (unlike the voice graph's stereo pan stage): the L/R
 *  independence that gives reverb/chorus their stereo width comes from running
 *  TWO of these with separate state, not from the graph. `input` is a
 *  businput-source buffer the caller fills with the mono signal to process
 *  before running `steps`; `out` holds the mono result. */
export interface CompiledPost {
  steps: CompiledStep[]
  params: Map<string, CompiledParam>
  /** businput source buffer — caller writes the mono input here per block. */
  input: Float32Array
  /** Mono result buffer written by the terminal (out-feeding) node. */
  out: Float32Array
}

/** Everything both a voice graph and a post graph need: validated, topo-sorted
 *  kernel steps with every input pre-resolved to a concrete buffer. The two
 *  compile entry points differ only in their OUTPUT stage (voice = stereo pan,
 *  post = mono out) and which source buffers their graphs actually reference
 *  (voice: notefreq/gate/velocity; post: businput -> `input`). */
interface CompiledCore {
  steps: CompiledStep[]
  params: Map<string, CompiledParam>
  nodeOut: Map<number, Float32Array>
  resolve: (src: number | { node: number }) => Float32Array
  byId: Map<number, NodeSpec>
  outNode: NodeSpec
  terminal: NodeSpec | null
  pan: NodeSpec | undefined
  noteFreq: Float32Array
  gate: Float32Array
  velocity: Float32Array
  input: Float32Array
}

function assemble(spec: GraphSpec, ctx: DspContext): CompiledCore {
  validateGraph(spec)
  validateParams(spec.params)

  const byId = new Map<number, NodeSpec>()
  for (const n of spec.nodes) byId.set(n.id, n)
  const paramSpecs = new Map<string, ParamSpec>()
  for (const p of spec.params) paramSpecs.set(p.name, p)

  // --- per-node structural validation --------------------------------------
  const panNodes = spec.nodes.filter((n) => n.type === 'pan')
  if (panNodes.length > 1) throw new GraphError(`at most one pan node allowed (found ${panNodes.length})`)
  for (const n of spec.nodes) {
    const ports = PORTS[n.type]
    if (!ports) throw new GraphError(`node ${n.id}: unknown type '${n.type}'`)
    for (const port of Object.keys(n.inputs)) {
      if (!ports.some((p) => p.name === port)) {
        throw new GraphError(`node ${n.id} (${n.type}): unknown input port '${port}'`)
      }
    }
    for (const p of ports) {
      if (p.def === undefined && n.inputs[p.name] === undefined) {
        throw new GraphError(`node ${n.id} (${n.type}): missing required input '${p.name}'`)
      }
    }
    if (n.type === 'out' && n.id !== spec.out) {
      throw new GraphError(`node ${n.id} (out): must be the graph output node`)
    }
    if (n.type === 'const' && typeof n.config?.['value'] !== 'number') {
      throw new GraphError(`node ${n.id} (const): requires numeric config.value`)
    }
    if (n.type === 'param') {
      const name = n.config?.['name']
      if (typeof name !== 'string') throw new GraphError(`node ${n.id} (param): requires config.name`)
      if (!paramSpecs.has(name)) throw new GraphError(`node ${n.id} (param): '${name}' not declared in spec.params`)
    }
  }

  // --- stereo contract ------------------------------------------------------
  // Terminal producer: what `out` consumes, or spec.out itself if it isn't an
  // 'out'-type node. A pan node must BE the terminal producer (and nothing
  // else may consume it).
  const outNode = byId.get(spec.out)!
  let terminal: NodeSpec | null = outNode
  if (outNode.type === 'out') {
    const src = outNode.inputs['in']!
    terminal = typeof src === 'number' ? null : byId.get(src.node)!
  }
  const pan = panNodes[0]
  if (pan && pan !== terminal) {
    throw new GraphError(
      `node ${pan.id} (pan): must be the terminal out-feeding node — route pan directly into out`,
    )
  }
  for (const n of spec.nodes) {
    for (const [port, src] of Object.entries(n.inputs)) {
      if (typeof src === 'number') continue
      const ref = byId.get(src.node)!
      if (ref.type === 'out') throw new GraphError(`node ${n.id}: cannot consume 'out' node ${ref.id}`)
      if (ref.type === 'pan' && !(n.type === 'out' && port === 'in')) {
        throw new GraphError(`node ${n.id}: pan output may only feed 'out'`)
      }
    }
  }

  // --- buffers --------------------------------------------------------------
  const noteFreq = new Float32Array(BLOCK)
  const gate = new Float32Array(BLOCK)
  const velocity = new Float32Array(BLOCK)
  // businput source buffer (post graphs only; voice graphs never reference it).
  const input = new Float32Array(BLOCK)
  const params = new Map<string, CompiledParam>()
  for (const p of spec.params) {
    params.set(p.name, { spec: p, buf: new Float32Array(BLOCK).fill(p.default) })
  }

  const constPool = new Map<number, Float32Array>()
  const constBuf = (v: number): Float32Array => {
    let b = constPool.get(v)
    if (!b) constPool.set(v, (b = new Float32Array(BLOCK).fill(v)))
    return b
  }

  // Output buffer per node. Kernel nodes get a fresh buffer; source-like
  // specials alias the voice-state/constant buffers; out/pan produce none.
  const nodeOut = new Map<number, Float32Array>()
  for (const n of spec.nodes) {
    switch (n.type) {
      case 'out':
      case 'pan':
        break
      case 'const':
        nodeOut.set(n.id, constBuf(n.config!['value'] as number))
        break
      case 'param':
        nodeOut.set(n.id, params.get(n.config!['name'] as string)!.buf)
        break
      case 'notefreq':
        nodeOut.set(n.id, noteFreq)
        break
      case 'gate':
        nodeOut.set(n.id, gate)
        break
      case 'velocity':
        nodeOut.set(n.id, velocity)
        break
      case 'businput':
        nodeOut.set(n.id, input)
        break
      default:
        nodeOut.set(n.id, new Float32Array(BLOCK))
    }
  }

  const resolve = (src: number | { node: number }): Float32Array => {
    if (typeof src === 'number') return constBuf(src)
    const buf = nodeOut.get(src.node)
    // unreachable after validation (only out/pan lack buffers, and consuming
    // them is rejected above) — kept as a hard failure rather than a silent one
    if (!buf) throw new GraphError(`node ${src.node} has no output buffer`)
    return buf
  }

  // --- topological order (delay `in` edges excluded) ------------------------
  // Kahn's algorithm over all nodes; validateGraph already guarantees the
  // delay-reduced graph is acyclic, so this always completes.
  const indegree = new Map<number, number>()
  const dependents = new Map<number, number[]>()
  for (const n of spec.nodes) indegree.set(n.id, 0)
  for (const n of spec.nodes) {
    for (const [port, src] of Object.entries(n.inputs)) {
      if (typeof src === 'number') continue
      if (n.type === 'delay' && port === 'in') continue
      indegree.set(n.id, indegree.get(n.id)! + 1)
      let d = dependents.get(src.node)
      if (!d) dependents.set(src.node, (d = []))
      d.push(n.id)
    }
  }
  const order: number[] = []
  const queue: number[] = []
  for (const n of spec.nodes) if (indegree.get(n.id) === 0) queue.push(n.id)
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const dep of dependents.get(id) ?? []) {
      const deg = indegree.get(dep)! - 1
      indegree.set(dep, deg)
      if (deg === 0) queue.push(dep)
    }
  }

  // --- kernel steps ---------------------------------------------------------
  const steps: CompiledStep[] = []
  for (const id of order) {
    const n = byId.get(id)!
    const make = REGISTRY[n.type]
    if (!make) continue // specials: buffers already wired / handled below
    const inputs: Record<string, Float32Array> = {}
    for (const p of PORTS[n.type]) {
      const src = n.inputs[p.name]
      inputs[p.name] = src === undefined ? constBuf(p.def!) : resolve(src)
    }
    steps.push({ id: n.id, kernel: make(n.config ?? {}, ctx), inputs, out: nodeOut.get(n.id)! })
  }

  return { steps, params, nodeOut, resolve, byId, outNode, terminal, pan, noteFreq, gate, velocity, input }
}

/** Compile a validated GraphSpec into a runnable single-voice graph: validate
 *  params/ports/stereo contract, topo-sort (delay `in` edges excluded),
 *  instantiate kernels, and pre-resolve every input to a concrete buffer so
 *  the per-block process path allocates nothing. */
export function compileGraph(spec: GraphSpec, ctx: DspContext): CompiledGraph {
  const c = assemble(spec, ctx)
  const { outNode, terminal, pan, resolve, nodeOut } = c

  // --- stereo stage ---------------------------------------------------------
  let panIn: Float32Array
  let panPos: Float32Array | null
  if (pan) {
    panIn = resolve(pan.inputs['in']!)
    const posSrc = pan.inputs['pos']
    panPos = resolve(posSrc ?? 0.5) // resolve() pools numeric constants
  } else if (terminal) {
    panIn = nodeOut.get(terminal.id)!
    panPos = null
  } else {
    // out consumes a bare constant — degenerate but legal
    panIn = resolve(outNode.inputs['in']!)
    panPos = null
  }

  return { steps: c.steps, noteFreq: c.noteFreq, gate: c.gate, velocity: c.velocity, params: c.params, panIn, panPos }
}

/** Compile a POST graph (per-synth FX chain over the summed voices). Like
 *  compileGraph but the terminal `out` produces a MONO result (no pan stage):
 *  stereo width comes from running two of these independently (see PostChain).
 *  Validated + compiled at synth() definition time so a bad post graph fails
 *  fast, just like the voice graph. */
export function compilePost(spec: GraphSpec, ctx: DspContext): CompiledPost {
  const c = assemble(spec, ctx)
  const { outNode, resolve, nodeOut } = c
  // The mono result is whatever feeds `out`; if `out` was optimized away (spec
  // points straight at a producer) it's that node's own buffer.
  const out = outNode.type === 'out' ? resolve(outNode.inputs['in']!) : nodeOut.get(outNode.id)!
  return { steps: c.steps, params: c.params, input: c.input, out }
}
