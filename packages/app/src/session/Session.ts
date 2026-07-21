import { Scheduler } from '@rondocode/pattern'
import type { SchedulerEvent } from '@rondocode/pattern'
import { diffGraphConstants } from '@rondocode/engine'
import type { EngineEvent, EngineMessage, SynthDef } from '@rondocode/engine'

/** Coalesce window for live (widget/scrub) synth REBUILDS. A structural or
 *  kernel-config change can't be hot-patched, so it redefines the synth
 *  (rebuilding its voice pool) — during a drag that would stutter, so live
 *  rebuilds are debounced to fire once movement settles. Constant-only changes
 *  bypass this entirely (patchConstants, applied immediately/continuously). */
const REBUILD_DEBOUNCE_MS = 120
import { clampCps, evalCode } from './evalCode'
import type { Diagnostic, EvalResult } from './evalCode'
import { baseScope } from './scope'

/* ------------------------------------------------------------------------- *
 * Session: the stateful command layer between code text and live sound.
 * This exact API is later exposed over the MCP bridge ("one API, two
 * clients"), so it is deliberately DOM-free: the audio side is injected as
 * an AudioSessionLike (the real AudioSession satisfies it; tests use a
 * message log).
 *
 * Responsibilities:
 * - evalCode(): run the pure evaluator, and ON SUCCESS ONLY diff the staged
 *   registrations against live state — defineSynth for new/changed graphs
 *   (JSON equality, so an unrelated re-eval never drops voices by
 *   redefining an unchanged synth), removeSynth for vanished ones,
 *   scheduler setPattern/removePattern likewise. A failed eval sends
 *   NOTHING and changes NOTHING (last-good-version contract).
 * - Scheduler wiring: pattern time comes from the audio clock
 *   (currentTimeFrames / sampleRate → monotonic seconds); fired events
 *   become noteOn/noteOff (atFrame = timeSec · sampleRate) plus setParam
 *   for numeric non-transport controls. setParam carries no atFrame in the
 *   v1 protocol, so patterned params apply when the message arrives —
 *   up to one lookahead (~100ms) early; acceptable v1 approximation.
 *   Events lacking a `sound` or a numeric `note` are skipped silently
 *   (nothing to route — continuous/param-only patterns are normal).
 * - Diagnostics: the Session maintains ONE merged current-diagnostics set
 *   and every onDiagnostics call carries the FULL set. It has two parts:
 *   the eval subset (replaced wholesale by each eval's diagnostics) and
 *   runtime diagnostics (source 'scheduler'/'engine'), keyed by
 *   (source, message) — a persistently failing pattern reports once, not
 *   at tick rate. POLICY: runtime diagnostics clear on the next SUCCESSFUL
 *   eval (the program changed; old runtime failures are stale), and
 *   survive failed evals (the live program still has them).
 *   The Session takes ownership of audio.onEvent (single-listener by
 *   design — see AudioSession); UI subscribes through the Session —
 *   opts.onEngineEvent passes the raw stream (meters etc.) through,
 *   error events included (they ALSO become diagnostics).
 * ------------------------------------------------------------------------- */

/** The slice of AudioSession the Session needs — injectable for tests. */
export interface AudioSessionLike {
  send(msg: EngineMessage): void
  /** Session assigns this in its constructor (takes ownership). */
  onEvent?: (ev: EngineEvent) => void
  /** Audio "now" in context frames (monotonic while running). */
  readonly currentTimeFrames: number
  readonly sampleRate: number
}

export interface SessionState {
  playing: boolean
  cps: number
  synths: string[]
  patterns: string[]
  lastError?: string
}

/** One value-probe target: a modulation expression the evaluator tagged, so the
 *  editor can show its live value inline. `node` is the voice-graph node id
 *  (what setProbes / probe events use); [from, to) is its source char-range. */
export interface ProbeTarget {
  synth: string
  node: number
  from: number
  to: number
}

type SetIntervalImpl = (fn: () => void, ms: number) => unknown
type ClearIntervalImpl = (handle: unknown) => void

