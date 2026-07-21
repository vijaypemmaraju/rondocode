import { describe, it, expect } from 'vitest'
import { SineKernel, SawKernel, SquareKernel, PulseKernel, TriKernel, NoiseKernel, SyncSawKernel, FMKernel, SuperSawKernel, LFSRKernel } from '../src/dsp/osc'
import { LadderKernel, OnePoleKernel, SvfKernel } from '../src/dsp/filters'
import { AdsrKernel } from '../src/dsp/env'
import { LfoKernel } from '../src/dsp/lfo'
import { MulKernel } from '../src/dsp/math'
import { DelayKernel } from '../src/dsp/delay'
import type { DspContext, Kernel } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

const run = (k: Kernel, freq: number, n: number): Float32Array => {
  const f = new Float32Array(n).fill(freq)
  const out = new Float32Array(n)
  k.process(n, { freq: f }, out, ctx)
  return out
}

const countUpwardZeroCrossings = (out: Float32Array, start = 0): number => {
  let crossings = 0
  for (let i = Math.max(1, start); i < out.length; i++) {
    if (out[i - 1]! < 0 && out[i]! >= 0) crossings++
  }
  return crossings
}

// Math.max(...arr) can blow the argument limit on large arrays; loop instead.
const minMax = (out: Float32Array, start = 0): [number, number] => {
  let min = Infinity
  let max = -Infinity
  for (let i = start; i < out.length; i++) {
    if (out[i]! < min) min = out[i]!
    if (out[i]! > max) max = out[i]!
  }
  return [min, max]
}

describe('SineKernel', () => {
  it('sine at 1kHz crosses zero upward ~100 times in 0.1s', () => {
    const out = run(new SineKernel(), 1000, 4800)
    const crossings = countUpwardZeroCrossings(out)
    expect(crossings).toBeGreaterThanOrEqual(99)
    expect(crossings).toBeLessThanOrEqual(101)
  })

  it('sine stays in [-1, 1]', () => {
    const out = run(new SineKernel(), 440, 48000)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.0001)
    expect(min).toBeGreaterThanOrEqual(-1.0001)
  })
})

describe('SawKernel', () => {
  it('polyblep saw has less aliasing than naive saw', () => {
    const roughness = (out: Float32Array): number => {
      let rough = 0
      for (let i = 2; i < out.length; i++) {
        rough += (out[i]! - 2 * out[i - 1]! + out[i - 2]!) ** 2
      }
      return rough / out.length
    }

    const out = run(new SawKernel(), 5000, 48000)

    // Naive (non-band-limited) saw at the same frequency for comparison.
    const naive = new Float32Array(48000)
    let phase = 0
    const dt = 5000 / ctx.sampleRate
    for (let i = 0; i < naive.length; i++) {
      naive[i] = 2 * phase - 1
      phase += dt
      if (phase >= 1) phase -= 1
    }

    // The 2-sample polyblep makes the waveform C1-continuous but second
    // differences at the corner remain O(1), so an absolute bound of 0.05 is
    // unattainable at 5kHz (naive ~0.83, polyblep ~0.28). Assert the actual
    // claim: polyblep is markedly smoother than naive (2.5x; actual ratio is
    // ~3.0, margin left for phase/rounding drift), plus an absolute ceiling.
    expect(roughness(out)).toBeLessThan(roughness(naive) / 2.5)
    expect(roughness(out)).toBeLessThan(0.3)
  })

  it('saw at 1kHz crosses zero upward ~100 times in 0.1s', () => {
    const out = run(new SawKernel(), 1000, 4800)
    const crossings = countUpwardZeroCrossings(out)
    expect(crossings).toBeGreaterThanOrEqual(99)
    expect(crossings).toBeLessThanOrEqual(101)
  })

  it('saw stays roughly in [-1, 1]', () => {
    const out = run(new SawKernel(), 440, 48000)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
  })
})

