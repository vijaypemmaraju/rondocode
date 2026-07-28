import { describe, it, expect } from 'vitest'
import { AdsrKernel } from '../src/dsp/env'
import { WavetableBank, WavetableKernel } from '../src/dsp/wavetable'
import { DualSvfKernel, SvfKernel } from '../src/dsp/filters'
import { NoiseKernel } from '../src/dsp/osc'
import { SampleKernel } from '../src/dsp/sample'
import { SampleBank } from '../src/samples'
import { duckReleaseCoeff } from '../src/realtime'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'
import type { RenderEvent } from '../src/render'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

/* ------------------------------------------------------------------------- *
 * 44.1 kHz pass: the whole suite runs at 48 kHz, so any kernel that bakes in
 * a 48000 (or derives a coefficient from the wrong rate) would still be green
 * there. This file re-runs a representative slice at sampleRate 44100 and
 * asserts the same CONTRACTS hold — times in seconds, frequencies in Hz —
 * not identical buffers.
 * ------------------------------------------------------------------------- */

const SR = 44100
const ctx: DspContext = { sampleRate: SR }

describe('44.1 kHz: envelope timing', () => {
  it('adsr attack completes in a*sampleRate SAMPLES (10 ms = 441 samples at 44.1k)', () => {
    const k = new AdsrKernel()
    const n = SR
    const out = new Float32Array(n)
    const at = (v: number): Float32Array => new Float32Array(n).fill(v)
    // a/d/s/r are input ports now, so the stage times arrive as buffers
    k.process(n, { gate: at(1), a: at(0.01), d: at(0.1), s: at(0.5), r: at(0.1) }, out, ctx)
    // halfway up the linear attack at a/2 seconds
    expect(out[Math.round(0.005 * SR)]!).toBeGreaterThan(0.45)
    expect(out[Math.round(0.005 * SR)]!).toBeLessThan(0.55)
    // at the top just past a seconds (441 samples), NOT at 480 (a 48k bake-in
    // would put the peak at 480 samples and read ~0.92 here)
    expect(out[Math.round(0.01 * SR)]!).toBeGreaterThan(0.99)
    const peak = out.findIndex((v) => v >= 1)
    expect(Math.abs(peak - 0.01 * SR)).toBeLessThanOrEqual(2)
  })
})

describe('44.1 kHz: filter tuning', () => {
  it('svf lp cutoff is in Hz: 500 Hz cutoff passes 250 Hz and kills 4 kHz', () => {
    const n = SR
    const raw = new Float32Array(n)
    new NoiseKernel(1234).process(n, {}, raw, ctx)
    const out = new Float32Array(n)
    new SvfKernel('lp').process(
      n,
      { in: raw, cutoff: new Float32Array(n).fill(500), res: new Float32Array(n).fill(0.2) },
      out,
      ctx,
    )
    const half = n >> 1
    const resp = (f: number): number =>
      goertzel(out.subarray(half), f, SR) / goertzel(raw.subarray(half), f, SR)
    expect(resp(250)).toBeGreaterThan(0.5) // passband (measured ~0.83)
    expect(resp(4000)).toBeLessThan(0.01) // 3 octaves above cutoff (measured ~3e-4)
    expect(out.every((x) => Number.isFinite(x))).toBe(true)
  })

  it('dualsvf cutoffs are in Hz: serial hp 300 → lp 2500 passes 1 kHz, kills 60 Hz and 8 kHz', () => {
    const n = SR
    const raw = new Float32Array(n)
    new NoiseKernel(1234).process(n, {}, raw, ctx)
    const out = new Float32Array(n)
    new DualSvfKernel({ mode: 'serial', a: 'hp', b: 'lp' }).process(
      n,
      {
        in: raw,
        cutoff: new Float32Array(n).fill(300),
        cutoff2: new Float32Array(n).fill(2500),
        res: new Float32Array(n).fill(0.2),
      },
      out,
      ctx,
    )
    const half = n >> 1
    const resp = (f: number): number =>
      goertzel(out.subarray(half), f, SR) / goertzel(raw.subarray(half), f, SR)
    expect(resp(1000)).toBeGreaterThan(10 * resp(60))
    expect(resp(1000)).toBeGreaterThan(10 * resp(8000))
    expect(out.every((x) => Number.isFinite(x))).toBe(true)
  })
})

describe('44.1 kHz: sidechain duck coefficient', () => {
  it('recovers 1 - depth*e^-1 of the way in releaseMs at THIS sample rate', () => {
    // releaseMs is a one-pole time constant: starting from 1 - depth = 0.4,
    // after exactly releaseMs of samples the level must sit at 1 - 0.6*e^-1
    // = 0.7793. A coefficient derived from 48k instead reads 0.7606 here —
    // outside the 2-decimal tolerance, so the wrong rate fails.
    const coeff = duckReleaseCoeff(100, SR)
    let level = 0.4
    for (let i = 0; i < Math.round(0.1 * SR); i++) level += (1 - level) * coeff
    expect(level).toBeCloseTo(1 - 0.6 * Math.exp(-1), 2)
  })
})

