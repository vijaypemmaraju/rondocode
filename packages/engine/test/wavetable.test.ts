import { describe, it, expect } from 'vitest'
import {
  WavetableKernel,
  WAVETABLE_TABLES,
  WAVETABLE_FRAME_SIZE,
  getWavetable,
} from '../src/dsp/wavetable'
import { goertzel } from './util/goertzel'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }

/** Render a WavetableKernel at a constant freq and pos over n samples. */
const run = (table: string | undefined, freq: number, pos: number, n: number): Float32Array => {
  const f = new Float32Array(n).fill(freq)
  const p = new Float32Array(n).fill(pos)
  const out = new Float32Array(n)
  new WavetableKernel(table, ctx).process(n, { freq: f, pos: p }, out, ctx)
  return out
}

const minMax = (out: Float32Array, start = 0): [number, number] => {
  let min = Infinity
  let max = -Infinity
  for (let i = start; i < out.length; i++) {
    if (out[i]! < min) min = out[i]!
    if (out[i]! > max) max = out[i]!
  }
  return [min, max]
}

/** Energy-weighted mean frequency (spectral centroid) sampled at the true
 *  harmonics of `fund` — a brightness proxy. Probing exact harmonics of a
 *  periodic tone avoids the Goertzel leakage a fixed-grid comb would suffer. */
const centroid = (out: Float32Array, sr: number, fund: number): number => {
  let num = 0
  let den = 0
  for (let k = 1; k * fund < sr / 2; k++) {
    const f = k * fund
    const p = goertzel(out, f, sr)
    num += f * p
    den += p
  }
  return den > 0 ? num / den : 0
}

describe('WavetableKernel: produces a tone', () => {
  it('basic table at pos 0 renders a 440 Hz fundamental (Goertzel peak)', () => {
    const out = run('basic', 440, 0, 48000)
    const atFund = goertzel(out, 440, ctx.sampleRate)
    // dominates its neighbours and unrelated bins
    expect(atFund).toBeGreaterThan(goertzel(out, 330, ctx.sampleRate) * 50)
    expect(atFund).toBeGreaterThan(goertzel(out, 550, ctx.sampleRate) * 50)
    expect(atFund).toBeGreaterThan(goertzel(out, 880, ctx.sampleRate) * 50)
  })

  it('defaults to the basic table when no name is given', () => {
    const out = run(undefined, 440, 0, 4800)
    const atFund = goertzel(out, 440, ctx.sampleRate)
    expect(atFund).toBeGreaterThan(0)
  })
})

describe('WavetableKernel: morph changes timbre', () => {
  it('basic table pos 0 is much darker than pos 1', () => {
    // 240 Hz => exactly 200 samples/cycle at 48k, so harmonic probes are coherent
    const dark = centroid(run('basic', 240, 0, 48000), ctx.sampleRate, 240)
    const bright = centroid(run('basic', 240, 1, 48000), ctx.sampleRate, 240)
    // pos 0 is a pure sine (centroid = the 240 Hz fundamental); pos 1 is a
    // band-limited square. Measured: dark = 240, bright ≈ 531 — a 2.2x lift
    // (the square's 1/k² energy weights the fundamental, so the power-centroid
    // is modest even though it is audibly far brighter). Pin > 2x.
    expect(bright).toBeGreaterThan(dark * 2)
  })

  it('harmonic table sweeps its centroid upward with pos', () => {
    const lo = centroid(run('harmonic', 240, 0, 48000), ctx.sampleRate, 240)
    const hi = centroid(run('harmonic', 240, 1, 48000), ctx.sampleRate, 240)
    expect(hi).toBeGreaterThan(lo)
  })
})

describe('WavetableKernel: anti-aliasing via mipmaps', () => {
  // A high note reading a harmonically rich frame: the mipmapped kernel keeps
  // only the harmonics that stay below Nyquist, while a deliberately
  // NON-mipmapped read of the same table (mipmap 0 = full harmonics) folds its
  // out-of-band harmonics back down as inharmonic alias energy.
  it('a high note aliases far less than a naive full-band read', () => {
    const n = 48000
    // 4700 Hz does NOT divide 48000 evenly, so out-of-band harmonics fold to
    // INHARMONIC positions (a 4 kHz fundamental would fold aliases exactly back
    // onto its own harmonics, hiding them). Legit harmonics: 4700/9400/14100/…
    const freq = 4700
    const table = getWavetable('basic')
    const lastFrame = table[table.length - 1]! // pos 1 = square/saw, richest
    const fullBand = lastFrame[0]! // mipmap 0 = all harmonics

    // mipmapped: the kernel picks a band-limited mipmap for 4 kHz
    const mip = run('basic', freq, 1, n)

    // naive: phase-accumulate straight through the full-band frame (aliases)
    const naive = new Float32Array(n)
    let phase = 0
    const dt = freq / ctx.sampleRate
    const size = WAVETABLE_FRAME_SIZE
    for (let i = 0; i < n; i++) {
      const posf = phase * size
      const i0 = posf | 0
      const frac = posf - i0
      const i1 = (i0 + 1) & (size - 1)
      naive[i] = fullBand[i0]! + frac * (fullBand[i1]! - fullBand[i0]!)
      phase += dt
      phase -= Math.floor(phase)
    }

    // Alias energy: power at probe frequencies that are NOT near a harmonic of
    // `freq`. For a mipmapped read those are ~0; a naive read spreads folded
    // harmonics all over them.
    const aliasEnergy = (out: Float32Array): number => {
      let e = 0
      for (let f = 550; f < ctx.sampleRate / 2; f += 313) {
        const r = f % freq
        if (r < 200 || freq - r < 200) continue // skip bins near a real harmonic
        e += goertzel(out, f, ctx.sampleRate)
      }
      return e
    }

    const mipAlias = aliasEnergy(mip)
    const naiveAlias = aliasEnergy(naive)
    // Measured (48k, 4700 Hz, basic pos 1): naive ≈ 4.9e-21, mipmapped ≈ 4.9e-25
    // inharmonic power — a ~10000x reduction. The absolute scale is small and
    // probe-grid dependent; the RATIO is the real claim, so pin a conservative
    // 100x margin (the naive read is the SAME table read without mipmapping).
    expect(mipAlias).toBeLessThan(naiveAlias / 100)
  })
})

