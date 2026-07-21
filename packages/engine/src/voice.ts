import { BLOCK } from './compile'
import type { CompiledGraph } from './compile'
import { compileGraph } from './compile'
import type { GraphSpec } from './graph'
import type { DspContext } from './dsp/types'
import { clamp } from './dsp/util'

const HALF_PI = Math.PI / 2
/** Equal-power center gain: cos(pi/4). */
const CENTER = Math.SQRT1_2
/** log2(440) — base for the log-space (semitone) glide ramp. */
const LOG2_440 = Math.log2(440)

/** Per-synth voice-allocation modes (normalized: every field present).
 *
 *  - `mono` — one reused voice cluster instead of polyphony; new notes reuse it
 *    (portamento). Default false (polyphonic — today's behavior).
 *  - `glide` — portamento time in SECONDS (mono only; ignored when poly). The
 *    pitch slides from the previous note toward the new one as a one-pole in
 *    LOG-FREQUENCY (semitone) space, so the perceived glide rate is constant
 *    across octaves; `glide` is the ~time-constant (≈63% of the way in `glide`
 *    s, essentially there by ~3·glide). 0 = instant pitch change. Default 0.
 *  - `unison` — detuned sub-voices per note, 1..9 (1 = off). Default 1.
 *  - `detune` — total unison detune SPREAD in cents; sub-voices are placed
 *    evenly from -detune to +detune around the note. Default 15.
 *  - `spread` — unison stereo width 0..1; sub-voices pan evenly left→right
 *    (center voice stays centered for odd `unison`). 0 = all centered (mono
 *    sum). Default 0.6. */
export interface VoiceOpts {
  mono: boolean
  glide: number
  unison: number
  detune: number
  spread: number
}

/** The neutral defaults — a poly, no-glide, unison-1 synth, i.e. exactly the
 *  pre-feature behavior. A pool built with these (or with undefined opts) takes
 *  the original code paths verbatim. */
export const DEFAULT_VOICE_OPTS: VoiceOpts = Object.freeze({
  mono: false,
  glide: 0,
  unison: 1,
  detune: 15,
  spread: 0.6,
})

/** Consecutive silent blocks (gate off, block RMS < 1e-5) before a voice is
 *  considered inactive/reclaimable. */
const SILENT_BLOCKS = 8
/** Mean-square threshold equivalent to RMS < 1e-5. */
const SILENT_MEAN_SQ = 1e-10

/** One playing note: owns a CompiledGraph (stateful kernels + buffers) and
 *  sums its stereo output into a shared mix bus.
 *
 *  The process() hot path is allocation-free: every buffer and resolved input
 *  map was built at compile time; noteOn/noteOff/setParam only fill
 *  preallocated buffers.
 *
 *  Retrigger semantics: noteOn on an active voice does NOT reset kernels —
 *  the ADSR retriggers from its current level by design (no click), and
 *  oscillators keep their phase. A STOLEN voice is likewise not reset: steal
 *  is a hard takeover (a fast forced release would click worse; crossfade
 *  polish can come later). */
export class Voice {
  private midiNote: number | null = null
  private gateOn = false
  private isActive = false
  private silentBlocks = 0
  /** Note velocity in [0, 1], captured at noteOn. The Voice AUTO-SCALES its
   *  output contribution by this as it sums into the bus (see process), so a
   *  pattern's .gain()/velocity always affects loudness — a synth graph does
   *  NOT need to multiply by the `velocity` signal. The `velocity` ctx node
   *  stays available, but it is for TIMBRE (e.g. velocity→filter brightness):
   *  multiplying the OUTPUT by it double-applies velocity. */
  private vel = 1

