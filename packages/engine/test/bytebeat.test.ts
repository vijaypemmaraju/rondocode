import { describe, expect, it } from 'vitest'
import { BytebeatKernel, compileBytebeat } from '../src/dsp/bytebeat'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'

const run = (kernel: BytebeatKernel, n: number, rate = 8000, sampleRate = 48000) => {
  const out = new Float32Array(n)
  kernel.process(n, { rate: new Float32Array(n).fill(rate) }, out, { sampleRate })
  return out
}

describe('bytebeat expression language', () => {
  it('matches JavaScript arithmetic / bitwise precedence across a long phrase', () => {
    const f = compileBytebeat('t * ((t >> 10) & 7) ^ t >> 4 | t & 31')
    for (let t = 0; t < 200000; t += 137) {
      expect(f(t)).toBe(t * ((t >> 10) & 7) ^ t >> 4 | t & 31)
    }
  })
  it('supports unsigned shifts, constants, comparisons, unary ops and lazy conditionals', () => {
    expect(compileBytebeat('~0 >>> 1')(0)).toBe(2147483647)
    expect(compileBytebeat('t < 4 ? 0xff : t == 4 ? 0b10 : -3')(3)).toBe(255)
    expect(compileBytebeat('t < 4 ? 0xff : t == 4 ? 0b10 : -3')(4)).toBe(2)
    expect(compileBytebeat('t < 4 ? 0xff : t == 4 ? 0b10 : -3')(5)).toBe(-3)
    expect(compileBytebeat('!t + .5e2')(0)).toBe(51)
    expect(compileBytebeat('sin(PI/2) + max(2, pow(3, 2))')(0)).toBe(10)
  })
  it.each(['', ' ', 't +', 't = 1', 'while(1){}', 'Math.sin(t)', 'globalThis', 'constructor(1)', 'sin(1,2)', 't; t', 't ** 2', '1e999', '('.repeat(257)])('rejects invalid or unbounded source %s', s => {
    expect(() => compileBytebeat(s)).toThrow(/bytebeat/)
  })
})

describe('bytebeat DSP', () => {
  it('holds each 8 kHz tick for exactly six 48 kHz samples', () => {
    const out = run(new BytebeatKernel({ expression: 't' }), 1536)
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(((Math.floor(i / 6) & 255) - 128) / 128)
  })
  it('preserves the clock across arbitrary processing boundaries and reset', () => {
    const k = new BytebeatKernel({ expression: 't ^ (t >> 3)' })
    const full = run(k, 997, 8000, 44100)
    k.reset()
    const pieces = [run(k, 7, 8000, 44100), run(k, 128, 8000, 44100), run(k, 862, 8000, 44100)]
    expect(Float32Array.from(pieces.flatMap(x => [...x]))).toEqual(full)
  })
  it('wraps byte and signed output, clips float, and silences invalid results', () => {
    expect(run(new BytebeatKernel({ expression: '-1' }), 1)[0]).toBe(127 / 128)
    expect(run(new BytebeatKernel({ expression: '255', mode: 'signed' }), 1)[0]).toBe(-1 / 128)
    expect(run(new BytebeatKernel({ expression: '257', mode: 'signed' }), 1)[0]).toBe(1 / 128)
    expect(run(new BytebeatKernel({ expression: '-4', mode: 'float' }), 1)[0]).toBe(-1)
    expect(run(new BytebeatKernel({ expression: '4', mode: 'float' }), 1)[0]).toBe(1)
    for (const mode of ['byte', 'signed', 'float'] as const) {
      expect([...run(new BytebeatKernel({ expression: '0/0', mode }), 12)]).toEqual(Array(12).fill(0))
    }
  })
  it('supports per-sample clock modulation, pauses safely and resumes', () => {
    const k = new BytebeatKernel({ expression: 't' })
    const out = new Float32Array(8)
    k.process(8, { rate: new Float32Array([48000, 0, NaN, -3, Infinity, 48000, 96000, 0]) }, out, { sampleRate: 48000 })
    expect([...out]).toEqual([0, 1, 1, 1, 1, 1, 2, 4].map(t => (t - 128) / 128))
  })
  it('validates at synth definition and survives JSON graph transport / offline rendering', () => {
    expect(() => synth(({ bytebeat }) => bytebeat('t +'))).toThrow(/bytebeat/)
    const def = synth(({ bytebeat, adsr, gate }) => bytebeat('t * ((t >> 8) & 7)')
      .mul(adsr(gate, { a: 0.005, s: 1, r: 0.02 })).mul(0.2))
    const events = [{ type: 'noteOn' as const, time: 0, note: 60 }, { type: 'noteOff' as const, time: 0.2, note: 60 }]
    const a = renderOffline(def, events, 0.5)
    const b = renderOffline(JSON.parse(JSON.stringify(def)), events, 0.5)
    expect(a.left).toEqual(b.left)
    expect(a.left.every(Number.isFinite)).toBe(true)
    expect(a.left.some(x => Math.abs(x) > 0.05)).toBe(true)
    expect(a.left.slice(20000).every(x => Math.abs(x) < 0.001)).toBe(true)
  })
})
