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

/* THE PIANO MODEL. A piano is not a bell with different numbers: what makes
 * the ear hear a struck STRING is that the partials sit sharp of the harmonic
 * series, because a real string is stiff. With that off, the same bank is an
 * organ stop. These pin the three properties that carry the illusion. */
describe('ModalKernel: the piano model', () => {
  const strike = (freq: number, n: number, cfg: Record<string, unknown> = {}): Float32Array => {
    const k = new ModalKernel({ model: 'piano', decay: 6, ...cfg }, ctx)
    const out = new Float32Array(n)
    k.process(n, { gate: gateOn(n), freq: constBuf(n, freq) }, out, ctx)
    return out
  }
  /** Cents by which partial `n` actually sits above the exact harmonic. */
  const stretchCents = (x: Float32Array, f0: number, n: number): number => {
    let best = 0
    let bestF = n * f0
    for (let f = n * f0 * 0.99; f < n * f0 * 1.06; f += 0.05) {
      const m = goertzel(x, f, sr)
      if (m > best) {
        best = m
        bestF = f
      }
    }
    return 1200 * Math.log2(bestF / (n * f0))
  }

  it('puts the partials SHARP, by the amount stiffness predicts', () => {
    // f_n = n*f0*sqrt(1 + B*n^2); at B = 0.0004 partial 8 is 21.9 cents sharp.
    const x = strike(130.81, sr)
    expect(stretchCents(x, 130.81, 8)).toBeGreaterThan(18)
    expect(stretchCents(x, 130.81, 8)).toBeLessThan(26)
    // and the stretch GROWS with partial number — that is the whole shape
    expect(stretchCents(x, 130.81, 8)).toBeGreaterThan(stretchCents(x, 130.81, 4) + 8)
  })

  it('is harmonic again with stretch: 0, which is the tell', () => {
    const x = strike(130.81, sr, { stretch: 0 })
    expect(Math.abs(stretchCents(x, 130.81, 8))).toBeLessThan(2)
  })

  /** Seconds until the note falls to a tenth of its opening level. `decay: 2`
   *  rather than the 6 above so the BASS also finishes inside the window: at
   *  the real setting it rings past ten seconds, which is the point, but a
   *  measurement that clamps cannot compare two clamped values. */
  const ringSec = (freq: number, cfg: Record<string, unknown> = {}): number => {
    const x = strike(freq, sr * 10, { decay: 2, ...cfg })
    const open = rms(x, 0, Math.floor(sr * 0.2))
    for (let t = 0.2; t < 9.6; t += 0.1) {
      if (rms(x, Math.floor(t * sr), Math.floor((t + 0.2) * sr)) < open * 0.1) return t
    }
    return 10
  }

  it('rings longer in the bass than the treble', () => {
    // a real piano holds its bottom notes for twenty seconds and its top for
    // about one; a single decay time cannot be right for both
    expect(ringSec(55)).toBeGreaterThan(ringSec(1047) * 2)
  })

  it('takes keyScale: 0 to make every pitch ring the same length', () => {
    const ratio = ringSec(55, { keyScale: 0 }) / ringSec(1047, { keyScale: 0 })
    expect(ratio).toBeGreaterThan(0.6)
    expect(ratio).toBeLessThan(1.7)
  })

  it('leaves the percussion models exactly as they were', () => {
    // stretch/keyScale default to the MODEL's values, and bell has none: a
    // new option must not quietly retune every existing patch
    const k = new ModalKernel({ model: 'bell', decay: 2 }, ctx)
    const a = new Float32Array(sr)
    k.process(sr, { gate: gateOn(sr), freq: constBuf(sr, 440) }, a, ctx)
    const k2 = new ModalKernel({ model: 'bell', decay: 2, stretch: 0, keyScale: 0 }, ctx)
    const b = new Float32Array(sr)
    k2.process(sr, { gate: gateOn(sr), freq: constBuf(sr, 440) }, b, ctx)
    for (let i = 0; i < a.length; i += 97) expect(a[i]).toBeCloseTo(b[i]!, 6)
  })
})