describe('44.1 kHz: custom wavetable band-limiting', () => {
  it('mipmap selection uses THIS rate: harmonics above 22.05k are dropped, in-band ones kept', () => {
    const bank = new WavetableBank()
    // 12th harmonic only. Mipmaps are octave-quantized: harmonic 12 needs a
    // mipmap keeping >= 16 harmonics, which the kernel picks only while
    // 16 <= Nyquist/freq. At 1450 Hz that ratio is 15.2 at 44.1k (drop -> the
    // mipmap keeps <= 8, silence) but 16.55 at 48k (keep) — so a kernel that
    // baked in 48k would SOUND here. At 1300 Hz the ratio is 16.96 at 44.1k:
    // kept, and 12 x 1300 = 15.6 kHz is honestly in band.
    bank.set('h12', [Array.from({ length: 12 }, (_, i) => (i === 11 ? 1 : 0))])
    const wctx: DspContext = { sampleRate: SR, wavetables: bank }
    const render = (freq: number): Float32Array => {
      const n = SR
      const out = new Float32Array(n)
      new WavetableKernel('h12', wctx).process(
        n,
        { freq: new Float32Array(n).fill(freq), pos: new Float32Array(n) },
        out,
        wctx,
      )
      return out
    }
    const dropped = render(1450)
    const kept = render(1300)
    const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length)
    expect(rms(dropped)).toBeLessThan(1e-6) // 44.1k selection drops it (48k would keep it)
    expect(goertzel(kept, 12 * 1300, SR)).toBeGreaterThan(1e-3) // kept, on pitch
  })

  it('warp mipmap budget applies at THIS rate: out-of-budget content drops, never folds', () => {
    // same h12 table, same 1300 Hz that the plain read KEEPS at 44.1k. With
    // warp:'sync' at amt 1 the read runs 4x faster, so the kernel budgets its
    // mipmap for 5200 Hz: allowed harmonics 22050/5200 = 4.2 -> the picked
    // mipmap keeps 4 and the 12th-harmonic table goes SILENT — the honest
    // tradeoff (content beyond the warped budget is dropped, not aliased).
    const bank = new WavetableBank()
    bank.set('h12w', [Array.from({ length: 12 }, (_, i) => (i === 11 ? 1 : 0))])
    const wctx: DspContext = { sampleRate: SR, wavetables: bank }
    const render = (warpAmt: number): Float32Array => {
      const n = SR
      const out = new Float32Array(n)
      new WavetableKernel('h12w', wctx, 'sync').process(
        n,
        {
          freq: new Float32Array(n).fill(1300),
          pos: new Float32Array(n),
          warpAmt: new Float32Array(n).fill(warpAmt),
        },
        out,
        wctx,
      )
      return out
    }
    const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length)
    expect(rms(render(0))).toBeGreaterThan(1e-3) // amt 0 = identity, audible
    expect(rms(render(1))).toBeLessThan(1e-6) // amt 1 = budgeted out, silent not aliased
  })
})

describe('44.1 kHz: renderOffline', () => {
  it('renders the requested duration in 44.1k samples with the fundamental on pitch', () => {
    const def = synth(({ note, gate, sine, adsr }) =>
      sine(note.freq).mul(adsr(gate, { a: 0.005, d: 0.05, s: 0.8, r: 0.05 })))
    const events: RenderEvent[] = [
      { time: 0, type: 'noteOn', note: 45, velocity: 1 }, // 110 Hz
      { time: 0.4, type: 'noteOff', note: 45 },
    ]
    const r = renderOffline(def, events, 0.5, { sampleRate: SR })
    expect(r.sampleRate).toBe(SR)
    expect(r.left.length).toBe(Math.round(0.5 * SR)) // 22050, not 24000
    expect(r.left.every((x) => Number.isFinite(x))).toBe(true)
    // pitch contract: note 45 is 110 Hz measured AT 44.1k — a renderer that
    // mixed up rates would land the tone off this bin
    const steady = r.left.subarray(Math.round(0.1 * SR), Math.round(0.35 * SR))
    expect(goertzel(steady, 110, SR)).toBeGreaterThan(goertzel(steady, 137, SR) * 50)
    expect(goertzel(steady, 110, SR)).toBeGreaterThan(goertzel(steady, 110 * 48000 / 44100, SR) * 20)
  })
})

describe('44.1 kHz: sample slicing', () => {
  it('the chop edge fade is 3 ms of SOURCE frames (132 at 44.1k, not 144)', () => {
    const bank = new SampleBank()
    bank.set('dc', new Float32Array(SR).fill(1), SR) // flat 1.0: the output IS the fade curve
    const k = new SampleKernel('dc', false, bank, { start: 0.25, end: 0.75 }) // default 3 ms fade
    const out = new Float32Array(SR)
    k.process(SR, { gate: new Float32Array(SR).fill(1) }, out, ctx)
    // 0.003 * 44100 = 132.3 frames: full level by 133, half way at 66.
    // A baked-in 48000 would give 144 frames and read 0.917 here.
    expect(out[66]).toBeCloseTo(0.5, 2)
    expect(out[132]!).toBeGreaterThan(0.99)
    expect(out[133]).toBe(1)
  })

  it('a window is a FRACTION of the buffer at any rate', () => {
    const bank = new SampleBank()
    bank.set('r', Float32Array.from({ length: SR }, (_, i) => i), SR)
    const k = new SampleKernel('r', false, bank, { start: 0.5, end: 0.75, fade: 0 })
    const out = new Float32Array(SR)
    k.process(SR, { gate: new Float32Array(SR).fill(1) }, out, ctx)
    expect(out[0]).toBe(SR / 2) // 22050, not 24000
    expect(out[SR / 4 - 1]).toBe(SR * 0.75 - 1)
    expect(out[SR / 4]).toBe(0) // exactly a quarter of the buffer long
  })
})
