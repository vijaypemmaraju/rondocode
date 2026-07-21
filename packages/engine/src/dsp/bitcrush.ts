import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface BitcrushConfig {
  /** Bit depth 1..16 — the signal is quantized to 2^bits levels. Fewer bits =
   *  coarser, grittier steps. Default 8. */
  bits?: number
  /** Sample-and-hold factor 1..64 (integer) — the output holds each grabbed
   *  sample for this many output samples, reducing the effective sample rate.
   *  Default 1 (no downsampling). */
  downsample?: number
}

/** Lo-fi bit + sample-rate reducer. Input 'in'; bits/downsample are
 *  construction config, NOT per-sample inputs. Every `downsample` samples it
 *  grabs the input, quantizes it to 2^bits levels (`round(x*half)/half`, where
 *  half = 2^(bits-1) — a mid-tread quantizer), and HOLDS that value for the
 *  intervening samples. The hold reduces the effective sample rate (aliasing
 *  grit); the quantization reduces bit depth (digital fuzz).
 *
 *  Stateful (hold counter + held value) but has no feedback path, so there is
 *  nothing to accumulate: quantized silence is exactly 0 and a held value is
 *  just a delayed input. A non-finite held value is scrubbed to 0 at block end
 *  so a stray NaN cannot latch. */
export class BitcrushKernel implements Kernel {
  private readonly half: number
  private readonly downsample: number
  private counter = 0
  private held = 0

  constructor(config: BitcrushConfig = {}, _ctx?: DspContext) {
    const bits = Math.round(clamp(config.bits ?? 8, 1, 16))
    this.half = 2 ** (bits - 1)
    this.downsample = Math.round(clamp(config.downsample ?? 1, 1, 64))
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, _ctx: DspContext): void {
    const input = inputs['in']!
    const half = this.half
    const downsample = this.downsample
    let counter = this.counter
    let held = this.held
    for (let i = 0; i < n; i++) {
      if (counter === 0) {
        held = Math.round(input[i]! * half) / half
        counter = downsample
      }
      out[i] = held
      counter--
    }
    if (!Number.isFinite(held)) held = 0
    this.counter = counter
    this.held = held
  }

  reset(): void {
    this.counter = 0
    this.held = 0
  }
}
