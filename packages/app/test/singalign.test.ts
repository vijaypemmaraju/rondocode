import { describe, expect, it } from 'vitest'
import { measureLagSamples } from '../src/sing/neural'

/* Objective on-beat alignment: measureLagSamples cross-correlates the RVC
 * output's energy envelope against the beat-aligned guide's and returns the lag
 * (in output samples) needed to seat the vocal on the grid — replacing the old
 * hand-tuned delay constant. These tests feed it a synthetic guide and a known
 * time-shifted copy and assert it recovers the shift. */

/** A signal with Gaussian energy bursts (stand-ins for sung syllables) at the
 *  given times, sampled at `rate`. */
function bursts(rate: number, durSec: number, atSec: number[], widthSec = 0.02): Float32Array {
  const x = new Float32Array(Math.round(rate * durSec))
  const w = widthSec * rate
  for (const p of atSec) {
    const c = p * rate
    for (let k = Math.max(0, Math.floor(c - 4 * w)); k < Math.min(x.length, c + 4 * w); k++) {
      x[k]! += Math.exp(-0.5 * ((k - c) / w) ** 2)
    }
  }
  return x
}

const POS = [0.1, 0.35, 0.6, 0.85] // four "syllables" over a 1s loop
const FRAME_S = 1 / 500 // measurement granularity (frameHz=500) → tolerance

describe('measureLagSamples', () => {
  it('recovers a delay: output lagging the guide → positive lag (rotate left to align)', () => {
    const sr = 48000
    const guide = bursts(sr, 1, POS)
    const delaySec = 0.03
    const output = bursts(sr, 1, POS.map((p) => p + delaySec))
    const lag = measureLagSamples(guide, sr, output, sr)
    // within one frame of the true delay
    expect(Math.abs(lag - delaySec * sr)).toBeLessThan(FRAME_S * sr)
  })

  it('recovers an advance: output ahead of the guide → negative lag', () => {
    const sr = 48000
    const guide = bursts(sr, 1, POS)
    const output = bursts(sr, 1, POS.map((p) => p - 0.024))
    const lag = measureLagSamples(guide, sr, output, sr)
    expect(lag).toBeLessThan(0)
    expect(Math.abs(lag - -0.024 * sr)).toBeLessThan(FRAME_S * sr)
  })

  it('returns ~0 when guide and output are already aligned', () => {
    const sr = 48000
    const guide = bursts(sr, 1, POS)
    const lag = measureLagSamples(guide, sr, bursts(sr, 1, POS), sr)
    expect(Math.abs(lag)).toBeLessThan(FRAME_S * sr)
  })

  it('works across different sample rates (guide 44.1k, output 48k)', () => {
    const guide = bursts(44100, 1, POS)
    const delaySec = 0.02
    const output = bursts(48000, 1, POS.map((p) => p + delaySec))
    const lag = measureLagSamples(guide, 44100, output, 48000)
    // lag is in OUTPUT samples; allow the cross-rate frame quantization (±1 frame)
    expect(Math.abs(lag - delaySec * 48000)).toBeLessThan(1.5 * FRAME_S * 48000)
  })

  it('is bounded by maxLagS and never NaN on silence', () => {
    const sr = 48000
    const silent = new Float32Array(sr)
    expect(measureLagSamples(silent, sr, silent, sr)).toBe(0)
    // a delay beyond the search window is clamped, not chased past ±maxLagS
    const guide = bursts(sr, 1, POS)
    const output = bursts(sr, 1, POS.map((p) => p + 0.03))
    const lag = measureLagSamples(guide, sr, output, sr, 0.01) // 10ms window
    expect(Math.abs(lag)).toBeLessThanOrEqual(Math.round(0.01 * sr) + 1)
  })
})
