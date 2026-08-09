import { describe, expect, it } from 'vitest'
import { TapeKernel, saturate } from '../src/dsp/tape'
import { goertzel } from './util/goertzel'

/* "Tape" is four separate things, and the usual mistake is to ship one of them
 * (a saturator) and call it tape. So every test here isolates ONE component
 * and measures it, with the other three switched off — including the tests
 * that separate wow from flutter, which is a difference of RATE and which a
 * single-LFO implementation would blur into "some wobble".
 */

const sr = 48000

function run(cfg: ConstructorParameters<typeof TapeKernel>[0], input: Float32Array, block = 128, rate = sr): Float32Array {
  const k = new TapeKernel(cfg)
  const out = new Float32Array(input.length)
  for (let d = 0; d < input.length; d += block) {
    const len = Math.min(block, input.length - d)
    k.process(len, { in: input.subarray(d, d + len) }, out.subarray(d, d + len), { sampleRate: rate })
  }
  return out
}

const sine = (n: number, hz: number, amp = 0.6, rate = sr): Float32Array => {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
  return a
}

/** Frequency of every cycle, from interpolated upward zero crossings. This is
 *  what makes wow and flutter measurable at all: a windowed estimate is too
 *  coarse to see either, and a spectrum cannot resolve a 7 Hz sideband next to
 *  a 440 Hz carrier without leakage swamping it. */
function cycleFreqs(o: Float32Array, from = sr): number[] {
  const cross: number[] = []
  for (let i = from + 1; i < o.length; i++) {
    if (o[i - 1]! < 0 && o[i]! >= 0) {
      cross.push(i - 1 + -o[i - 1]! / (o[i]! - o[i - 1]!))
    }
  }
  const f: number[] = []
  for (let i = 1; i < cross.length; i++) f.push(sr / (cross[i]! - cross[i - 1]!))
  return f
}

const swingPct = (f: number[], carrier = 440): number =>
  ((Math.max(...f) - Math.min(...f)) / carrier) * 100

const OFF = { wow: 0, flutter: 0, sat: 0, tone: 20000 }
const TONE = sr * 3

describe('saturate (the curve on its own)', () => {
  it('sat 0 is an IDENTITY, not "slightly less distorted"', () => {
    for (const x of [-1, -0.3, 0, 0.3, 1]) expect(saturate(x, 0)).toBe(x)
  })

  it('compresses the range: it LIFTS everything under full scale', () => {
    /* Normalised to unity at x = 1, so it does not turn the signal down — it
     * pulls quiet material up toward the peak, which is the same statement as
     * "it compresses the dynamic range" and is what saturation does to a
     * meter. Asserting it makes things quieter would be asserting a clipper. */
    expect(saturate(1, 1)).toBeCloseTo(1, 6)
    expect(saturate(0.5, 1), 'the curve is not lifting low level').toBeGreaterThan(0.5)
    expect(saturate(0.5, 1)).toBeLessThan(1)
  })

  it('holds the ceiling: well past full scale it barely moves', () => {
    // a clipper would flatten to exactly 1; this keeps rising, very slowly
    expect(saturate(3, 1)).toBeGreaterThan(saturate(2, 1))
    expect(saturate(3, 1)).toBeLessThan(1.02)
  })

  it('is odd — the same curve either side of zero', () => {
    for (const x of [0.2, 0.5, 0.9]) expect(saturate(-x, 0.7)).toBeCloseTo(-saturate(x, 0.7), 12)
  })

  it('is monotonic, so it never folds the waveform back on itself', () => {
    let prev = -Infinity
    for (let x = -2; x <= 2; x += 0.01) {
      const y = saturate(x, 1)
      expect(y).toBeGreaterThan(prev)
      prev = y
    }
  })
})

describe('with everything off, tape is CLEAN', () => {
  it('holds the pitch perfectly steady', () => {
    // the control for every wow/flutter test below: with no modulation there
    // must be no modulation, or none of them mean anything
    const f = cycleFreqs(run(OFF, sine(TONE, 440)))
    expect(swingPct(f)).toBeLessThan(0.001)
  })

  it('adds no harmonics', () => {
    const out = run(OFF, sine(TONE, 440))
    const tail = out.subarray(out.length - 16384)
    expect(goertzel(tail, 1320, sr) / goertzel(tail, 440, sr)).toBeLessThan(0.001)
  })
})