describe('SquareKernel', () => {
  it('square at 1kHz crosses zero upward ~100 times in 0.1s', () => {
    const out = run(new SquareKernel(), 1000, 4800)
    const crossings = countUpwardZeroCrossings(out)
    expect(crossings).toBeGreaterThanOrEqual(99)
    expect(crossings).toBeLessThanOrEqual(101)
  })

  it('square stays roughly in [-1, 1]', () => {
    const out = run(new SquareKernel(), 440, 48000)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
  })

  it('square has mean ~0 (50% duty cycle)', () => {
    const out = run(new SquareKernel(), 440, 48000)
    let sum = 0
    for (let i = 0; i < out.length; i++) sum += out[i]!
    expect(Math.abs(sum / out.length)).toBeLessThan(0.05)
  })
})

describe('PulseKernel', () => {
  const runPulse = (freq: number, width: number, n: number): Float32Array => {
    const f = new Float32Array(n).fill(freq)
    const w = new Float32Array(n).fill(width)
    const out = new Float32Array(n)
    new PulseKernel().process(n, { freq: f, width: w }, out, ctx)
    return out
  }

  it('pulse at 1kHz crosses zero upward ~100 times in 0.1s', () => {
    const out = runPulse(1000, 0.25, 4800)
    const crossings = countUpwardZeroCrossings(out)
    expect(crossings).toBeGreaterThanOrEqual(99)
    expect(crossings).toBeLessThanOrEqual(101)
  })

  it('pulse stays roughly in [-1, 1]', () => {
    const out = runPulse(440, 0.25, 48000)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
  })

  it('pulse at width 0.25 has mean ~ -0.5', () => {
    const out = runPulse(440, 0.25, 48000)
    let sum = 0
    for (let i = 0; i < out.length; i++) sum += out[i]!
    const mean = sum / out.length
    expect(mean).toBeGreaterThan(-0.55)
    expect(mean).toBeLessThan(-0.45)
  })
})

describe('TriKernel', () => {
  it('tri at 1kHz crosses zero upward ~100 times per 0.1s after settling', () => {
    const n = 48000
    const out = run(new TriKernel(), 1000, n)
    const skip = Math.floor(n * 0.1)
    const crossings = countUpwardZeroCrossings(out, skip)
    const seconds = (n - skip) / ctx.sampleRate
    const expected = 1000 * seconds
    expect(crossings).toBeGreaterThanOrEqual(expected * 0.97)
    expect(crossings).toBeLessThanOrEqual(expected * 1.03)
  })

  it('tri amplitude is roughly in [-1, 1] after settling', () => {
    const n = 48000
    const out = run(new TriKernel(), 440, n)
    const settled = out.subarray(Math.floor(n * 0.1))
    const [min, max] = minMax(settled)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
    // it should actually reach substantial amplitude, not decay to nothing
    expect(max).toBeGreaterThan(0.7)
    expect(min).toBeLessThan(-0.7)
  })
})

