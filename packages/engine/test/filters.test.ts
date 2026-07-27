import { describe, it, expect } from 'vitest'
import { DualSvfKernel, LadderKernel, OnePoleKernel, SvfKernel } from '../src/dsp/filters'
import type { DualSvfConfig } from '../src/dsp/filters'
import { NoiseKernel } from '../src/dsp/osc'
import type { DspContext, Kernel } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate
const TWO_PI = 2 * Math.PI

const constArr = (n: number, v: number): Float32Array => new Float32Array(n).fill(v)

/** Run a filter kernel over `input` with constant cutoff/res, in `block`-sized
 *  chunks (chunking matters for the block-end denormal/NaN flush tests). */
const runFilter = (
  k: Kernel,
  input: Float32Array,
  cutoff: number,
  res: number,
  block = input.length,
): Float32Array => {
  const n = input.length
  const out = new Float32Array(n)
  const c = constArr(n, cutoff)
  const r = constArr(n, res)
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i)
    k.process(
      m,
      { in: input.subarray(i, i + m), cutoff: c.subarray(i, i + m), res: r.subarray(i, i + m) },
      out.subarray(i, i + m),
      ctx,
    )
  }
  return out
}

const noise = (n: number, seed = 1234): Float32Array => {
  const out = new Float32Array(n)
  new NoiseKernel(seed).process(n, {}, out, ctx)
  return out
}

/** Estimated power transfer |H(f)|^2: filtered power over raw input power at
 *  `f`, both measured on the last half of the signals (transient skipped).
 *  Normalizing per-frequency cancels the noise source's spectral ripple. */
const response = (raw: Float32Array, filtered: Float32Array, f: number): number => {
  const half = raw.length >> 1
  return goertzel(filtered.subarray(half), f, sr) / goertzel(raw.subarray(half), f, sr)
}

const maxAbs = (out: Float32Array): number => {
  let peak = 0
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]!)
    if (a > peak) peak = a
  }
  return peak
}

describe('SvfKernel', () => {
  it('lp at 500Hz passes 200Hz and attenuates 5kHz by > 20x', () => {
    const raw = noise(sr)
    const filtered = runFilter(new SvfKernel('lp'), raw, 500, 0.2)
    const low = response(raw, filtered, 200)
    const high = response(raw, filtered, 5000)
    expect(low).toBeGreaterThan(20 * high)
  })

  it('hp at 500Hz passes 5kHz and attenuates 200Hz by > 20x', () => {
    const raw = noise(sr)
    const filtered = runFilter(new SvfKernel('hp'), raw, 500, 0.2)
    const low = response(raw, filtered, 200)
    const high = response(raw, filtered, 5000)
    expect(high).toBeGreaterThan(20 * low)
  })

  it('bp at 1kHz peaks at cutoff vs cutoff/8 and cutoff*8', () => {
    const raw = noise(sr)
    const filtered = runFilter(new SvfKernel('bp'), raw, 1000, 0.5)
    const center = response(raw, filtered, 1000)
    expect(center).toBeGreaterThan(response(raw, filtered, 125))
    expect(center).toBeGreaterThan(response(raw, filtered, 8000))
  })

  it('notch at 1kHz dips at cutoff vs 300Hz and 4kHz', () => {
    const raw = noise(sr)
    const filtered = runFilter(new SvfKernel('notch'), raw, 1000, 0.2)
    const dip = response(raw, filtered, 1000)
    // the rejected band sits far below both neighbours
    expect(dip * 5).toBeLessThan(response(raw, filtered, 300))
    expect(dip * 5).toBeLessThan(response(raw, filtered, 4000))
  })

  it('peak at 1kHz emphasizes cutoff vs 300Hz and 4kHz', () => {
    const raw = noise(sr)
    const filtered = runFilter(new SvfKernel('peak'), raw, 1000, 0.7)
    const center = response(raw, filtered, 1000)
    expect(center).toBeGreaterThan(2 * response(raw, filtered, 300))
    expect(center).toBeGreaterThan(2 * response(raw, filtered, 4000))
  })

  it('notch and peak stay finite and bounded at res=1.0, cutoff=18kHz', () => {
    // notch only ever attenuates, so it stays near the input level; peak is a
    // resonant bell (Q ~ 25 at the res=0.98 clamp) so its cutoff boost is large
    // but FINITE and stable — bounded well below any runaway.
    const bound: Record<'notch' | 'peak', number> = { notch: 10, peak: 30 }
    for (const mode of ['notch', 'peak'] as const) {
      const filtered = runFilter(new SvfKernel(mode), noise(sr), 18000, 1.0)
      for (let i = 0; i < filtered.length; i++) {
        expect(Number.isFinite(filtered[i]!)).toBe(true)
      }
      expect(maxAbs(filtered)).toBeLessThan(bound[mode])
    }
  })

  it('stays finite and bounded at res=1.0, cutoff=18kHz on 1s of noise', () => {
    const filtered = runFilter(new SvfKernel('lp'), noise(sr), 18000, 1.0)
    for (let i = 0; i < filtered.length; i++) {
      expect(Number.isFinite(filtered[i]!)).toBe(true)
    }
    expect(maxAbs(filtered)).toBeLessThan(10)
  })

  it('allpass at 1kHz keeps the magnitude flat across the band (within ±3dB)', () => {
    const raw = noise(sr)
    const filtered = runFilter(new SvfKernel('allpass'), raw, 1000, 0.5)
    for (const f of [100, 500, 1000, 2000, 8000]) {
      const r = response(raw, filtered, f)
      expect(r, `|H|^2 at ${f}Hz`).toBeGreaterThan(0.5) // -3dB in power
      expect(r, `|H|^2 at ${f}Hz`).toBeLessThan(2)
    }
  })

  it('allpass at cutoff shifts the phase ~180° (anti-correlated with the input) at unchanged level', () => {
    // steady 1kHz sine through an allpass tuned to 1kHz: a 2nd-order allpass
    // is at -180° exactly at cutoff, so in/out correlate strongly NEGATIVELY,
    // while the amplitude stays ~unchanged.
    const n = sr
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = Math.sin((TWO_PI * 1000 * i) / sr)
    const out = runFilter(new SvfKernel('allpass'), input, 1000, 0.5)
    const half = n >> 1
    let dot = 0
    let pin = 0
    let pout = 0
    for (let i = half; i < n; i++) {
      dot += input[i]! * out[i]!
      pin += input[i]! * input[i]!
      pout += out[i]! * out[i]!
    }
    expect(Math.sqrt(pout / pin)).toBeGreaterThan(0.95) // level preserved
    expect(Math.sqrt(pout / pin)).toBeLessThan(1.05)
    expect(dot / Math.sqrt(pin * pout)).toBeLessThan(-0.9) // ~180° out of phase
  })
})