describe('WOW: slow pitch drift', () => {
  it('moves the pitch', () => {
    const f = cycleFreqs(run({ ...OFF, wow: 1 }, sine(TONE, 440)))
    expect(swingPct(f), 'no wow at all').toBeGreaterThan(0.5)
  })

  it('more wow moves it further', () => {
    const a = swingPct(cycleFreqs(run({ ...OFF, wow: 0.3 }, sine(TONE, 440))))
    const b = swingPct(cycleFreqs(run({ ...OFF, wow: 1 }, sine(TONE, 440))))
    expect(b).toBeGreaterThan(a * 2)
  })

  it('drifts SLOWLY — that is what makes it wow and not flutter', () => {
    /* The rate, measured as how much the pitch changes from one cycle to the
     * next, relative to its total swing. Wow measures 0.003 here and flutter
     * 0.029: an order of magnitude, which is the whole distinction. */
    const f = cycleFreqs(run({ ...OFF, wow: 1 }, sine(TONE, 440)))
    let adj = 0
    for (let i = 1; i < f.length; i++) adj += Math.abs(f[i]! - f[i - 1]!)
    adj /= f.length - 1
    expect(adj / (Math.max(...f) - Math.min(...f))).toBeLessThan(0.01)
  })
})

describe('FLUTTER: the same thing, faster', () => {
  it('moves the pitch', () => {
    const f = cycleFreqs(run({ ...OFF, flutter: 1 }, sine(TONE, 440)))
    expect(swingPct(f), 'no flutter at all').toBeGreaterThan(0.3)
  })

  it('more flutter moves it further', () => {
    const a = swingPct(cycleFreqs(run({ ...OFF, flutter: 0.3 }, sine(TONE, 440))))
    const b = swingPct(cycleFreqs(run({ ...OFF, flutter: 1 }, sine(TONE, 440))))
    expect(b).toBeGreaterThan(a * 2)
  })

  it('varies FASTER than wow, at the same swing', () => {
    // the property that makes them two controls rather than one
    const rate = (f: number[]): number => {
      let adj = 0
      for (let i = 1; i < f.length; i++) adj += Math.abs(f[i]! - f[i - 1]!)
      return adj / (f.length - 1) / (Math.max(...f) - Math.min(...f))
    }
    const wow = rate(cycleFreqs(run({ ...OFF, wow: 1 }, sine(TONE, 440))))
    const flut = rate(cycleFreqs(run({ ...OFF, flutter: 1 }, sine(TONE, 440))))
    expect(flut, 'flutter is not faster than wow').toBeGreaterThan(wow * 5)
  })
})

describe('the drift is not a VIBRATO', () => {
  it('does not repeat at its own oscillator period', () => {
    /* A single LFO is a vibrato — a regular wobble no machine ever made. Two
     * incommensurate oscillators never line up again, so the frequency curve
     * one wow period later is a DIFFERENT curve. A single 0.61 Hz LFO would
     * score ~0 here; this measures 0.14. */
    const out = run({ ...OFF, wow: 1 }, sine(sr * 12, 440))
    const cross: number[] = []
    for (let i = sr + 1; i < out.length; i++) {
      if (out[i - 1]! < 0 && out[i]! >= 0) cross.push(i - 1 + -out[i - 1]! / (out[i]! - out[i - 1]!))
    }
    // frequency on a uniform 5 ms grid, so a time shift is an index shift
    const step = Math.round(0.005 * sr)
    const grid: number[] = []
    let k = 1
    for (let s = sr; s + step < out.length; s += step) {
      while (k < cross.length && cross[k]! < s) k++
      if (k >= cross.length) break
      grid.push(sr / (cross[k]! - cross[k - 1]!))
    }
    const period = Math.round(1 / 0.61 / 0.005)
    let diff = 0
    let cnt = 0
    for (let i = 0; i + period < grid.length; i++) {
      diff += Math.abs(grid[i]! - grid[i + period]!)
      cnt++
    }
    const swing = Math.max(...grid) - Math.min(...grid)
    expect(diff / cnt / swing, 'the drift repeats — this is a vibrato').toBeGreaterThan(0.05)
  })
})

