/* ------------------------------------------------------------------------- *
 * render-runner: headless code → audio, no browser anywhere. The pure core
 * behind the render_* MCP tools (render-tools.ts):
 *
 *   stageCode(source)  — evalCode against the app's baseScope; staged
 *                        synth/pattern Maps out, positioned diagnostics on
 *                        failure. Same evaluator the browser Session uses,
 *                        so what renders here is what would play there.
 *   runPatterns(...)   — drive a REAL Scheduler with a virtual clock (the
 *                        scripts/demo-render.ts approach, extracted) and
 *                        route each onset to its synth's RenderEvent list,
 *                        keyed by controls.sound.
 *   renderMix(...)     — renderOffline each synth's events as a stem, sum
 *                        the stems, peak-normalize the mix to 0.89 when it
 *                        runs hot. Per-stem event counts and RMS come back
 *                        so an agent can see WHICH voice is loud/silent.
 *
 * Everything here is deterministic: same source + cycles + cps → the same
 * samples, bit for bit (seeded noise, virtual clock, no wall time).
 *
 * TRUST MODEL: stageCode runs the supplied source through evalCode's
 * `new Function` in THIS Node process — the same trust boundary as the
 * browser's eval (the user's own machine, the user's own agent). This is a
 * namespace, not a security sandbox; do not feed it untrusted code.
 * ------------------------------------------------------------------------- */

// Deep read-only imports from sibling package SOURCE (established pattern —
// see mcp.ts header): the app's eval core gives us the exact browser
// vocabulary; pattern/engine give the scheduler and offline renderer.
import { evalCode } from '../../app/src/session/evalCode'
import type { Diagnostic, BusDef, SendSpec } from '../../app/src/session/evalCode'
import { baseScope } from '../../app/src/session/scope'
import { Scheduler } from '../../pattern/src/index'
import type { ControlMap, Pattern } from '../../pattern/src/index'
import { BLOCK, duckReleaseCoeff, gainReductionDb, smoothCoeff, PostChain, renderOffline } from '../../engine/src/index'
import type { RenderEvent, SynthDef } from '../../engine/src/index'

/** Control keys that are NOT synth params (mirrors Session.ts / demo-render). */
const NON_PARAM_KEYS = new Set(['n', 'note', 'sound', 'gain', 'pan', 'dur', 'slide', 'loc'])

/** Guaranteed low-gate window between back-to-back same-note events so
 *  envelopes re-attack — copied from Session.ts (GATE_GAP_SEC there; a
 *  shared home would touch packages/app, noted as future dedup). Without
 *  it a four-on-the-floor kick renders its first hit and then silence. */
export const GATE_GAP_SEC = 0.005
/** Slide gate overlap into the next note (mirrors Session.SLIDE_OVERLAP_SEC). */
const SLIDE_OVERLAP_SEC = 0.03

/** Virtual-clock step driving Scheduler.tick() — the scheduler's default
 *  real-time interval, reused as the offline step. */
const TICK_SEC = 0.025

export type StageResult =
  | {
      ok: true
      synths: Map<string, SynthDef>
      patterns: Map<string, Pattern<ControlMap>>
      /** Staged shared send buses (name → compiled FX graph + gain). */
      buses: Map<string, BusDef>
      /** Staged per-synth sends into buses. */
      sends: SendSpec[]
      /** Present iff the code called setCps (already clamped 0.05..4). */
      cps?: number
      /** Present iff the code called sidechain() — releaseMs, not seconds.
       *  `amounts` are per-synth duck responses (0..1); any synth not listed
       *  defaults to 1 (full duck). */
      sidechain?: { source: string; depth: number; releaseMs: number; amounts?: Record<string, number> }
      /** Present iff the code called masterCompress() — master-bus glue
       *  compressor config (dB / ratio / ms). */
      masterComp?: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }
      /** Non-fatal eval diagnostics (warnings). */
      warnings: Diagnostic[]
    }
  | { ok: false; diagnostics: Diagnostic[] }

/** Evaluate rondocode source headlessly: staged registrations out, nothing
 *  applied anywhere. Wraps the app's evalCode + baseScope (the browser's
 *  exact vocabulary and semantics — all-or-nothing staging included). */
export function stageCode(source: string): StageResult {
  const r = evalCode(source, baseScope)
  if (!r.ok) return { ok: false, diagnostics: r.diagnostics }
  const out: StageResult = {
    ok: true,
    synths: r.synths,
    patterns: r.patterns,
    buses: r.buses,
    sends: r.sends,
    warnings: r.diagnostics,
  }
  if (r.cps !== undefined) out.cps = r.cps
  if (r.sidechain !== undefined) out.sidechain = r.sidechain
  if (r.masterComp !== undefined) out.masterComp = r.masterComp
  return out
}