export interface SessionOpts {
  audio: AudioSessionLike
  /** Receives the FULL merged current-diagnostics set (possibly []) on
   *  every change — see the module doc for merge/clear policy. */
  onDiagnostics?: (d: Diagnostic[]) => void
  /** Fired after any state-changing operation (eval — applied OR failed —,
   *  transport, new runtime error). */
  onState?: (s: SessionState) => void
  /** Raw engine event passthrough (meters, errors) for UI consumers; error
   *  events are also consumed into the diagnostics channel. */
  onEngineEvent?: (ev: EngineEvent) => void
  /** Each scheduler onEvents batch, AFTER the engine messages were sent —
   *  events carry loc + timeSec so the editor can flash originating text.
   *  Exceptions thrown by the hook are swallowed (a UI rendering bug must
   *  not take down the scheduler tick). */
  onPatternEvents?: (evs: SchedulerEvent[]) => void
  /** Fired on every SUCCESSFUL eval with the staged WGSL shader source (or
   *  null when the program registers no visual()) plus the current synth names
   *  — the GPU visualizer generates per-synth hit_<name> channels from them and
   *  recompiles live. Not fired on a failed eval (last-good). */
  onVisual?: (wgsl: string | null, synths: string[]) => void
  /** Fired on every SUCCESSFUL eval with the value-probe targets: every
   *  modulation expression the evaluator tagged (synth + voice-graph node id +
   *  source char-range). The editor picks which to show as live readouts and
   *  calls setProbes; `[]` when the program has none. Not fired on a failed
   *  eval (last-good). */
  onProbes?: (targets: ProbeTarget[]) => void
  /** Timer injection for tests; provide BOTH or NEITHER (defaults to
   *  globalThis timers). */
  setIntervalImpl?: SetIntervalImpl
  clearIntervalImpl?: ClearIntervalImpl
  /** Seconds to anchor cycle 0 ahead of the audio clock on play() so the
   *  first onset queues and fires cleanly instead of being swallowed by a
   *  just-started graph. Default 0.1. Tests that assert exact frames pass 0. */
  startLead?: number
}

/** Control keys that are NOT synth params (mirrors scripts/demo-render.ts). */
const NON_PARAM_KEYS = new Set(['n', 'note', 'sound', 'gain', 'pan', 'dur', 'slide', 'loc'])

/** See dispatchEvents: guaranteed low-gate window between back-to-back
 *  same-note events so envelopes re-attack. */
const GATE_GAP_SEC = 0.005
/** How far a slide note's release is pushed PAST the next note's onset, so the
 *  gate is still held when that note fires (making it glide) but drops right
 *  after — a small tie, not a whole extra step. */
const SLIDE_OVERLAP_SEC = 0.03
/** Safety cap on how long a deferred slide note holds if no next note ever
 *  arrives (prevents a stuck gate at pattern end / on a long gap). */
const MAX_SLIDE_HOLD_SEC = 4

export class Session {
  private readonly audio: AudioSessionLike
  private readonly onDiagnostics: ((d: Diagnostic[]) => void) | undefined
  private readonly onState: ((s: SessionState) => void) | undefined
  private readonly onEngineEvent: ((ev: EngineEvent) => void) | undefined
  private readonly onPatternEvents: ((evs: SchedulerEvent[]) => void) | undefined
  private readonly onVisual: ((wgsl: string | null, synths: string[]) => void) | undefined
  private readonly onProbes: ((targets: ProbeTarget[]) => void) | undefined
  private readonly setIntervalImpl: SetIntervalImpl | undefined
  private readonly clearIntervalImpl: ClearIntervalImpl | undefined
  private readonly scheduler: Scheduler

