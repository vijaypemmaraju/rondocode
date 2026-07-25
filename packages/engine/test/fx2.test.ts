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
  it('sweeps MOVING spectral notches across the harmonics (not a static allpass/EQ)', () => {
    // 2 s of a rich saw through a 1 Hz phaser: two windows half an LFO period
    // apart sit at opposite sweep positions, so the notch pattern must MOVE.
    // A static allpass or EQ has one steady-state spectrum — every harmonic
    // ratio between the windows would be ~1 and both assertions below fail.
    const n = 2 * sr
    const dry = saw(220, n)
    const out = new Float32Array(n)
    new PhaserKernel({ rate: 1, depth: 0.8, feedback: 0.5 }).process(n, { in: dry }, out, ctx)
    const winA = out.subarray(Math.round(0.5 * sr), Math.round(0.75 * sr))
    const winB = out.subarray(Math.round(1.0 * sr), Math.round(1.25 * sr))
    let maxRatio = 0
    let minRatio = Infinity
    for (let k = 1; k <= 30; k++) {
      const f = 220 * k
      const ratio = goertzel(winA, f, sr) / goertzel(winB, f, sr)
      maxRatio = Math.max(maxRatio, ratio)
      minRatio = Math.min(minRatio, ratio)
    }
    // measured: max ~11x, min ~0.07x — some harmonic is notched in window B
    // but open in window A, and vice versa. Pin conservative 2x both ways.
    expect(maxRatio).toBeGreaterThan(2)
    expect(minRatio).toBeLessThan(0.5)
    // and it stays bounded/finite while doing so
    let peak = 0
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, Math.abs(out[i]!))
      expect(Number.isNaN(out[i]!)).toBe(false)
    }
    expect(peak).toBeLessThan(2)
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