describe('NoiseKernel', () => {
  const runNoise = (k: NoiseKernel, n: number): Float32Array => {
    const out = new Float32Array(n)
    k.process(n, {}, out, ctx)
    return out
  }

  it('noise has mean ~0 and RMS ~0.577', () => {
    const out = runNoise(new NoiseKernel(), 48000)
    let sum = 0
    let sq = 0
    for (let i = 0; i < out.length; i++) {
      sum += out[i]!
      sq += out[i]! * out[i]!
    }
    const mean = sum / out.length
    const rms = Math.sqrt(sq / out.length)
    expect(Math.abs(mean)).toBeLessThan(0.02)
    expect(rms).toBeGreaterThan(0.527)
    expect(rms).toBeLessThan(0.627)
  })

  it('noise stays in [-1, 1]', () => {
    const out = runNoise(new NoiseKernel(), 48000)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1)
    expect(min).toBeGreaterThanOrEqual(-1)
  })

  it('same seed produces identical output', () => {
    const a = runNoise(new NoiseKernel(12345), 1024)
    const b = runNoise(new NoiseKernel(12345), 1024)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('different seeds produce different output', () => {
    const a = runNoise(new NoiseKernel(12345), 1024)
    const b = runNoise(new NoiseKernel(54321), 1024)
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })

  it('reset() replays the same sequence', () => {
    const k = new NoiseKernel(777)
    const a = runNoise(k, 1024)
    k.reset()
    const b = runNoise(k, 1024)
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})

describe('SyncSawKernel', () => {
  const runSync = (freq: number, ratio: number, n: number): Float32Array => {
    const f = new Float32Array(n).fill(freq)
    const r = new Float32Array(n).fill(ratio)
    const out = new Float32Array(n)
    new SyncSawKernel().process(n, { freq: f, ratio: r }, out, ctx)
    return out
  }

  /** Naive hard-sync saw (reset without any polyBLEP) for the AA comparison. */
  const naiveSync = (freq: number, ratio: number, n: number): Float32Array => {
    const out = new Float32Array(n)
    let mp = 0
    let sp = 0
    const dtm = freq / ctx.sampleRate
    const dts = dtm * ratio
    for (let i = 0; i < n; i++) {
      out[i] = 2 * sp - 1
      mp += dtm
      if (mp >= 1) {
        mp -= 1
        sp = 0
      } else {
        sp += dts
        if (sp >= 1) sp -= 1
      }
    }
    return out
  }

  /** Total energy at frequencies BETWEEN the master's harmonics — a sync tone
   *  at f0 (constant ratio) is periodic at f0, so ideal energy there is ~0 and
   *  whatever shows up is aliasing. */
  const interHarmonicEnergy = (out: Float32Array, f0: number): number => {
    let e = 0
    // probe the half-harmonics (k+0.5)*f0 across the top of the band where
    // aliasing concentrates
    for (let k = 3; (k + 0.5) * f0 < 0.5 * sr; k++) {
      e += goertzel(out, (k + 0.5) * f0, sr)
    }
    return e
  }

  it('polyBLEP reset aliases far less than a naive reset', () => {
    const f0 = 2000
    const ratio = 2.5
    const blep = runSync(f0, ratio, sr)
    const naive = naiveSync(f0, ratio, sr)
    // both carry the same in-band sync harmonics; only the aliased
    // inter-harmonic energy should differ. Measured: naive ~ 34x the blep
    // version (blep aliased energy is essentially zero); pin at a conservative
    // 2x with wide margin (tune-and-document, like the polyblep saw test).
    expect(interHarmonicEnergy(blep, f0) * 2).toBeLessThan(interHarmonicEnergy(naive, f0))
  })

  it('ratio 1 is ~a plain saw: fundamental sits at freq', () => {
    const f0 = 400
    const out = runSync(f0, 1, sr)
    const fund = goertzel(out, f0, sr)
    // the fundamental dominates its neighbours and the octave
    expect(fund).toBeGreaterThan(goertzel(out, f0 / 2, sr))
    expect(fund).toBeGreaterThan(goertzel(out, f0 * 1.5, sr))
    expect(fund).toBeGreaterThan(0.01)
  })

  it('output stays bounded with no NaN across a ratio sweep', () => {
    const n = sr
    const f = new Float32Array(n).fill(600)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) r[i] = 1 + (6 * i) / (n - 1) // sweep ratio 1 -> 7
    const out = new Float32Array(n)
    new SyncSawKernel().process(n, { freq: f, ratio: r }, out, ctx)
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true)
      expect(Math.abs(out[i]!)).toBeLessThanOrEqual(1.3)
    }
  })

  it('reset() zeros both phases (replays identically)', () => {
    const k = new SyncSawKernel()
    const f = new Float32Array(1000).fill(500)
    const r = new Float32Array(1000).fill(2.5)
    const a = new Float32Array(1000)
    const b = new Float32Array(1000)
    k.process(1000, { freq: f, ratio: r }, a, ctx)
    k.reset()
    k.process(1000, { freq: f, ratio: r }, b, ctx)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('recovers from a NaN freq block within one clean block', () => {
    const k = new SyncSawKernel()
    const bad = { freq: new Float32Array(512).fill(NaN), ratio: new Float32Array(512).fill(2) }
    k.process(512, bad, new Float32Array(512), ctx)
    const good = { freq: new Float32Array(512).fill(440), ratio: new Float32Array(512).fill(2) }
    const out = new Float32Array(512)
    k.process(512, good, out, ctx)
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true)
      expect(Math.abs(out[i]!)).toBeLessThanOrEqual(1.3)
    }
  })
})