  /** Live synths: name → JSON.stringify(graph), the diffing fingerprint. */
  private readonly liveSynths = new Map<string, string>()
  /** Last-APPLIED def per live synth — the base a re-eval diffs against to
   *  decide hot-patch (constants only) vs rebuild (defineSynth). */
  private readonly liveDefs = new Map<string, SynthDef>()
  /** Synths awaiting a coalesced live rebuild (name → latest def). */
  private readonly pendingRebuilds = new Map<string, SynthDef>()
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined
  /** JSON fingerprint of the live sidechain config (undefined = none). */
  private liveSidechain: string | undefined
  /** Per-synth sidechain duck amounts last sent via setChannel — the diff
   *  base so an unchanged amount isn't resent and a dropped one resets to 1. */
  private liveScAmounts = new Map<string, number>()
  /** JSON fingerprint of the live master-comp config (undefined = none). */
  private liveMasterComp: string | undefined
  /** Live send buses: name → JSON.stringify(BusDef), the diffing fingerprint. */
  private readonly liveBuses = new Map<string, string>()
  /** Live per-synth sends: `${synth} ${bus}` → amount, the diff base so an
   *  unchanged send isn't resent and a dropped one resets to 0. */
  private liveSends = new Map<string, number>()
  /** Slide notes whose release is deferred until the synth's next note lands
   *  (adaptive 303 slide): synth name -> the held slide note. */
  private readonly pendingSlide = new Map<string, number>()
  /** Eval subset of the merged diagnostics (replaced by every eval). */
  private evalDiags: Diagnostic[] = []
  /** Runtime diagnostics keyed by `source message` for dedup. */
  private readonly runtimeDiags = new Map<string, Diagnostic>()
  private playing = false
  private lastGoodSource = ''
  private lastAttemptedSource = ''
  private lastError: string | undefined

  constructor(opts: SessionOpts) {
    if ((opts.setIntervalImpl === undefined) !== (opts.clearIntervalImpl === undefined)) {
      throw new TypeError('Session: provide both setIntervalImpl and clearIntervalImpl, or neither')
    }
    this.audio = opts.audio
    this.onDiagnostics = opts.onDiagnostics
    this.onState = opts.onState
    this.onEngineEvent = opts.onEngineEvent
    this.onPatternEvents = opts.onPatternEvents
    this.onVisual = opts.onVisual
    this.onProbes = opts.onProbes
    this.setIntervalImpl = opts.setIntervalImpl
    this.clearIntervalImpl = opts.clearIntervalImpl

    this.scheduler = new Scheduler({
      getTime: () => this.audio.currentTimeFrames / this.audio.sampleRate,
      // Anchor cycle 0 a lookahead ahead of "now" so the first onset is a
      // future-timestamped event the engine queues and fires cleanly, instead
      // of a past-due one that fires immediately into a just-started graph and
      // gets swallowed (the missing first stab). ~100ms is imperceptible.
      startLead: opts.startLead ?? 0.1,
      onEvents: (evs) => {
        this.dispatchEvents(evs)
        try {
          this.onPatternEvents?.(evs)
        } catch {
          // UI hook failures must not break the tick (see SessionOpts doc)
        }
      },
      onError: (name, error) => {
        const msg = error instanceof Error ? error.message : String(error)
        this.reportRuntime('scheduler', name === '*' ? msg : `pattern '${name}': ${msg}`)
      },
    })

    // Take ownership of the engine event stream (single listener by design).
    this.audio.onEvent = (ev) => {
      if (ev.kind === 'error') this.reportRuntime('engine', ev.message)
      this.onEngineEvent?.(ev)
    }
  }

