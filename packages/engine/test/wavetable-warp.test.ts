import { describe, expect, it } from 'vitest'
import { WavetableKernel, WAVETABLE_WARPS } from '../src/dsp/wavetable'
import { goertzel } from './util/goertzel'
import type { DspContext } from '../src/dsp/types'

/* Warp modes: spectral contracts per mode, measured with Goertzel probes at
 * the true harmonics (240 Hz = exactly 200 samples/cycle at 48k, so probes
 * are coherent). See the WAVETABLE_WARPS block comment in dsp/wavetable.ts
 * for the honest aliasing story each assertion pins down. */

const run = (
  freq: number,
  pos: number,
  n: number,
  warp?: 'sync' | 'bend' | 'mirror',
  amt = 0.5,
  sr = 48000,
): Float32Array => {
  const ctx: DspContext = { sampleRate: sr }
  const inputs: Record<string, Float32Array> = {
    freq: new Float32Array(n).fill(freq),
    pos: new Float32Array(n).fill(pos),
    warpAmt: new Float32Array(n).fill(amt),
  }
  const out = new Float32Array(n)
  new WavetableKernel('basic', ctx, warp).process(n, inputs, out, ctx)
  return out
}

const harmonicEnergy = (x: Float32Array, fund: number, from: number, to: number, sr = 48000): number => {
  let e = 0
  for (let k = from; k <= to; k++) {
    const f = k * fund
    if (f >= sr / 2) break
    e += goertzel(x, f, sr)
  }
  return e
}

/** Energy-weighted mean frequency probed at the true harmonics of `fund`. */
const centroid = (x: Float32Array, fund: number, sr = 48000): number => {
  let num = 0
  let den = 0
  for (let k = 1; k * fund < sr / 2; k++) {
    const p = goertzel(x, k * fund, sr)
    num += k * fund * p
    den += p
  }
  return den > 0 ? num / den : 0
}

/** Power at probe bins that are NOT near any harmonic of `fund`. */
const aliasEnergy = (x: Float32Array, fund: number, sr = 48000): number => {
  let e = 0
  for (let f = 550; f < sr / 2; f += 313) {
    const r = f % fund
    if (r < 200 || fund - r < 200) continue
    e += goertzel(x, f, sr)
  }
  return e
}

describe('warp sync', () => {
  it('adds upper partials the unwarped read does not have (pos 0 = pure sine frame)', () => {
    const dry = run(240, 0, 48000)
    const wet = run(240, 0, 48000, 'sync', 0.5)
    const dryUp = harmonicEnergy(dry, 240, 2, 20)
    const wetUp = harmonicEnergy(wet, 240, 2, 20)
    // measured: dry ~8e-16 (numerical zero — the frame IS a sine), wet ~1e4.
    // Pin a conservative 1000x lift and a >2x centroid rise (240 -> ~569 Hz).
    expect(wetUp).toBeGreaterThan(dryUp * 1000)
    expect(wetUp).toBeGreaterThan(1)
    expect(centroid(wet, 240)).toBeGreaterThan(centroid(dry, 240) * 2)
  })

  it('keeps the fundamental on pitch (sync tears timbre, not tuning)', () => {
    const wet = run(240, 0, 48000, 'sync', 0.5)
    expect(goertzel(wet, 240, 48000)).toBeGreaterThan(goertzel(wet, 330, 48000) * 50)
  })

  it('stays >=60 dB more harmonic than aliased at high pitch (mipmap budgets freq*rate)', () => {
    // 4700 Hz does not divide 48000: folded content would land on inharmonic
    // probe bins. The wrap discontinuity is sync's honest aliasing tradeoff —
    // measured ~1e-5 of the harmonic energy; pin 1e-3 (60 dB).
    const wet = run(4700, 1, 48000, 'sync', 0.9)
    expect(aliasEnergy(wet, 4700)).toBeLessThan(harmonicEnergy(wet, 4700, 1, 5) / 1000)
  })
})

describe('warp bend', () => {
  it('reshapes the sine frame into a harmonic series (transfer bow adds partials)', () => {
    const dry = run(240, 0, 48000)
    const wet = run(240, 0, 48000, 'bend', 0.6)
    expect(harmonicEnergy(wet, 240, 2, 12)).toBeGreaterThan(harmonicEnergy(dry, 240, 2, 12) * 1000)
    expect(harmonicEnergy(wet, 240, 2, 12)).toBeGreaterThan(1)
  })

  it('adds no measurable inharmonic energy (continuous transfer curve)', () => {
    const wet = run(233, 0.66, 48000, 'bend', 1) // 233 Hz: inharmonic folds visible
    expect(aliasEnergy(wet, 233)).toBeLessThan(harmonicEnergy(wet, 233, 1, 10) / 1000)
  })
})