describe('NaN-freq recovery', () => {
  it('sine recovers from a NaN freq block within one clean block', () => {
    const k = new SineKernel()
    run(k, NaN, 512) // poison the phase for one block
    const out = run(k, 440, 512) // clean input: sane again from the next block
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true)
      expect(Math.abs(out[i]!)).toBeLessThanOrEqual(1.0001)
    }
  })
})

describe('per-sample width contract', () => {
  it('pulse with width swept 0.1 -> 0.9 across the block stays bounded', () => {
    const n = 48000
    const f = new Float32Array(n).fill(440)
    const w = new Float32Array(n)
    for (let i = 0; i < n; i++) w[i] = 0.1 + (0.8 * i) / (n - 1)
    const out = new Float32Array(n)
    new PulseKernel().process(n, { freq: f, width: w }, out, ctx)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
  })
})

describe('block-boundary continuity', () => {
  const cases: [string, () => Kernel][] = [
    ['sine', () => new SineKernel()],
    ['saw', () => new SawKernel()],
    ['square', () => new SquareKernel()],
    ['pulse', () => new PulseKernel()],
    ['tri', () => new TriKernel()],
    ['noise', () => new NoiseKernel(42)],
    ['svf', () => new SvfKernel('lp')],
    ['ladder', () => new LadderKernel()],
    ['onepole', () => new OnePoleKernel()],
    ['adsr', () => new AdsrKernel()],
    ['lfo', () => new LfoKernel('sine')],
    ['mul', () => new MulKernel()],
    ['delay', () => new DelayKernel()],
  ]

  it.each(cases)('%s: two half blocks equal one full block', (_name, make) => {
    const n = 1024
    // Every input any of the kernels reads; extras are ignored. The filters
    // get a 440Hz sine as signal input. The adsr gate drops at sample 400 —
    // mid-attack (default a=0.01 is 480 samples), so the attack never
    // completes and the release tail spans the block boundary at 512.
    const sig = new Float32Array(n)
    for (let i = 0; i < n; i++) sig[i] = Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate)
    const gate = new Float32Array(n)
    gate.fill(1, 0, 400)
    const inputs = {
      freq: new Float32Array(n).fill(440),
      width: new Float32Array(n).fill(0.25),
      in: sig,
      cutoff: new Float32Array(n).fill(1000),
      res: new Float32Array(n).fill(0.5),
      gate,
      a: sig,
      b: new Float32Array(n).fill(0.5),
      time: new Float32Array(n).fill(0.005), // 240 samples < n: echoes recirculate
      feedback: new Float32Array(n).fill(0.5),
    }
    const slice = (lo: number, hi: number): Record<string, Float32Array> => ({
      freq: inputs.freq.subarray(lo, hi),
      width: inputs.width.subarray(lo, hi),
      in: inputs.in.subarray(lo, hi),
      cutoff: inputs.cutoff.subarray(lo, hi),
      res: inputs.res.subarray(lo, hi),
      gate: inputs.gate.subarray(lo, hi),
      a: inputs.a.subarray(lo, hi),
      b: inputs.b.subarray(lo, hi),
      time: inputs.time.subarray(lo, hi),
      feedback: inputs.feedback.subarray(lo, hi),
    })
    const full = new Float32Array(n)
    make().process(n, inputs, full, ctx)
    const split = new Float32Array(n)
    const k = make()
    k.process(n / 2, slice(0, n / 2), split.subarray(0, n / 2), ctx)
    k.process(n / 2, slice(n / 2, n), split.subarray(n / 2), ctx)
    expect(Array.from(split)).toEqual(Array.from(full))
  })
})