  /**
   * Evaluate source and, when ok, apply the staged registrations to live
   * state (see module doc for the diffing rules). Diagnostics — including
   * an empty list on a clean eval — always reach onDiagnostics. On failure
   * nothing is sent and nothing changes; the result carries the details.
   */
  evalCode(source: string, opts?: { live?: boolean }): EvalResult {
    this.lastAttemptedSource = source
    const result = evalCode(source, baseScope)
    this.evalDiags = result.diagnostics
    // Runtime diagnostics describe the PREVIOUS program: stale once a new
    // one applies. A failed eval leaves the old program (and its runtime
    // failures) live, so they survive.
    if (result.ok) this.runtimeDiags.clear()
    this.emitDiagnostics()
    if (!result.ok) {
      this.lastError = result.diagnostics.find((d) => d.severity === 'error')?.message
      this.onState?.(this.getState())
      return result
    }

    // Shader visualizer source (or null) + the program's synth names (for
    // per-synth hit_<name> channels). The GPU layer dedupes and only recompiles
    // when the effective shader changed, so firing on every successful eval
    // (including live widget scrubs) is safe.
    this.onVisual?.(result.visual ?? null, [...result.synths.keys()])

    // Value-probe targets: every modulation expression the evaluator tagged
    // (SynthDef.nodeLocs). The editor filters these to the ones worth a live
    // readout and calls setProbes. Cheap; fired on every successful eval so the
    // spans track edits/scrubs.
    if (this.onProbes !== undefined) {
      const targets: ProbeTarget[] = []
      for (const [synth, def] of result.synths) {
        const locs = def.nodeLocs
        if (locs === undefined) continue
        for (const [id, span] of Object.entries(locs)) targets.push({ synth, node: Number(id), from: span[0], to: span[1] })
      }
      this.onProbes(targets)
    }

    // Synths: hot-patch when only input constants changed (live sweep, no
    // rebuild); else defineSynth (new/structural/config change); remove
    // vanished. Fingerprint keys on graph + post + voiceOpts + maxVoices so a
    // changed post-chain or voice mode re-defines the synth.
    const live = opts?.live === true
    for (const [name, def] of result.synths) {
      const json = JSON.stringify({ graph: def.graph, post: def.post, voiceOpts: def.voiceOpts, maxVoices: def.maxVoices })
      if (this.liveSynths.get(name) === json) continue // unchanged vs last applied
      const prev = this.liveDefs.get(name)
      // Patchable only if it already exists, isn't mid-rebuild, and only its
      // voice-graph input constants changed (post/voiceOpts/maxVoices equal).
      const structuralSame =
        prev !== undefined &&
        !this.pendingRebuilds.has(name) &&
        JSON.stringify(prev.post ?? null) === JSON.stringify(def.post ?? null) &&
        JSON.stringify(prev.voiceOpts ?? null) === JSON.stringify(def.voiceOpts ?? null) &&
        (prev.maxVoices ?? null) === (def.maxVoices ?? null)
      const patches = structuralSame ? diffGraphConstants(prev.graph, def.graph) : null
      if (patches !== null) {
        if (patches.length > 0) this.audio.send({ kind: 'patchConstants', name, patches })
        this.liveDefs.set(name, def)
        this.liveSynths.set(name, json)
      } else if (live && this.liveSynths.has(name)) {
        // rebuild needed mid-drag — coalesce to avoid rebuild-spam/stutter
        this.pendingRebuilds.set(name, def)
        this.armRebuild()
      } else {
        this.defineSynthNow(name, def, json)
      }
    }
    for (const name of [...this.liveSynths.keys()]) {
      if (!result.synths.has(name)) {
        this.audio.send({ kind: 'removeSynth', name })
        this.liveSynths.delete(name)
        this.liveDefs.delete(name)
        this.pendingRebuilds.delete(name)
      }
    }

    // Patterns: hot-swap wholesale (cheap, and takes effect next tick).
    for (const [name, pat] of result.patterns) this.scheduler.setPattern(name, pat)
    for (const name of this.scheduler.patterns()) {
      if (!result.patterns.has(name)) this.scheduler.removePattern(name)
    }

    if (result.cps !== undefined) this.scheduler.setCps(result.cps)

    // Sidechain: send setSidechain on new/changed config, clearSidechain when
    // it vanishes — same apply-on-ok, diff-and-send discipline as synths.
    const scJson = result.sidechain !== undefined ? JSON.stringify(result.sidechain) : undefined
    if (scJson !== this.liveSidechain) {
      if (result.sidechain !== undefined) {
        const { source, depth, releaseMs } = result.sidechain
        this.audio.send({ kind: 'setSidechain', source, depth, releaseMs })
      } else {
        this.audio.send({ kind: 'clearSidechain' })
      }
      // Per-channel duck amounts: setChannel(sidechain) for new/changed
      // entries, reset a dropped synth to full duck (1). Guarded on live
      // synths — the amounts map races renames/removals like any control.
      const newAmounts = result.sidechain?.amounts ?? {}
      for (const [synth, amount] of Object.entries(newAmounts)) {
        if (this.liveScAmounts.get(synth) !== amount && this.liveSynths.has(synth)) {
          this.audio.send({ kind: 'setChannel', synth, sidechain: amount })
        }
      }
      for (const synth of this.liveScAmounts.keys()) {
        if (!(synth in newAmounts) && this.liveSynths.has(synth)) {
          this.audio.send({ kind: 'setChannel', synth, sidechain: 1 })
        }
      }
      this.liveScAmounts = new Map(Object.entries(newAmounts))
      this.liveSidechain = scJson
    }

    // Master glue compressor: same diff-and-send discipline — setMasterComp on
    // new/changed config, clearMasterComp when it vanishes.
    const mcJson = result.masterComp !== undefined ? JSON.stringify(result.masterComp) : undefined
    if (mcJson !== this.liveMasterComp) {
      if (result.masterComp !== undefined) {
        this.audio.send({ kind: 'setMasterComp', ...result.masterComp })
      } else {
        this.audio.send({ kind: 'clearMasterComp' })
      }
      this.liveMasterComp = mcJson
    }

    // Shared send buses: defineBus on new/changed, removeBus when vanished —
    // same apply-on-ok, diff-and-send discipline as synths. Buses are applied
    // BEFORE sends so a send never references a not-yet-defined bus.
    for (const [name, def] of result.buses) {
      const json = JSON.stringify(def)
      if (this.liveBuses.get(name) === json) continue
      this.audio.send({ kind: 'defineBus', name, graph: def.graph, gain: def.gain })
      this.liveBuses.set(name, json)
    }
    for (const name of [...this.liveBuses.keys()]) {
      if (!result.buses.has(name)) {
        this.audio.send({ kind: 'removeBus', name })
        this.liveBuses.delete(name)
      }
    }

    // Sends: setSend for new/changed routes, reset a dropped route to 0 — but
    // only while both endpoints still exist (removeBus/removeSynth already drop
    // the routing engine-side, and setSend to a gone endpoint would error).
    const sendKey = (synth: string, bus: string): string => `${synth} ${bus}`
    const newSends = new Map<string, number>()
    for (const s of result.sends) newSends.set(sendKey(s.synth, s.bus), s.amount)
    for (const s of result.sends) {
      const key = sendKey(s.synth, s.bus)
      if (this.liveSends.get(key) === s.amount) continue
      if (this.liveSynths.has(s.synth) && this.liveBuses.has(s.bus)) {
        this.audio.send({ kind: 'setSend', synth: s.synth, bus: s.bus, amount: s.amount })
      }
    }
    for (const key of this.liveSends.keys()) {
      if (newSends.has(key)) continue
      const sep = key.indexOf(' ')
      const synth = key.slice(0, sep)
      const bus = key.slice(sep + 1)
      if (this.liveSynths.has(synth) && this.liveBuses.has(bus)) {
        this.audio.send({ kind: 'setSend', synth, bus, amount: 0 })
      }
    }
    this.liveSends = newSends

    this.lastGoodSource = source
    this.lastError = undefined
    this.onState?.(this.getState())
    return result
  }

