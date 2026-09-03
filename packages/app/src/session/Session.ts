import { Scheduler, setMacroValue } from '@rondocode/pattern'
import { DEFAULT_TIME_SIG } from '@rondocode/pattern'
import type { ControlMap, SchedulerEvent, TimeSig } from '@rondocode/pattern'
import { DEFAULT_MASTER_GAIN, MAX_TOTAL_VOICES, RESERVED_PARAM_NAMES, diffGraphConstants, diffParamDefaults, graphShape, getCustomWavetables, parseSampleRef, planVoiceBudget, sampleNamesIn } from '@rondocode/engine'
import type { EngineEvent, EngineMessage, SynthDef } from '@rondocode/engine'

/** Coalesce window for live (widget/scrub) synth REBUILDS. A structural or
 *  kernel-config change can't be hot-patched, so it redefines the synth
 *  (rebuilding its voice pool) — during a drag that would stutter, so live
 *  rebuilds are debounced to fire once movement settles. Constant-only changes
 *  bypass this entirely (patchConstants, applied immediately/continuously). */
export const REBUILD_DEBOUNCE_MS = 120
import { ensureDdspModels, ddspModelNamesInGraph } from '../audio/ddspModels'
import { EXTERNAL_OUTPUTS, clampCps, evalCode } from './evalCode'
import type { Diagnostic, EvalResult } from './evalCode'
import { baseScope } from './scope'
import type { MaskFrame } from '../mask/frame'
import type { MaskDrawFn } from '../mask/music'

export { EXTERNAL_OUTPUTS }

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
 *   for numeric non-transport controls, ALL stamped with the same atFrame.
 *   The engine fires params before noteOn at equal frames, so a note opens
 *   on its own patterned values. (Until #334 setParam carried no atFrame and
 *   applied on arrival, up to one lookahead early — automation landed on the
 *   previous note, and live disagreed with an offline bounce.)
 *   An event with a `sound` but no numeric `note` is AUTOMATION: its params
 *   are sent and no gate opens (what sing() stacks under its trigger so a
 *   patterned post param moves through the phrase). An event with no
 *   `sound` is skipped silently (nothing to route).
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
  /** Load raw mono PCM as a named sample. Optional: when present (the real
   *  AudioSession), loads also register in the main-thread PCM store the
   *  bounce path reads, so features that deliver samples (ddsp body IRs)
   *  render offline exactly as live. Absent = host without sample support. */
  loadSamplePcm?(name: string, data: Float32Array, sampleRate: number): void
  /** Session assigns this in its constructor (takes ownership). */
  onEvent?: (ev: EngineEvent) => void
  /** Audio "now" in context frames (monotonic while running). */
  readonly currentTimeFrames: number
  readonly sampleRate: number
  /** Sample names loaded so far. Optional: a host that cannot answer simply
   *  gets no missing-sample warnings, rather than a wrong list of them. */
  getSamples?(): { name: string }[]
}

