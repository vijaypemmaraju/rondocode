import { BLOCK } from './compile'
import type { SynthDef } from './builder'
import { VoicePool } from './voice'
import { SampleBank } from './samples'
import type { DspContext } from './dsp/types'

/* ------------------------------------------------------------------------- *
 * Offline renderer: turn a SynthDef plus a timed event list into stereo
 * Float32Arrays. This is how tests and AI agents "hear" a patch without an
 * audio device — render, then feed the result to analysis.ts.
 *
 * Time is walked in BLOCK-sample chunks, but every block is additionally
 * split at event boundaries, so events land on their exact sample
 * (VoicePool.process accepts any n <= BLOCK). Renders are fully
 * deterministic — bit-identical across runs — including noise patches
 * (NoiseKernel is seeded xorshift32 with a fixed default seed). The real
 * caveat: multiple unseeded noise nodes in one graph all share that default
 * seed and emit the SAME sequence, i.e. correlated (identical) noise.
 * ------------------------------------------------------------------------- */

export interface RenderEvent {
  /** Event time in seconds from render start. Must be finite and >= 0;
   *  events at or beyond `duration` are ignored. */
  time: number
  type: 'noteOn' | 'noteOff' | 'param'
  /** Midi note number — required for noteOn/noteOff. */
  note?: number
  /** noteOn velocity 0..1; defaults to 1. */
  velocity?: number
  /** Param name — required for param events. Unknown names are a no-op
   *  (matching Voice.setParam's typo tolerance). */
  name?: string
  /** Param value — required for param events. Clamped to the param's
   *  declared [min, max] by the voice. */
  value?: number
}

export interface RenderResult {
  left: Float32Array
  right: Float32Array
  sampleRate: number
}

export interface RenderOptions {
  /** Default 48000. */
  sampleRate?: number
  /** Polyphony of the temporary VoicePool. Default 8. */
  maxVoices?: number
  /** Audio samples available to sample('name') nodes, keyed by name. Each is
   *  mono PCM at its own sampleRate (the kernel resamples to the render rate). */
  samples?: Record<string, { data: Float32Array; sampleRate: number }>
}

/** Sort rank for events landing on the same SAMPLE (ordering happens in the
 *  sample domain — see the sort below): noteOff(0) < param(1) < noteOn(2).
 *  noteOff MUST precede noteOn — that is the retrigger idiom: a
 *  pattern ending one note exactly where the next begins emits noteOff and
 *  noteOn at the same time, and if the noteOn ran first the stale noteOff
 *  would immediately release the freshly (re)triggered voice. param sits in
 *  between so a value scheduled "at" a note's start is in effect when the
 *  note fires. Ties beyond that keep input order (stable sort). */
const rank = (e: RenderEvent): number => (e.type === 'noteOff' ? 0 : e.type === 'param' ? 1 : 2)

const validateEvent = (e: RenderEvent, i: number): void => {
  if (!Number.isFinite(e.time)) {
    throw new RangeError(`renderOffline: events[${i}].time must be a finite number, got ${e.time}`)
  }
  if (e.time < 0) {
    throw new RangeError(`renderOffline: events[${i}].time must be >= 0, got ${e.time}`)
  }
  if (e.type === 'noteOn' || e.type === 'noteOff') {
    if (typeof e.note !== 'number' || !Number.isFinite(e.note)) {
      throw new TypeError(`renderOffline: events[${i}] (${e.type}) requires a finite 'note'`)
    }
    if (e.velocity !== undefined && !Number.isFinite(e.velocity)) {
      throw new TypeError(`renderOffline: events[${i}].velocity must be finite, got ${e.velocity}`)
    }
  } else if (e.type === 'param') {
    if (typeof e.name !== 'string') {
      throw new TypeError(`renderOffline: events[${i}] (param) requires a string 'name'`)
    }
    if (typeof e.value !== 'number' || !Number.isFinite(e.value)) {
      throw new TypeError(`renderOffline: events[${i}] (param '${e.name}') requires a finite 'value'`)
    }
  } else {
    throw new TypeError(`renderOffline: events[${i}] has unknown type '${String(e.type)}'`)
  }
}