describe('WavetableKernel: bounded and finite', () => {
  it('|out| <= 1.1 with no NaN across freq 20..15000 and pos 0..1', () => {
    for (const table of WAVETABLE_TABLES) {
      for (const freq of [20, 110, 440, 1000, 4000, 8000, 15000]) {
        for (const pos of [0, 0.25, 0.5, 0.75, 1]) {
          const out = run(table, freq, pos, 4096)
          for (let i = 0; i < out.length; i++) {
            expect(Number.isFinite(out[i]!)).toBe(true)
          }
          const [min, max] = minMax(out)
          expect(max, `${table} f=${freq} p=${pos}`).toBeLessThanOrEqual(1.1)
          expect(min, `${table} f=${freq} p=${pos}`).toBeGreaterThanOrEqual(-1.1)
        }
      }
    }
  }, 20_000) // heavy parameter sweep (~140k asserts); don't rely on the 5s default

  it('recovers from a NaN freq block within one clean block', () => {
    const k = new WavetableKernel('basic', ctx)
    const nanF = new Float32Array(512).fill(NaN)
    const p = new Float32Array(512).fill(0.5)
    k.process(512, { freq: nanF, pos: p }, new Float32Array(512), ctx)
    const cleanF = new Float32Array(512).fill(440)
    const out = new Float32Array(512)
    k.process(512, { freq: cleanF, pos: p }, out, ctx)
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true)
      expect(Math.abs(out[i]!)).toBeLessThanOrEqual(1.1)
    }
  })
})

describe('WavetableKernel: block-boundary continuity', () => {
  it('two half blocks equal one full block', () => {
    const n = 1024
    const freq = new Float32Array(n).fill(440)
    const pos = new Float32Array(n)
    for (let i = 0; i < n; i++) pos[i] = i / (n - 1) // ramp so morph advances
    const inputs = { freq, pos }
    const slice = (lo: number, hi: number) => ({
      freq: freq.subarray(lo, hi),
      pos: pos.subarray(lo, hi),
    })
    const full = new Float32Array(n)
    new WavetableKernel('basic', ctx).process(n, inputs, full, ctx)
    const split = new Float32Array(n)
    const k = new WavetableKernel('basic', ctx)
    k.process(n / 2, slice(0, n / 2), split.subarray(0, n / 2), ctx)
    k.process(n / 2, slice(n / 2, n), split.subarray(n / 2), ctx)
    expect(Array.from(split)).toEqual(Array.from(full))
  })

  it('reset() zeros phase (replays the same output)', () => {
    const k = new WavetableKernel('basic', ctx)
    const f = new Float32Array(256).fill(440)
    const p = new Float32Array(256).fill(0.3)
    const a = new Float32Array(256)
    k.process(256, { freq: f, pos: p }, a, ctx)
    k.reset()
    const b = new Float32Array(256)
    k.process(256, { freq: f, pos: p }, b, ctx)
    expect(Array.from(b)).toEqual(Array.from(a))
  })
})

describe('WavetableKernel: audio-rate pos', () => {
  it('a pos ramp within a block morphs smoothly and stays bounded', () => {
    const n = 4096
    const freq = new Float32Array(n).fill(330)
    const pos = new Float32Array(n)
    for (let i = 0; i < n; i++) pos[i] = i / (n - 1)
    const out = new Float32Array(n)
    new WavetableKernel('basic', ctx).process(n, { freq, pos }, out, ctx)
    for (let i = 0; i < n; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
  })

  it('clamps out-of-range pos without blowing up', () => {
    const n = 2048
    const freq = new Float32Array(n).fill(440)
    const pos = new Float32Array(n)
    for (let i = 0; i < n; i++) pos[i] = -2 + (4 * i) / (n - 1) // -2 .. 2
    const out = new Float32Array(n)
    new WavetableKernel('basic', ctx).process(n, { freq, pos }, out, ctx)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
  })
})

describe('WavetableKernel: table set', () => {
  it('exposes basic, harmonic and pwm tables with octave mipmaps', () => {
    expect([...WAVETABLE_TABLES]).toEqual(['basic', 'harmonic', 'pwm'])
    for (const name of WAVETABLE_TABLES) {
      const frames = getWavetable(name)
      expect(frames.length).toBeGreaterThanOrEqual(7) // ~8 frames
      for (const mips of frames) {
        expect(mips.length).toBeGreaterThanOrEqual(10) // ~10-11 octave mipmaps
        expect(mips[0]!.length).toBe(WAVETABLE_FRAME_SIZE)
      }
    }
  })

  it('rejects an unknown table name', () => {
    expect(() => new WavetableKernel('nope', ctx)).toThrow()
  })
})