export interface SessionState {
  playing: boolean
  cps: number
  /** The project's meter (4/4 unless the code says otherwise). A cycle is one
   *  BAR, so this is how many quarter notes a cycle spans — what the header
   *  tempo field, the MIDI clock and MIDI export all convert against. */
  timeSig: TimeSig
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

/** Who is holding a param away from the pattern: a finger on a widget, or a
 *  mapped hardware control. See heldParams for why they are distinguished. */
export type ParamOwner = 'touch' | 'midi'

/** One declared, settable param of a live synth: what a control surface binds
 *  to and the range/curve it has to scale onto. */
export interface ParamTarget {
  synth: string
  param: string
  default: number
  min: number
  max: number
  curve: 'lin' | 'log'
  /** true when the param lives in the synth's POST chain (shared per synth,
   *  and NOT reachable from a pattern's `.ctrl`). */
  post?: boolean
  /** true when this site came from a project-wide macro() rather than the
   *  synth's own param(): the flag that says it moves with every other site of
   *  the same name. See macroTargets(). */
  macro?: true
}

/** One project-wide macro, resolved against what is LIVE: the declared range
 *  plus every param site it actually reaches. `sites` is empty when a macro is
 *  declared but referenced nowhere — a knob with nothing on the other end,
 *  which a control surface should show as such rather than silently drop. */
export interface MacroTarget {
  name: string
  default: number
  min: number
  max: number
  curve: 'lin' | 'log'
  sites: ParamTarget[]
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
  /** Fired on every SUCCESSFUL eval with the pictures the program staged for
   *  the LED mask (maskFrame(slot, painter)), by slot, and its live painters
   *  (maskDraw(n, painter)), by number; empty maps when it staged none. The
   *  mask output diffs the pictures against what the device holds and runs
   *  the painters while one is showing. Not fired on a failed eval
   *  (last-good). */
  onMaskFrames?: (frames: ReadonlyMap<number, MaskFrame>, draws: ReadonlyMap<number, MaskDrawFn>) => void
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
/** Structural keys, DERIVED not restated. This was the THIRD copy of the
 *  engine's list (evalCode had the second, fixed in #199) and it was the one
 *  that survived: a degree accidental sends `nAcc` per event, so an otherwise
 *  working patch logged `unknown param 'nAcc'` on exactly the notes that
 *  carried one — which reads as random. */
const NON_PARAM_KEYS: ReadonlySet<string> = RESERVED_PARAM_NAMES

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


/** A note's own STEP length in seconds, undoing the `dur` multiplier.
 *
 *  `durSec` is the sounding length (whole x 1/cps x dur), so a `dur: 0.1` note
 *  reports a tenth of its step. A tie is about where the NEXT STEP begins, not
 *  how long this note happens to sound, so the multiplier has to come back out
 *  or a short `dur` would refuse every tie. */
function slideStepSec(ev: SchedulerEvent): number {
  const d = ev.controls.dur
  const mult = typeof d === 'number' && d > 0 ? d : 1
  return ev.durSec / mult
}

export class Session {
  private readonly audio: AudioSessionLike
  private readonly onDiagnostics: ((d: Diagnostic[]) => void) | undefined
  private readonly onState: ((s: SessionState) => void) | undefined
  private readonly onEngineEvent: ((ev: EngineEvent) => void) | undefined
  private readonly onPatternEvents: ((evs: SchedulerEvent[]) => void) | undefined
  private readonly onVisual: ((wgsl: string | null, synths: string[]) => void) | undefined
  private readonly onMaskFrames: ((frames: ReadonlyMap<number, MaskFrame>, draws: ReadonlyMap<number, MaskDrawFn>) => void) | undefined
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
  /** Per-synth hardware output routes last SENT ("lo..hi", 1-based) — the
   *  diff base. Only synths that were live at send time are recorded, so a
   *  synth removed and later re-added gets its route re-sent instead of
   *  silently defaulting to the master pair. */
  private liveRoutes = new Map<string, string>()
  /** JSON fingerprint of the live master-comp config (undefined = none). */
  private liveMasterComp: string | undefined
  /** Live send buses: name → JSON.stringify(BusDef), the diffing fingerprint. */
  private readonly liveBuses = new Map<string, string>()
  /** Live custom wavetables: name → JSON.stringify(frames), the diffing
   *  fingerprint (the specs are small partial lists — cheap to fingerprint). */
  private readonly liveWavetables = new Map<string, string>()
  /** Live per-synth sends: `${synth}\u0000${bus}` → amount, the diff base so an
   *  unchanged send isn't resent and a dropped one resets to 0. */
  private liveSends = new Map<string, number>()
  /** Slide notes whose release is deferred until the synth's next note lands
   *  (adaptive 303 slide): synth name -> the held note and the frame past
   *  which it is released anyway.
   *
   *  The deadline is CHECKED each tick rather than pre-sent as a scheduled
   *  noteOff. Pre-sending assumed "whichever fires first wins, the other is a
   *  no-op" — untrue the moment the same pitch is re-triggered before the cap
   *  expires, because the stale release then lands inside the NEW note and
   *  cuts it. At a tempo whose loop divides the cap that is not a rare race:
   *  it happens on exactly the same frame, every time round. */
  private readonly pendingSlide = new Map<string, { note: number; deadlineFrame: number }>()
  /** Eval subset of the merged diagnostics (replaced by every eval). */
  private evalDiags: Diagnostic[] = []
  /** Runtime diagnostics keyed by `source message` for dedup. */
  private readonly runtimeDiags = new Map<string, Diagnostic>()
  /** Tempo last pushed to the ENGINE (setCps), the diff base so an unchanged
   *  tempo isn't resent every eval. Starts at the scheduler's own default,
   *  which is also the engine's — the two agree before anyone sets anything. */
  private liveCps: number | undefined
  /** Last masterGain(db) applied, so an unchanged one is not resent. */
  private masterGainDb: number | undefined
  /** JSON fingerprint of the live stereo stage (undefined = never set). */
  private liveStereo: string | undefined
  /** The project's meter, from the last successful eval. Not sent to the
   *  engine: nothing in the audio graph counts bars — this scales the tempo
   *  UNIT (bpm), the clock and the exported file, all of which read it from
   *  getState(). */
  private timeSig: TimeSig = DEFAULT_TIME_SIG
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
    this.onMaskFrames = opts.onMaskFrames
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

    // The engine boots at the same default tempo the scheduler does, so the
    // first setCps only goes out once they actually diverge.
    this.liveCps = this.scheduler.cps