  /** Glide (portamento) state. `glideCoeff` 0 = no glide (instant pitch, the
   *  default): noteOn/glideTo fill notefreq immediately and process() never
   *  touches it — byte-identical to the pre-feature path. > 0 = one-pole per
   *  sample in log-freq space from `curLog` toward `tgtLog` (see VoiceOpts).
   *  `hasPitch` is false until the first note, so the first note snaps rather
   *  than sliding up from nothing. */
  private glideCoeff = 0
  private curLog = 0
  private tgtLog = 0
  private hasPitch = false
  /** Constant frequency multiplier for this (unison) sub-voice's detune; 1 =
   *  no detune (the default). Applied to the note frequency. */
  private detuneMul = 1
  /** Per-voice equal-power stereo balance, applied to BOTH legs as the voice
   *  sums into the bus. Unity (1, 1) by default — a multiply by exactly 1.0 is
   *  the identity in IEEE-754, so the default path stays byte-identical. Unison
   *  sub-voices set a balance normalized to unity at center (0.5), so spread 0
   *  keeps L==R (mono sum) and spread > 0 places sub-voices across the field. */
  private glBal = 1
  private grBal = 1

  constructor(
    private readonly graph: CompiledGraph,
    private readonly ctx: DspContext,
  ) {}

  /** Set the per-sample log-space glide coefficient (0 = instant). Called once
   *  by VoicePool when the synth is mono. */
  setGlide(coeff: number): void {
    this.glideCoeff = coeff
  }

  /** Configure this voice as a unison sub-voice: a constant detune multiplier
   *  and a stereo pan position `q` in [0, 1] (0.5 = center). The balance is
   *  normalized so q=0.5 is unity gain on both legs (spread 0 sums to the mono
   *  result); off-center positions trade the two legs at equal power. */
  setUnison(detuneMul: number, q: number): void {
    this.detuneMul = detuneMul
    // cos/sin give an equal-power PAN; dividing by cos(pi/4) (=SQRT1_2)
    // renormalizes it to a BALANCE that is unity at center.
    this.glBal = (Math.cos(q * HALF_PI) * Math.SQRT2)
    this.grBal = (Math.sin(q * HALF_PI) * Math.SQRT2)
  }

  /** Start (or retrigger) a note: notefreq = 440*2^((n-69)/12), gate = 1,
   *  velocity clamped to [0, 1]. Kernels are NOT reset (see class doc). */
  noteOn(midiNote: number, velocity: number): void {
    const g = this.graph
    this.midiNote = midiNote
    this.gateOn = true
    this.isActive = true
    this.silentBlocks = 0
    const v = clamp(velocity, 0, 1)
    this.vel = v
    if (this.glideCoeff === 0) {
      // Instant pitch (default): fill notefreq once. detuneMul is 1 for a
      // non-unison voice, and `freq * 1 === freq`, so this stays byte-identical.
      g.noteFreq.fill(440 * 2 ** ((midiNote - 69) / 12) * this.detuneMul)
    } else {
      // Gliding: set the target; snap current on the very first note (no slide
      // from silence). process() fills notefreq per sample from here on.
      const baseLog = LOG2_440 + (midiNote - 69) / 12
      if (!this.hasPitch) this.curLog = baseLog
      this.tgtLog = baseLog
      this.hasPitch = true
    }
    g.gate.fill(1)
    // The `velocity` signal buffer stays populated for TIMBRE modulation
    // inside the graph; amplitude scaling by v happens in process().
    g.velocity.fill(v)
  }

  /** Legato pitch move (mono portamento): retarget the note WITHOUT re-firing
   *  the gate or resetting the envelope — the note keeps sounding and the pitch
   *  slides. With glide 0 the pitch changes instantly (still no re-attack).
   *  Velocity is left untouched so amplitude does not jump mid-slide. */
  glideTo(midiNote: number): void {
    this.midiNote = midiNote
    if (this.glideCoeff === 0) {
      this.graph.noteFreq.fill(440 * 2 ** ((midiNote - 69) / 12) * this.detuneMul)
    } else {
      this.tgtLog = LOG2_440 + (midiNote - 69) / 12
      if (!this.hasPitch) {
        this.curLog = this.tgtLog
        this.hasPitch = true
      }
    }
  }

  /** Release: gate = 0. The voice stays active until its output has been
   *  silent for the hysteresis window (see `active`). */
  noteOff(): void {
    this.gateOn = false
    this.graph.gate.fill(0)
  }

