import { describe, expect, it } from 'vitest'
import { CompressKernel, gainReductionDb } from '../src/dsp/compress'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'

/** Drive a kernel with a constant DC level for `n` samples; return final out. */
const settle = (k: CompressKernel, level: number, n: number, sr = 48000): Float32Array => {
  const input = new Float32Array(n).fill(level)
  const out = new Float32Array(n)
  k.process(n, { in: input }, out, { sampleRate: sr })
  return out
}

describe('gainReductionDb (static curve)', () => {
  it('is 0 below the threshold (hard knee)', () => {
    expect(gainReductionDb(-30, -18, 4, 0)).toBe(0)
  })
  it('applies (1 - 1/ratio) * overshoot above the threshold', () => {
    // -6 dB is 12 dB over a -18 threshold; 4:1 -> 0.75 * 12 = 9 dB reduction
    expect(gainReductionDb(-6, -18, 4, 0)).toBeCloseTo(9, 6)
  })
  it('ratio 1:1 never reduces', () => {
    expect(gainReductionDb(0, -18, 1, 6)).toBe(0)
  })
  it('soft knee eases in reduction around the threshold', () => {
    // exactly at threshold with a 6 dB knee -> a little reduction, not zero
    const gr = gainReductionDb(-18, -18, 4, 6)
    expect(gr).toBeGreaterThan(0)
    expect(gr).toBeLessThan(gainReductionDb(-12, -18, 4, 6)) // grows past it
  })
})

describe('CompressKernel', () => {
  it('leaves a signal below threshold untouched', () => {
    // 0.05 ≈ -26 dBFS, below -18 -> no reduction, unity gain
    const out = settle(new CompressKernel({ threshold: -18, ratio: 4 }), 0.05, 2400)
    expect(out[out.length - 1]!).toBeCloseTo(0.05, 4)
  })

  it('reduces a signal above threshold toward the ratio target', () => {
    // 0.5 ≈ -6 dBFS -> 9 dB reduction at 4:1 -> gain 10^(-9/20) ≈ 0.3548
    const out = settle(new CompressKernel({ threshold: -18, ratio: 4, attack: 5 }), 0.5, 4800)
    const expected = 0.5 * Math.pow(10, -9 / 20)
    expect(out[out.length - 1]!).toBeCloseTo(expected, 3)
  })

  it('makeup gain scales the output', () => {
    const out = settle(new CompressKernel({ threshold: -18, ratio: 4, attack: 5, makeup: 6 }), 0.5, 4800)
    const expected = 0.5 * Math.pow(10, -9 / 20) * Math.pow(10, 6 / 20)
    expect(out[out.length - 1]!).toBeCloseTo(expected, 2)
  })

  it('attack ramps the reduction in (not instant)', () => {
    const k = new CompressKernel({ threshold: -18, ratio: 8, attack: 20 })
    const out = settle(k, 0.8, 4800)
    // first sample barely reduced (attack still ramping), last well reduced
    expect(Math.abs(out[0]!)).toBeGreaterThan(Math.abs(out[out.length - 1]!))
  })

  it('stays finite on silence and does not reduce it', () => {
    const out = settle(new CompressKernel({}), 0, 512)
    expect(out.every((v) => v === 0)).toBe(true)
  })
})

describe('compress() through synth() + renderOffline', () => {
  it('tames a hot signal (compressed peak < uncompressed peak)', () => {
    const hot = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(2).mul(adsr(gate, { a: 0.001, s: 1 })))
    const comp = synth(({ note, gate, adsr, saw, compress }) =>
      compress(saw(note.freq).mul(2), { threshold: -18, ratio: 6, attack: 2 }).mul(adsr(gate, { a: 0.001, s: 1 })))
    const ev = [{ time: 0, type: 'noteOn' as const, note: 57, velocity: 1 }, { time: 0.3, type: 'noteOff' as const, note: 57 }]
    const peak = (r: { left: Float32Array }): number => {
      let p = 0
      for (let i = 0; i < r.left.length; i++) p = Math.max(p, Math.abs(r.left[i]!))
      return p
    }
    const rawPeak = peak(renderOffline(hot, ev, 0.4))
    const compPeak = peak(renderOffline(comp, ev, 0.4))
    expect(compPeak).toBeLessThan(rawPeak)
    expect(compPeak).toBeGreaterThan(0)
  })
})
