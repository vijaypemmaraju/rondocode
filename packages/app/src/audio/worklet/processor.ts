import { BLOCK, RealtimeEngine } from '@rondocode/engine'
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
  private blocks = 0

  constructor() {
    super()
    // The engine validates message shapes itself — the cast just crosses the
    // structured-clone boundary; malformed data comes back as an error event.
    this.port.onmessage = (e) => this.engine.handleMessage(e.data as EngineMessage)
    this.engine.onEvent = (ev) => this.port.postMessage(ev)
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const l = out?.[0]
    if (!l) return true // no output wired yet: keep the processor alive
    const r = out[1] ?? this.scratch // mono fallback: play the L leg only
    this.engine.process(l, r, currentFrame)
    if (++this.blocks % METER_EVERY === 0) this.port.postMessage(this.engine.collectMeters())
    return true
  }
}

registerProcessor('rondocode-engine', RondocodeProcessor)