  /** The last successfully APPLIED source — the live truth an MCP get_code
   *  should report. (The current editor buffer is the editor's concern.) */
  get code(): string {
    return this.lastGoodSource
  }

  /** The last source handed to evalCode, good or not. */
  get lastAttempted(): string {
    return this.lastAttemptedSource
  }

  /** Send defineSynth NOW and record it as the live def/fingerprint. */
  private defineSynthNow(name: string, def: SynthDef, json: string): void {
    const msg: Extract<EngineMessage, { kind: 'defineSynth' }> = { kind: 'defineSynth', name, graph: def.graph }
    if (def.post !== undefined) msg.post = def.post
    if (def.voiceOpts !== undefined) msg.voiceOpts = def.voiceOpts
    if (def.maxVoices !== undefined) msg.maxVoices = def.maxVoices
    this.audio.send(msg)
    this.liveDefs.set(name, def)
    this.liveSynths.set(name, json)
    this.pendingRebuilds.delete(name)
  }

  private armRebuild(): void {
    if (this.rebuildTimer !== undefined) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined
      for (const [name, def] of [...this.pendingRebuilds]) {
        const json = JSON.stringify({ graph: def.graph, post: def.post, voiceOpts: def.voiceOpts, maxVoices: def.maxVoices })
        this.defineSynthNow(name, def, json)
      }
      this.pendingRebuilds.clear()
    }, REBUILD_DEBOUNCE_MS)
  }

  /** Set a live synth param. `addr` is "synthName.paramName" (split at the
   *  FIRST dot — param names may not contain dots). Throws on a malformed
   *  address: this is programmatic API misuse, not user-code failure. */
  setParam(addr: string, value: number, rampMs?: number): void {
    const dot = addr.indexOf('.')
    if (dot <= 0 || dot === addr.length - 1) {
      throw new TypeError(`setParam: addr must be 'synth.param', got '${addr}'`)
    }
    const synth = addr.slice(0, dot)
    const name = addr.slice(dot + 1)
    this.audio.send(
      rampMs !== undefined
        ? { kind: 'setParam', synth, name, value, rampMs }
        : { kind: 'setParam', synth, name, value },
    )
  }

  /** Set which of a synth's voice-graph nodes the engine value-probes (the
   *  editor's live readouts). Replaces the synth's whole set; `[]` clears it.
   *  Probe values arrive as `probe` engine events through onEngineEvent. */
  setProbes(synth: string, nodes: number[]): void {
    this.audio.send({ kind: 'setProbes', synth, nodes })
  }

  /** Per-synth channel strip (mixer): thin passthrough to the engine's
   *  setChannel. An UNKNOWN synth is a silent no-op (console.warn only):
   *  mixer sliders and MCP callers race live-coding evals that rename and
   *  remove synths constantly, and a control bound to a just-removed name
   *  must be forgiven, not throw mid-performance. (Contrast setParam, whose
   *  malformed-address throw flags programmer error, not a race.) */
  setChannel(synth: string, opts: { gain?: number; pan?: number }): void {
    if (!this.liveSynths.has(synth)) {
      console.warn(`[session] setChannel: unknown synth '${synth}' (ignored)`)
      return
    }
    const msg: Extract<EngineMessage, { kind: 'setChannel' }> = { kind: 'setChannel', synth }
    if (opts.gain !== undefined) msg.gain = opts.gain
    if (opts.pan !== undefined) msg.pan = opts.pan
    this.audio.send(msg)
  }

  /** play: (re)start the scheduler at cycle 0 and begin ticking every 25ms.
   *  stop: halt ticking and panic (allNotesOff). cps, when given, is
   *  clamped to [0.05, 4] like setCps. */
  transport(cmd: 'play' | 'stop', opts?: { cps?: number }): void {
    if (opts?.cps !== undefined) this.scheduler.setCps(clampCps(opts.cps))
    if (cmd === 'play') {
      if (this.setIntervalImpl !== undefined && this.clearIntervalImpl !== undefined) {
        this.scheduler.start(this.setIntervalImpl, this.clearIntervalImpl)
      } else {
        this.scheduler.start()
      }
      this.playing = true
    } else {
      this.scheduler.stop()
      this.audio.send({ kind: 'allNotesOff' })
      this.pendingSlide.clear() // deferred slide releases are moot after a panic
      this.playing = false
    }
    this.onState?.(this.getState())
  }

  getState(): SessionState {
    const s: SessionState = {
      playing: this.playing,
      cps: this.scheduler.cps,
      synths: [...this.liveSynths.keys()],
      patterns: this.scheduler.patterns(),
    }
    if (this.lastError !== undefined) s.lastError = this.lastError
    return s
  }

  /** TERMINAL: stop ticking, silence everything, release the engine event
   *  stream, and forget all registrations — getState() afterwards reports
   *  an empty stopped session. A disposed Session must not be reused
   *  (create a new one); no removeSynth messages are sent, since disposal
   *  normally accompanies audio teardown. */
  dispose(): void {
    this.scheduler.stop()
    this.audio.send({ kind: 'allNotesOff' })
    this.audio.onEvent = undefined
    this.playing = false
    if (this.rebuildTimer !== undefined) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = undefined
    this.pendingRebuilds.clear()
    this.liveSynths.clear()
    this.liveDefs.clear()
    this.liveSidechain = undefined
    this.liveScAmounts.clear()
    this.liveMasterComp = undefined
    this.liveBuses.clear()
    this.liveSends = new Map()
    this.pendingSlide.clear()
    for (const name of this.scheduler.patterns()) this.scheduler.removePattern(name)
  }

  /** SchedulerEvents → engine messages (see module doc for the mapping). */
  private dispatchEvents(evs: SchedulerEvent[]): void {
    const sr = this.audio.sampleRate
    const overlap = Math.round(SLIDE_OVERLAP_SEC * sr)
    for (const ev of evs) {
      const sound = ev.controls.sound
      const note = ev.controls.note
      if (typeof sound !== 'string' || typeof note !== 'number') continue
      const atFrame = Math.round(ev.timeSec * sr)
      // ADAPTIVE SLIDE: if a slide note is pending for this synth, release it
      // JUST as this note's gate opens (+overlap) so the still-held gate makes a
      // mono+glide synth portamento into this note. Because live events arrive
      // per tick, we defer a slide note's release (below) and resolve it here
      // when its next note lands — bridging any gap, not just adjacent notes.
      const pending = this.pendingSlide.get(sound)
      if (pending !== undefined) {
        this.audio.send({ kind: 'noteOff', synth: sound, note: pending, atFrame: atFrame + overlap })
        this.pendingSlide.delete(sound)
      }
      for (const [key, value] of Object.entries(ev.controls)) {
        if (NON_PARAM_KEYS.has(key) || typeof value !== 'number') continue
        this.audio.send({ kind: 'setParam', synth: sound, name: key, value })
      }
      const velocity = typeof ev.controls.gain === 'number' ? ev.controls.gain : 1
      this.audio.send({ kind: 'noteOn', synth: sound, note, velocity, atFrame })
      const slide = typeof ev.controls.slide === 'number' && ev.controls.slide > 0
      if (slide) {
        // Defer the release: hold until the NEXT note for this synth arrives
        // (resolved above). A safety noteOff far out prevents a stuck note if
        // no next note ever comes; whichever fires first wins, the other is a
        // no-op in the engine.
        this.pendingSlide.set(sound, note)
        this.audio.send({ kind: 'noteOff', synth: sound, note, atFrame: atFrame + Math.round(MAX_SLIDE_HOLD_SEC * sr) })
      } else {
        // Gate gap: shorten the gate slightly so back-to-back events on the
        // SAME note leave a low-gate window between them, so the retriggered
        // voice's ADSR re-attacks (a four-on-the-floor kick would otherwise
        // play once and go silent). Legato ties are available via dur > 1.
        const gateSec = Math.max(GATE_GAP_SEC, ev.durSec - GATE_GAP_SEC)
        this.audio.send({ kind: 'noteOff', synth: sound, note, atFrame: Math.round((ev.timeSec + gateSec) * sr) })
      }
    }
  }

  /** Emit the full merged diagnostics set (eval subset first). */
  private emitDiagnostics(): void {
    this.onDiagnostics?.([...this.evalDiags, ...this.runtimeDiags.values()])
  }

  /** Add a runtime diagnostic, deduplicated by (source, message): a
   *  recurring identical failure (e.g. a pattern throwing every 25ms tick)
   *  emits nothing after its first report — neither diagnostics nor
   *  onState — until a successful eval clears the set. */
  private reportRuntime(source: 'scheduler' | 'engine', message: string): void {
    const key = `${source} ${message}`
    if (this.runtimeDiags.has(key)) return
    this.lastError = message
    this.runtimeDiags.set(key, { line: 1, col: 1, message, severity: 'error', source })
    this.emitDiagnostics()
    this.onState?.(this.getState())
  }
}