describe('warp mirror', () => {
  it('full mirror reads the cycle as a palindrome (reflection symmetry)', () => {
    const P = 200 // samples per 240 Hz cycle at 48k
    const wet = run(240, 0.66, 48000, 'mirror', 1)
    const dry = run(240, 0.66, 48000)
    const t0 = 10 * P
    let wetD = 0
    let dryD = 0
    for (let i = 1; i < P; i++) {
      wetD = Math.max(wetD, Math.abs(wet[t0 + i]! - wet[t0 + P - i]!))
      dryD = Math.max(dryD, Math.abs(dry[t0 + i]! - dry[t0 + P - i]!))
    }
    // measured: wet ~2e-13 (float noise), dry ~1.9 (a saw-ish frame is
    // maximally asymmetric). The symmetry IS the spectral claim: a palindrome
    // has zero sine-phase (odd) component.
    expect(wetD).toBeLessThan(1e-6)
    expect(dryD).toBeGreaterThan(0.5)
  })

  it('changes the spectrum while staying on the harmonic comb', () => {
    const wet = run(240, 0.66, 48000, 'mirror', 1)
    const dry = run(240, 0.66, 48000)
    expect(Math.abs(centroid(wet, 240) - centroid(dry, 240))).toBeGreaterThan(20)
    expect(aliasEnergy(wet, 240)).toBeLessThan(harmonicEnergy(wet, 240, 1, 20) / 1000)
  })
})

describe('warp: identity and safety contracts', () => {
  it('warpAmt 0 is sample-identical to no warp, for every mode', () => {
    const dry = run(240, 0.66, 4800)
    for (const warp of WAVETABLE_WARPS) {
      expect(Array.from(run(240, 0.66, 4800, warp, 0)), warp).toEqual(Array.from(dry))
    }
  })

  it('a missing warpAmt input falls back to the identity read (direct kernel use)', () => {
    const ctx: DspContext = { sampleRate: 48000 }
    const n = 4800
    const inputs = { freq: new Float32Array(n).fill(240), pos: new Float32Array(n).fill(0.66) }
    const out = new Float32Array(n)
    new WavetableKernel('basic', ctx, 'sync').process(n, inputs, out, ctx)
    expect(Array.from(out)).toEqual(Array.from(run(240, 0.66, n)))
  })

  it('rejects an unknown warp mode at construction', () => {
    expect(() => new WavetableKernel('basic', { sampleRate: 48000 }, 'fold')).toThrow(/unknown wavetable warp/)
  })

  it('finite and bounded across modes, amounts and freqs at 44100', () => {
    for (const warp of WAVETABLE_WARPS) {
      for (const amt of [0, 0.25, 0.5, 1]) {
        for (const f of [20, 440, 4000, 15000]) {
          const out = run(f, 0.8, 4096, warp, amt, 44100)
          let ok = true
          let peak = 0
          for (let i = 0; i < out.length; i++) {
            if (!Number.isFinite(out[i]!)) ok = false
            const a = Math.abs(out[i]!)
            if (a > peak) peak = a
          }
          expect(ok, `${warp} amt=${amt} f=${f} finite`).toBe(true)
          expect(peak, `${warp} amt=${amt} f=${f} bounded`).toBeLessThanOrEqual(1.1)
        }
      }
    }
  })

  it('44.1k: a warped tone keeps its fundamental on pitch', () => {
    const wet = run(441, 0.5, 44100, 'sync', 0.5, 44100)
    expect(goertzel(wet, 441, 44100)).toBeGreaterThan(goertzel(wet, 350, 44100) * 20)
  })

  it('clamps out-of-range and NaN warpAmt without blowing up', () => {
    const ctx: DspContext = { sampleRate: 48000 }
    const n = 2048
    const amts = new Float32Array(n)
    for (let i = 0; i < n; i++) amts[i] = i % 3 === 0 ? NaN : -2 + (5 * i) / n // NaN, and -2..3
    const inputs = {
      freq: new Float32Array(n).fill(440),
      pos: new Float32Array(n).fill(0.5),
      warpAmt: amts,
    }
    for (const warp of WAVETABLE_WARPS) {
      const out = new Float32Array(n)
      new WavetableKernel('basic', ctx, warp).process(n, inputs, out, ctx)
      for (let i = 0; i < n; i++) {
        expect(Number.isFinite(out[i]!)).toBe(true)
        expect(Math.abs(out[i]!)).toBeLessThanOrEqual(1.1)
      }
    }
  })

  it('block-boundary continuity holds with a warp engaged', () => {
    const ctx: DspContext = { sampleRate: 48000 }
    const n = 1024
    const freq = new Float32Array(n).fill(440)
    const pos = new Float32Array(n).fill(0.4)
    const amt = new Float32Array(n)
    for (let i = 0; i < n; i++) amt[i] = i / (n - 1)
    const slice = (lo: number, hi: number) => ({
      freq: freq.subarray(lo, hi),
      pos: pos.subarray(lo, hi),
      warpAmt: amt.subarray(lo, hi),
    })
    const full = new Float32Array(n)
    new WavetableKernel('basic', ctx, 'bend').process(n, { freq, pos, warpAmt: amt }, full, ctx)
    const split = new Float32Array(n)
    const k = new WavetableKernel('basic', ctx, 'bend')
    k.process(n / 2, slice(0, n / 2), split.subarray(0, n / 2), ctx)
    k.process(n / 2, slice(n / 2, n), split.subarray(n / 2), ctx)
    expect(Array.from(split)).toEqual(Array.from(full))
  })
})
