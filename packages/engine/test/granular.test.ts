import { describe, expect, it } from 'vitest'
import { GranularKernel } from '../src/dsp/granular'
import { SampleBank } from '../src/samples'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'
import type { GranularConfig } from '../src/dsp/granular'
import { goertzel } from './util/goertzel'

const tone = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) * 0.8)

const run = (
  k: GranularKernel,
  n: number,
  sr: number,
  opts?: { gate?: Float32Array; pos?: number; rate?: number },
): Float32Array => {
  const inputs: Record<string, Float32Array> = { gate: opts?.gate ?? new Float32Array(n).fill(1) }
  if (opts?.pos !== undefined) inputs['pos'] = new Float32Array(n).fill(opts.pos)
  if (opts?.rate !== undefined) inputs['rate'] = new Float32Array(n).fill(opts.rate)
  const out = new Float32Array(n)
  k.process(n, inputs, out, { sampleRate: sr })
  return out
}

const mk = (bank: SampleBank, cfg: GranularConfig = {}): GranularKernel => new GranularKernel('t', cfg, bank)

describe('GranularKernel', () => {
  it('a missing/unloaded sample is silence', () => {
    expect(run(new GranularKernel('nope', {}, new SampleBank()), 128, 48000).every((v) => v === 0)).toBe(true)
    expect(run(new GranularKernel('nope', {}, undefined), 128, 48000).every((v) => v === 0)).toBe(true)
  })

  it('sprays finite, audible output over a loaded buffer while gated', () => {
    const bank = new SampleBank()
    bank.set('t', tone(4800), 48000)
    const out = run(mk(bank, { size: 0.02, density: 60 }), 4800, 48000, { pos: 0.2 })
    let peak = 0
    expect(out.every(Number.isFinite)).toBe(true)
    for (const v of out) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeGreaterThan(0.01)
  })

  it('spawns NO grains while the gate is low', () => {
    const bank = new SampleBank()
    bank.set('t', tone(4800), 48000)
    const out = run(mk(bank, { density: 80 }), 512, 48000, { gate: new Float32Array(512).fill(0) })
    expect(out.every((v) => v === 0)).toBe(true)
  })

  it('reset() clears active grains (no lingering tails)', () => {
    const bank = new SampleBank()
    bank.set('t', tone(4800), 48000)
    const k = mk(bank, { density: 100, size: 0.1 })
    run(k, 512, 48000) // spawn a cloud
    k.reset()
    const out = run(k, 256, 48000, { gate: new Float32Array(256).fill(0) })
    expect(out.every((v) => v === 0)).toBe(true)
  })

  it('is deterministic (same seed -> same output)', () => {
    const bank = new SampleBank()
    bank.set('t', tone(4800), 48000)
    const a = run(mk(bank, { density: 50, spray: 0.02, seed: 7 }), 1024, 48000, { pos: 0.3 })
    const b = run(mk(bank, { density: 50, spray: 0.02, seed: 7 }), 1024, 48000, { pos: 0.3 })
    expect([...a]).toEqual([...b])
  })
})

describe('GranularKernel: pos scans position, rate pitches grains', () => {
  const SR = 48000
  /** 2 s source whose halves differ spectrally: 200 Hz sine then 4000 Hz sine —
   *  so WHERE the grains read from is visible in the output spectrum. */
  const splitBank = (): SampleBank => {
    const len = 2 * SR
    const buf = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      buf[i] = i < len / 2 ? Math.sin((2 * Math.PI * 200 * i) / SR) : Math.sin((2 * Math.PI * 4000 * i) / SR)
    }
    const bank = new SampleBank()
    bank.set('t', buf, SR)
    return bank
  }
  const cloud = (pos: number, rate: number): Float32Array =>
    run(new GranularKernel('t', { size: 0.05, density: 40, spray: 0.005, loop: false }, splitBank()), SR, SR, { pos, rate })

  it('pos 0.2 reads the low half, pos 0.8 the high half', () => {
    const lo = cloud(0.2, 1)
    const hi = cloud(0.8, 1)
    // measured margins are ~10^7; pin a conservative 100x each way
    expect(goertzel(lo, 200, SR)).toBeGreaterThan(goertzel(lo, 4000, SR) * 100)
    expect(goertzel(hi, 4000, SR)).toBeGreaterThan(goertzel(hi, 200, SR) * 100)
  })

  it('rate 2 pitches the grains an octave up (200 Hz source reads out at 400 Hz)', () => {
    const natural = cloud(0.2, 1)
    const doubled = cloud(0.2, 2)
    expect(goertzel(natural, 200, SR)).toBeGreaterThan(goertzel(natural, 400, SR) * 100)
    expect(goertzel(doubled, 400, SR)).toBeGreaterThan(goertzel(doubled, 200, SR) * 100)
  })
})

describe('granular() through synth() + renderOffline', () => {
  it('a granular synth renders audible, finite output', () => {
    const buf = Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i * 0.02) * (0.6 + 0.4 * Math.sin(i * 0.0003)))
    const def = synth(({ note, gate, adsr, granular }) => {
      const env = adsr(gate, { a: 0.05, d: 0.3, s: 0.7, r: 0.4 })
      return granular(gate, 'pad', { root: 60, pos: 0.3, size: 0.09, density: 30 }).mul(env).mul(0.8)
    })
    const r = renderOffline(def, [
      { time: 0, type: 'noteOn', note: 60, velocity: 1 },
      { time: 0.8, type: 'noteOff', note: 60 },
    ], 1.2, { sampleRate: 48000, samples: { pad: { data: buf, sampleRate: 48000 } } })
    let peak = 0
    for (let i = 0; i < r.left.length; i++) peak = Math.max(peak, Math.abs(r.left[i]!))
    expect(r.left.every(Number.isFinite)).toBe(true)
    expect(peak).toBeGreaterThan(0.02)
  })
})

describe('GranularKernel: NaN / out-of-bounds hygiene', () => {
  it('loop:false on a short sample stays finite (grain runs off the end)', () => {
    const bank = new SampleBank()
    bank.set('t', tone(500), 48000) // grain (size 0.08s) >> buffer
    expect(run(mk(bank, { size: 0.08 }), 2000, 48000).every((v) => Number.isFinite(v))).toBe(true)
  })

  it('pos = NaN stays finite', () => {
    const bank = new SampleBank()
    bank.set('t', tone(4800), 48000)
    expect(run(mk(bank), 2000, 48000, { pos: NaN }).every((v) => Number.isFinite(v))).toBe(true)
  })

  it('negative rate with loop:false stays finite', () => {
    const bank = new SampleBank()
    bank.set('t', tone(4800), 48000)
    expect(run(mk(bank), 2000, 48000, { rate: -2 }).every((v) => Number.isFinite(v))).toBe(true)
  })
})
