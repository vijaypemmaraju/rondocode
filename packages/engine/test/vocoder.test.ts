import { describe, it, expect } from 'vitest'
import { VocoderKernel } from '../src/dsp/vocoder'
import type { VocoderConfig } from '../src/dsp/vocoder'
import { SawKernel } from '../src/dsp/osc'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

/** rich carrier: a saw whose harmonics land on the test frequencies. */
const saw = (freq: number, n: number): Float32Array => {
  const o = new Float32Array(n)
  new SawKernel().process(n, { freq: new Float32Array(n).fill(freq) }, o, ctx)
  return o
}
const sine = (freq: number, n: number): Float32Array => {
  const o = new Float32Array(n)
  for (let i = 0; i < n; i++) o[i] = Math.sin((2 * Math.PI * freq * i) / sr)
  return o
}
const voc = (carrier: Float32Array, modulator: Float32Array, cfg: VocoderConfig = {}): Float32Array => {
  const o = new Float32Array(carrier.length)
  new VocoderKernel(cfg, ctx).process(carrier.length, { carrier, modulator }, o, ctx)
  return o
}
const rms = (x: Float32Array): number => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / x.length)
}

describe('VocoderKernel', () => {
  it('imposes the modulator’s spectral envelope onto the carrier', () => {
    const n = 24000
    const carrier = saw(100, n) // harmonics at 300, 3000, …
    // a low-band modulator vs a high-band modulator (pure tones in each region)
    const outLow = voc(carrier, sine(300, n))
    const outHigh = voc(carrier, sine(3000, n))
    // Compare the SAME carrier harmonic across the two modulators: the band is
    // open only when the modulator has energy there.
    // 300 Hz harmonic: passed under the low modulator, gated out under the high.
    expect(goertzel(outLow, 300, sr)).toBeGreaterThan(goertzel(outHigh, 300, sr) * 2)
    // 3000 Hz harmonic: passed under the high modulator, gated out under the low.
    expect(goertzel(outHigh, 3000, sr)).toBeGreaterThan(goertzel(outLow, 3000, sr) * 2)
  })

  it('is silent when the modulator is silent (no band energy to pass)', () => {
    const n = 12000
    const out = voc(saw(110, n), new Float32Array(n))
    expect(rms(out)).toBeLessThan(1e-4)
  })

  it('stays finite and bounded (soft-clipped) across band counts', () => {
    for (const bands of [4, 16, 32]) {
      const out = voc(saw(80, 12000), sine(500, 12000), { bands })
      let peak = 0
      for (let i = 0; i < out.length; i++) {
        expect(Number.isNaN(out[i]!)).toBe(false)
        peak = Math.max(peak, Math.abs(out[i]!))
      }
      expect(peak).toBeLessThan(8) // linear (no internal clip); the master stage limits
    }
  })

  it('bands has a real effect: 32 narrow bands isolate the modulator far more sharply than 4', () => {
    // A 500 Hz sine modulator opens only the bands containing 500 Hz. With 4
    // wide bands, plenty of off-target carrier energy (e.g. near 3 kHz) leaks
    // through the same band; with 32 narrow bands it is squeezed out. If the
    // `bands` config were ignored, both selectivities would be identical.
    const n = 24000
    const sel = (bands: number): number => {
      const out = voc(saw(100, n), sine(500, n), { bands })
      const half = out.subarray(n >> 1) // filterbank settled
      return goertzel(half, 500, sr) / (goertzel(half, 3000, sr) + 1e-30)
    }
    const sel4 = sel(4)
    const sel32 = sel(32)
    // measured: ~163 vs ~2716 (16.7x). Pin a conservative 3x.
    expect(sel32).toBeGreaterThan(sel4 * 3)
    expect(Number.isFinite(sel4)).toBe(true)
  })
})