  /** Set a declared param, clamped to its spec [min, max]. `value` is always
   *  the REAL value regardless of curve — 'log' only tells UIs how to lay out
   *  a slider; the engine never maps through the curve. Unknown names are
   *  ignored (typos in live code shouldn't kill the audio thread). */
  setParam(name: string, value: number): void {
    const p = this.graph.params.get(name)
    if (!p) return
    p.buf.fill(clamp(value, p.spec.min, p.spec.max))
  }

  /** Owned constant buffers for live-patched input ports, keyed "id:port".
   *  We can't overwrite the compiled input buffer — the compiler POOLS
   *  constants by value across nodes, so it may be shared — so patching
   *  re-points the port at a private buffer (allocated once, refilled after). */
  private patchBufs: Map<string, Float32Array> | null = null

  /** Live-patch one input-port constant (see patch.ts). Unknown node/port is
   *  ignored — the host diffed against a graph that may race a redefine. */
  patchConstant(nodeId: number, port: string, value: number): void {
    const steps = this.graph.steps
    let step: (typeof steps)[number] | undefined
    for (let s = 0; s < steps.length; s++) {
      if (steps[s]!.id === nodeId) {
        step = steps[s]!
        break
      }
    }
    if (step === undefined || !(port in step.inputs)) return
    const key = `${nodeId}:${port}`
    const cache = (this.patchBufs ??= new Map())
    let buf = cache.get(key)
    if (buf === undefined) {
      buf = new Float32Array(step.inputs[port]!.length) // = BLOCK; own it, don't touch the pooled buffer
      cache.set(key, buf)
      step.inputs[port] = buf
    }
    buf.fill(value)
  }

  /** Read a node's most recent output sample (last frame of the last processed
   *  block) — the value-probe tap. NaN for an unknown id. Cheap: a step scan
   *  (like patchConstant) plus one array read; the caller gates the cadence.
   *  An inactive voice keeps its stale buffer, so callers read active voices. */
  readNode(nodeId: number): number {
    const steps = this.graph.steps
    for (let s = 0; s < steps.length; s++) {
      if (steps[s]!.id === nodeId) {
        const out = steps[s]!.out
        return out.length > 0 ? out[out.length - 1]! : NaN
      }
    }
    return NaN
  }

  /** Reset every kernel's state (delay lines, filter/envelope/oscillator
   *  state). VoicePool calls this ONLY when allocating an INACTIVE voice to a
   *  new note: a reclaimed voice can still hold stale delay-line energy (see
   *  `active` on delay tails) that would replay into the new note. Retrigger
   *  and steal intentionally do NOT reset (see class doc). */
  reset(): void {
    const steps = this.graph.steps
    for (let s = 0; s < steps.length; s++) steps[s]!.kernel.reset()
    // A reclaimed voice has no previous pitch to glide from (mono never takes
    // this path, so its portamento-across-a-gap behavior is unaffected).
    this.hasPitch = false
  }

  /** False until noteOn; after noteOff, flips false once gate is off AND
   *  block RMS < 1e-5 for 8 consecutive blocks (envelope-agnostic, cheap:
   *  measured from the sums of squares the mix loop already touches).
   *  An inactive voice's process() is a no-op, so it costs nothing to keep
   *  in the pool.
   *
   *  Known v1 limitation: the hysteresis only sees the voice's OUTPUT, so a
   *  delay line still holding unheard energy doesn't keep the voice alive.
   *  After gate-off, any silent gap of >= 8 blocks (~21ms at 48kHz) between
   *  echoes reclaims the voice before the next echo re-emerges — e.g. a
   *  feedback loop with a 25ms delay time dies after its first post-release
   *  gap. Loops with periods under ~21ms are unaffected. */
  get active(): boolean {
    return this.isActive
  }

  /** Currently assigned midi note; null when the voice is inactive. */
  get note(): number | null {
    return this.isActive ? this.midiNote : null
  }