/** Render `def` offline: apply `events` sample-accurately and return
 *  `duration` seconds of stereo audio. Output starts zeroed; the voice pool
 *  ADDS into it (mix-bus semantics), so the result is exactly the voice sum.
 *
 *  - An event's sample index is round(time * sampleRate). Events are stably
 *    sorted by that sample index; same-sample ties order
 *    noteOff < param < noteOn (see `rank` for why). Note the rounding means
 *    a time just under `duration` whose sample rounds up to the buffer
 *    length (e.g. duration - 1/(2*sampleRate)) is dropped as out of range.
 *  - noteOff with no matching sounding note is a no-op; so are param events
 *    naming an undeclared param.
 *  - duration must be > 0 and <= 300 s (offline safety rail — ~14.4M samples
 *    at 48k; anything longer is almost certainly a bug in the caller). */
export function renderOffline(
  def: SynthDef,
  events: RenderEvent[],
  duration: number,
  opts?: RenderOptions,
): RenderResult {
  const sampleRate = opts?.sampleRate ?? 48000
  const maxVoices = opts?.maxVoices ?? 8
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError(`renderOffline: duration must be > 0 seconds, got ${duration}`)
  }
  if (duration > 300) {
    throw new RangeError(`renderOffline: duration must be <= 300 seconds, got ${duration}`)
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`renderOffline: sampleRate must be > 0, got ${sampleRate}`)
  }
  if (!Number.isInteger(maxVoices) || maxVoices < 1) {
    throw new RangeError(`renderOffline: maxVoices must be an integer >= 1, got ${maxVoices}`)
  }
  events.forEach(validateEvent)

  const totalSamples = Math.round(duration * sampleRate)
  const left = new Float32Array(totalSamples)
  const right = new Float32Array(totalSamples)
  // voiceOpts (mono/glide/unison/...) flow straight through — offline renders
  // exactly what the live VoicePool would, since both use this same class.
  const ctx: DspContext = { sampleRate }
  if (opts?.samples !== undefined) {
    const bank = new SampleBank()
    for (const [name, s] of Object.entries(opts.samples)) bank.set(name, s.data, s.sampleRate)
    ctx.samples = bank
  }
  const pool = new VoicePool(def.graph, ctx, maxVoices, def.voiceOpts)

  // Stable sort in the SAMPLE domain, not by float time: two events whose
  // times differ only by float error (13 * 0.1 vs 1.3) land on the same
  // sample, and only sample-domain ordering lets the noteOff<noteOn tie rule
  // see them as simultaneous. Events past the end are dropped up front.
  const timed = events
    .map((e) => ({ e, sample: Math.round(e.time * sampleRate) }))
    .filter((t) => t.sample < totalSamples)
    .sort((a, b) => a.sample - b.sample || rank(a.e) - rank(b.e))

  let cursor = 0
  let next = 0
  while (cursor < totalSamples) {
    // apply everything scheduled at (or before — first iteration) the cursor
    while (next < timed.length && timed[next]!.sample <= cursor) {
      const e = timed[next]!.e
      if (e.type === 'noteOn') pool.noteOn(e.note!, e.velocity ?? 1)
      else if (e.type === 'noteOff') pool.noteOff(e.note!)
      else pool.setParam(e.name!, e.value!)
      next++
    }
    // render up to the next block boundary or event, whichever comes first
    let end = Math.min(cursor + BLOCK, totalSamples)
    if (next < timed.length && timed[next]!.sample < end) end = timed[next]!.sample
    pool.process(left.subarray(cursor, end), right.subarray(cursor, end), end - cursor)
    cursor = end
  }

  return { left, right, sampleRate }
}
