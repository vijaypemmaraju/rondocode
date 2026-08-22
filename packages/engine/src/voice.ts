import { BLOCK } from './compile'
import type { CompiledGraph } from './compile'
import { compileGraph } from './compile'
import type { GraphSpec } from './graph'
import { resolveParamValue } from './graph'
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
 *  - `glide` — portamento time in SECONDS (mono only; ignored when poly).
 *    Applies to LEGATO moves only — a note tied into the next by `slide`, or a
 *    held keyboard line. A note that retriggers snaps to its pitch, so `slide`
 *    is what decides whether a step bends. The
 *    pitch slides from the previous note toward the new one as a one-pole in
 *    LOG-FREQUENCY (semitone) space, so the perceived glide rate is constant
 *    across octaves; `glide` is the ~time-constant (≈63% of the way in `glide`
 *    s, essentially there by ~3·glide). 0 = instant pitch change. Default 0.
 *  - `unison` — detuned sub-voices per note, 1..9 (1 = off). Default 1.
 *  - `detune` — total unison detune SPREAD in cents; sub-voices are placed
 *    evenly from -detune to +detune around the note. Default 15.
 *  - `spread` — unison stereo width 0..1; sub-voices pan evenly left→right
 *    (center voice stays centered for odd `unison`). 0 = all centered (mono
 *    sum). Default 0.6.
 *  - `curve` — detune-curve exponent, clamped to [0.2, 5]. 1 (default) is the
 *    even spacing above; > 1 pulls the INNER sub-voices toward the note
 *    (center-weighted, Serum-style focus — edges stay at ±detune); < 1 pushes
 *    them out toward the edges.
 *  - `blend` — edge-voice gain 0..1 (default 1 = all equal): sub-voice gain
 *    fades linearly from 1 at the center to `blend` at the outermost pair.
 *  - `octaves` — every Nth sub-voice (layout order) plays +12 semitones;
 *    N >= 2, 0/1 = off (default 0).
 *  - `humanize` — 0..1 (default 0 = off), how far a player's hand drifts off
 *    the grid. Each voice gets its own small pitch and timing offset, so a
 *    unison stack or a stacked chord stops being N bit-identical copies. At
 *    full amount the pitch offset spans ±HUMANIZE_CENTS cents and the note is
 *    held back by 0..HUMANIZE_DELAY_MS ms (see those constants). The offsets
 *    are HASHED from the voice slot and the midi note, never Math.random, so a
 *    render is reproducible sample-for-sample. */
export interface VoiceOpts {
  mono: boolean
  glide: number
  unison: number
  detune: number
  spread: number
  curve: number
  blend: number
  octaves: number
  humanize: number
}

/** Full-amount humanize pitch spread, in cents (±): the offset is uniform over
 *  [-8, +8] cents at humanize 1. Deliberately under a tenth of a semitone —
 *  enough to stop unison voices phase-locking, small enough to never read as
 *  out of tune. */
export const HUMANIZE_CENTS = 8
/** Full-amount humanize timing spread, in ms: the note is held back by a
 *  uniform 0..14 ms at humanize 1. ONE-SIDED (a player can be late, never
 *  early — there is no future to read). A note shorter than its own delay is
 *  released before it ever sounds; at 14 ms that only reaches sub-14 ms
 *  events. */
export const HUMANIZE_DELAY_MS = 14

/** 32-bit integer avalanche hash of (a, b, salt) → uniform [0, 1). This is the
 *  whole determinism story for humanize: the offsets are a pure function of
 *  the voice slot and the midi note, so re-rendering the same events gives
 *  bit-identical audio. (The voice SLOT is part of the key, so two renders
 *  agree because voice allocation is itself deterministic — not because a
 *  given note always lands on the same offset.) */