  /** Render n samples (n <= BLOCK) and ADD them into outL/outR (mix bus
   *  semantics — the caller owns clearing the bus). Allocation-free. */
  process(outL: Float32Array, outR: Float32Array, n: number): void {
    if (n > BLOCK) throw new RangeError(`n (${n}) exceeds BLOCK (${BLOCK})`)
    // n <= 0: nothing to render — and running the silence check on an empty
    // block would compute a NaN mean square and reset the hysteresis count
    if (n <= 0 || !this.isActive) return
    const g = this.graph
    const ctx = this.ctx
    // Glide: advance the log-space pitch toward its target per sample and fill
    // the notefreq buffer before the kernels read it. Skipped entirely when
    // glideCoeff is 0 (the default), leaving noteOn's constant fill in place.
    if (this.glideCoeff > 0) {
      const nf = g.noteFreq
      const t = this.tgtLog
      const k = this.glideCoeff
      const dm = this.detuneMul
      let c = this.curLog
      for (let i = 0; i < n; i++) {
        c += (t - c) * k
        nf[i] = 2 ** c * dm
      }
      this.curLog = c
    }
    const steps = g.steps
    for (let s = 0; s < steps.length; s++) {
      const st = steps[s]!
      st.kernel.process(n, st.inputs, st.out, ctx)
    }

    const input = g.panIn
    const pos = g.panPos
    // Auto-apply note velocity to amplitude: one extra multiply per sample,
    // constant across the note. RMS/active tracking below sees the
    // POST-velocity signal (sumSq accumulates the ducked-by-velocity legs).
    const vel = this.vel
    // Per-voice unison balance; unity (1, 1) unless this is a spread sub-voice.
    // At unity, `l * 1 === l`, so both branches below reduce EXACTLY to the
    // original pan/center math (a*a + a*a === 2*a*a in IEEE-754).
    const glBal = this.glBal
    const grBal = this.grBal
    let sumSq = 0
    if (pos) {
      for (let i = 0; i < n; i++) {
        const p = clamp(pos[i]!, 0, 1)
        const x = input[i]! * vel
        const l = x * Math.cos(p * HALF_PI) * glBal
        const r = x * Math.sin(p * HALF_PI) * grBal
        outL[i] = outL[i]! + l
        outR[i] = outR[i]! + r
        sumSq += l * l + r * r
      }
    } else {
      for (let i = 0; i < n; i++) {
        const x = input[i]! * CENTER * vel
        const l = x * glBal
        const r = x * grBal
        outL[i] = outL[i]! + l
        outR[i] = outR[i]! + r
        sumSq += l * l + r * r
      }
    }

    if (!this.gateOn && sumSq / (2 * n) < SILENT_MEAN_SQ) {
      if (++this.silentBlocks >= SILENT_BLOCKS) this.isActive = false
    } else {
      this.silentBlocks = 0
    }
  }
}

/** Clamp + floor a unison count into the legal 1..9 range. */
const clampUnison = (n: number): number => Math.floor(clamp(Number.isFinite(n) ? n : 1, 1, 9))

/** Fixed-size polyphony manager. All voices are compiled and instantiated up
 *  front (each Voice owns its own CompiledGraph — kernels are stateful), so
 *  steady-state operation allocates nothing.
 *
 *  Three modes, chosen by VoiceOpts (defaults = poly, unison 1 = today's
 *  behavior, on the ORIGINAL code path):
 *
 *  - POLY (default): a voice already playing that note is retriggered;
 *    otherwise the first inactive voice; otherwise the OLDEST voice is stolen
 *    (a hard takeover, see Voice).
 *  - POLY + UNISON N: each noteOn spawns a CLUSTER of N detuned, stereo-spread
 *    sub-voices (retriggering the note's existing cluster if it is still
 *    playing). This uses N× the voice budget — the pool steals the oldest
 *    voices when a cluster does not fit.
 *  - MONO (optionally + unison): one fixed cluster of `clusterSize` voices,
 *    reused for every note, with a held-note STACK for legato portamento. A
 *    note arriving over a held note SLIDES the pitch and does not re-attack;
 *    a note after a gap retriggers (and still glides from the last pitch).
 *    Mono never steals or resets, so the glide's from-pitch survives gaps. */