    // Take ownership of the engine event stream (single listener by design).
    this.audio.onEvent = (ev) => {
      if (ev.kind === 'error') {
        this.reportRuntime('engine', ev.message)
        this.forgetRejectedSynth(ev.context)
      }
      if (ev.kind === 'loopBounced') {
        // A pedal's loop coming back from the engine: round-trip it through
        // the ONE sample-loading path, so the registry, project persistence
        // and the samples UI all see it — no private bank writes.
        this.audio.loadSamplePcm?.(ev.sample, ev.data, ev.sampleRate)
      }
      this.onEngineEvent?.(ev)
    }
  }

  /**
   * Evaluate source and, when ok, apply the staged registrations to live
   * state (see module doc for the diffing rules). Diagnostics — including
   * an empty list on a clean eval — always reach onDiagnostics. On failure
   * nothing is sent and nothing changes; the result carries the details.
   */
  /**
   * Drop a synth the engine REFUSED from the applied mirror.
   *
   * `liveSynths` records what has been sent, and the diff skips anything
   * unchanged — so a `defineSynth` the engine rejected (voice budget spent, a
   * graph it could not compile) left the host believing the synth existed. It
   * never re-sent it, and every note for it reported `unknown synth` forever:
   * the only way out was editing that synth's own text, which does not help
   * when the problem is elsewhere in the project.
   *
   * Forgetting it means the next eval tries again, so freeing voices anywhere
   * is enough to bring it back.
   */
  private forgetRejectedSynth(context: string | undefined): void {
    if (context === undefined) return
    const m = /^defineSynth '(.+)'$/.exec(context)
    if (m === null) return
    const name = m[1]!
    this.liveSynths.delete(name)
    this.liveDefs.delete(name)
  }

  /**
   * What the voice budget will do to this project, said BEFORE anything is
   * sent and while the line that caused it is still on screen.
   *
   * The budget is first come, first served, so the synth written last is the
   * one that gets nothing — and the engine's own report of that arrives as a
   * single line that is immediately buried under `unknown synth` for every
   * note it should have played. The host knows every synth's `voices:` up
   * front, so it can say the whole thing once: the total, the ceiling, who is
   * spending it, and who loses.
   */
  /** Names of every NAMED looper in the applied program (voice graphs, post
   *  chains, buses) — what the samples popover offers to bounce. */
  namedLoopers(): string[] {
    const names = new Set<string>()
    const scan = (g: unknown): void => {
      const nodes = (g as { nodes?: unknown } | undefined)?.nodes
      if (!Array.isArray(nodes)) return
      for (const n of nodes) {
        const node = n as { type?: unknown; config?: Record<string, unknown> }
        if (node.type !== 'looper') continue
        const nm = node.config?.['name']
        if (typeof nm === 'string' && nm.length > 0) names.add(nm)
      }
    }
    for (const def of this.liveDefs.values()) {
      scan(def.graph)
      scan(def.post)
    }
    for (const json of this.liveBuses.values()) {
      try { scan(JSON.parse(json)) } catch { /* fingerprint, not a graph — skip */ }
    }
    return [...names].sort()
  }

  private voiceBudgetDiags(synths: ReadonlyMap<string, SynthDef>): Diagnostic[] {
    const plan = planVoiceBudget([...synths].map(([name, def]) => ({ name, voices: def.maxVoices })))
    const rejected = plan.filter((p) => p.rejected)
    const clamped = plan.filter((p) => !p.rejected && p.got < p.asked)
    if (rejected.length === 0 && clamped.length === 0) return []
    const asked = plan.reduce((n, p) => n + p.asked, 0)
    const biggest = [...plan].sort((a, b) => b.asked - a.asked).slice(0, 3)
      .map((p) => `${p.name} (${p.asked})`).join(', ')
    const parts = [`this project asks for ${asked} voices and the budget is ${MAX_TOTAL_VOICES}`]
    if (rejected.length > 0) {
      parts.push(`${rejected.map((p) => `'${p.name}'`).join(', ')} will NOT be created, so `
        + `${rejected.length === 1 ? 'it is' : 'they are'} silent`)
    }
    for (const p of clamped) parts.push(`'${p.name}' gets ${p.got} of the ${p.asked} voices it asks for`)
    parts.push(`the largest are ${biggest} — lower \`voices:\` on those`)
    return [{
      line: 1,
      col: 1,
      message: parts.join('. ') + '.',
      severity: 'warning' as const,
      source: 'eval' as const,
    }]
  }

  /**
   * Every sample a program plays that is not loaded.
   *
   * A missing sample is SILENT and says nothing: the kernel resolves the name
   * per block and outputs zeros when it finds nothing, so a typo in a sample
   * name renders a track with a voice quietly absent and reports success. An
   * offline bounce of the granular example once wrote a file of digital zero
   * this way. `sampleNamesIn` was built to answer exactly this and had no
   * caller in the app.
   *
   * A WARNING, not an error: a name can legitimately be missing for a moment
   * while you are still writing the line, or between choosing a sample and
   * loading it, and failing the eval there would fight the person typing.
   */
  /**
   * Sample names that are loaded right now, by FAMILY: `bd:1` and `bd:2` are
   * both `bd`, because that is the name you write.
   *
   * Public because the editor completes sample names from it. That is the same
   * list `missingSampleDiags` warns against, deliberately — offering a name and
   * then warning that it is not loaded would be the editor arguing with itself.
   */
  loadedSampleNames(): string[] {
    const list = this.audio.getSamples?.()
    if (list === undefined) return []
    const out = new Set<string>()
    for (const s of list) out.add(parseSampleRef(s.name).base)
    return [...out].sort()
  }