export interface RunOpts {
  /** Whole cycles to schedule (events with onset cycle >= cycles are cut). */
  cycles: number
  /** Cycles per second (tempo). */
  cps: number
}

/**
 * Drive a virtual-clock Scheduler over `cycles` whole cycles and route every
 * onset to its synth's RenderEvent list (keyed by controls.sound — events
 * lacking a string `sound` or numeric `note` are skipped, exactly like the
 * browser Session). Includes sounds with no staged synth — the caller
 * decides whether that's an error worth reporting.
 *
 * Per event: one noteOn (velocity = gain, default 1), one noteOff shortened
 * by the gate gap (see GATE_GAP_SEC), and one param event per numeric
 * non-transport control sampled at the onset.
 */
export function runPatterns(
  patterns: Map<string, Pattern<ControlMap>>,
  opts: RunOpts,
): Map<string, RenderEvent[]> {
  const { cycles, cps } = opts
  const bySynth = new Map<string, RenderEvent[]>()
  // Slide noteOffs to retime in a post-pass, once every onset is known.
  const slideOffs: { synth: string; onTime: number; naturalEnd: number; off: RenderEvent }[] = []
  const durationSec = cycles / cps
  const clock = { now: 0 }
  const sched = new Scheduler({
    getTime: () => clock.now,
    onEvents: (evs) => {
      for (const ev of evs) {
        if (ev.cycle >= cycles) continue
        const sound = ev.controls.sound
        const midi = ev.controls.note
        if (typeof sound !== 'string' || typeof midi !== 'number') continue
        let list = bySynth.get(sound)
        if (list === undefined) {
          list = []
          bySynth.set(sound, list)
        }
        for (const [key, value] of Object.entries(ev.controls)) {
          if (NON_PARAM_KEYS.has(key) || typeof value !== 'number') continue
          list.push({ time: ev.timeSec, type: 'param', name: key, value })
        }
        const velocity = typeof ev.controls.gain === 'number' ? ev.controls.gain : 1
        list.push({ time: ev.timeSec, type: 'noteOn', note: midi, velocity })
        const naturalEnd = ev.timeSec + Math.max(GATE_GAP_SEC, ev.durSec - GATE_GAP_SEC)
        const slide = typeof ev.controls.slide === 'number' && ev.controls.slide > 0
        // slide (303): defer this noteOff to the NEXT onset in a post-pass so the
        // still-held gate makes a mono+glide synth portamento in. Placeholder =
        // the natural end (used verbatim if there is no next note).
        const off: RenderEvent = { time: naturalEnd, type: 'noteOff', note: midi }
        list.push(off)
        if (slide) slideOffs.push({ synth: sound, onTime: ev.timeSec, naturalEnd, off })
      }
    },
    lookahead: 0.1,
  })
  sched.setCps(cps)
  for (const [name, pat] of patterns) sched.setPattern(name, pat)
  sched.play()
  // One lookahead past the end guarantees the final window is queried.
  while (clock.now < durationSec + 0.2) {
    sched.tick()
    clock.now += TICK_SEC
  }
  sched.stop()
  // Adaptive slide: hold each slide note until (just past) its synth's NEXT
  // onset, so it ties into that note regardless of the gap — but no further, so
  // the note-after-next still retriggers. No next onset -> keep the natural end.
  for (const { synth, onTime, naturalEnd, off } of slideOffs) {
    const list = bySynth.get(synth)
    if (list === undefined) continue
    let next = Infinity
    for (const e of list) {
      if (e.type === 'noteOn' && e.time > onTime + 1e-6 && e.time < next) next = e.time
    }
    off.time = next === Infinity ? naturalEnd : next + SLIDE_OVERLAP_SEC
  }
  return bySynth
}

