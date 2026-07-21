import { BLOCK } from './compile'
import { VoicePool } from './voice'
import type { VoiceOpts } from './voice'
import { PostChain } from './post'
import type { GraphSpec } from './graph'
import type { DspContext } from './dsp/types'
import { SampleBank } from './samples'
import { gainReductionDb, smoothCoeff } from './dsp/compress'
import { clamp, softClipTanh } from './dsp/util'
import type { EngineEvent, EngineMessage } from './protocol'

/* ------------------------------------------------------------------------- *
 * Realtime engine core: the message-driven layer an AudioWorklet processor
 * wraps in ~30 lines (port.onmessage → handleMessage, process() per render
 * quantum). Pure TS, no Web Audio.
 *
 * Control plane vs audio plane:
 * - handleMessage() allocates freely (it runs between blocks). It validates
 *   every message shape itself and NEVER throws — problems come back as
 *   { kind: 'error' } events via onEvent.
 * - process() is THE audio callback: allocation-free in steady state. The
 *   future-event queue is a sorted array consumed by an advancing head index
 *   (no shift()); fully drained → length reset (no allocation); fired
 *   entries are compacted lazily by the next enqueue (control plane). The
 *   only allocations on the audio path are error-event objects on rare,
 *   rate-limited failure paths (NaN scrub, process-body crash), documented
 *   below.
 *
 * Signal flow per block:
 *   each synth: VoicePool → channel strip (gain × equal-power pan, both
 *   ramped over one block on change) → master bus sum → master gain (ramped
 *   over one block) → soft knee above CLIP_THRESHOLD → non-finite scrub → out.
 *
 * Channel pan is a stereo BALANCE: outL += busL·gain·cos(pan·π/2),
 * outR += busR·gain·sin(pan·π/2). Center costs the usual −3dB per leg; hard
 * left keeps only the L leg (the R leg's content is discarded, not folded) —
 * fine for v1's mono-source voices, documented as such.
 * ------------------------------------------------------------------------- */

/** Hard cap on queued (future-timestamped) note events; beyond it new events
 *  are dropped with an error event. */
export const MAX_PENDING_EVENTS = 4096
/** Total voice budget across all synths. defineSynth clamps its maxVoices to
 *  whatever is left (and fails with an error event when nothing is). 128 gives
 *  a rich multi-synth patch room to breathe — a full track can easily run a
 *  dozen synths, and per-synth `voices` lets patches right-size within it. */
export const MAX_TOTAL_VOICES = 128
/** Cap on retired-but-still-ringing voice pools kept across same-name
 *  redefines. A redefine no longer cuts playing voices — the old pool rings
 *  out while new notes use the new graph — but the backlog is bounded so rapid
 *  live edits can't accumulate pools; the oldest is hard-stopped past this. */
export const MAX_RETIRING = 6
/** |sample| level where the master soft knee engages (see masterSafety). */
export const CLIP_THRESHOLD = 0.95

const DEFAULT_MAX_SYNTHS = 16
/** Upper bound on the constructor's maxSynths option — a sanity rail on the
 *  registry size, independent of the voice budget (which is what actually
 *  limits polyphony: 64 synths would run 1 voice each). */
const MAX_SYNTHS_LIMIT = 64
const DEFAULT_VOICES = 8
const DEFAULT_CHANNEL_GAIN = 0.8
const DEFAULT_PAN = 0.5
const DEFAULT_MASTER_GAIN = 0.8
const MAX_GAIN = 2
const MAX_RAMP_MS = 10000
const HALF_PI = Math.PI / 2
/** Same-frame ordering: noteOff fires before noteOn (retrigger idiom — see
 *  render.ts's rank comment for the full rationale). */
const RANK_OFF = 0
const RANK_ON = 1

/** Master bus per-sample safety stage, exported for direct unit testing (an
 *  honest in-graph NaN source doesn't exist — every kernel guards or flushes
 *  — so the scrub is verified at unit level and the knee via integration):
 *  non-finite → 0, then slope-matched tanh knee above CLIP_THRESHOLD.
 *  Output is always finite and within ±1. */
export const masterSafety = (v: number): number =>
  Number.isFinite(v) ? softClipTanh(v, CLIP_THRESHOLD) : 0

/** Sidechain duck bounds. */
const DEFAULT_DUCK_DEPTH = 0.6
const DEFAULT_DUCK_RELEASE_MS = 180
const MIN_DUCK_RELEASE_MS = 1
const MAX_DUCK_RELEASE_MS = 5000

/** One-pole release coefficient for the sidechain duck: per sample the level
 *  advances `level += (1 - level) * coeff` toward 1. `releaseMs` is clamped to
 *  [1, 5000] here so the LIVE engine and the OFFLINE render (which both call
 *  this) derive the SAME coefficient from the same inputs — the single source
 *  of live==offline parity. */
export const duckReleaseCoeff = (releaseMs: number, sampleRate: number): number => {
  const ms = clamp(releaseMs, MIN_DUCK_RELEASE_MS, MAX_DUCK_RELEASE_MS)
  return 1 - Math.exp(-1 / ((ms / 1000) * sampleRate))
}

interface QueuedNote {
  frame: number
  rank: number // RANK_OFF | RANK_ON
  synth: string
  note: number
  velocity: number // unused for noteOff
}

interface ParamState {
  min: number
  max: number
  /** Last value handed to the pool (spec default until first setParam). */
  value: number
}

interface Ramp {
  name: string
  param: ParamState
  from: number
  to: number
  startFrame: number
  endFrame: number
}