const hash01 = (a: number, b: number, salt: number): number => {
  let h = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b) ^ salt) | 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
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
  curve: 1,
  blend: 1,
  octaves: 0,
  humanize: 0,
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

  /** Humanize state (see VoiceOpts.humanize). `humanizeAmt` 0 = off, and then
   *  `humanizeMul` stays exactly 1 and `pendingSamples` exactly 0 — a multiply
   *  by 1.0 is the identity in IEEE-754 and the gate path below is skipped, so
   *  a humanize-free synth is byte-identical to the pre-feature engine. */
  private humanizeAmt = 0
  private slot = 0
  private humanizeMul = 1
  /** Samples of note-onset delay still owed before the gate may rise. */
  private pendingSamples = 0
  /** True while a delayed gate still has stale zeros at the head of the gate
   *  buffer that must be overwritten once the delay has fully elapsed. */
  private gateSettle = false

  constructor(
    private readonly graph: CompiledGraph,
    private readonly ctx: DspContext,
  ) {}

  /** Set the per-sample log-space glide coefficient (0 = instant). Called once
   *  by VoicePool when the synth is mono. */
  setGlide(coeff: number): void {
    this.glideCoeff = coeff
  }

  /** Configure this voice as a unison sub-voice: a constant detune multiplier,
   *  a stereo pan position `q` in [0, 1] (0.5 = center), and a per-sub-voice
   *  `gain` (the blend shaping; default 1 = unshaped — `x * 1 === x`, so the
   *  legacy path stays byte-identical). The balance is normalized so q=0.5 is
   *  unity gain on both legs (spread 0 sums to the mono result); off-center
   *  positions trade the two legs at equal power. */
  setUnison(detuneMul: number, q: number, gain = 1): void {
    this.detuneMul = detuneMul
    // cos/sin give an equal-power PAN; dividing by cos(pi/4) (=SQRT1_2)
    // renormalizes it to a BALANCE that is unity at center.
    this.glBal = (Math.cos(q * HALF_PI) * Math.SQRT2) * gain
    this.grBal = (Math.sin(q * HALF_PI) * Math.SQRT2) * gain
  }

  /** Configure this voice's HUMANIZE: `amount` 0..1 and the voice's pool slot
   *  (the hash key alongside the note — see hash01). Called once by VoicePool
   *  at construction; 0 leaves every humanize path dormant. */
  setHumanize(amount: number, slot: number): void {
    this.humanizeAmt = clamp(Number.isFinite(amount) ? amount : 0, 0, 1)
    this.slot = slot
  }

  /** Start (or retrigger) a note: notefreq = 440*2^((n-69)/12), gate = 1,
   *  velocity clamped to [0, 1]. Kernels are NOT reset (see class doc). */
  /** Step ids whose kernel takes the per-note slice (`begin`/`end` ports —
   *  the samplers). Found lazily on the first noteOn rather than in the
   *  constructor, so the compiled graph is certainly assigned. */
  private sliceSteps: number[] | null = null

  /** Start (or retrigger) a note. `begin`/`end` (fractions 0..1) are the
   *  slice of the sample this note plays — what `.chop()` writes; they are
   *  PATCHED onto every sampler's ports before the gate rises, and the kernel
   *  latches them on the edge, so they are per note and per voice without a
   *  graph node of their own. A graph with no sampler never looks at them. */
  noteOn(midiNote: number, velocity: number, begin = 0, end = 1): void {
    const g = this.graph
    if (this.sliceSteps === null) {
      this.sliceSteps = g.steps.filter((st) => 'begin' in st.inputs && 'end' in st.inputs).map((st) => st.id)
    }
    for (const id of this.sliceSteps) {
      this.patchConstant(id, 'begin', begin)
      this.patchConstant(id, 'end', end)
    }
    this.midiNote = midiNote
    this.gateOn = true
    this.isActive = true
    this.silentBlocks = 0
    const v = clamp(velocity, 0, 1)
    this.vel = v
    // HUMANIZE: derive this voice's pitch and timing offset deterministically
    // from (slot, note). At amount 0 both are exactly the neutral value.
    if (this.humanizeAmt > 0) {
      const a = this.humanizeAmt
      const cents = (hash01(this.slot, midiNote, 0x1f2e3d4c) * 2 - 1) * HUMANIZE_CENTS * a
      this.humanizeMul = 2 ** (cents / 1200)
      const ms = hash01(this.slot, midiNote, 0x7a5c9b31) * HUMANIZE_DELAY_MS * a
      this.pendingSamples = Math.round((ms / 1000) * this.ctx.sampleRate)
    }
    if (this.glideCoeff === 0) {
      // Instant pitch (default): fill notefreq once. detuneMul is 1 for a
      // non-unison voice, and `freq * 1 === freq`, so this stays byte-identical.
      g.noteFreq.fill(440 * 2 ** ((midiNote - 69) / 12) * this.detuneMul * this.humanizeMul)
    } else {
      // A RETRIGGER SNAPS (303 model). noteOn means a new note with its own
      // attack; glideTo() is the legato path and the only one that bends
      // pitch. This used to snap only when the voice had no previous pitch,
      // which is almost never: a voice is not reclaimed until its RELEASE
      // finishes, and the scheduler leaves a 5 ms gate gap, so any patch whose
      // release outlasts that (`adsr .01 .15 0 .1` — an ordinary pluck) kept
      // the old pitch and glided EVERY note regardless of `slide`.
      //
      // That contradicted slide's contract, which is that a non-slide note
      // retriggers cleanly. It also made `slide` nearly decorative: it removed
      // the re-attack and nothing else. Always-glide is still available by
      // sliding every note (`slide: 1`), which is the honest way to ask for it.
      const baseLog = LOG2_440 + (midiNote - 69) / 12
      this.curLog = baseLog
      this.tgtLog = baseLog
      this.hasPitch = true
    }
    // A humanized onset holds the gate LOW until its delay elapses (process()
    // raises it mid-block); without humanize this is the original fill(1).
    if (this.pendingSamples > 0) {
      g.gate.fill(0)
      this.gateSettle = true
    } else {
      g.gate.fill(1)
    }
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
      this.graph.noteFreq.fill(440 * 2 ** ((midiNote - 69) / 12) * this.detuneMul * this.humanizeMul)
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
    // Drop any humanize onset delay still owed: a note released inside its own
    // delay window never sounds (only reachable for sub-14 ms events).
    this.pendingSamples = 0
    this.gateSettle = false
    this.graph.gate.fill(0)
  }

  /** Set a declared param, clamped to its spec [min, max]. `value` is always
   *  the REAL value regardless of curve — 'log' only tells UIs how to lay out
   *  a slider; the engine never maps through the curve. Unknown names are
   *  ignored (typos in live code shouldn't kill the audio thread). */
  setParam(name: string, value: number): void {
    const p = this.graph.params.get(name)
    if (!p) return
    p.buf.fill(resolveParamValue(p.spec, value))
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
    this.pendingSamples = 0
    this.gateSettle = false
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
    // HUMANIZE onset delay: hold the gate low for the samples still owed, then
    // raise it mid-block. Both branches are skipped entirely when humanize is
    // off (pendingSamples 0, gateSettle false), leaving noteOn's fill(1).
    if (this.pendingSamples > 0) {
      const gb = g.gate
      const k = this.pendingSamples < n ? this.pendingSamples : n
      gb.fill(0, 0, k)
      if (k < n) gb.fill(1, k, n)
      this.pendingSamples -= k
    } else if (this.gateSettle) {
      // The delay elapsed mid-block last time; the head of the buffer still
      // holds its zeros, so overwrite the whole gate with the held-on value.
      g.gate.fill(1)
      this.gateSettle = false
    }
    // Glide: advance the log-space pitch toward its target per sample and fill
    // the notefreq buffer before the kernels read it. Skipped entirely when
    // glideCoeff is 0 (the default), leaving noteOn's constant fill in place.
    if (this.glideCoeff > 0) {
      const nf = g.noteFreq
      const t = this.tgtLog
      const k = this.glideCoeff
      const dm = this.detuneMul * this.humanizeMul
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
  /** Per-sub-voice detune multipliers, pan positions and blend gains (length
   *  `unison`). */
  private readonly detuneMuls: number[]
  private readonly panPos: number[]
  private readonly gains: number[]
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
    // Unison SHAPING (see VoiceOpts). Defensive defaults keep pre-feature wire
    // messages (no curve/blend/octaves fields) on the legacy layout exactly.
    const curve = clamp(Number.isFinite(vo.curve) ? vo.curve : 1, 0.2, 5)
    const blend = clamp(Number.isFinite(vo.blend) ? vo.blend : 1, 0, 1)
    const octaves = Math.floor(clamp(Number.isFinite(vo.octaves) ? vo.octaves : 0, 0, 9))
    // HUMANIZE: hand each voice its pool slot (half the hash key) and the
    // amount. Guarded so a humanize-free pool never touches a voice at all.
    const humanize = clamp(Number.isFinite(vo.humanize) ? vo.humanize : 0, 0, 1)
    if (humanize > 0) {
      for (let i = 0; i < this.voices.length; i++) this.voices[i]!.setHumanize(humanize, i)
    }

    // Unison layout: pitches spread across [-detune, +detune] cents (evenly at
    // curve 1; warped toward the center for curve > 1 — the curve===1 guard
    // keeps the default byte-identical), pans evenly across the field scaled
    // by `spread` (center for odd unison), gains fading to `blend` at the
    // edges, and every `octaves`-th sub-voice lifted +12.
    this.detuneMuls = []
    this.panPos = []
    this.gains = []
    const N = this.unison
    for (let j = 0; j < N; j++) {
      const frac = N === 1 ? 0 : (j / (N - 1)) * 2 - 1 // -1..+1, linear
      const warped = curve === 1 || frac === 0 ? frac : Math.sign(frac) * Math.abs(frac) ** curve
      let mul = 2 ** ((warped * detune) / 1200)
      if (octaves >= 2 && (j + 1) % octaves === 0) mul *= 2 // +12 semitones
      this.detuneMuls.push(mul)
      const panFrac = N === 1 ? 0.5 : j / (N - 1) // 0..1
      this.panPos.push(0.5 + (panFrac - 0.5) * spread)
      this.gains.push(blend === 1 ? 1 : 1 - (1 - blend) * Math.abs(frac))
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
        if (N > 1) v.setUnison(this.detuneMuls[j]!, this.panPos[j]!, this.gains[j]!)
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

  noteOn(note: number, vel: number, begin = 0, end = 1): void {
    if (this.mono) return this.monoNoteOn(note, vel, begin, end)
    if (this.unison > 1) return this.polyUnisonNoteOn(note, vel, begin, end)

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
    vs[idx]!.noteOn(note, vel, begin, end)
  }

  /** Mono note-on with legato note priority: a new note over a held one slides
   *  (no re-attack); the first note of an idle voice retriggers. All cluster
   *  voices move together. */
  private monoNoteOn(note: number, vel: number, begin = 0, end = 1): void {
    const held = this.held
    const wasIdle = held.length === 0
    const k = held.indexOf(note)
    if (k >= 0) held.splice(k, 1)
    held.push(note)
    for (let j = 0; j < this.clusterSize; j++) {
      if (wasIdle) this.voices[j]!.noteOn(note, vel, begin, end)
      else this.voices[j]!.glideTo(note)
    }
  }

  /** Poly unison note-on: retrigger the note's existing cluster if still
   *  sounding, else allocate a fresh cluster of `unison` sub-voices. */
  private polyUnisonNoteOn(note: number, vel: number, begin = 0, end = 1): void {
    const vs = this.voices
    let retriggered = false
    for (let i = 0; i < vs.length; i++) {
      if (vs[i]!.active && vs[i]!.note === note) {
        vs[i]!.noteOn(note, vel, begin, end) // keep this sub-voice's detune/pan
        this.seqs[i] = ++this.seqCounter
        retriggered = true
      }
    }
    if (retriggered) return
    for (let j = 0; j < this.unison; j++) {
      const idx = this.allocIndex()
      this.seqs[idx] = ++this.seqCounter
      vs[idx]!.setUnison(this.detuneMuls[j]!, this.panPos[j]!, this.gains[j]!)
      vs[idx]!.noteOn(note, vel, begin, end)
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

  /** Hard stop (transport Stop): drop the gate AND reset each active voice's
   *  kernels, so an in-flight one-shot sample (a sung vocal clip) stops NOW
   *  instead of playing to its end. reset() clears the sample's playing flag;
   *  the noteOff first keeps the (now-zero) gate from re-triggering it. */
  silenceAll(): void {
    this.held.length = 0
    for (const v of this.voices) {
      if (v.active) {
        v.noteOff()
        v.reset()
      }
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