export class VoicePool {
  /** Exposed for inspection (tests, UIs); treat as read-only. */
  readonly voices: Voice[] = []
  private readonly seqs: number[] = []
  private seqCounter = 0

  private readonly mono: boolean
  private readonly unison: number
  /** How many voices form one cluster (unison, capped by the pool size). */
  private readonly clusterSize: number
  /** Per-sub-voice detune multipliers and pan positions (length `unison`). */
  private readonly detuneMuls: number[]
  private readonly panPos: number[]
  /** Mono held-note stack (most-recent last); drives legato note priority. */
  private readonly held: number[] = []

  constructor(spec: GraphSpec, ctx: DspContext, maxVoices = 8, opts?: VoiceOpts) {
    for (let i = 0; i < maxVoices; i++) {
      this.voices.push(new Voice(compileGraph(spec, ctx), ctx))
      this.seqs.push(0)
    }

    const vo = opts ?? DEFAULT_VOICE_OPTS
    this.mono = vo.mono === true
    this.unison = clampUnison(vo.unison)
    const detune = Math.max(0, Number.isFinite(vo.detune) ? vo.detune : 0)
    const spread = clamp(Number.isFinite(vo.spread) ? vo.spread : 0, 0, 1)

    // Unison layout: pitches spread evenly across [-detune, +detune] cents and
    // pans evenly across the field scaled by `spread` (center for odd unison).
    this.detuneMuls = []
    this.panPos = []
    const N = this.unison
    for (let j = 0; j < N; j++) {
      const frac = N === 1 ? 0 : (j / (N - 1)) * 2 - 1 // -1..+1
      this.detuneMuls.push(2 ** ((frac * detune) / 1200))
      const panFrac = N === 1 ? 0.5 : j / (N - 1) // 0..1
      this.panPos.push(0.5 + (panFrac - 0.5) * spread)
    }

    // Glide applies only in mono (portamento between successive notes).
    const glideCoeff =
      this.mono && vo.glide > 0 && Number.isFinite(vo.glide)
        ? 1 - Math.exp(-1 / (vo.glide * ctx.sampleRate))
        : 0

    this.clusterSize = this.mono ? Math.min(N, this.voices.length) : N
    if (this.mono) {
      // The mono cluster is fixed: configure its voices once, up front.
      for (let j = 0; j < this.clusterSize; j++) {
        const v = this.voices[j]!
        v.setGlide(glideCoeff)
        if (N > 1) v.setUnison(this.detuneMuls[j]!, this.panPos[j]!)
      }
    }
  }