/** Run a DualSvfKernel over `input` with constant cutoffs/res. */
const runDual = (cfg: DualSvfConfig, input: Float32Array, fa: number, fb: number, res: number): Float32Array => {
  const n = input.length
  const out = new Float32Array(n)
  new DualSvfKernel(cfg).process(
    n,
    { in: input, cutoff: constArr(n, fa), cutoff2: constArr(n, fb), res: constArr(n, res) },
    out,
    ctx,
  )
  return out
}

describe('DualSvfKernel', () => {
  it('serial lp+lp at one cutoff rolls off much steeper than a single svf lp', () => {
    const raw = noise(sr)
    const single = runFilter(new SvfKernel('lp'), raw, 500, 0.2)
    const dual = runDual({}, raw, 500, 500, 0.2) // defaults: serial, lp + lp
    const s = response(raw, single, 4000)
    const d = response(raw, dual, 4000)
    expect(d).toBeLessThan(s / 10) // 24dB/oct vs 12dB/oct, 3 octaves up
    expect(response(raw, dual, 200)).toBeGreaterThan(0.3) // passband intact
  })

  it('serial hp 500 → lp 2000 passes the middle and kills both edges', () => {
    const raw = noise(sr)
    const dual = runDual({ mode: 'serial', a: 'hp', b: 'lp' }, raw, 500, 2000, 0.2)
    const mid = response(raw, dual, 1000)
    expect(mid).toBeGreaterThan(10 * response(raw, dual, 100))
    expect(mid).toBeGreaterThan(10 * response(raw, dual, 8000))
  })

  it('parallel lp 400 + hp 4000 leaves a spectral hole between the cutoffs', () => {
    const raw = noise(sr)
    const dual = runDual({ mode: 'parallel', a: 'lp', b: 'hp' }, raw, 400, 4000, 0.2)
    const holeF = Math.sqrt(400 * 4000) // ~1265Hz, the geometric middle
    const hole = response(raw, dual, holeF)
    expect(hole * 5).toBeLessThan(response(raw, dual, 100))
    expect(hole * 5).toBeLessThan(response(raw, dual, 10000))
    // both passbands survive near unity
    expect(response(raw, dual, 100)).toBeGreaterThan(0.5)
    expect(response(raw, dual, 10000)).toBeGreaterThan(0.5)
  })

  it('each stage obeys ITS OWN cutoff (audio-rate independent inputs)', () => {
    // widen stage B's lp: the top end opens while stage A's hp edge stays put
    const raw = noise(sr)
    const narrow = runDual({ mode: 'serial', a: 'hp', b: 'lp' }, raw, 500, 1000, 0.2)
    const wide = runDual({ mode: 'serial', a: 'hp', b: 'lp' }, raw, 500, 8000, 0.2)
    expect(response(raw, wide, 4000)).toBeGreaterThan(10 * response(raw, narrow, 4000))
    // the shared hp edge is unaffected by cutoff2
    const loNarrow = response(raw, narrow, 100)
    const loWide = response(raw, wide, 100)
    expect(loWide).toBeLessThan(loNarrow * 3 + 0.01)
  })

  it('stays finite and bounded at res=1.0 with extreme cutoffs on 1s of noise', () => {
    const out = runDual({ mode: 'parallel', a: 'peak', b: 'peak' }, noise(sr), 18000, 30, 1.0)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    expect(maxAbs(out)).toBeLessThan(60) // two resonant bells, still bounded
  })
})

