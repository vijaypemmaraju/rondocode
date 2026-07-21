import { describe, it, expect } from 'vitest'
import { PluckKernel, ModalKernel } from '../src/dsp/physical'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

/** Gate high from sample 0 (a rising edge at 0 triggers the strike/pluck). */
const gateOn = (n: number): Float32Array => {
  const g = new Float32Array(n)
  g.fill(1)
  return g
}
const constBuf = (n: number, v: number): Float32Array => new Float32Array(n).fill(v)

const rms = (x: Float32Array, from = 0, to = x.length): number => {
  let s = 0
  for (let i = from; i < to; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / (to - from))
}

describe('PluckKernel (Karplus-Strong)', () => {
  const run = (freq: number, n: number, cfg = {}): Float32Array => {
    const k = new PluckKernel(cfg, ctx)
    const out = new Float32Array(n)
    k.process(n, { gate: gateOn(n), freq: constBuf(n, freq) }, out, ctx)
    return out
  }

  it('a pluck sounds and then decays over time', () => {
    const out = run(220, sr, { decay: 1 }) // 1s
    const early = rms(out, 0, sr / 4)
    const late = rms(out, (3 * sr) / 4, sr)
    expect(early).toBeGreaterThan(0.02)
    expect(late).toBeLessThan(early * 0.7) // rings down
  })

  it('is tuned: energy concentrates at the fundamental', () => {
    const out = run(220, sr, { decay: 2, damp: 0.3 })
    const f0 = goertzel(out, 220, sr)
    // dominates non-harmonic neighbours (a mistuned string would smear)
    expect(f0).toBeGreaterThan(goertzel(out, 180, sr) * 4)
    expect(f0).toBeGreaterThan(goertzel(out, 260, sr) * 4)
  })

  it('damp shortens the ring (darker + faster HF decay)', () => {
    const bright = run(220, sr, { decay: 3, damp: 0.05 })
    const dark = run(220, sr, { decay: 3, damp: 0.9 })
    const tail = [(3 * sr) / 4, sr] as const
    expect(rms(dark, tail[0], tail[1])).toBeLessThan(rms(bright, tail[0], tail[1]))
  })

  it('stays silent with no gate, and bounded/finite while ringing', () => {
    const k = new PluckKernel({}, ctx)
    const silent = new Float32Array(1024)
    k.process(1024, { gate: new Float32Array(1024), freq: constBuf(1024, 220) }, silent, ctx)
    expect(rms(silent)).toBe(0)
    const out = run(440, sr)
    let peak = 0
    for (let i = 0; i < out.length; i++) {
      expect(Number.isNaN(out[i]!)).toBe(false)
      peak = Math.max(peak, Math.abs(out[i]!))
    }
    expect(peak).toBeLessThan(1.5)
  })
})

describe('ModalKernel (resonator bank)', () => {
  const run = (freq: number, n: number, cfg = {}): Float32Array => {
    const k = new ModalKernel(cfg, ctx)
    const out = new Float32Array(n)
    k.process(n, { gate: gateOn(n), freq: constBuf(n, freq) }, out, ctx)
    return out
  }

  it('a strike rings on well after the ~3ms excitation burst', () => {
    const out = run(440, sr, { decay: 2 })
    // energy long after the 3ms strike proves the resonators are ringing, not
    // just passing the exciter through
    expect(rms(out, sr / 2, sr)).toBeGreaterThan(0.005)
  })

  it("puts energy at the model's mode frequencies", () => {
    // 'bar' fundamental ratio is 1, so freq itself is a strong mode
    const out = run(300, sr, { model: 'bar', decay: 2 })
    const f0 = goertzel(out, 300, sr)
    expect(f0).toBeGreaterThan(goertzel(out, 250, sr) * 3)
    expect(f0).toBeGreaterThan(goertzel(out, 350, sr) * 3)
  })

  it('stays finite/bounded and rejects an unknown model', () => {
    const out = run(660, sr, { model: 'glass' })
    let peak = 0
    for (let i = 0; i < out.length; i++) {
      expect(Number.isNaN(out[i]!)).toBe(false)
      peak = Math.max(peak, Math.abs(out[i]!))
    }
    expect(peak).toBeLessThan(1.5)
    expect(() => new ModalKernel({ model: 'nope' }, ctx)).toThrow(/unknown modal model/)
  })

  it('reset() clears the resonators', () => {
    const k = new ModalKernel({}, ctx)
    const first = new Float32Array(4096)
    k.process(4096, { gate: gateOn(4096), freq: constBuf(4096, 440) }, first, ctx)
    k.reset()
    const idle = new Float32Array(1024)
    k.process(1024, { gate: new Float32Array(1024), freq: constBuf(1024, 440) }, idle, ctx)
    expect(rms(idle)).toBe(0)
  })
})