  private missingSampleDiags(synths: ReadonlyMap<string, SynthDef>): Diagnostic[] {
    if (this.audio.getSamples === undefined) return []
    const loaded = new Set<string>(this.loadedSampleNames())
    const wanted = new Set<string>()
    for (const def of synths.values()) {
      for (const n of sampleNamesIn(def.graph)) wanted.add(n)
      if (def.post !== undefined) for (const n of sampleNamesIn(def.post)) wanted.add(n)
    }
    /* Compared by FAMILY: `bd:3` is satisfied by any variant of `bd`, because
     * the index wraps. Checking the literal name would report every
     * round-robin reference as missing. */
    const missing = [...wanted].filter((n) => !loaded.has(parseSampleRef(n).base))
    if (missing.length === 0) return []
    const have = [...loaded].sort().join(', ')
    return missing.sort().map((name) => ({
      line: 1,
      col: 1,
      message: `no sample named '${name}' is loaded, so that voice is SILENT`
        + (have === '' ? '. Load one with the + button in the editor.' : `. Loaded: ${have}`),
      severity: 'warning' as const,
      source: 'eval' as const,
    }))
  }

  evalCode(source: string, opts?: { live?: boolean }): EvalResult {
    this.lastAttemptedSource = source
    const result = evalCode(source, baseScope)
    this.evalDiags = result.ok
      ? [
          ...result.diagnostics,
          ...this.voiceBudgetDiags(result.synths),
          ...this.missingSampleDiags(result.synths),
        ]
      : result.diagnostics
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

    // Pictures and live painters for the LED mask. The mask output diffs the
    // pictures against what it has uploaded, so firing the whole map on every
    // eval is safe.
    this.onMaskFrames?.(result.maskFrames, result.maskDraws)

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

    // Custom wavetables FIRST: the staged eval already wrote the registry
    // (it mirrors the last successful eval), so diff it onto the wire —
    // loadWavetable for new/CHANGED specs, clearWavetable for vanished ones.
    // Must precede the synth diff: a new synth's kernels resolve their table
    // at construction, so the bank has to exist engine-side by then. A
    // changed spec alone needs NO synth rebuild — kernels re-resolve their
    // bank per block, which is what makes dragging a wavedef partial bar
    // audible mid-gesture.
    const tables = getCustomWavetables()
    for (const [name, frames] of tables) {
      const json = JSON.stringify(frames)
      if (this.liveWavetables.get(name) === json) continue
      this.audio.send({ kind: 'loadWavetable', name, frames })
      this.liveWavetables.set(name, json)
    }
    for (const name of [...this.liveWavetables.keys()]) {
      if (!tables.has(name)) {
        this.audio.send({ kind: 'clearWavetable', name })
        this.liveWavetables.delete(name)
      }
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
      // The POST chain is compared by SHAPE, not byte-for-byte: a knob declared
      // in a post chain lives in post.params, so comparing the whole thing made
      // every post-knob edit structural — the reason a `mix:` knob on a delay
      // lagged. Its default moving is a value change, and setParam applies it
      // now; only the graph around it moving is a rebuild.
      const postShapeSame = prev !== undefined && graphShape(prev.post) === graphShape(def.post)
      const postParams = postShapeSame
        ? diffParamDefaults(prev.post?.params ?? [], def.post?.params ?? [])
        : null
      const structuralSame =
        prev !== undefined &&
        !this.pendingRebuilds.has(name) &&
        postShapeSame && postParams !== null &&
        JSON.stringify(prev.voiceOpts ?? null) === JSON.stringify(def.voiceOpts ?? null) &&
        (prev.maxVoices ?? null) === (def.maxVoices ?? null)
      const patches = structuralSame ? diffGraphConstants(prev.graph, def.graph) : null
      const voiceParams = structuralSame && patches !== null
        ? diffParamDefaults(prev.graph.params, def.graph.params)
        : null
      if (patches !== null) {
        if (patches.length > 0) this.audio.send({ kind: 'patchConstants', name, patches })
        // A moved default IS the new value: send it now rather than waiting for
        // a debounced rebuild to carry it. Held params are skipped — a hand on
        // the knob outranks the text it is in the middle of writing.
        for (const p of [...(voiceParams ?? []), ...(postParams ?? [])]) {
          if (this.heldParams.has(`${name}.${p.name}`)) continue
          this.audio.send({ kind: 'setParam', synth: name, name: p.name, value: p.value })
        }
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

    // The meter comes from the document on every successful eval (4/4 when
    // unwritten), so deleting the line really does mean 4/4 again.
    if (result.timeSig !== undefined) this.timeSig = result.timeSig
    if (result.cps !== undefined) this.requestCps(result.cps)
    this.syncCps()

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

    // Hardware output routing: diff-and-send like the duck amounts. The
    // message carries 0-BASED channels (the language is 1-based, like the
    // jacks); a dropped route resets its synth to the master pair. The engine
    // preserves a route across a live redefine, so an unchanged fingerprint
    // is safe to skip.
    const newRoutes = result.routes ?? {}
    const sentRoutes = new Map<string, string>()
    for (const [synth, r] of Object.entries(newRoutes)) {
      if (!this.liveSynths.has(synth)) continue // unknown target: warned at eval
      const fp = `${r.lo}..${r.hi}`
      if (this.liveRoutes.get(synth) !== fp) {
        this.audio.send({ kind: 'setChannel', synth, out: { lo: r.lo - 1, hi: r.hi - 1 } })
      }
      sentRoutes.set(synth, fp)
    }
    for (const synth of this.liveRoutes.keys()) {
      if (!sentRoutes.has(synth) && this.liveSynths.has(synth)) {
        this.audio.send({ kind: 'setChannel', synth, out: { lo: 0, hi: 1 } })
      }
    }
    this.liveRoutes = sentRoutes

    // Master glue compressor: same diff-and-send discipline — setMasterComp on
    // new/changed config, clearMasterComp when it vanishes.
    // The engine has understood `setMaster` since it was written, and nothing
    // in the app had ever sent it — a master gain the code could not reach.
    if (result.masterGain !== this.masterGainDb) {
      this.masterGainDb = result.masterGain
      this.audio.send({ kind: 'setMaster', gain: Math.pow(10, (result.masterGain ?? 0) / 20) * DEFAULT_MASTER_GAIN })
    }
    // Master-bus mid/side: same diff-and-send discipline. Clearing it back to
    // defaults matters as much as setting it — a width left over from the last
    // eval would silently narrow the next program.
    const stJson = result.stereo !== undefined ? JSON.stringify(result.stereo) : undefined
    if (stJson !== this.liveStereo) {
      this.liveStereo = stJson
      this.audio.send({ kind: 'setStereo', ...(result.stereo ?? { width: 1, monoBelow: 0 }) })
    }
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
    const sendKey = (synth: string, bus: string): string => `${synth}\u0000${bus}`
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
      const sep = key.indexOf('\u0000')
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

  /** The tempo the DOCUMENT (or an explicit transport call) last asked for.
   *  Kept even while an external clock overrides it, so switching back to the
   *  internal clock restores what the tune says rather than freezing on
   *  whatever the last master happened to be playing at. */
  private docCps: number | undefined
  /** Tempo imposed by an external master (MIDI clock). See setExternalCps. */
  private externalCps: number | undefined

  /** Apply a tempo asked for by the document or a transport call. PRECEDENCE:
   *  an external clock outranks it. The request is always remembered. */
  private requestCps(cps: number): void {
    this.docCps = cps
    if (this.externalCps === undefined) this.scheduler.setCps(cps)
  }

  /**
   * Hand the tempo to an external master, or take it back.
   *
   * While an external cps is set it OWNS the transport rate: a `cps` line in
   * the document is remembered but not applied. That is the rule that makes
   * following usable, because live coding re-evaluates constantly and a tune
   * that says `setCps(0.5)` would otherwise yank the tempo off the master on
   * every keystroke. Passing undefined releases it and restores the document's
   * own tempo immediately.
   */
  setExternalCps(cps: number | undefined): void {
    if (cps !== undefined && (!Number.isFinite(cps) || cps <= 0)) return
    const was = this.externalCps
    const before = this.scheduler.cps
    this.externalCps = cps
    const next = cps ?? this.docCps
    if (next !== undefined) this.scheduler.setCps(clampCps(next))
    this.syncCps()
    // A follower calls this a few times a beat; only a tempo that actually
    // moved (or taking/releasing the clock) is worth a state render.
    if ((was === undefined) !== (cps === undefined) || this.scheduler.cps !== before) {
      this.onState?.(this.getState())
    }
  }

  /** The tempo the document asks for, whether or not it is in force. */
  get documentCps(): number | undefined {
    return this.docCps
  }

  /** An external master owns the tempo right now. */
  get followingExternalCps(): boolean {
    return this.externalCps !== undefined
  }

  /** Transport position in cycles (0 while stopped) — what an external clock
   *  measures its phase error against. */
  get cycle(): number {
    return this.scheduler.cycle
  }

  /** Push the scheduler's tempo to the ENGINE when it changed, so `sync` lfo
   *  and delay nodes re-rate to the transport. Called from every place the
   *  scheduler's cps can move — a `cps` line in an eval, and transport() —
   *  which is exactly what keeps a live tempo edit audible without a rebuild.
   *  Diffed, because an eval that did not touch the tempo should send nothing. */
  private syncCps(): void {
    const cps = this.scheduler.cps
    if (cps === this.liveCps) return
    this.liveCps = cps
    this.audio.send({ kind: 'setCps', cps })
  }

  /** ddsp model names already posted to THIS engine instance, so re-evals
   *  don't re-clone ~1 MB of weights per eval. The worklet bank keeps them
   *  for the AudioSession's lifetime, which the Session shares. */
  private readonly ddspDelivered = new Set<string>()

  /** Send defineSynth NOW and record it as the live def/fingerprint. */
  private defineSynthNow(name: string, def: SynthDef, json: string): void {
    // Lazy-fetch any shipped ddsp models this graph names (silence until the
    // bytes land, then the kernel resolves them per block — sample contract).
    ensureDdspModels(
      ddspModelNamesInGraph(def.graph).filter((m) => !this.ddspDelivered.has(m)),
      (model, bytes) => {
        this.ddspDelivered.add(model)
        this.audio.send({ kind: 'loadDdspModel', name: model, data: bytes })
      },
      (sampleName, data, sampleRate) => {
        // body-resonance IR for the post chain's convolve('<name>body') —
        // loadSamplePcm (when the host has it) also fills the bounce store
        if (this.audio.loadSamplePcm) this.audio.loadSamplePcm(sampleName, data, sampleRate)
        else this.audio.send({ kind: 'loadSample', name: sampleName, data, sampleRate })
      },
    )
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

  /** Touch-to-override: params currently held by a performer ("synth.param" →
   *  the set of owners holding it). While held, pattern-driven setParams for
   *  that param are SUPPRESSED in dispatchEvents — the performer outranks the
   *  sequencer — and the drive resumes on its next event once the LAST owner
   *  releases.
   *
   *  Two owners exist because they behave differently: 'touch' is a gesture
   *  that ends when the finger lifts, 'midi' is a knob that keeps its param
   *  until it is unmapped. Scoping the holds means a finger drag over a
   *  knob-owned param hands the param back to the KNOB on release, not to the
   *  pattern. The value itself is simply whoever moved last. */
  private readonly heldParams = new Map<string, Set<ParamOwner>>()

  /** Hold a param at `value` (a hand or a mapped CC is on the knob). Applies
   *  immediately and suppresses the pattern drive for this param until every
   *  owner has released it. Unknown synths are forgiven like setChannel —
   *  holds race live evals. */
  holdParam(synth: string, name: string, value: number, owner: ParamOwner = 'touch'): void {
    const key = `${synth}.${name}`
    const owners = this.heldParams.get(key)
    if (owners === undefined) this.heldParams.set(key, new Set([owner]))
    else owners.add(owner)
    this.audio.send({ kind: 'setParam', synth, name, value })
  }

  /** Release one owner's hold on a param. The pattern drive takes back over on
   *  its next event once NO owner holds it (or the param simply keeps the held
   *  value if nothing drives it). */
  releaseParam(synth: string, name: string, owner: ParamOwner = 'touch'): void {
    const key = `${synth}.${name}`
    const owners = this.heldParams.get(key)
    if (owners === undefined) return
    owners.delete(owner)
    if (owners.size === 0) this.heldParams.delete(key)
  }

  /** Every param the live synths declare, with the range and curve a control
   *  surface needs to scale onto it — the voice graph's params plus the
   *  per-synth post chain's (both reach setParam). This is the list a MIDI
   *  learn or a mixer picks from; it is empty until an eval succeeds, and it
   *  shrinks the moment a synth is renamed or deleted, which is what makes a
   *  saved mapping show up as stale. */
  paramTargets(): ParamTarget[] {
    const out: ParamTarget[] = []
    for (const [synth, def] of this.liveDefs) {
      for (const p of def.graph.params) {
        const t: ParamTarget = { synth, param: p.name, default: p.default, min: p.min, max: p.max, curve: p.curve ?? 'lin' }
        if (p.macro === true) t.macro = true
        out.push(t)
      }
      for (const p of def.post?.params ?? []) {
        const t: ParamTarget = { synth, param: p.name, default: p.default, min: p.min, max: p.max, curve: p.curve ?? 'lin', post: true }
        if (p.macro === true) t.macro = true
        out.push(t)
      }
    }
    return out
  }

  /** The project's macros, each with the live param sites it drives.
   *
   *  Grouped on the MACRO FLAG, never on the name alone: two synths that each
   *  declare their own `cutoff` are deliberately two separate controls (a
   *  param belongs to its synth), and only a macro() declaration says
   *  otherwise. Every site of one macro carries the same range and curve by
   *  construction — they all read the one declaration — so the group can be
   *  drawn as a single knob without reconciling anything. */
  macroTargets(): MacroTarget[] {
    const byName = new Map<string, MacroTarget>()
    for (const t of this.paramTargets()) {
      if (t.macro !== true) continue
      const found = byName.get(t.param)
      if (found === undefined) {
        byName.set(t.param, {
          name: t.param, default: t.default, min: t.min, max: t.max, curve: t.curve, sites: [t],
        })
      } else found.sites.push(t)
    }
    return [...byName.values()]
  }

  /** Which synths a macro is currently HELD on. A drag re-evals continuously,
   *  so the live target list changes under it — a synth can be renamed, added
   *  or removed between the hold and the release. Releasing against the
   *  CURRENT list would then miss a site and leave it held forever, ignoring
   *  its pattern for the rest of the session. Release what was actually held. */
  private readonly heldMacroSites = new Map<string, Set<string>>()

  /** Move a macro: applies to EVERY site at once, and holds them, so the one
   *  knob outranks any pattern driving a copy (see holdParam). Unknown macro
   *  name = no sites = a silent no-op, forgiven like setChannel: a control
   *  surface races live evals that rename and delete things constantly. */
  holdMacro(name: string, value: number, owner: ParamOwner = 'touch'): void {
    // the PATTERN layer reads the same knob (macroval), and it must not have
    // to wait for a re-eval to see the hand move
    setMacroValue(name, value)
    const sites = this.heldMacroSites.get(name) ?? new Set<string>()
    for (const t of this.paramTargets()) {
      if (t.macro !== true || t.param !== name) continue
      this.holdParam(t.synth, name, value, owner)
      sites.add(t.synth) // voice and post share one key, so a Set is exact
    }
    this.heldMacroSites.set(name, sites)
  }

  /** Release the hold on every site this macro was HELD on (see releaseParam
   *  and heldMacroSites for why it is not the current target list). */
  releaseMacro(name: string, owner: ParamOwner = 'touch'): void {
    for (const synth of this.heldMacroSites.get(name) ?? []) this.releaseParam(synth, name, owner)
    this.heldMacroSites.delete(name)
  }

  /** Set a macro WITHOUT holding it — the programmatic route (MCP, a script),
   *  where nothing is going to call release. Returns how many sites it reached,
   *  so a caller can tell "moved nothing" from "moved everything". */
  setMacro(name: string, value: number, rampMs?: number): number {
    setMacroValue(name, value)
    let n = 0
    for (const t of this.paramTargets()) {
      if (t.macro !== true || t.param !== name) continue
      this.setParam(`${t.synth}.${name}`, value, rampMs)
      n++
    }
    return n
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
    if (opts?.cps !== undefined) this.requestCps(clampCps(opts.cps))
    this.syncCps()
    if (cmd === 'play') {
      // The slide sweep rides the scheduler's OWN timer rather than a second
      // one. It cannot live in dispatchEvents: the scheduler skips onEvents
      // entirely on a tick with no events (`if (evs.length === 0) return`),
      // and "no next event" is exactly the stuck-note case the deadline
      // exists to catch.
      const wrap = (si: SetIntervalImpl): SetIntervalImpl =>
        (fn, ms) => si(() => { this.releaseExpiredSlides(); fn() }, ms)
      if (this.setIntervalImpl !== undefined && this.clearIntervalImpl !== undefined) {
        this.scheduler.start(wrap(this.setIntervalImpl), this.clearIntervalImpl)
      } else {
        this.scheduler.start(wrap((fn, ms) => setInterval(fn, ms)), (h) => clearInterval(h as ReturnType<typeof setInterval>))
      }
      this.playing = true
    } else {
      this.scheduler.stop()
      this.audio.send({ kind: 'silenceAll' }) // hard cut: also stops an in-flight sung vocal clip
      this.pendingSlide.clear() // deferred slide releases are moot after a panic
      this.playing = false
    }
    this.onState?.(this.getState())
  }

  /** Set the tempo WITHOUT touching play/stop — the header's BPM field uses
   *  this when the document carries no tempo line to rewrite, so the change
   *  applies to this run only (the next eval of a doc with a tempo line takes
   *  it back). Clamped to [0.05, 4] like setCps, and pushed to the engine so
   *  synced lfo/delay times follow. Like every other tempo request it defers
   *  to an external clock while one is being followed (see setExternalCps),
   *  and is remembered for when that clock is released. */
  setCps(cps: number): void {
    this.requestCps(clampCps(cps))
    this.syncCps()
    this.onState?.(this.getState())
  }

  /** Seconds (audio clock) → transport cycle position. The roll playhead uses
   *  this so it restarts at 0 with the transport instead of riding absolute
   *  wall-clock phase. */
  cycleAt(timeSec: number): number {
    return this.scheduler.cycleAt(timeSec).valueOf()
  }

  getState(): SessionState {
    const s: SessionState = {
      playing: this.playing,
      cps: this.scheduler.cps,
      timeSig: this.timeSig,
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
    this.liveRoutes.clear()
    this.liveMasterComp = undefined
    this.liveBuses.clear()
    this.liveWavetables.clear()
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
      if (typeof sound !== 'string' || EXTERNAL_OUTPUTS.has(sound)) continue
      const atFrame = Math.round(ev.timeSec * sr)
      if (typeof note !== 'number') {
        // AUTOMATION (see pattern's isAutomation): params only, no gate. What
        // sing() stacks under its once-per-phrase trigger so a patterned post
        // param keeps moving through the phrase.
        this.sendParams(sound, ev.controls, atFrame)
        continue
      }
      // ADAPTIVE SLIDE: if a slide note is pending for this synth, release it
      // JUST as this note's gate opens (+overlap) so the still-held gate makes a
      // mono+glide synth portamento into this note. Because live events arrive
      // per tick, we defer a slide note's release (below) and resolve it here
      // when its next note lands — bridging any gap, not just adjacent notes.
      const pending = this.pendingSlide.get(sound)
      if (pending !== undefined) {
        this.audio.send({ kind: 'noteOff', synth: sound, note: pending.note, atFrame: atFrame + overlap })
        this.pendingSlide.delete(sound)
      }
      this.sendParams(sound, ev.controls, atFrame)
      const velocity = typeof ev.controls.gain === 'number' ? ev.controls.gain : 1
      // per-note sample slice (.chop): begin/end ride the noteOn, latched by
      // any sampler in the voice at the gate edge (a plain synth ignores them)
      const begin = typeof ev.controls.begin === 'number' ? ev.controls.begin : undefined
      const end = typeof ev.controls.end === 'number' ? ev.controls.end : undefined
      this.audio.send({ kind: 'noteOn', synth: sound, note, velocity, atFrame, ...(begin !== undefined ? { begin } : {}), ...(end !== undefined ? { end } : {}) })
      const slide = typeof ev.controls.slide === 'number' && ev.controls.slide > 0
      if (slide) {
        /* Hold until the NEXT note for this synth arrives (resolved above),
         * but NO LONGER THAN THIS NOTE'S OWN STEP.
         *
         * A tie is a relationship between ADJACENT steps: the next note begins
         * where this one's step ends. Anything further away has a REST in
         * between, and a rest is not a note to glide into. The deadline used
         * to be a flat 4 seconds, so a slide note followed by rests sustained
         * across them — measured at 1.25s from a step of 0.11s, which reads as
         * a stuck gate rather than a glide.
         *
         * BOUNDED, not detected. Rests emit no events, and the scheduler's
         * lookahead is often shorter than a step, so "is there a next note?"
         * has no reliable answer at this point — peeking into the batch made
         * the release land differently depending on where the window fell.
         * The deadline needs no lookahead: an adjacent note is dispatched
         * before the clock reaches it and resolves the tie first, and nothing
         * else can hold the gate past its own step. */
        const bound = Math.min(slideStepSec(ev) + SLIDE_OVERLAP_SEC, MAX_SLIDE_HOLD_SEC)
        this.pendingSlide.set(sound, { note, deadlineFrame: atFrame + Math.round(bound * sr) })
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

  /** Every numeric, non-structural control on an event → setParam at its
   *  frame (a knob a hand is holding is left alone). */
  private sendParams(sound: string, controls: ControlMap, atFrame: number): void {
    for (const [key, value] of Object.entries(controls)) {
      if (NON_PARAM_KEYS.has(key) || typeof value !== 'number') continue
      if (this.heldParams.has(`${sound}.${key}`)) continue // a hand holds this knob
      /* SAME FRAME AS THE NOTE. Without atFrame the engine applied the value
       * when the message arrived, which is up to one lookahead ahead of the
       * note it belongs to (measured at a steady 75ms) — and since a param
       * reaches every voice of the synth, the change was heard on the
       * PREVIOUS note's tail. At equal frames the engine fires params before
       * noteOn, so the note opens on its own value. */
      this.audio.send({ kind: 'setParam', synth: sound, name: key, value, atFrame })
    }
  }

  /** Release any slide note whose next note never came. Runs each tick, so
   *  the release is sent only when it is actually needed — and never sits in
   *  the engine's queue waiting to cut a note that has not been played yet. */
  private releaseExpiredSlides(): void {
    const now = this.audio.currentTimeFrames
    for (const [sound, held] of this.pendingSlide) {
      if (held.deadlineFrame > now) continue
      this.audio.send({ kind: 'noteOff', synth: sound, note: held.note, atFrame: held.deadlineFrame })
      this.pendingSlide.delete(sound)
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