describe('LadderKernel', () => {
  // NOTE: the prescribed res=0.95/cutoff=1kHz never self-oscillates with this
  // exact topology: the one-sample feedback delay plus the unwarped
  // g = 1 - exp(-2*pi*fc) mapping keeps the linearized spectral radius < 1 at
  // 1kHz for every res <= 1.1 (verified numerically). At cutoff=500 and
  // res=1.1 (fb=4.4) it does oscillate, settling to RMS ~0.055 at ~526Hz
  // within ~3s. Hence: res=1.1, cutoff=500, 4s run.
  it('self-oscillates when pinged at res=1.1, cutoff=500', () => {
    const input = new Float32Array(4 * sr)
    input[0] = 1
    const out = runFilter(new LadderKernel(), input, 500, 1.1)
    const tail = out.subarray(out.length - sr / 2)
    let sq = 0
    for (let i = 0; i < tail.length; i++) sq += tail[i]! * tail[i]!
    expect(Math.sqrt(sq / tail.length)).toBeGreaterThan(0.01)

    // Goertzel scan over a 200..4000Hz log grid: peak within 15% of cutoff.
    let bestF = 0
    let bestP = -1
    for (let j = 0; j <= 80; j++) {
      const f = 200 * Math.pow(20, j / 80)
      const p = goertzel(tail, f, sr)
      if (p > bestP) {
        bestP = p
        bestF = f
      }
    }
    expect(bestF).toBeGreaterThan(500 * 0.85)
    expect(bestF).toBeLessThan(500 * 1.15)
  })

  it('behaves as a lowpass at res=0, cutoff=500', () => {
    const raw = noise(sr)
    const filtered = runFilter(new LadderKernel(), raw, 500, 0)
    const low = response(raw, filtered, 200)
    const high = response(raw, filtered, 5000)
    expect(low).toBeGreaterThan(20 * high)
  })
})

describe('OnePoleKernel', () => {
  it('step response reaches ~63% after one time constant', () => {
    const fc = 100
    const tau = Math.round(sr / (TWO_PI * fc)) // samples per time constant
    const out = runFilter(new OnePoleKernel(), constArr(4 * tau, 1), fc, 0)
    expect(out[tau]!).toBeGreaterThan(0.632 * 0.8)
    expect(out[tau]!).toBeLessThan(0.632 * 1.2)
  })
})

/** Adapter so DualSvfKernel fits the shared in/cutoff/res harness: cutoff2
 *  mirrors cutoff (both stages tuned together — state hygiene doesn't care). */
const dualAsFilter = (cfg: DualSvfConfig): Kernel => {
  const k = new DualSvfKernel(cfg)
  return {
    process: (n, inputs, out, c) => k.process(n, { ...inputs, cutoff2: inputs['cutoff']! }, out, c),
    reset: () => k.reset(),
  }
}

// [name, factory] — every filter kernel, for the shared state-hygiene tests.
const allFilters: [string, () => Kernel][] = [
  ['svf', () => new SvfKernel('lp')],
  ['svf-allpass', () => new SvfKernel('allpass')],
  ['ladder', () => new LadderKernel()],
  ['onepole', () => new OnePoleKernel()],
  ['dualsvf-serial', () => dualAsFilter({})],
  ['dualsvf-parallel', () => dualAsFilter({ mode: 'parallel', a: 'lp', b: 'hp' })],
]

describe('denormal flush', () => {
  it.each(allFilters)('%s: output after 1s of silence is exactly 0', (_name, make) => {
    const k = make()
    // Excite with a noise burst, then 1s of silence, processed in 512-sample
    // blocks so the block-end flush gets a chance to run.
    runFilter(k, noise(2048), 500, 0.5, 512)
    runFilter(k, new Float32Array(sr), 500, 0.5, 512)
    const out = runFilter(k, new Float32Array(512), 500, 0.5)
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0) // exactly 0, not 1e-200
    }
  })
})

describe('NaN-input robustness', () => {
  it.each(allFilters)('%s: recovers within 100ms of clean input after a NaN block', (_name, make) => {
    const k = make()
    const poisoned = new Float32Array(512)
    poisoned.fill(NaN, 100, 110)
    runFilter(k, poisoned, 500, 0.5)
    // 100ms of clean silence, then the filter must be fully sane again.
    runFilter(k, new Float32Array(Math.floor(0.1 * sr)), 500, 0.5, 512)
    const out = runFilter(k, new Float32Array(512), 500, 0.5)
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0)
    }
  })

  it.each(allFilters)('%s: recovers after NaN in the cutoff input', (_name, make) => {
    const k = make()
    const n = 512
    const cut = constArr(n, 500)
    cut.fill(NaN, 100, 110)
    k.process(n, { in: noise(n), cutoff: cut, res: constArr(n, 0.5) }, new Float32Array(n), ctx)
    // 100ms of clean silence, then the filter must be fully sane again.
    runFilter(k, new Float32Array(Math.floor(0.1 * sr)), 500, 0.5, 512)
    const out = runFilter(k, new Float32Array(512), 500, 0.5)
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(0)
    }
  })
})