describe('edge cases: out-of-range inputs stay bounded', () => {
  // [name, factory, skipFraction] — tri skips its integrator settling
  // transient, same as the main tri tests.
  const phaseKernels: [string, () => Kernel, number][] = [
    ['sine', () => new SineKernel(), 0],
    ['saw', () => new SawKernel(), 0],
    ['square', () => new SquareKernel(), 0],
    ['pulse', () => new PulseKernel(), 0],
    ['tri', () => new TriKernel(), 0.1],
  ]

  const runEdge = (k: Kernel, freq: number, n: number): Float32Array => {
    const inputs = {
      freq: new Float32Array(n).fill(freq),
      width: new Float32Array(n).fill(0.5),
    }
    const out = new Float32Array(n)
    k.process(n, inputs, out, ctx)
    return out
  }

  // Bound is 1.15, not 1.1: at negative freq the polyblep terms vanish
  // (dt < 0 never enters either branch), so tri integrates an unsmoothed
  // square and settles at ~±1.096. The assertion's point is "near ±1, not
  // unbounded" — pre-fix outputs reached 1e3..1e9.
  it.each(phaseKernels)('%s stays bounded at freq = -440', (_name, make, skip) => {
    const n = 48000
    const [min, max] = minMax(runEdge(make(), -440, n), Math.floor(n * skip))
    expect(max).toBeLessThanOrEqual(1.15)
    expect(min).toBeGreaterThanOrEqual(-1.15)
  })

  it.each(phaseKernels)('%s stays bounded at freq = 100kHz (> sampleRate)', (_name, make, skip) => {
    const n = 48000
    const [min, max] = minMax(runEdge(make(), 100000, n), Math.floor(n * skip))
    expect(max).toBeLessThanOrEqual(1.15)
    expect(min).toBeGreaterThanOrEqual(-1.15)
  })

  it('pulse stays bounded at width = 1.5', () => {
    const n = 48000
    const inputs = {
      freq: new Float32Array(n).fill(440),
      width: new Float32Array(n).fill(1.5),
    }
    const out = new Float32Array(n)
    new PulseKernel().process(n, inputs, out, ctx)
    const [min, max] = minMax(out)
    expect(max).toBeLessThanOrEqual(1.1)
    expect(min).toBeGreaterThanOrEqual(-1.1)
  })
})