export interface MixOpts {
  /** Default 48000. */
  sampleRate?: number
  /** Per-stem polyphony. Default 12. */
  maxVoices?: number
  /** Sidechain duck: every noteOn of `source` snaps a per-sample envelope down
   *  to `1 - depth` and it recovers toward 1 (one-pole, releaseMs). Every
   *  NON-source stem is multiplied by that envelope before summing; the source
   *  stem is untouched. The release coefficient comes from the SAME
   *  engine.duckReleaseCoeff the live RealtimeEngine uses, so the offline pump
   *  matches the live pump exactly. `amounts` scales each stem's response
   *  (0..1, default 1): the effective per-sample multiplier for a stem is
   *  `1 - amount·(1 - env)`, matching the live engine's per-channel formula. */
  sidechain?: { source: string; depth: number; releaseMs: number; amounts?: Record<string, number> }
  /** Audio samples available to sample('name') nodes, keyed by name (mono PCM
   *  at its own sampleRate). Threaded into every stem's render so offline
   *  playback matches the live engine's loaded samples. */
  samples?: Record<string, { data: Float32Array; sampleRate: number }>
  /** Master-bus glue compressor (dB / ratio / ms), applied stereo-linked over
   *  the summed mix before normalization — mirrors the live engine's master
   *  compressor (which runs after master gain, before the limiter). */
  masterComp?: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }
  /** Shared send buses (name → compiled FX graph + gain). Fed by `sends` and
   *  summed into the mix before the master compressor — mirrors the live
   *  engine's bus stage. */
  buses?: Map<string, BusDef>
  /** Per-synth sends into buses (0..1). Tapped from each stem's raw post-FX
   *  (pre-duck), matching the live engine's pre-fader send tap. */
  sends?: SendSpec[]
}

export interface MixResult {
  left: Float32Array
  right: Float32Array
  sampleRate: number
  /** Stems actually rendered: event count and pre-normalization RMS each. */
  perSynth: Record<string, { events: number; rms: number }>
  /** True when the summed mix peaked above 0.89 and was scaled down. */
  normalized: boolean
}

/** Per-sample sidechain duck envelope over the whole render. Mirrors the live
 *  RealtimeEngine exactly: at each source noteOn sample the level snaps to
 *  1 - depth (depth clamped 0..1), and between hits it advances
 *  `level += (1 - level) * coeff` per sample toward 1, using the SAME
 *  duckReleaseCoeff (releaseMs clamped inside it). Source onset samples are
 *  round(time * sampleRate), matching Session's atFrame rounding. */
const buildDuckEnvelope = (
  sc: { depth: number; releaseMs: number },
  sourceEvents: RenderEvent[] | undefined,
  total: number,
  sampleRate: number,
): Float32Array => {
  const depth = Math.min(1, Math.max(0, sc.depth))
  const coeff = duckReleaseCoeff(sc.releaseMs, sampleRate)
  const onsets = (sourceEvents ?? [])
    .filter((e) => e.type === 'noteOn')
    .map((e) => Math.round(e.time * sampleRate))
    .sort((a, b) => a - b)
  const env = new Float32Array(total)
  let oi = 0
  let level = 1
  for (let i = 0; i < total; i++) {
    while (oi < onsets.length && onsets[oi]! === i) {
      level = 1 - depth
      oi++
    }
    env[i] = level
    level += (1 - level) * coeff
  }
  return env
}

const stemRms = (l: Float32Array, r: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < l.length; i++) sum += l[i]! * l[i]! + r[i]! * r[i]!
  return Math.sqrt(sum / (2 * l.length))
}

/**
 * Render each synth's events as a stem (renderOffline), sum the stems
 * equally, and peak-normalize the mix down to 0.89 if it exceeds that
 * (never scaled UP — a quiet render stays quiet, which is itself feedback).
 * Sounds in `events` with no def in `synths` are skipped; synths with no
 * events still appear in perSynth as { events: 0, rms: 0 }.
 */