interface Channel {
  name: string
  pool: VoicePool
  /** Per-synth FX post-chain over the SUMMED voices (undefined = no post).
   *  Runs between the voice sum and the channel strip; its reverb/delay state
   *  is shared across all voices of this synth (one tail, not one per note). */
  post: PostChain | undefined
  voices: number
  /** Strip targets; *Prev is the value at the end of the last block — the
   *  pair ramps linearly across one block after a setChannel. */
  gain: number
  pan: number
  gainPrev: number
  panPrev: number
  /** Block-scoped ramp endpoints, refreshed at every block start. */
  g0: number
  g1: number
  p0: number
  p1: number
  params: Map<string, ParamState>
  ramps: Ramp[]
  /** Sum of squares (both legs, post strip) of the last block — meters. */
  sumSq: number
  /** How much this channel responds to the sidechain duck, [0, 1]. 1 = full
   *  duck (down to 1 - depth); 0 = ignore the duck. Effective per-sample
   *  multiplier is 1 - scAmount·(1 - duckLevel). The source channel is never
   *  ducked regardless of this. */
  scAmount: number
  /** Per-synth send amounts into shared buses (busName -> 0..1). Tapped
   *  pre-strip/pre-duck (raw post-FX), so a reverb send does not pump. */
  sends: Map<string, number>
}

/** A shared send bus: an FX chain (like a synth post-chain) fed by the summed
 *  per-synth sends, its output mixed into the master before the master stage. */
interface Bus {
  name: string
  post: PostChain
  gain: number
  /** Per-block send accumulators (BLOCK long), zeroed each block start. */
  accumL: Float32Array
  accumR: Float32Array
  sumSq: number
}

const MAX_BUSES = 8

const isObj = (m: unknown): m is Record<string, unknown> => typeof m === 'object' && m !== null
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const rampValue = (r: Ramp, frame: number): number => {
  if (frame >= r.endFrame) return r.to
  if (frame <= r.startFrame) return r.from
  return r.from + (r.to - r.from) * ((frame - r.startFrame) / (r.endFrame - r.startFrame))
}

export class RealtimeEngine {
  /** Engine → host event sink (errors, meters). Exceptions thrown by the
   *  callback are swallowed — a broken host listener must not kill audio. */
  onEvent?: (ev: EngineEvent) => void

  private readonly ctx: DspContext
  private readonly maxSynths: number
  private readonly byName = new Map<string, Channel>()
  /** Old channels from same-name redefines, kept alive so their in-flight
   *  voices ring out instead of being cut (new notes go to the new channel).
   *  Reaped each block once fully silent; bounded by MAX_RETIRING. */
  private retiring: Channel[] = []
  /** Dense mirror of byName.values() + retiring for allocation-free iteration
   *  in process(); rebuilt on define/remove/reap (control plane). */
  private list: Channel[] = []
  /** Future note events, sorted by (frame, rank), consumed via qHead. */
  private queue: QueuedNote[] = []
  private qHead = 0
  private frames = 0
  /** False until the first FINITE startFrame adopts the host's timeline. */
  private originAdopted = false
  private masterGain = DEFAULT_MASTER_GAIN
  private masterPrev = DEFAULT_MASTER_GAIN
  private masterSumSq = 0
  /** Master-bus glue compressor (stereo-linked), off until setMasterComp.
   *  atk/rel are per-sample smoothing coeffs; makeupLin is linear. */
  private masterComp:
    | { threshold: number; ratio: number; knee: number; atk: number; rel: number; makeupLin: number }
    | undefined
  /** Current master-comp gain reduction in dB (>= 0), smoothed across blocks. */
  private masterCompGr = 0
  private lastNanErrorFrame = -Infinity
  private lastProcErrorFrame = -Infinity
  /** Queue-overflow drops accumulated since the last coalesced report. */
  private queueDropped = 0
  private lastQueueErrorFrame = -Infinity
  /** Correlation id of the message currently being dispatched; echoed onto
   *  any error events it provokes (undefined outside handleMessage). */
  private msgId: string | undefined
  /** Per-channel scratch bus reused across channels and segments. */
  private readonly busL = new Float32Array(BLOCK)
  private readonly busR = new Float32Array(BLOCK)
  /** Shared send buses (name -> Bus) + a dense mirror for allocation-free
   *  iteration in render(), rebuilt on define/remove (control plane). */
  private readonly busByName = new Map<string, Bus>()
  private busList: Bus[] = []
  /** Sidechain duck. scSource undefined = no ducking. duckLevel is the running
   *  envelope (1 = no duck), snapped to 1 - scDepth on each source noteOn and
   *  recovering toward 1 via scReleaseCoeff per sample; it advances continuously
   *  across blocks. `duck` is a preallocated per-sample scratch of the envelope
   *  for the current block — filled ONCE per output sample (not per channel) so
   *  channel count never changes the recovery rate. */
  private scSource: string | undefined
  private scDepth = DEFAULT_DUCK_DEPTH
  private scReleaseCoeff: number
  private duckLevel = 1
  private readonly duck = new Float32Array(BLOCK)

  /** Shared sample store; also exposed on ctx.samples so compiled
   *  SampleKernels resolve names against it (and see later loads). */
  private readonly samples: SampleBank

  constructor(ctx: DspContext, opts?: { maxSynths?: number }) {
    // Adopt any bank the host supplied on the ctx, else create one and publish
    // it back onto the ctx so voice graphs compiled with this ctx can read it.
    this.samples = (ctx.samples as SampleBank | undefined) ?? new SampleBank()
    ctx.samples = this.samples
    this.ctx = ctx
    this.maxSynths = Math.floor(clamp(opts?.maxSynths ?? DEFAULT_MAX_SYNTHS, 1, MAX_SYNTHS_LIMIT))
    this.scReleaseCoeff = duckReleaseCoeff(DEFAULT_DUCK_RELEASE_MS, ctx.sampleRate)
  }

  /** The engine's current frame on the HOST's timeline: the first process()
   *  call adopts its startFrame as the origin (see process), and the counter
   *  advances by BLOCK per process() call, unconditionally — the timeline
   *  never stalls, even on errors. Before the first process() this is 0, and
   *  atFrame semantics are undefined-but-safe: any future-looking atFrame is
   *  queued and lands correctly once the origin is known. */
  get currentFrame(): number {
    return this.frames
  }