describe('FMKernel', () => {
  const sineBuf = (freq: number, n: number): Float32Array => {
    const out = new Float32Array(n)
    const k = new SineKernel()
    k.process(n, { freq: new Float32Array(n).fill(freq) }, out, ctx)
    return out
  }
  const runFM = (n: number, freq: number, mod?: Float32Array, feedback = 0): Float32Array => {
    const out = new Float32Array(n)
    const inputs: Record<string, Float32Array> = {
      freq: new Float32Array(n).fill(freq),
      mod: mod ?? new Float32Array(n), // default 0 (mirrors the PORTS default)
      feedback: new Float32Array(n).fill(feedback),
    }
    new FMKernel().process(n, inputs, out, ctx)
    return out
  }

  it('with no modulation and no feedback it IS a pure sine (fundamental only)', () => {
    const n = 48000
    const fm = runFM(n, 500)
    const sine = sineBuf(500, n)
    // sample-for-sample identical to the sine oscillator
    let maxDiff = 0
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(fm[i]! - sine[i]!))
    expect(maxDiff).toBeLessThan(1e-6)
    // negligible energy at a would-be sideband
    expect(goertzel(fm, 700, sr)).toBeLessThan(goertzel(fm, 500, sr) * 1e-3)
  })

  it('a modulator injects sidebands at carrier ± k·modFreq', () => {
    const n = 48000
    const carrier = 500
    const modFreq = 100
    const index = 2 // modulator amplitude in cycles
    const mod = sineBuf(modFreq, n)
    for (let i = 0; i < n; i++) mod[i]! *= index
    const dry = runFM(n, carrier)
    const wet = runFM(n, carrier, mod)
    // 700 = carrier + 2·modFreq: silent dry, loud once modulated
    expect(goertzel(wet, 700, sr)).toBeGreaterThan(goertzel(dry, 700, sr) * 100)
    // and 400 = carrier − modFreq gains energy too
    expect(goertzel(wet, 400, sr)).toBeGreaterThan(goertzel(dry, 400, sr) * 100)
    // output stays bounded (it is a sine of a phase)
    const [min, max] = minMax(wet)
    expect(max).toBeLessThanOrEqual(1.0001)
    expect(min).toBeGreaterThanOrEqual(-1.0001)
  })

  it('self-feedback adds upper harmonics and stays bounded', () => {
    const n = 48000
    const clean = runFM(n, 500, undefined, 0)
    const fed = runFM(n, 500, undefined, 0.8)
    // the 2nd harmonic (1000 Hz) is negligible on the clean sine, present with feedback
    expect(goertzel(fed, 1000, sr)).toBeGreaterThan(goertzel(clean, 1000, sr) * 50)
    const [min, max] = minMax(fed)
    expect(max).toBeLessThanOrEqual(1.05)
    expect(min).toBeGreaterThanOrEqual(-1.05)
  })

  it('reset() clears phase and feedback history (deterministic restart)', () => {
    const n = 256
    const k = new FMKernel()
    const first = new Float32Array(n)
    const inputs = { freq: new Float32Array(n).fill(440), mod: new Float32Array(n), feedback: new Float32Array(n).fill(0.7) }
    k.process(n, inputs, first, ctx)
    k.reset()
    const second = new Float32Array(n)
    k.process(n, inputs, second, ctx)
    for (let i = 0; i < n; i++) expect(second[i]).toBeCloseTo(first[i]!, 10)
  })

  it('the wave option changes the operator timbre; an unknown wave throws', () => {
    const n = 4800
    const run = (wave?: string): Float32Array => {
      const out = new Float32Array(n)
      new FMKernel(wave).process(n, { freq: new Float32Array(n).fill(500), mod: new Float32Array(n), feedback: new Float32Array(n) }, out, ctx)
      return out
    }
    const sine = run()
    const saw = run('saw')
    // a saw operator (no modulation) has strong upper harmonics the sine lacks
    expect(goertzel(saw, 1000, sr)).toBeGreaterThan(goertzel(sine, 1000, sr) * 20) // 2nd
    expect(goertzel(saw, 1500, sr)).toBeGreaterThan(goertzel(sine, 1500, sr) * 20) // 3rd
    // square is hard-bipolar
    const sq = run('square')
    for (let i = 0; i < n; i++) expect(Math.abs(sq[i]!)).toBeCloseTo(1, 6)
    expect(() => new FMKernel('nope')).toThrow(/unknown fm wave/)
  })
})

