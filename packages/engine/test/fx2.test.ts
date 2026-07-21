import { describe, it, expect } from 'vitest'
import { PhaserKernel, FormantKernel } from '../src/dsp/fx2'
import { SawKernel } from '../src/dsp/osc'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

const saw = (freq: number, n: number): Float32Array => {
  const out = new Float32Array(n)
  new SawKernel().process(n, { freq: new Float32Array(n).fill(freq) }, out, ctx)
  return out
}
const rms = (x: Float32Array): number => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / x.length)
}

describe('PhaserKernel', () => {
  it('alters the signal, stays bounded, and is time-varying (LFO sweep)', () => {
    const n = 48000
    const dry = saw(220, n)
    const out = new Float32Array(n)
    new PhaserKernel({ rate: 2, depth: 0.8, feedback: 0.5 }).process(n, { in: dry }, out, ctx)
    let diff = 0
    let peak = 0
    for (let i = 0; i < n; i++) {
      diff += Math.abs(out[i]! - dry[i]!)
      peak = Math.max(peak, Math.abs(out[i]!))
      expect(Number.isNaN(out[i]!)).toBe(false)
    }
    expect(diff / n).toBeGreaterThan(0.001) // it actually did something
    expect(peak).toBeLessThan(2) // bounded
    // time-varying: the first and last quarter-seconds differ in character
    const early = rms(out.subarray(0, sr / 4))
    const mid = rms(out.subarray(sr / 2, sr / 2 + sr / 4))
    expect(Math.abs(early - mid)).toBeGreaterThan(1e-4)
  })
})

describe('FormantKernel', () => {
  const formant = (morph: number, freq: number, n: number): Float32Array => {
    const out = new Float32Array(n)
    new FormantKernel().process(n, { in: saw(freq, n), morph: new Float32Array(n).fill(morph) }, out, ctx)
    return out
  }

  it("boosts a vowel's formant band and morph moves it", () => {
    const n = 24000
    // vowel 'a' (morph 0): F1 ~730 Hz. vowel 'u' (morph 1): F1 ~300 Hz.
    const a = formant(0, 110, n) // rich saw at 110 Hz, harmonics every 110
    const u = formant(1, 110, n)
    // 'a' has much more energy near 730 (its F1) than 'u' does
    expect(goertzel(a, 770, sr)).toBeGreaterThan(goertzel(u, 770, sr) * 2)
    // 'u' concentrates low (F1 ~300): more energy near 330 than 'a' has there
    expect(goertzel(u, 330, sr)).toBeGreaterThan(goertzel(a, 330, sr) * 1.5)
  })

  it('stays finite and bounded', () => {
    const out = formant(0.5, 150, 24000)
    let peak = 0
    for (let i = 0; i < out.length; i++) {
      expect(Number.isNaN(out[i]!)).toBe(false)
      peak = Math.max(peak, Math.abs(out[i]!))
    }
    expect(peak).toBeLessThan(4)
  })
})
