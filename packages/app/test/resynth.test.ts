import { afterEach, describe, expect, it } from 'vitest'
import { analyzePartials, toWavedefLine, toDefineWavetableCall, wavetableNameFor } from '../src/editor/resynth'
import { clearCustomWavetables, defineWavetable, getWavetableBank, WAVETABLE_FRAME_SIZE } from '@rondocode/engine'
import { compile } from '@rondocode/rondo'

/* The resynthesis contract, pinned numerically on synthetic signals whose
 * true spectra are known in closed form. Deterministic throughout: the same
 * PCM analyzes to the same frames, forever. */

const SR = 44100

/** Additive test tone: sum of a(k)*sin(2*pi*k*f0*t), k = 1..maxK. */
const gen = (f0: number, len: number, a: (k: number) => number, maxK: number): Float32Array => {
  const x = new Float32Array(len)
  for (let k = 1; k <= maxK; k++) {
    const amp = a(k)
    if (amp === 0) continue
    const w = (2 * Math.PI * k * f0) / SR
    for (let i = 0; i < len; i++) x[i]! += amp * Math.sin(w * i)
  }
  return x
}

afterEach(() => clearCustomWavetables())

describe('analyzePartials: f0 detection', () => {
  it('finds a sawtooth fundamental within 0.05%', () => {
    const r = analyzePartials(gen(220, SR, (k) => 1 / k, 40), SR)
    expect(Math.abs(r.f0 - 220) / 220).toBeLessThan(0.0005)
    expect(r.clarity).toBeGreaterThan(0.95)
  })

  it('resists the octave error when the 2nd harmonic dominates', () => {
    // fundamental at 0.4, 2nd harmonic at 1.0 — a global-max ACF picker (or a
    // spectral peak picker) would report 392 Hz
    const trap = gen(196, SR, (k) => (k === 1 ? 0.4 : k === 2 ? 1 : 1 / k), 20)
    const r = analyzePartials(trap, SR)
    expect(Math.abs(r.f0 - 196) / 196).toBeLessThan(0.005)
  })

  it('an f0 override skips detection', () => {
    const r = analyzePartials(gen(220, SR, (k) => 1 / k, 40), SR, { f0: 220 })
    expect(r.f0).toBe(220)
    expect(r.clarity).toBe(1)
  })
})

describe('analyzePartials: partial amplitudes', () => {
  it('a sawtooth resynthesizes to ~1/k rolloff (per-partial err < 0.02, rel L2 < 0.03)', () => {
    const r = analyzePartials(gen(220, SR, (k) => 1 / k, 40), SR)
    expect(r.frames.length).toBe(8)
    const mid = r.frames[4]!
    expect(mid.length).toBe(16)
    let l2num = 0
    let l2den = 0
    for (let k = 1; k <= 16; k++) {
      const want = 1 / k
      const err = Math.abs(mid[k - 1]! - want)
      expect(err, `partial ${k}`).toBeLessThan(0.02) // measured max ~0.011
      l2num += err * err
      l2den += want * want
    }
    expect(Math.sqrt(l2num / l2den)).toBeLessThan(0.03) // measured ~0.010
  })

  it('a sine is a single partial (all others < 0.005)', () => {
    const r = analyzePartials(gen(440, SR, (k) => (k === 1 ? 1 : 0), 1), SR)
    for (const fr of r.frames) {
      expect(fr[0]!).toBeGreaterThan(0.99)
      for (let k = 2; k <= 16; k++) expect(fr[k - 1]!, `partial ${k}`).toBeLessThan(0.005)
    }
  })

  it('a square keeps only odd partials (evens < 0.01)', () => {
    const r = analyzePartials(gen(110, SR, (k) => (k % 2 === 1 ? 1 / k : 0), 40), SR)
    const mid = r.frames[3]!
    for (let k = 2; k <= 16; k += 2) expect(mid[k - 1]!, `partial ${k}`).toBeLessThan(0.01)
    expect(Math.abs(mid[2]! - 1 / 3)).toBeLessThan(0.02)
    expect(Math.abs(mid[4]! - 1 / 5)).toBeLessThan(0.02)
  })

  it('a non-bin-aligned fundamental stays accurate (233.7 Hz, worst-case bin offset)', () => {
    const r = analyzePartials(gen(233.7, SR, (k) => 1 / k, 40), SR)
    const mid = r.frames[4]!
    for (let k = 1; k <= 16; k++) expect(Math.abs(mid[k - 1]! - 1 / k), `partial ${k}`).toBeLessThan(0.02)
  })

  it('frames capture an evolving timbre (saw morphing to square across the take)', () => {
    const len = SR
    const x = new Float32Array(len)
    for (let k = 1; k <= 30; k++) {
      const w = (2 * Math.PI * k * 220) / SR
      for (let i = 0; i < len; i++) {
        const t = i / len
        x[i]! += ((1 - t) / k + t * (k % 2 === 1 ? 1 / k : 0)) * Math.sin(w * i)
      }
    }
    const r = analyzePartials(x, SR)
    // harmonic 2: strong in the first frame (saw), gone in the last (square)
    expect(r.frames[0]![1]!).toBeGreaterThan(0.35)
    expect(r.frames[7]![1]!).toBeLessThan(0.08)
  })

  it('is deterministic', () => {
    const pcm = gen(220, SR, (k) => 1 / k, 40)
    expect(analyzePartials(pcm, SR)).toEqual(analyzePartials(pcm, SR))
  })

  it('degrades gracefully: too-short input yields no frames; noise reports low clarity', () => {
    expect(analyzePartials(new Float32Array(64), SR).frames).toEqual([])
    let s = 1 // deterministic LCG noise
    const noise = new Float32Array(SR / 2).map(() => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x40000000 - 1
    })
    expect(analyzePartials(noise, SR).clarity).toBeLessThan(0.5)
  })
})

