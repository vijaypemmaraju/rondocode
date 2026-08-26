import { BLOCK, MAX_MIC_INPUTS, RealtimeEngine } from '@rondocode/engine'
import type { EngineMessage } from '@rondocode/engine'

/* AudioWorkletGlobalScope globals (sampleRate, currentFrame,
 * AudioWorkletProcessor, registerProcessor) come from ./worklet-globals.d.ts
 * — this directory is a separate DOM-free tsconfig project so worklet and
 * main-thread type surfaces stay isolated. */

/** Meter cadence: one meters event every 10 blocks (~27 ms at 48 kHz). */
const METER_EVERY = 10

/** The ~30-line adapter: everything real lives in RealtimeEngine (pure TS).
 *  The Web Audio render quantum is 128 frames = the engine's BLOCK; if a host
 *  ever hands us a different length the engine zeroes the block and reports a
 *  rate-limited error event instead of throwing. */
class RondocodeProcessor extends AudioWorkletProcessor {
  private readonly engine = new RealtimeEngine({ sampleRate })
  /** Discard buffer for the R leg when the output is unexpectedly mono. */
  private readonly scratch = new Float32Array(BLOCK)
  /** Reused view of output channels 2..N (allocated once, refilled per block
   *  — the render quantum must not allocate). */
  private extra: Float32Array[] | null = null
  private blocks = 0

  constructor() {
    super()
    // The engine validates message shapes itself — the cast just crosses the
    // structured-clone boundary; malformed data comes back as an error event.
    this.port.onmessage = (e) => this.engine.handleMessage(e.data as EngineMessage)
    this.engine.onEvent = (ev) => this.port.postMessage(ev)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const l = out?.[0]
    if (!l) return true // no output wired yet: keep the processor alive
    const r = out[1] ?? this.scratch // mono fallback: play the L leg only
    // live inputs: slot 0 = the default mic, slots 1.. = device-named
    // captures (silent/absent unless AudioSession connected them)
    for (let s = 0; s < MAX_MIC_INPUTS; s++) this.engine.writeMic(inputs[s]?.[0] ?? null, s)
    // Hardware channels beyond the master pair (a multichannel interface):
    // handed to the engine so routed strips (`out lead 3..4`) land on them.
    if (out.length > 2) {
      if (this.extra === null || this.extra.length !== out.length - 2) {
        this.extra = new Array<Float32Array>(out.length - 2)
      }
      for (let k = 2; k < out.length; k++) this.extra[k - 2] = out[k]!
      this.engine.process(l, r, currentFrame, this.extra)
    } else {
      this.engine.process(l, r, currentFrame)
    }
    if (++this.blocks % METER_EVERY === 0) {
      this.port.postMessage(this.engine.collectMeters())
      const probe = this.engine.collectProbes() // null unless the editor set probes
      if (probe !== null) this.port.postMessage(probe)
    }
    return true
  }
}

registerProcessor('rondocode-engine', RondocodeProcessor)
