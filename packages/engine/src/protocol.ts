import type { GraphSpec } from './graph'
import type { VoiceOpts } from './voice'

/* ------------------------------------------------------------------------- *
 * Wire protocol between the host (main thread) and the RealtimeEngine
 * (AudioWorklet). Every type here crosses a postMessage boundary, so all of
 * it MUST stay structured-clone-safe: plain objects, strings, and numbers
 * only — no class instances, functions, Maps, or typed arrays. GraphSpec is
 * already plain data by construction.
 *
 * The engine never throws on a message: malformed or out-of-policy messages
 * come back as an { kind: 'error' } EngineEvent instead (see realtime.ts).
 * ------------------------------------------------------------------------- */

/** Host → engine. */
export type EngineMessage = (
  /** Create or atomically REPLACE the synth named `name`. Replacement only
   *  happens if the new graph compiles — a bad graph leaves the old synth
   *  untouched (last-good-version guarantee). `maxVoices` defaults to 8 and
   *  is clamped so the total across all synths stays within the engine's
   *  voice budget. Definition is a control-plane op: compiling allocates, so
   *  a very complex graph may glitch audio for a block or two — hosts can
   *  pre-validate on the main thread (builder's synth() compiles) to make
   *  worklet-side failures rare. */
  | { kind: 'defineSynth'; name: string; graph: GraphSpec; post?: GraphSpec; voiceOpts?: VoiceOpts; maxVoices?: number }
  /** Live-patch input-port constants of an already-defined synth WITHOUT
   *  rebuilding its voice pool — updates every voice's compiled input buffer
   *  in place, so ringing notes keep their state and sweep continuously. The
   *  host sends this (instead of defineSynth) only when the new graph differs
   *  from the live one solely in numeric input constants (see patch.ts /
   *  diffGraphConstants). Unknown synth → no-op. */
  | { kind: 'patchConstants'; name: string; patches: { node: number; port: string; value: number }[] }
  /** Drop the synth and all its voices immediately (hard stop, no release). */
  | { kind: 'removeSynth'; name: string }
  /** `atFrame` is an absolute frame in the SAME timeline the host passes as
   *  `startFrame` to RealtimeEngine.process() — for an AudioWorklet host
   *  that's the context's running frame counter. Omitted or already past →
   *  applies at the start of the next block; in the future → queued and
   *  applied sample-accurately. Schedulers learn "now" from the `frame`
   *  field of meters events (or engine.currentFrame on the worklet side). */
  | { kind: 'noteOn'; synth: string; note: number; velocity?: number; atFrame?: number }
  | { kind: 'noteOff'; synth: string; note: number; atFrame?: number }
  /** Panic: releases every note on every synth NOW and drops all queued
   *  note events. */
  | { kind: 'allNotesOff' }
  /** Set a declared synth param. rampMs (default 0 = instant, clamped to
   *  [0, 10000]) ramps the value linearly, applied at block granularity
   *  (~2.7ms at 48kHz) — params are block-rate in the voice pool. */
  | { kind: 'setParam'; synth: string; name: string; value: number; rampMs?: number }
  /** Channel strip: per-synth gain (default 0.8) and pan (default 0.5,
   *  equal-power balance). Changes ramp over one block to avoid zipper.
   *  `sidechain` (0..1, default 1) is how much THIS channel responds to the
   *  sidechain duck: 1 = full duck (down to 1 - depth), 0 = ignore the duck
   *  entirely. Clamped to [0, 1]; the source channel is never ducked
   *  regardless. Lets some channels pump hard while others stay steady. */
  | { kind: 'setChannel'; synth: string; gain?: number; pan?: number; sidechain?: number }
  /** Master gain (default 0.8), ramped over one block. */
  | { kind: 'setMaster'; gain: number }
  /** SIDECHAIN DUCK: every noteOn to `source` snaps a duck envelope down to
   *  `1 - depth` (instant attack) which then recovers toward 1 via a one-pole
   *  release; the envelope multiplies every channel EXCEPT `source` (the kick
   *  stays full) — the classic progressive-house "pump". `depth` is 0..1
   *  (default 0.6, clamped); `releaseMs` is the recovery time constant
   *  (default 180, clamped to [1, 5000]). Last setSidechain wins. */
  | { kind: 'setSidechain'; source: string; depth?: number; releaseMs?: number }
  /** Remove the sidechain duck: the level returns to 1 (no ducking). */
  | { kind: 'clearSidechain' }
  /** Load (or REPLACE) a mono audio sample under `name`, available to any
   *  synth's sample('name') node. `data` is Float32 PCM (stereo is downmixed
   *  to mono by the host before sending); `sampleRate` is the buffer's own
   *  rate (the kernel resamples to the engine rate). Loading is a control-plane
   *  op; already-compiled synths pick the sample up on their next block. */
  | { kind: 'loadSample'; name: string; data: Float32Array; sampleRate: number }
  /** Drop a loaded sample; synths referencing `name` fall back to silence. */
  | { kind: 'clearSample'; name: string }
  /** MASTER GLUE COMPRESSOR: a stereo-linked feed-forward compressor on the
   *  master bus, after master gain and before the limiter. All fields optional
   *  with compressor defaults (threshold -18 dB, ratio 4, attack 10 ms, release
   *  120 ms, knee 6 dB, makeup 0 dB). Last setMasterComp wins. */
  | { kind: 'setMasterComp'; threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number }
  /** Remove the master glue compressor (no reduction). */
  | { kind: 'clearMasterComp' }
) & {
  /** Optional correlation id, echoed back on any error event this message
   *  provokes so hosts (MCP bridge, UI) can match failures to requests.
   *  Successes are silent — no ack events in v1. */
  id?: string
}

/** Engine → host. */
export type EngineEvent =
  /** Anything the engine refused or scrubbed: bad message, failed
   *  defineSynth, unknown synth/param, queue overflow, NaN scrub. `id`
   *  echoes the offending message's correlation id when it carried one
   *  (audio-path errors like NaN scrub have none). */
  | { kind: 'error'; message: string; context?: string; id?: string }
  /** RMS of the LAST processed block, per synth (post channel strip) and for
   *  the master output. `frame` is the engine's current frame at collection
   *  time (the end of the last processed block) — the natural "now" heartbeat
   *  for schedulers stamping future atFrame values. Produced by
   *  RealtimeEngine.collectMeters() on request — the engine does not emit
   *  these unprompted. */
  | { kind: 'meters'; frame: number; master: number; channels: Record<string, number> }