export function renderMix(
  synths: Map<string, SynthDef>,
  events: Map<string, RenderEvent[]>,
  durationSec: number,
  opts?: MixOpts,
): MixResult {
  const sampleRate = opts?.sampleRate ?? 48000
  const maxVoices = opts?.maxVoices ?? 12
  const total = Math.round(durationSec * sampleRate)
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  const perSynth: Record<string, { events: number; rms: number }> = {}

  // Sidechain: build a per-sample duck envelope over the whole render — start
  // at 1, snap to 1 - depth at each SOURCE noteOn sample, recover toward 1 via
  // the shared engine coefficient. Multiplies every NON-source stem.
  const sc = opts?.sidechain
  const duck = sc !== undefined ? buildDuckEnvelope(sc, events.get(sc.source), total, sampleRate) : undefined

  // Shared send buses: one full-length accumulator pair per bus, and a
  // per-synth index of its sends. Stems tap into these PRE-duck (below),
  // mirroring the live engine's pre-fader send tap.
  const busAccums = new Map<string, { L: Float32Array; R: Float32Array }>()
  const sendsBySynth = new Map<string, SendSpec[]>()
  if (opts?.buses !== undefined && opts.buses.size > 0) {
    for (const [busName] of opts.buses) busAccums.set(busName, { L: new Float32Array(total), R: new Float32Array(total) })
    for (const s of opts.sends ?? []) {
      if (!busAccums.has(s.bus)) continue
      const list = sendsBySynth.get(s.synth) ?? []
      list.push(s)
      sendsBySynth.set(s.synth, list)
    }
  }

  for (const [name] of synths) perSynth[name] = { events: 0, rms: 0 }
  for (const [name, evs] of events) {
    const def = synths.get(name)
    if (def === undefined) continue
    // renderOffline now runs the per-synth POST chain inline (so time-varying
    // post params from setParam events take effect), returning the post-FX stem
    // — pre-duck, mirroring the live signal path. No separate post pass here.
    const stem = renderOffline(def, evs, durationSec, { sampleRate, maxVoices: def.maxVoices ?? maxVoices, samples: opts?.samples })
    // Send tap: pre-duck (raw post-FX), so a reverb send does not pump.
    const stemSends = sendsBySynth.get(name)
    if (stemSends !== undefined) {
      for (const s of stemSends) {
        const acc = busAccums.get(s.bus)!
        for (let i = 0; i < total; i++) {
          acc.L[i]! += stem.left[i]! * s.amount
          acc.R[i]! += stem.right[i]! * s.amount
        }
      }
    }
    if (duck !== undefined && sc !== undefined && name !== sc.source) {
      // Per-stem duck response: 1 - amount·(1 - env). amount defaults to 1
      // (full duck), matching the live engine's per-channel formula.
      const amount = sc.amounts?.[name] ?? 1
      if (amount !== 0) {
        for (let i = 0; i < total; i++) {
          const m = 1 - amount * (1 - duck[i]!)
          stem.left[i]! *= m
          stem.right[i]! *= m
        }
      }
    }
    for (let i = 0; i < total; i++) {
      left[i]! += stem.left[i]!
      right[i]! += stem.right[i]!
    }
    const notes = evs.filter((e) => e.type === 'noteOn').length
    perSynth[name] = { events: notes, rms: stemRms(stem.left, stem.right) }
  }

  // Shared send buses: each bus's FX chain processes its accumulated sends
  // (block by block, like the live PostChain), then the output is scaled by
  // gain and summed into the mix BEFORE the master compressor — mirroring the
  // live engine's bus stage.
  if (opts?.buses !== undefined) {
    for (const [busName, def] of opts.buses) {
      const acc = busAccums.get(busName)
      if (acc === undefined) continue
      const chain = new PostChain(def.graph, { sampleRate })
      for (let i = 0; i < total; i += BLOCK) {
        const n = Math.min(BLOCK, total - i)
        chain.processStereo(acc.L.subarray(i, i + n), acc.R.subarray(i, i + n), n)
      }
      const g = def.gain
      for (let i = 0; i < total; i++) {
        left[i]! += acc.L[i]! * g
        right[i]! += acc.R[i]! * g
      }
    }
  }

  // Master glue compressor (stereo-linked), mirroring the live engine's master
  // stage: detect on max(|L|,|R|), one gain from the same soft-knee curve.
  const mc = opts?.masterComp
  if (mc !== undefined) {
    const knee = Math.max(0, mc.knee)
    const ratio = Math.min(60, Math.max(1, mc.ratio))
    const atk = smoothCoeff(Math.min(500, Math.max(0.05, mc.attack)), sampleRate)
    const rel = smoothCoeff(Math.min(3000, Math.max(1, mc.release)), sampleRate)
    const makeup = Math.pow(10, mc.makeup / 20)
    let gr = 0
    for (let i = 0; i < total; i++) {
      const pk = Math.max(Math.abs(left[i]!), Math.abs(right[i]!))
      const db = pk > 0 ? 20 * Math.log10(pk) : -120
      const target = Math.min(60, Math.max(0, gainReductionDb(db, mc.threshold, ratio, knee)))
      gr += (target - gr) * (target > gr ? atk : rel)
      const g = Math.pow(10, -gr / 20) * makeup
      left[i]! *= g
      right[i]! *= g
    }
  }

  let peak = 0
  for (let i = 0; i < total; i++) {
    const amp = Math.max(Math.abs(left[i]!), Math.abs(right[i]!))
    if (amp > peak) peak = amp
  }
  const normalized = peak > 0.89
  if (normalized) {
    const scale = 0.89 / peak
    for (let i = 0; i < total; i++) {
      left[i]! *= scale
      right[i]! *= scale
    }
  }
  return { left, right, sampleRate, perSynth, normalized }
}