describe('NoiseKernel colors', () => {
  const gen = (color: string, n: number): Float32Array => {
    const out = new Float32Array(n)
    new NoiseKernel(12345, color).process(n, {}, out, ctx)
    return out
  }
  // low/high spectral energy via a few Goertzel bins
  const band = (x: Float32Array, freqs: number[]): number =>
    freqs.reduce((s, f) => s + goertzel(x, f, sr), 0)
  const tilt = (x: Float32Array): number =>
    band(x, [80, 120, 160]) / (band(x, [4000, 6000, 8000]) + 1e-12)

  it('pink tilts toward lows and brown tilts harder than white', () => {
    const n = 48000
    const white = tilt(gen('white', n))
    const pink = tilt(gen('pink', n))
    const brown = tilt(gen('brown', n))
    expect(pink).toBeGreaterThan(white * 3) // pink has far more lows than highs
    expect(brown).toBeGreaterThan(pink) // brown is steeper still
  })

  it('rejects an unknown color', () => {
    expect(() => new NoiseKernel(1, 'green')).toThrow(/unknown noise color/)
  })
})

describe('SuperSawKernel', () => {
  const run = (freq: number, detune: number, mix: number, n: number): Float32Array => {
    const out = new Float32Array(n)
    new SuperSawKernel().process(
      n,
      { freq: new Float32Array(n).fill(freq), detune: new Float32Array(n).fill(detune), mix: new Float32Array(n).fill(mix) },
      out,
      ctx,
    )
    return out
  }

  it('sounds, is saw-like (rich harmonics), and stays bounded', () => {
    const n = 48000
    const out = run(220, 0.3, 0.7, n)
    let sumSq = 0
    const [min, max] = minMax(out)
    for (let i = 0; i < n; i++) sumSq += out[i]! * out[i]!
    expect(Math.sqrt(sumSq / n)).toBeGreaterThan(0.05) // audible
    expect(max).toBeLessThanOrEqual(1.15)
    expect(min).toBeGreaterThanOrEqual(-1.15)
    // a saw has energy at 2f, 3f
    expect(goertzel(out, 440, sr)).toBeGreaterThan(goertzel(out, 330, sr))
    expect(goertzel(out, 660, sr)).toBeGreaterThan(goertzel(out, 770, sr))
  })

  it('detune spreads energy around the fundamental (fatter than detune 0)', () => {
    const n = 48000
    const tight = run(220, 0, 0.7, n)
    const wide = run(220, 0.5, 0.7, n)
    // just off the fundamental: the detuned stack leaks energy there, the tight one much less
    expect(goertzel(wide, 226, sr)).toBeGreaterThan(goertzel(tight, 226, sr) * 3)
  })
})

describe('LFSRKernel (chip noise)', () => {
  const run = (freq: number, mode: string | undefined, n: number): Float32Array => {
    const out = new Float32Array(n)
    new LFSRKernel(mode).process(n, { freq: new Float32Array(n).fill(freq) }, out, ctx)
    return out
  }

  it('outputs 1-bit ±1 with mean ~0', () => {
    const out = run(6000, 'white', 48000)
    let sum = 0
    for (let i = 0; i < out.length; i++) {
      const v = out[i]!
      expect(v === 1 || v === -1 || v === 0).toBe(true)
      sum += v
    }
    expect(Math.abs(sum / out.length)).toBeLessThan(0.2)
  })

  it('periodic mode is a pitched tone at ~clock/93; white mode is not', () => {
    const n = 48000
    const f = 9300 // periodic loop = 93 shifts -> ~100 Hz fundamental
    const periodic = run(f, 'periodic', n)
    const white = run(f, 'white', n)
    expect(goertzel(periodic, 100, sr)).toBeGreaterThan(goertzel(white, 100, sr) * 10)
  })

  it('higher clock freq shifts energy up (brighter)', () => {
    const n = 48000
    const lowE = goertzel(run(1500, 'white', n), 6000, sr)
    const highE = goertzel(run(18000, 'white', n), 6000, sr)
    expect(highE).toBeGreaterThan(lowE * 2)
  })

  it('is deterministic and rejects an unknown mode', () => {
    const a = run(4000, undefined, 512)
    const b = run(4000, undefined, 512)
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]!)
    expect(() => new LFSRKernel('square')).toThrow(/unknown lfsr mode/)
  })
})