  /** Consume one host → engine message. Never throws: malformed or
   *  out-of-policy messages emit an error event instead. Wire this to the
   *  worklet's port.onmessage. */
  handleMessage(msg: EngineMessage): void {
    const raw = msg as unknown
    this.msgId = isObj(raw) && typeof raw['id'] === 'string' ? raw['id'] : undefined
    try {
      this.dispatch(raw)
    } catch (e) {
      // Backstop — dispatch validates explicitly, but nothing past this line
      // may ever escape to the caller.
      this.error(e instanceof Error ? e.message : String(e), 'handleMessage')
    } finally {
      this.msgId = undefined
    }
  }

  /** RMS meters of the LAST processed block: per synth (post channel strip)
   *  and master (post everything), stamped with the engine's current frame
   *  (the scheduler's "now"). On-request, control plane (allocates the event
   *  object). Prototype-less record so a synth named '__proto__' meters like
   *  any other; channel RMS is measured PRE-scrub, so a NaN-emitting patch
   *  is reported as 0 here rather than poisoning the host's UI. */
  collectMeters(): EngineEvent {
    const channels = Object.create(null) as Record<string, number>
    for (const ch of this.list) {
      const v = Math.sqrt(ch.sumSq / (2 * BLOCK))
      channels[ch.name] = Number.isFinite(v) ? v : 0
    }
    const master = Math.sqrt(this.masterSumSq / (2 * BLOCK))
    const ev: Extract<EngineEvent, { kind: 'meters' }> = {
      kind: 'meters',
      frame: this.frames,
      master: Number.isFinite(master) ? master : 0,
      channels,
    }
    if (this.busList.length > 0) {
      const buses = Object.create(null) as Record<string, number>
      for (const bus of this.busList) {
        const v = Math.sqrt(bus.sumSq / (2 * BLOCK))
        buses[bus.name] = Number.isFinite(v) ? v : 0
      }
      ev.buses = buses
    }
    return ev
  }