  /** Live-patch input-port constants across EVERY voice (all voices are
   *  compiled up front, so this reaches active and idle alike). */
  patchConstants(patches: readonly { node: number; port: string; value: number }[]): void {
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i]!
      for (let p = 0; p < patches.length; p++) v.patchConstant(patches[p]!.node, patches[p]!.port, patches[p]!.value)
    }
  }

  /** Read a node's current output value from an active voice — the value-probe
   *  tap. Idle voices hold stale buffers, so the first ACTIVE voice is used
   *  (any of a poly cluster reflects the shared modulation well enough for a
   *  readout); NaN when the synth is silent. */
  readNode(nodeId: number): number {
    for (let i = 0; i < this.voices.length; i++) {
      if (this.voices[i]!.active) return this.voices[i]!.readNode(nodeId)
    }
    return NaN
  }

  noteOn(note: number, vel: number): void {
    if (this.mono) return this.monoNoteOn(note, vel)
    if (this.unison > 1) return this.polyUnisonNoteOn(note, vel)

    // --- original poly path (unison 1) — byte-identical to pre-feature ---
    const vs = this.voices
    let idx = -1
    for (let i = 0; i < vs.length; i++) {
      if (vs[i]!.active && vs[i]!.note === note) {
        idx = i // retrigger the voice already playing this note
        break
      }
    }
    if (idx < 0) {
      for (let i = 0; i < vs.length; i++) {
        if (!vs[i]!.active) {
          idx = i
          // fresh allocation of a reclaimed voice: clear stale kernel state
          // (retrigger and steal above/below stay no-reset by design)
          vs[i]!.reset()
          break
        }
      }
    }
    if (idx < 0) {
      idx = 0 // steal the oldest
      for (let i = 1; i < vs.length; i++) {
        if (this.seqs[i]! < this.seqs[idx]!) idx = i
      }
    }
    this.seqs[idx] = ++this.seqCounter
    vs[idx]!.noteOn(note, vel)
  }

  /** Mono note-on with legato note priority: a new note over a held one slides
   *  (no re-attack); the first note of an idle voice retriggers. All cluster
   *  voices move together. */
  private monoNoteOn(note: number, vel: number): void {
    const held = this.held
    const wasIdle = held.length === 0
    const k = held.indexOf(note)
    if (k >= 0) held.splice(k, 1)
    held.push(note)
    for (let j = 0; j < this.clusterSize; j++) {
      if (wasIdle) this.voices[j]!.noteOn(note, vel)
      else this.voices[j]!.glideTo(note)
    }
  }

  /** Poly unison note-on: retrigger the note's existing cluster if still
   *  sounding, else allocate a fresh cluster of `unison` sub-voices. */
  private polyUnisonNoteOn(note: number, vel: number): void {
    const vs = this.voices
    let retriggered = false
    for (let i = 0; i < vs.length; i++) {
      if (vs[i]!.active && vs[i]!.note === note) {
        vs[i]!.noteOn(note, vel) // keep this sub-voice's detune/pan
        this.seqs[i] = ++this.seqCounter
        retriggered = true
      }
    }
    if (retriggered) return
    for (let j = 0; j < this.unison; j++) {
      const idx = this.allocIndex()
      this.seqs[idx] = ++this.seqCounter
      vs[idx]!.setUnison(this.detuneMuls[j]!, this.panPos[j]!)
      vs[idx]!.noteOn(note, vel)
    }
  }

  /** Pick a voice for a fresh cluster member: the first inactive one (reset to
   *  clear stale kernel state), else steal the oldest (hard takeover). The
   *  caller marks it active via noteOn before the next call, so a cluster never
   *  double-books a voice. */
  private allocIndex(): number {
    const vs = this.voices
    for (let i = 0; i < vs.length; i++) {
      if (!vs[i]!.active) {
        vs[i]!.reset()
        return i
      }
    }
    let idx = 0
    for (let i = 1; i < vs.length; i++) {
      if (this.seqs[i]! < this.seqs[idx]!) idx = i
    }
    return idx
  }

  noteOff(note: number): void {
    if (this.mono) {
      const held = this.held
      const k = held.indexOf(note)
      if (k < 0) return
      held.splice(k, 1)
      if (held.length === 0) {
        for (let j = 0; j < this.clusterSize; j++) this.voices[j]!.noteOff()
      } else {
        // Fall back to the most-recent still-held note (slide, no re-attack).
        const top = held[held.length - 1]!
        for (let j = 0; j < this.clusterSize; j++) this.voices[j]!.glideTo(top)
      }
      return
    }
    for (const v of this.voices) {
      if (v.active && v.note === note) v.noteOff()
    }
  }

  allNotesOff(): void {
    this.held.length = 0
    for (const v of this.voices) {
      if (v.active) v.noteOff()
    }
  }

  /** Broadcast to every voice. Voices are all pre-instantiated, so the
   *  broadcast IS the stored default — a voice reused for a later note keeps
   *  the last value set here. */
  setParam(name: string, v: number): void {
    for (const voice of this.voices) voice.setParam(name, v)
  }

  /** Sum all active voices into outL/outR (adds; caller clears the bus).
   *  Indexed loop, no iterator — allocation-free like Voice.process. */
  process(outL: Float32Array, outR: Float32Array, n: number): void {
    const vs = this.voices
    for (let i = 0; i < vs.length; i++) vs[i]!.process(outL, outR, n)
  }
}
