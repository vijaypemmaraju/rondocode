import { describe, it, expect } from 'vitest'
import { psola, estimateF0, olaStretch } from '../src/sing/psola'

/* TD-PSOLA port verification: it must genuinely PITCH (not merely time-stretch)
 * and time-stretch without changing pitch. Uses a synthetic glottal source (a
 * band-limited pulse train — one clear epoch per period) so pitch marks are
 * unambiguous. Mirrors the offline Python reference's F0-check. */

const sr = 44100

/** A saw-ish glottal source at f0: harmonics phase-aligned → one peak/period. */
function glottal(f0: number, dur: number): Float32Array {
  const n = Math.floor(dur * sr)
  const x = new Float32Array(n)
  const H = 12
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 1; k <= H; k++) s += Math.sin((2 * Math.PI * k * f0 * i) / sr) / k
    x[i] = s
  }
  let pk = 0
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]!))
  for (let i = 0; i < n; i++) x[i]! /= pk || 1
  return x
}

describe('psola port', () => {
  it('estimateF0 recovers the fundamental', () => {
    expect(estimateF0(glottal(150, 0.4), sr)).toBeCloseTo(150, -1) // within ~5 Hz
    expect(estimateF0(glottal(220, 0.4), sr)).toBeCloseTo(220, -1)
  })

  it('shifts pitch UP an octave (the load-bearing property)', () => {
    const x = glottal(150, 0.4)
    const y = psola(x, sr, 1, 300, estimateF0(x, sr))
    const f0 = estimateF0(y, sr)
    expect(f0).toBeGreaterThan(270)
    expect(f0).toBeLessThan(330)
  })

  it('shifts pitch DOWN to a target note', () => {
    const x = glottal(220, 0.4)
    const y = psola(x, sr, 1, 165, estimateF0(x, sr)) // 220 -> 165 (a fourth down)
    const f0 = estimateF0(y, sr)
    expect(f0).toBeGreaterThan(150)
    expect(f0).toBeLessThan(180)
  })

  it('time-stretches ~2x WITHOUT changing pitch', () => {
    const x = glottal(150, 0.3)
    const y = psola(x, sr, 2.0, 150, estimateF0(x, sr))
    expect(y.length).toBeGreaterThan(x.length * 1.8)
    expect(y.length).toBeLessThan(x.length * 2.2)
    const f0 = estimateF0(y, sr)
    expect(f0).toBeGreaterThan(135)
    expect(f0).toBeLessThan(165)
  })

  it('unvoiced fallback (olaStretch) hits the target length and is finite', () => {
    const noise = new Float32Array(4000)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.sin(i * 0.31) * 0.3 // deterministic
    const y = olaStretch(noise, 8000, sr)
    expect(y.length).toBe(8000)
    for (let i = 0; i < y.length; i++) expect(Number.isFinite(y[i]!)).toBe(true)
  })
})