  /** Render exactly BLOCK frames into outL/outR (their previous contents are
   *  overwritten). `startFrame` is the absolute frame index of outL[0] in the
   *  timeline that noteOn/noteOff `atFrame` values refer to — pass the
   *  worklet's running frame counter.
   *
   *  TIMELINE ORIGIN: the first process() call with a FINITE startFrame
   *  adopts it as the engine's internal frame counter, so currentFrame,
   *  meters.frame, atFrame, and startFrame all live on ONE timeline even
   *  when the worklet spins up mid-context (context frame N > 0). A
   *  scheduler can therefore stamp atFrame = meters.frame + delta safely.
   *  Non-finite calls do not latch the origin — a host that sends garbage
   *  first and real frames later still gets a unified timeline.
   *
   *  A non-finite startFrame falls back to the internal counter WITH a
   *  rate-limited error event — a host bug worth hearing about, not worth
   *  stopping audio for. The whole body is wrapped in one try/catch (never
   *  per-sample): a crash zeroes the block and emits a rate-limited error
   *  event. */
  process(outL: Float32Array, outR: Float32Array, startFrame: number): void {
    if (!this.originAdopted && Number.isFinite(startFrame)) {
      this.originAdopted = true
      this.frames = startFrame
    }
    let start = startFrame
    if (!Number.isFinite(start)) {
      start = this.frames
      this.rateLimited('lastProcErrorFrame', start, `process: non-finite startFrame (${startFrame}), using internal frame counter`)
    }
    try {
      if (outL.length !== BLOCK || outR.length !== BLOCK) {
        outL.fill(0)
        outR.fill(0)
        this.rateLimited(
          'lastProcErrorFrame',
          start,
          `process: buffers must be exactly BLOCK (${BLOCK}) frames, got ${outL.length}/${outR.length}`,
        )
      } else {
        this.render(outL, outR, start)
      }
    } catch (e) {
      outL.fill(0)
      outR.fill(0)
      this.rateLimited('lastProcErrorFrame', start, `process: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.frames += BLOCK
  }

  /* ----------------------------- audio plane ----------------------------- */

  private render(outL: Float32Array, outR: Float32Array, start: number): void {
    outL.fill(0)
    outR.fill(0)
    // Reap retired pools that have gone fully silent (control-plane rate: only
    // when one actually drains, so process() stays scan-free otherwise).
    if (this.retiring.length > 0) {
      let reaped = false
      for (let i = this.retiring.length - 1; i >= 0; i--) {
        if (!this.poolActive(this.retiring[i]!.pool)) {
          this.retiring.splice(i, 1)
          reaped = true
        }
      }
      if (reaped) this.rebuildList()
    }
    const list = this.list

    // Block start: advance param ramps (block-rate granularity), latch the
    // strip ramp endpoints, reset the meters.
    for (let c = 0; c < list.length; c++) {
      const ch = list[c]!
      this.advanceRamps(ch, start)
      ch.g0 = ch.gainPrev
      ch.g1 = ch.gain
      ch.gainPrev = ch.gain
      ch.p0 = ch.panPrev
      ch.p1 = ch.pan
      ch.panPrev = ch.pan
      ch.sumSq = 0
    }
    // Zero the shared-bus send accumulators for this block (mixChannel taps
    // into them pre-strip/pre-duck; the buses are summed after the segment walk).
    for (let b = 0; b < this.busList.length; b++) {
      const bus = this.busList[b]!
      bus.accumL.fill(0)
      bus.accumR.fill(0)
      bus.sumSq = 0
    }

    // Walk the block, splitting at queued-event frames so each event applies
    // on its exact sample (VoicePool.process accepts any n <= BLOCK). fire()
    // may snap duckLevel down when a source noteOn lands, so the duck envelope
    // is filled per SEGMENT (after the fires), once per output sample.
    const duckActive = this.scSource !== undefined
    const q = this.queue
    let cursor = 0
    while (cursor < BLOCK) {
      while (this.qHead < q.length && q[this.qHead]!.frame - start <= cursor) {
        this.fire(q[this.qHead]!)
        this.qHead++
      }
      let end = BLOCK
      if (this.qHead < q.length) {
        const off = q[this.qHead]!.frame - start
        if (off < end) end = off
      }
      const n = end - cursor
      if (duckActive) {
        // Once per sample, independent of channel count.
        const coeff = this.scReleaseCoeff
        let lvl = this.duckLevel
        for (let i = cursor; i < end; i++) {
          this.duck[i] = lvl
          lvl += (1 - lvl) * coeff
        }
        this.duckLevel = lvl
      }
      for (let c = 0; c < list.length; c++) {
        const ch = list[c]!
        // A channel with scAmount 0 opts out entirely (treat as no duck).
        const ducked = duckActive && ch.name !== this.scSource && ch.scAmount > 0 ? this.duck : null
        this.mixChannel(ch, outL, outR, cursor, n, ducked, ch.scAmount)
      }
      cursor = end
    }
    if (this.qHead > 0 && this.qHead >= q.length) {
      q.length = 0 // fully drained: reset in place, no allocation
      this.qHead = 0
    }

    // Shared send buses: each bus's FX chain processes the whole block of
    // summed sends, then its output is mixed into the master PRE gain/comp (so
    // a bus reverb sits inside the master glue, and — being fed pre-duck — does
    // not pump with the sidechain).
    for (let b = 0; b < this.busList.length; b++) {
      const bus = this.busList[b]!
      const aL = bus.accumL
      const aR = bus.accumR
      bus.post.processStereo(aL, aR, BLOCK)
      const g = bus.gain
      let ss = 0
      for (let i = 0; i < BLOCK; i++) {
        const l = aL[i]! * g
        const r = aR[i]! * g
        outL[i] = outL[i]! + l
        outR[i] = outR[i]! + r
        ss += l * l + r * r
      }
      bus.sumSq = ss
    }

    // Master stage: gain (one-block ramp), optional glue compressor, soft knee,
    // non-finite scrub. The compressor runs AFTER master gain and BEFORE the
    // limiter; it's stereo-linked (one gain from max|L|,|R|) so the image never
    // shifts, and its reduction state carries across blocks.
    const m0 = this.masterPrev
    const m1 = this.masterGain
    const mc = this.masterComp
    let gr = this.masterCompGr
    let nan = 0
    let ss = 0
    for (let i = 0; i < BLOCK; i++) {
      const g = m0 + (m1 - m0) * ((i + 1) / BLOCK)
      let l = outL[i]! * g
      let r = outR[i]! * g
      if (mc !== undefined) {
        const peak = Math.max(Math.abs(l), Math.abs(r))
        const db = peak > 0 ? 20 * Math.log10(peak) : -120
        const target = clamp(gainReductionDb(db, mc.threshold, mc.ratio, mc.knee), 0, 60)
        gr += (target - gr) * (target > gr ? mc.atk : mc.rel)
        const cg = Math.pow(10, -gr / 20) * mc.makeupLin
        l *= cg
        r *= cg
      }
      if (!Number.isFinite(l)) nan++
      if (!Number.isFinite(r)) nan++
      l = masterSafety(l)
      r = masterSafety(r)
      outL[i] = l
      outR[i] = r
      ss += l * l + r * r
    }
    this.masterPrev = m1
    this.masterCompGr = Number.isFinite(gr) ? gr : 0
    this.masterSumSq = ss
    if (nan > 0) {
      this.rateLimited('lastNanErrorFrame', start, `master: scrubbed ${nan} non-finite sample(s) this block`)
    }
  }

  /** Evaluate ch's active param ramps at the block start and push the values
   *  to the pool; completed ramps are swap-popped (allocation-free). */
  private advanceRamps(ch: Channel, start: number): void {
    const ramps = ch.ramps
    for (let i = ramps.length - 1; i >= 0; i--) {
      const r = ramps[i]!
      const v = rampValue(r, start)
      r.param.value = v
      ch.pool.setParam(r.name, v)
      if (start >= r.endFrame) {
        ramps[i] = ramps[ramps.length - 1]!
        ramps.pop()
      }
    }
  }

  /** Render n frames of ch into its scratch bus, then mix into the master at
   *  [cursor, cursor+n) through the channel strip. Strip ramps interpolate
   *  across the WHOLE block (t indexes cursor+i), so segment splits don't
   *  distort them; the constant path skips the per-sample trig. */
  private mixChannel(
    ch: Channel,
    outL: Float32Array,
    outR: Float32Array,
    cursor: number,
    n: number,
    duck: Float32Array | null,
    scAmount: number,
  ): void {
    const bufL = this.busL
    const bufR = this.busR
    bufL.fill(0, 0, n)
    bufR.fill(0, 0, n)
    ch.pool.process(bufL, bufR, n)
    // Per-synth FX post-chain: process the SUMMED voices once (shared reverb
    // tail etc.), in place, BEFORE the channel strip + sidechain duck.
    if (ch.post !== undefined) ch.post.processStereo(bufL, bufR, n)
    // Shared-bus sends: tap the raw post-FX (pre-strip, pre-duck) into each
    // target bus's block accumulator. Pre-duck so a reverb send doesn't pump.
    if (ch.sends.size > 0) {
      for (const [busName, amt] of ch.sends) {
        const bus = this.busByName.get(busName)
        if (bus === undefined) continue
        const aL = bus.accumL
        const aR = bus.accumR
        for (let i = 0; i < n; i++) {
          aL[cursor + i] = aL[cursor + i]! + bufL[i]! * amt
          aR[cursor + i] = aR[cursor + i]! + bufR[i]! * amt
        }
      }
    }
    // Effective duck multiplier for this channel: 1 - amount·(1 - duckLevel).
    // amount 1 → the raw duck envelope; amount 0 → 1 (never entered here,
    // duck is null then). Shared with the offline mirror in render-runner.
    let ss = ch.sumSq
    if (ch.g0 === ch.g1 && ch.p0 === ch.p1) {
      const gl = ch.g1 * Math.cos(ch.p1 * HALF_PI)
      const gr = ch.g1 * Math.sin(ch.p1 * HALF_PI)
      for (let i = 0; i < n; i++) {
        const d = duck === null ? 1 : 1 - scAmount * (1 - duck[cursor + i]!)
        const l = bufL[i]! * gl * d
        const r = bufR[i]! * gr * d
        outL[cursor + i] = outL[cursor + i]! + l
        outR[cursor + i] = outR[cursor + i]! + r
        ss += l * l + r * r
      }
    } else {
      for (let i = 0; i < n; i++) {
        const t = (cursor + i + 1) / BLOCK // reaches the target by block end
        const g = ch.g0 + (ch.g1 - ch.g0) * t
        const p = ch.p0 + (ch.p1 - ch.p0) * t
        const d = duck === null ? 1 : 1 - scAmount * (1 - duck[cursor + i]!)
        const l = bufL[i]! * g * Math.cos(p * HALF_PI) * d
        const r = bufR[i]! * g * Math.sin(p * HALF_PI) * d
        outL[cursor + i] = outL[cursor + i]! + l
        outR[cursor + i] = outR[cursor + i]! + r
        ss += l * l + r * r
      }
    }
    ch.sumSq = ss
  }

  private fire(ev: QueuedNote): void {
    const ch = this.byName.get(ev.synth)
    if (!ch) return // removeSynth purges its pending events; purely defensive
    if (ev.rank === RANK_ON) {
      ch.pool.noteOn(ev.note, ev.velocity)
      // Sidechain trigger, sample-accurate: the walk splits the block at this
      // event's frame, so resetting duckLevel here snaps the duck exactly at
      // the source noteOn's sample.
      if (ev.synth === this.scSource) this.duckLevel = 1 - this.scDepth
    } else {
      ch.pool.noteOff(ev.note)
      this.releaseRetiring(ev.synth, ev.note)
    }
  }

  /** Release `note` on any retired pool of `name` still holding it — otherwise
   *  a note gated on an old (retired) pool never gets its note-off and sustains
   *  forever (never reaped). A no-op where the note isn't present. Both the
   *  queued (fire) and immediate (msgNote) note-off paths call this. */
  private releaseRetiring(name: string, note: number): void {
    for (let i = 0; i < this.retiring.length; i++) {
      if (this.retiring[i]!.name === name) this.retiring[i]!.pool.noteOff(note)
    }
  }

  /* ---------------------------- control plane ---------------------------- */

  private dispatch(m: unknown): void {
    if (!isObj(m) || typeof m['kind'] !== 'string') {
      this.error(`malformed message (expected an object with a string 'kind')`, 'message')
      return
    }
    switch (m['kind']) {
      case 'defineSynth':
        return this.msgDefineSynth(m)
      case 'patchConstants':
        return this.msgPatchConstants(m)
      case 'removeSynth':
        return this.msgRemoveSynth(m)
      case 'noteOn':
        return this.msgNote(m, RANK_ON)
      case 'noteOff':
        return this.msgNote(m, RANK_OFF)
      case 'allNotesOff':
        return this.msgAllNotesOff()
      case 'setParam':
        return this.msgSetParam(m)
      case 'setChannel':
        return this.msgSetChannel(m)
      case 'setMaster':
        return this.msgSetMaster(m)
      case 'setSidechain':
        return this.msgSetSidechain(m)
      case 'clearSidechain':
        return this.msgClearSidechain()
      case 'loadSample':
        return this.msgLoadSample(m)
      case 'clearSample':
        return this.msgClearSample(m)
      case 'setMasterComp':
        return this.msgSetMasterComp(m)
      case 'clearMasterComp':
        return this.msgClearMasterComp()
      case 'defineBus':
        return this.msgDefineBus(m)
      case 'removeBus':
        return this.msgRemoveBus(m)
      case 'setSend':
        return this.msgSetSend(m)
      default:
        this.error(`unknown message kind '${m['kind']}'`, 'message')
    }
  }

  private msgDefineSynth(m: Record<string, unknown>): void {
    const name = m['name']
    if (typeof name !== 'string' || name.length === 0) {
      return this.error(`'name' must be a non-empty string`, 'defineSynth')
    }
    if (!isObj(m['graph'])) {
      return this.error(`'graph' must be a GraphSpec object`, `defineSynth '${name}'`)
    }
    const existing = this.byName.get(name)
    if (!existing && this.byName.size >= this.maxSynths) {
      return this.error(`synth limit reached (${this.maxSynths})`, `defineSynth '${name}'`)
    }
    let requested = DEFAULT_VOICES
    if (m['maxVoices'] !== undefined) {
      if (!fin(m['maxVoices'])) return this.error(`'maxVoices' must be a finite number`, `defineSynth '${name}'`)
      requested = Math.floor(m['maxVoices'])
    }
    // Voice budget: clamp to what the OTHER synths leave free (a same-name
    // replacement releases its own voices first).
    let others = 0
    for (const ch of this.list) if (ch !== existing) others += ch.voices
    const budget = MAX_TOTAL_VOICES - others
    if (budget < 1) {
      return this.error(`voice budget exhausted (${MAX_TOTAL_VOICES} total)`, `defineSynth '${name}'`)
    }
    const voices = Math.floor(clamp(requested, 1, budget))
    const graph = m['graph'] as unknown as GraphSpec
    const postGraph = isObj(m['post']) ? (m['post'] as unknown as GraphSpec) : undefined
    // voiceOpts (mono/glide/unison/...) is normalized host-side; the pool clamps
    // defensively, so a plain wire object is safe to pass straight through.
    const voiceOpts = isObj(m['voiceOpts']) ? (m['voiceOpts'] as unknown as VoiceOpts) : undefined
    let pool: VoicePool
    let post: PostChain | undefined
    try {
      // Compiles (validates + allocates) BEFORE touching the registry: a bad
      // graph (or post graph) leaves any existing synth of this name untouched.
      pool = new VoicePool(graph, this.ctx, voices, voiceOpts)
      post = postGraph !== undefined ? new PostChain(postGraph, this.ctx) : undefined
    } catch (e) {
      return this.error(
        `defineSynth '${name}' rejected: ${e instanceof Error ? e.message : String(e)}`,
        `defineSynth '${name}'`,
      )
    }
    const params = new Map<string, ParamState>()
    if (Array.isArray(graph.params)) {
      for (const p of graph.params) params.set(p.name, { min: p.min, max: p.max, value: p.default })
    }
    // Replacement keeps the channel strip (a live coder's fader shouldn't
    // jump on redefine) but resets params to the new graph's defaults and
    // drops in-flight ramps (the param set may have changed).
    const gain = existing?.gain ?? DEFAULT_CHANNEL_GAIN
    const pan = existing?.pan ?? DEFAULT_PAN
    // Don't cut ringing voices on a same-name redefine: retire the old channel
    // so its in-flight voices finish naturally (new notes use the new pool).
    // Bound the backlog — hard-stop the oldest retired pool past the cap.
    if (existing !== undefined && this.poolActive(existing.pool)) {
      while (this.retiring.length >= MAX_RETIRING) this.retiring.shift()!.pool.allNotesOff()
      this.retiring.push(existing)
    }
    this.byName.set(name, {
      name,
      pool,
      post,
      voices,
      gain,
      pan,
      gainPrev: existing?.gainPrev ?? gain,
      panPrev: existing?.panPrev ?? pan,
      g0: gain,
      g1: gain,
      p0: pan,
      p1: pan,
      params,
      ramps: [],
      sumSq: 0,
      // Preserve the sidechain response across a redefine (like the strip).
      scAmount: existing?.scAmount ?? 1,
      // Preserve send amounts too: a redefine shouldn't drop the synth's
      // routing into shared buses.
      sends: existing?.sends ?? new Map(),
    })
    this.rebuildList()
  }

  private msgPatchConstants(m: Record<string, unknown>): void {
    const name = m['name']
    if (typeof name !== 'string') return this.error(`'name' must be a string`, 'patchConstants')
    const ch = this.byName.get(name)
    if (!ch) return this.error(`unknown synth '${name}'`, 'patchConstants')
    const patches = m['patches']
    if (!Array.isArray(patches)) return this.error(`'patches' must be an array`, `patchConstants '${name}'`)
    const clean: { node: number; port: string; value: number }[] = []
    for (const p of patches) {
      if (isObj(p) && typeof p['node'] === 'number' && typeof p['port'] === 'string' && fin(p['value'])) {
        clean.push({ node: p['node'], port: p['port'], value: p['value'] })
      }
    }
    ch.pool.patchConstants(clean)
  }

  private msgRemoveSynth(m: Record<string, unknown>): void {
    const name = m['name']
    if (typeof name !== 'string') return this.error(`'name' must be a string`, 'removeSynth')
    if (!this.byName.delete(name)) {
      return this.error(`unknown synth '${name}'`, 'removeSynth')
    }
    // removeSynth is a hard stop — drop any retired pools of this name too.
    for (let i = this.retiring.length - 1; i >= 0; i--) {
      if (this.retiring[i]!.name === name) {
        this.retiring[i]!.pool.allNotesOff()
        this.retiring.splice(i, 1)
      }
    }
    this.rebuildList()
    // Purge queued events for the dropped synth so nothing fires (or errors)
    // later — including against a future same-name redefine.
    if (this.qHead > 0) {
      this.queue.splice(0, this.qHead)
      this.qHead = 0
    }
    this.queue = this.queue.filter((e) => e.synth !== name)
  }

  private msgDefineBus(m: Record<string, unknown>): void {
    const name = m['name']
    if (typeof name !== 'string' || name.length === 0) {
      return this.error(`'name' must be a non-empty string`, 'defineBus')
    }
    if (!isObj(m['graph'])) {
      return this.error(`'graph' must be a GraphSpec object`, `defineBus '${name}'`)
    }
    const existing = this.busByName.get(name)
    if (existing === undefined && this.busByName.size >= MAX_BUSES) {
      return this.error(`bus limit reached (${MAX_BUSES})`, `defineBus '${name}'`)
    }
    let gain = 1
    if (m['gain'] !== undefined) {
      if (!fin(m['gain'])) return this.error(`'gain' must be a finite number`, `defineBus '${name}'`)
      gain = m['gain'] as number
    }
    const graph = m['graph'] as unknown as GraphSpec
    let post: PostChain
    try {
      // Compile BEFORE touching the registry: a bad graph leaves any existing
      // bus of this name untouched (mirrors defineSynth's last-good guarantee).
      post = new PostChain(graph, this.ctx)
    } catch (e) {
      return this.error(
        `defineBus '${name}' rejected: ${e instanceof Error ? e.message : String(e)}`,
        `defineBus '${name}'`,
      )
    }
    // Reuse the old accumulators on redefine (they're just scratch), else fresh.
    this.busByName.set(name, {
      name,
      post,
      gain,
      accumL: existing?.accumL ?? new Float32Array(BLOCK),
      accumR: existing?.accumR ?? new Float32Array(BLOCK),
      sumSq: 0,
    })
    this.rebuildBusList()
  }

  private msgRemoveBus(m: Record<string, unknown>): void {
    const name = m['name']
    if (typeof name !== 'string') return this.error(`'name' must be a string`, 'removeBus')
    if (!this.busByName.delete(name)) {
      return this.error(`unknown bus '${name}'`, 'removeBus')
    }
    // Drop dangling sends into the removed bus (keeps the per-channel maps
    // tight); a send left pointing at a gone bus would be a no-op anyway.
    for (const ch of this.byName.values()) ch.sends.delete(name)
    this.rebuildBusList()
  }

  private msgSetSend(m: Record<string, unknown>): void {
    const synth = m['synth']
    const bus = m['bus']
    if (typeof synth !== 'string') return this.error(`'synth' must be a string`, 'setSend')
    if (typeof bus !== 'string') return this.error(`'bus' must be a string`, 'setSend')
    const ch = this.byName.get(synth)
    if (!ch) return this.error(`unknown synth '${synth}'`, `setSend '${synth}'->'${bus}'`)
    if (!this.busByName.has(bus)) return this.error(`unknown bus '${bus}'`, `setSend '${synth}'->'${bus}'`)
    if (!fin(m['amount'])) return this.error(`'amount' must be a finite number`, `setSend '${synth}'->'${bus}'`)
    const amount = clamp(m['amount'] as number, 0, 1)
    // Amount 0 removes the send so the audio-path tap loop stays minimal.
    if (amount === 0) ch.sends.delete(bus)
    else ch.sends.set(bus, amount)
  }

  private rebuildBusList(): void {
    this.busList = [...this.busByName.values()]
  }

  private msgNote(m: Record<string, unknown>, rank: number): void {
    const what = rank === RANK_ON ? 'noteOn' : 'noteOff'
    const ch = this.lookup(m, what)
    if (!ch) return
    const note = m['note']
    if (!fin(note)) return this.error(`'note' must be a finite number`, `${what} '${ch.name}'`)
    let velocity = 1
    if (m['velocity'] !== undefined) {
      if (!fin(m['velocity'])) return this.error(`'velocity' must be a finite number`, `${what} '${ch.name}'`)
      velocity = clamp(m['velocity'], 0, 1)
    }
    const at = m['atFrame']
    if (at !== undefined && !fin(at)) {
      return this.error(`'atFrame' must be a finite number`, `${what} '${ch.name}'`)
    }
    if (at !== undefined && at > this.frames) {
      this.enqueue(Math.floor(at), rank, ch.name, note, velocity)
    } else if (rank === RANK_ON) {
      ch.pool.noteOn(note, velocity)
      // Immediate (unqueued) source noteOn: snap the duck at the next block
      // start (offset 0) — this runs on the control plane between blocks.
      if (ch.name === this.scSource) this.duckLevel = 1 - this.scDepth
    } else {
      ch.pool.noteOff(note)
      this.releaseRetiring(ch.name, note)
    }
  }

  private msgAllNotesOff(): void {
    this.queue.length = 0
    this.qHead = 0
    for (const ch of this.list) ch.pool.allNotesOff()
  }

  private msgSetParam(m: Record<string, unknown>): void {
    const ch = this.lookup(m, 'setParam')
    if (!ch) return
    const name = m['name']
    if (typeof name !== 'string') return this.error(`'name' must be a string`, `setParam '${ch.name}'`)
    if (!fin(m['value'])) return this.error(`'value' must be a finite number`, `setParam '${ch.name}'`)
    // Unlike Voice.setParam (typo-tolerant by design — it runs on the audio
    // path), the engine has the spec at hand and tells the host about typos.
    const p = ch.params.get(name)
    if (!p) return this.error(`unknown param '${name}'`, `setParam '${ch.name}'`)
    let rampMs = 0
    if (m['rampMs'] !== undefined) {
      if (!fin(m['rampMs'])) return this.error(`'rampMs' must be a finite number`, `setParam '${ch.name}'`)
      rampMs = clamp(m['rampMs'], 0, MAX_RAMP_MS)
    }
    const target = clamp(m['value'], p.min, p.max)
    // A new set replaces any in-flight ramp on the same param, starting from
    // the ramp's current value (evaluated at the present frame).
    const ramps = ch.ramps
    for (let i = ramps.length - 1; i >= 0; i--) {
      if (ramps[i]!.name === name) {
        p.value = rampValue(ramps[i]!, this.frames)
        ramps[i] = ramps[ramps.length - 1]!
        ramps.pop()
      }
    }
    const durFrames = Math.round((rampMs / 1000) * this.ctx.sampleRate)
    if (durFrames < 1) {
      p.value = target
      ch.pool.setParam(name, target)
    } else {
      ramps.push({
        name,
        param: p,
        from: p.value,
        to: target,
        startFrame: this.frames,
        endFrame: this.frames + durFrames,
      })
    }
  }

  private msgSetChannel(m: Record<string, unknown>): void {
    const ch = this.lookup(m, 'setChannel')
    if (!ch) return
    const gain = m['gain']
    const pan = m['pan']
    const sidechain = m['sidechain']
    // Validate EVERYTHING before mutating ANYTHING: one message is one
    // atomic effect — {gain: 0, pan: 'x'} must not half-apply.
    if (gain !== undefined && !fin(gain)) {
      return this.error(`'gain' must be a finite number`, `setChannel '${ch.name}'`)
    }
    if (pan !== undefined && !fin(pan)) {
      return this.error(`'pan' must be a finite number`, `setChannel '${ch.name}'`)
    }
    if (sidechain !== undefined && !fin(sidechain)) {
      return this.error(`'sidechain' must be a finite number`, `setChannel '${ch.name}'`)
    }
    if (gain !== undefined) ch.gain = clamp(gain, 0, MAX_GAIN)
    if (pan !== undefined) ch.pan = clamp(pan, 0, 1)
    if (sidechain !== undefined) ch.scAmount = clamp(sidechain, 0, 1)
  }

  private msgSetMaster(m: Record<string, unknown>): void {
    if (!fin(m['gain'])) return this.error(`'gain' must be a finite number`, 'setMaster')
    this.masterGain = clamp(m['gain'], 0, MAX_GAIN)
  }

  private msgSetSidechain(m: Record<string, unknown>): void {
    const source = m['source']
    if (typeof source !== 'string' || source.length === 0) {
      return this.error(`'source' must be a non-empty string`, 'setSidechain')
    }
    // Validate EVERYTHING before mutating ANYTHING (atomic, like setChannel).
    let depth = DEFAULT_DUCK_DEPTH
    if (m['depth'] !== undefined) {
      if (!fin(m['depth'])) return this.error(`'depth' must be a finite number`, `setSidechain '${source}'`)
      depth = clamp(m['depth'], 0, 1)
    }
    let releaseMs = DEFAULT_DUCK_RELEASE_MS
    if (m['releaseMs'] !== undefined) {
      if (!fin(m['releaseMs'])) return this.error(`'releaseMs' must be a finite number`, `setSidechain '${source}'`)
      releaseMs = m['releaseMs']
    }
    this.scSource = source
    this.scDepth = depth
    this.scReleaseCoeff = duckReleaseCoeff(releaseMs, this.ctx.sampleRate)
  }

  private msgClearSidechain(): void {
    this.scSource = undefined
    this.duckLevel = 1
  }

  private msgLoadSample(m: Record<string, unknown>): void {
    const name = m['name']
    if (typeof name !== 'string' || name.length === 0) {
      return this.error(`'name' must be a non-empty string`, 'loadSample')
    }
    const data = m['data']
    if (!(data instanceof Float32Array)) {
      return this.error(`'data' must be a Float32Array`, `loadSample '${name}'`)
    }
    const sr = m['sampleRate']
    if (!fin(sr) || sr <= 0) {
      return this.error(`'sampleRate' must be a positive number`, `loadSample '${name}'`)
    }
    this.samples.set(name, data, sr)
  }

  private msgClearSample(m: Record<string, unknown>): void {
    const name = m['name']
    if (typeof name !== 'string' || name.length === 0) {
      return this.error(`'name' must be a non-empty string`, 'clearSample')
    }
    this.samples.delete(name)
  }

  private msgSetMasterComp(m: Record<string, unknown>): void {
    // Validate every provided field before mutating (atomic, like setSidechain).
    const numOr = (key: string, def: number): number | undefined => {
      if (m[key] === undefined) return def
      if (!fin(m[key])) {
        this.error(`'${key}' must be a finite number`, 'setMasterComp')
        return undefined
      }
      return m[key] as number
    }
    const threshold = numOr('threshold', -18)
    const ratio = numOr('ratio', 4)
    const attack = numOr('attack', 10)
    const release = numOr('release', 120)
    const knee = numOr('knee', 6)
    const makeup = numOr('makeup', 0)
    if (
      threshold === undefined || ratio === undefined || attack === undefined ||
      release === undefined || knee === undefined || makeup === undefined
    ) return // an error was already emitted
    const sr = this.ctx.sampleRate
    this.masterComp = {
      threshold,
      ratio: clamp(ratio, 1, 60),
      knee: Math.max(0, knee),
      atk: smoothCoeff(clamp(attack, 0.05, 500), sr),
      rel: smoothCoeff(clamp(release, 1, 3000), sr),
      makeupLin: Math.pow(10, makeup / 20),
    }
  }

  private msgClearMasterComp(): void {
    this.masterComp = undefined
    this.masterCompGr = 0
  }

  /** Resolve m['synth'] to a channel; emits an error and returns null when
   *  the field is malformed or names no live synth. */
  private lookup(m: Record<string, unknown>, what: string): Channel | null {
    const synth = m['synth']
    if (typeof synth !== 'string') {
      this.error(`'synth' must be a string`, what)
      return null
    }
    const ch = this.byName.get(synth)
    if (!ch) {
      this.error(`unknown synth '${synth}'`, what)
      return null
    }
    return ch
  }

  /** Sorted insertion by (frame, rank), stable for equal keys. Runs on the
   *  control plane — the splices are fine here and keep process() scan-free. */
  private enqueue(frame: number, rank: number, synthName: string, note: number, velocity: number): void {
    const q = this.queue
    if (this.qHead > 0) {
      q.splice(0, this.qHead) // compact fired entries before measuring size
      this.qHead = 0
    }
    if (q.length >= MAX_PENDING_EVENTS) {
      // Coalesced like the audio-path errors: a flood of scheduled events
      // must not turn into a flood of error events. At most one report per
      // second (in engine frames); it carries the drop count accumulated
      // since the last one. Drops between reports stay silent until the NEXT
      // drop past the rate window (accepted: overflow is a sustained
      // condition, not a one-shot).
      this.queueDropped++
      if (this.frames - this.lastQueueErrorFrame >= this.ctx.sampleRate) {
        this.lastQueueErrorFrame = this.frames
        this.error(
          `event queue full (${MAX_PENDING_EVENTS} pending): dropped ${this.queueDropped} event(s) since last report`,
          'noteQueue',
        )
        this.queueDropped = 0
      }
      return
    }
    let lo = 0
    let hi = q.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const e = q[mid]!
      if (e.frame < frame || (e.frame === frame && e.rank <= rank)) lo = mid + 1
      else hi = mid
    }
    q.splice(lo, 0, { frame, rank, synth: synthName, note, velocity })
  }

  private rebuildList(): void {
    this.list = this.retiring.length === 0 ? [...this.byName.values()] : [...this.byName.values(), ...this.retiring]
  }

  /** True if any voice in the pool is still sounding (or in its release tail). */
  private poolActive(pool: VoicePool): boolean {
    const vs = pool.voices
    for (let i = 0; i < vs.length; i++) if (vs[i]!.active) return true
    return false
  }

  /** Emit at most one error per second (in engine frames) for high-frequency
   *  audio-path failure modes. `key` names the per-source timestamp field. */
  private rateLimited(key: 'lastNanErrorFrame' | 'lastProcErrorFrame', frame: number, message: string): void {
    if (frame - this[key] < this.ctx.sampleRate) return
    this[key] = frame
    this.error(message, 'process')
  }

  private error(message: string, context?: string): void {
    const ev: { kind: 'error'; message: string; context?: string; id?: string } = { kind: 'error', message }
    if (context !== undefined) ev.context = context
    if (this.msgId !== undefined) ev.id = this.msgId
    this.emit(ev)
  }

  private emit(ev: EngineEvent): void {
    const cb = this.onEvent
    if (!cb) return
    try {
      cb(ev)
    } catch {
      // a throwing host listener must never take down the engine
    }
  }
}