describe('SATURATION and TONE', () => {
  it('saturation adds harmonics, and sat 0 adds none', () => {
    const harm = (sat: number): number => {
      const out = run({ ...OFF, sat }, sine(TONE, 440, 0.9))
      const tail = out.subarray(out.length - 16384)
      return goertzel(tail, 1320, sr) / goertzel(tail, 440, sr)
    }
    expect(harm(0)).toBeLessThan(0.001)
    expect(harm(1), 'saturation added nothing').toBeGreaterThan(0.01)
    expect(harm(1)).toBeGreaterThan(harm(0.3))
  })

  it('tone takes the top off, and a high tone leaves it', () => {
    const level = (tone: number): number => {
      const out = run({ ...OFF, tone }, sine(TONE, 9000))
      let s = 0
      for (let i = out.length - 16384; i < out.length; i++) s += out[i]! * out[i]!
      return Math.sqrt(s / 16384)
    }
    const dark = 20 * Math.log10(level(4000) / level(20000))
    expect(dark, 'tone did nothing').toBeLessThan(-3)
  })

  it('tone leaves the LOW end alone — it is a rolloff, not a volume', () => {
    const level = (tone: number, hz: number): number => {
      const out = run({ ...OFF, tone }, sine(TONE, hz))
      let s = 0
      for (let i = out.length - 16384; i < out.length; i++) s += out[i]! * out[i]!
      return Math.sqrt(s / 16384)
    }
    expect(level(4000, 200) / level(20000, 200)).toBeCloseTo(1, 1)
  })
})

describe('TapeKernel robustness', () => {
  it('is DETERMINISTIC — the same input twice gives the same audio', () => {
    // a render has to be reproducible, so the drift cannot come from a random
    // source however tempting that is for "organic"
    const input = sine(sr, 440)
    const a = run({}, input)
    const b = run({}, input)
    for (let i = 0; i < input.length; i += 97) expect(b[i]!).toBe(a[i]!)
  })

  it('never emits a non-finite sample, even fed NaN', () => {
    const k = new TapeKernel({})
    const out = new Float32Array(256)
    k.process(128, { in: new Float32Array(128).fill(NaN) }, out.subarray(0, 128), { sampleRate: sr })
    k.process(128, { in: sine(128, 300) }, out.subarray(128), { sampleRate: sr })
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('gives the same answer across block sizes, including ragged ones', () => {
    const input = sine(sr / 2, 440)
    const ref = run({}, input, 128)
    for (const block of [1, 7, 333, 4096]) {
      const got = run({}, input, block)
      for (let i = 0; i < input.length; i += 97) {
        expect(got[i]!, `block ${block} sample ${i}`).toBeCloseTo(ref[i]!, 6)
      }
    }
  })

  it('works at 44.1k as well as 48k', () => {
    for (const rate of [44100, 48000]) {
      const out = run({}, sine(rate, 440, 0.6, rate), 128, rate)
      expect(out.every((v) => Number.isFinite(v)), `${rate}`).toBe(true)
      let peak = 0
      for (const v of out) peak = Math.max(peak, Math.abs(v))
      expect(peak, `${rate} produced no sound`).toBeGreaterThan(0.1)
    }
  })

  it('LIFTS the level slightly rather than losing it', () => {
    /* Measured rather than hoped for: the default `sat` normalises to unity at
     * full scale, so a 0.6 peak comes back at about 0.71 (+1.4 dB). Worth
     * pinning because it is the number someone will trip over when a tape
     * stage makes their bus louder. */
    const input = sine(sr, 440)
    const out = run({}, input)
    let pi = 0, po = 0
    for (const v of input) pi = Math.max(pi, Math.abs(v))
    for (let i = sr / 2; i < out.length; i++) po = Math.max(po, Math.abs(out[i]!))
    expect(po / pi).toBeGreaterThan(1)
    expect(po / pi, 'the lift got out of hand').toBeLessThan(1.3)
  })
})
