import { describe, it, expect } from 'vitest'
import { analyze, fft } from '../src/analysis'
import type { RenderResult } from '../src/render'

const SR = 48000

const result = (left: Float32Array, right?: Float32Array, sampleRate = SR): RenderResult => ({
  left,
  right: right ?? left.slice(),
  sampleRate,
})

const sine = (freqHz: number, amp: number, durSec: number, sr = SR): Float32Array => {
  const n = Math.round(durSec * sr)
  const buf = new Float32Array(n)
  const w = (2 * Math.PI * freqHz) / sr
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin(w * i)
  return buf
}

/** Deterministic uniform noise in [-1, 1) via a 32-bit LCG. */
const seededNoise = (n: number, seed: number): Float32Array => {
  const buf = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    buf[i] = s / 2147483648 - 1
  }
  return buf
}

describe('analyze: known signals', () => {
  it('440 Hz sine, amp 0.5: level, spectrum, bands, width', () => {
    const a = analyze(result(sine(440, 0.5, 1)))
    expect(a.durationSec).toBeCloseTo(1, 6)
    expect(a.sampleRate).toBe(SR)
    expect(a.rms).toBeGreaterThan(0.354 * 0.95)
    expect(a.rms).toBeLessThan(0.354 * 1.05)
    expect(a.peak).toBeGreaterThan(0.49)
    expect(a.peak).toBeLessThanOrEqual(0.501)
    expect(a.clipped).toBe(false)
    expect(a.isSilent).toBe(false)
    expect(a.hasNaN).toBe(false)
    expect(a.spectralCentroidHz).toBeGreaterThan(380)
    expect(a.spectralCentroidHz).toBeLessThan(500)
    expect(a.spectralRolloffHz).toBeLessThan(1000)
    expect(a.spectralFlatness).toBeLessThan(0.2)
    // 440 Hz sits in the mid band (250-4000)
    expect(a.lowMidHighRatio[0]).toBeLessThan(0.05)
    expect(a.lowMidHighRatio[1]).toBeGreaterThan(0.9)
    expect(a.lowMidHighRatio[2]).toBeLessThan(0.05)
    // identical L and R = perfectly mono
    expect(a.stereoWidth).toBeLessThan(0.05)
  })

  it('white noise: flat spectrum, centroid near sr/4, wide when decorrelated', () => {
    const n = SR // 1 s
    const mono = analyze(result(seededNoise(n, 1)))
    expect(mono.spectralFlatness).toBeGreaterThan(0.5)
    // Hann-windowed white noise: power-weighted centroid ~ sr/4 = 12 kHz
    expect(mono.spectralCentroidHz).toBeGreaterThan(8000)
    expect(mono.spectralCentroidHz).toBeLessThan(14000)
    expect(mono.stereoWidth).toBeLessThan(0.05)

    const wide = analyze(result(seededNoise(n, 1), seededNoise(n, 2)))
    expect(wide.stereoWidth).toBeGreaterThan(0.7)
  })

  it('silence: silent flags, sentinel attack, zero bands', () => {
    const a = analyze(result(new Float32Array(SR / 2)))
    expect(a.isSilent).toBe(true)
    expect(a.rms).toBe(0)
    expect(a.peak).toBe(0)
    expect(a.attackTimeMs).toBeNull()
    expect(a.lowMidHighRatio).toEqual([0, 0, 0])
    expect(a.hasNaN).toBe(false)
    expect(a.clipped).toBe(false)
  })

  it('click at t=2s in 4s: loudest moment and envelope spike located', () => {
    const buf = new Float32Array(4 * SR)
    buf[2 * SR] = 0.8
    const a = analyze(result(buf))
    expect(Math.abs(a.loudestMomentSec - 2)).toBeLessThan(0.1)
    expect(a.envelope).toHaveLength(50)
    // t=2s of 4s -> segment index 25; max-abs (not mean) keeps the transient
    expect(a.envelope[25]).toBeGreaterThan(0.5)
    expect(a.envelope[10]).toBeLessThan(0.01)
    expect(a.envelope[40]).toBeLessThan(0.01)
  })

  it('band ratios: 100 Hz is low, 8 kHz is high', () => {
    const low = analyze(result(sine(100, 0.5, 1)))
    expect(low.lowMidHighRatio[0]).toBeGreaterThan(0.9)
    expect(low.lowMidHighRatio[2]).toBeLessThan(0.05)
    const high = analyze(result(sine(8000, 0.5, 1)))
    expect(high.lowMidHighRatio[2]).toBeGreaterThan(0.9)
    expect(high.lowMidHighRatio[0]).toBeLessThan(0.05)
  })

  it('attack time: instant step is fast, 2s swell is slow', () => {
    const sharp = new Float32Array(SR / 2).fill(0.9)
    expect(analyze(result(sharp)).attackTimeMs).toBeLessThan(5)

    const swell = new Float32Array(2 * SR)
    for (let i = 0; i < swell.length; i++) swell[i] = 0.9 * (i / (swell.length - 1))
    expect(analyze(result(swell)).attackTimeMs).toBeGreaterThan(500)
  })

  it('clipped when peak touches full scale', () => {
    const hot = sine(440, 1.0, 0.5)
    hot[100] = 1.0 // guarantee an exactly-full-scale sample
    const a = analyze(result(hot))
    expect(a.clipped).toBe(true)
    expect(analyze(result(sine(440, 0.9, 0.5))).clipped).toBe(false)
  })

  it('out-of-phase stereo reads as narrow (width ~0), by design', () => {
    // width = 1 - |corr|: an inverted copy has corr = -1, so width 0 — it IS
    // narrow (and mono-sums to silence); see the stereoWidth field doc
    const l = sine(440, 0.5, 0.5)
    const r = new Float32Array(l.length)
    for (let i = 0; i < l.length; i++) r[i] = -l[i]!
    expect(analyze(result(l, r)).stereoWidth).toBeLessThan(0.05)
  })

  it('detects NaN', () => {
    const buf = sine(440, 0.5, 0.5)
    buf[1000] = Number.NaN
    expect(analyze(result(buf)).hasNaN).toBe(true)
    expect(analyze(result(sine(440, 0.5, 0.5))).hasNaN).toBe(false)
  })
})

describe('fft', () => {
  it('impulse -> flat magnitude spectrum', () => {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    re[0] = 1
    fft(re, im)
    for (let k = 0; k < n; k++) {
      expect(Math.hypot(re[k]!, im[k]!)).toBeCloseTo(1, 9)
    }
  })

  it('pure tone -> energy only in its bin (and its conjugate)', () => {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 8 * i) / n)
    fft(re, im)
    for (let k = 0; k < n; k++) {
      const mag = Math.hypot(re[k]!, im[k]!)
      if (k === 8 || k === n - 8) expect(mag).toBeCloseTo(n / 2, 6)
      else expect(mag).toBeLessThan(1e-6)
    }
  })

  it('rejects non-power-of-two sizes', () => {
    expect(() => fft(new Float64Array(48), new Float64Array(48))).toThrow(RangeError)
  })
})