describe('serialization', () => {
  it('emits a compiling wavedef line, amplitudes rounded to 3 decimals', () => {
    const r = analyzePartials(gen(220, SR, (k) => 1 / k, 20), SR)
    const line = toWavedefLine('sawtake_wt', r)
    expect(line.startsWith('wavedef sawtake_wt ')).toBe(true)
    expect(line.split(' / ').length).toBe(8)
    for (const tok of line.split(/ \/ | /).slice(2)) expect(tok).toMatch(/^-?(0|\.\d{1,3}|\d+(\.\d{1,3})?)$/)
    const prog = `${line}\n\nsynth s\n  wavetable note 0 table:sawtake_wt\n\nplay s\n  0\n`
    const c = compile(prog)
    expect(c.ok, JSON.stringify(!c.ok ? c.errors : '')).toBe(true)
  })

  it('emits the JS defineWavetable call for rondocode mode', () => {
    const r = analyzePartials(gen(220, SR, (k) => (k <= 3 ? 1 / k : 0), 3), SR, { frames: 2, partials: 4 })
    const call = toDefineWavetableCall('mytab', r)
    expect(call.startsWith("defineWavetable('mytab', [[")).toBe(true)
    // the emitted call is exactly what the engine accepts
    expect(() => new Function('defineWavetable', call)(defineWavetable)).not.toThrow()
    expect(getWavetableBank('mytab')).toBeDefined()
  })

  it('maps sample names to legal table names (letter-first word chars)', () => {
    expect(wavetableNameFor('mic1')).toBe('mic1_wt')
    expect(wavetableNameFor('808 kick!')).toBe('wt808_kick__wt') // digit start gets a wt prefix
    expect(/^[a-zA-Z][a-zA-Z0-9_]*$/.test(wavetableNameFor('808 kick!'))).toBe(true)
  })
})

describe('round trip: source -> wavedef -> engine table is spectrally close', () => {
  it('sawtooth: the synthesized frame matches 1/k within rel L2 0.05', () => {
    const r = analyzePartials(gen(220, SR, (k) => 1 / k, 40), SR)
    // through the REAL serialization (3-decimal rounding) and the REAL engine
    // synthesis path (defineWavetable -> mipmapped bank)
    const line = toWavedefLine('rt_saw', r)
    const frames = line
      .slice('wavedef rt_saw '.length)
      .split(' / ')
      .map((fr) => fr.split(' ').map(Number))
    defineWavetable('rt_saw', frames)
    const bank = getWavetableBank('rt_saw')!
    const wave = bank[4]![0]! // mid frame, full-band mipmap: one cycle, 2048 samples
    // single-cycle DFT at integer harmonics is exact (no leakage)
    const N = WAVETABLE_FRAME_SIZE
    const amp = (k: number): number => {
      let sre = 0
      let sim = 0
      for (let n = 0; n < N; n++) {
        const ph = (2 * Math.PI * k * n) / N
        sre += wave[n]! * Math.cos(ph)
        sim += wave[n]! * Math.sin(ph)
      }
      return (2 / N) * Math.hypot(sre, sim)
    }
    const a1 = amp(1)
    expect(a1).toBeGreaterThan(0)
    let l2num = 0
    let l2den = 0
    for (let k = 1; k <= 16; k++) {
      const got = amp(k) / a1
      const want = 1 / k
      l2num += (got - want) ** 2
      l2den += want ** 2
    }
    // measured ~0.012 (analysis error + 3-decimal rounding); pin 0.05
    expect(Math.sqrt(l2num / l2den)).toBeLessThan(0.05)
  })
})
