import { describe, it, expect } from 'vitest'
import { AdsrKernel } from '../src/dsp/env'
import { DualSvfKernel, SvfKernel } from '../src/dsp/filters'
import { NoiseKernel } from '../src/dsp/osc'
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
    const k = new AdsrKernel({ a: 0.01, d: 0.1, s: 0.5, r: 0.1 })
    const n = SR
    const out = new Float32Array(n)
    k.process(n, { gate: new Float32Array(n).fill(1) }, out, ctx)
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
