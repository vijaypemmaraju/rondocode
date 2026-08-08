import { describe, expect, it } from 'vitest'
import { LimiterKernel, requiredGain } from '../src/dsp/limiter'
import { goertzel } from './util/goertzel'

/* A limiter holds a ceiling by turning DOWN. The engine's existing master
 * stage holds it by DISTORTING (a tanh soft-clip at 0.95), which is a fine
 * last resort and a different thing.
 *
 * So the contract here is a guarantee, and it is tested as one: across every
 * signal below, no output sample may exceed the ceiling. A test that only
 * checked "quieter than the input" would pass for a soft clipper too. */

const sr = 48000
const dbToLin = (db: number): number => Math.pow(10, db / 20)

/** Run a signal through in blocks (the block boundary is where a delay-line
 *  index bug would show up). */
function run(k: LimiterKernel, input: Float32Array, block = 128, rate = sr): Float32Array {
  const out = new Float32Array(input.length)
  for (let d = 0; d < input.length; d += block) {
    const len = Math.min(block, input.length - d)
    k.process(len, { in: input.subarray(d, d + len) }, out.subarray(d, d + len), { sampleRate: rate })
  }
  return out
}

const peak = (a: Float32Array): number => {
  let p = 0
  for (const v of a) p = Math.max(p, Math.abs(v))
  return p
}

describe('requiredGain', () => {
  it('is 1 for anything already under the ceiling', () => {
    expect(requiredGain(0.5, 0.9)).toBe(1)
    expect(requiredGain(0.9, 0.9)).toBe(1)
  })

  it('is exactly the ratio that lands a peak ON the ceiling', () => {
    expect(requiredGain(2, 0.5)).toBeCloseTo(0.25, 12)
    expect(2 * requiredGain(2, 0.5)).toBeCloseTo(0.5, 12)
  })

  it('handles 0 and NaN without producing a non-finite gain', () => {
    expect(requiredGain(0, 0.9)).toBe(1)
    expect(requiredGain(NaN, 0.9)).toBe(1)
  })
})

describe('LimiterKernel: the ceiling is a GUARANTEE', () => {
  const CEIL_DB = -1
  const ceil = dbToLin(CEIL_DB)

  const cases: [string, Float32Array][] = [
    ['a steady loud sine', (() => {
      const n = sr / 2
      const a = new Float32Array(n)
      for (let i = 0; i < n; i++) a[i] = 0.9 * Math.sin((2 * Math.PI * 220 * i) / sr)
      return a
    })()],
    ['a signal that steps from quiet to very loud', (() => {
      const n = sr / 2
      const a = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const amp = i < n / 2 ? 0.05 : 3.0
        a[i] = amp * Math.sin((2 * Math.PI * 110 * i) / sr)
      }
      return a
    })()],
    ['isolated single-sample spikes', (() => {
      const a = new Float32Array(sr / 4)
      for (let i = 0; i < a.length; i += 977) a[i] = i % 2 === 0 ? 5 : -5
      return a
    })()],
    ['a DC step', (() => {
      const a = new Float32Array(sr / 8)
      a.fill(2.5)
      return a
    })()],
  ]

  for (const [name, input] of cases) {
    it(`never exceeds the ceiling: ${name}`, () => {
      const k = new LimiterKernel({ ceiling: CEIL_DB, lookahead: 5, release: 60 })
      const out = run(k, input)
      // a hair of tolerance for float rounding only
      expect(peak(out), 'a sample escaped above the ceiling').toBeLessThanOrEqual(ceil + 1e-6)
      expect(out.every((v) => Number.isFinite(v))).toBe(true)
    })
  }

  it('holds the ceiling across every block size, including ragged ones', () => {
    // an off-by-one in the delay index or the deque shows up here and nowhere
    // else, because the window wraps mid-block
    const n = sr / 4
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = 2 * Math.sin((2 * Math.PI * 300 * i) / sr)
    for (const block of [1, 7, 64, 128, 333, 4096]) {
      const k = new LimiterKernel({ ceiling: CEIL_DB, lookahead: 3, release: 40 })
      expect(peak(run(k, input, block)), `block ${block}`).toBeLessThanOrEqual(ceil + 1e-6)
    }
  })

  it('holds it at 44.1k too', () => {
    const n = 22050
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = 2 * Math.sin((2 * Math.PI * 300 * i) / 44100)
    const k = new LimiterKernel({ ceiling: CEIL_DB, lookahead: 5, release: 60 })
    expect(peak(run(k, input, 128, 44100))).toBeLessThanOrEqual(ceil + 1e-6)
  })
})

describe('LimiterKernel: it limits rather than distorts', () => {
  it('leaves a signal under the ceiling completely alone (after the delay)', () => {
    /* The difference from a soft clipper, which bends everything near its
     * threshold. Below the ceiling this must be a pure delay. */
    const n = 4096
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr)
    const look = 5
    const k = new LimiterKernel({ ceiling: -1, lookahead: look, release: 60 })
    const out = run(k, input)
    const d = Math.round((look / 1000) * sr)
    for (let i = d + 100; i < n; i++) {
      expect(out[i]!, `sample ${i} was altered`).toBeCloseTo(input[i - d]!, 6)
    }
  })

  it('delays by the lookahead — that is the cost, and it is real', () => {
    const n = 8192
    const input = new Float32Array(n)
    input[1000] = 0.5 // a lone quiet impulse, well under the ceiling
    const look = 4
    const k = new LimiterKernel({ ceiling: -1, lookahead: look, release: 60 })
    const out = run(k, input)
    const d = Math.round((look / 1000) * sr)
    let at = -1
    for (let i = 0; i < n; i++) if (Math.abs(out[i]!) > 0.1) { at = i; break }
    expect(at, 'the impulse did not come out where the lookahead says').toBe(1000 + d)
  })

  it('turns the gain back up after the peak has passed', () => {
    const n = sr
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const amp = i < 2000 ? 3 : 0.2 // one loud burst, then quiet
      input[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sr)
    }
    const k = new LimiterKernel({ ceiling: -1, lookahead: 5, release: 30 })
    const out = run(k, input)
    // long after the burst the quiet part should be back at full level
    const tail = out.subarray(n - 4096)
    expect(peak(tail), 'the gain never recovered').toBeCloseTo(0.2, 2)
  })

  it('a longer release recovers more slowly', () => {
    const mk = (release: number): number => {
      const n = 12000
      const input = new Float32Array(n)
      for (let i = 0; i < n; i++) input[i] = (i < 500 ? 4 : 0.3) * Math.sin((2 * Math.PI * 220 * i) / sr)
      const out = run(new LimiterKernel({ ceiling: -1, lookahead: 3, release }), input)
      return peak(out.subarray(2000, 4000))
    }
    expect(mk(200), 'slow release should still be ducking').toBeLessThan(mk(10))
  })

  it('reset() clears the delay line rather than replaying old audio', () => {
    const k = new LimiterKernel({ ceiling: -1, lookahead: 5, release: 60 })
    const loud = new Float32Array(4096).fill(0.8)
    run(k, loud)
    k.reset()
    const out = run(k, new Float32Array(4096))
    expect(peak(out), 'stale audio came out after a reset').toBe(0)
  })
})


/* ------------------------------------------------------------------------- *
 * WHAT THE LOOK-AHEAD ACTUALLY BUYS.
 *
 * A mutation audit found that removing the window minimum, and removing the
 * instant attack, both left every test above green — because the FINAL CLAMP
 * guarantees the ceiling all by itself. The guarantee was never the thing the
 * lookahead was for.
 *
 * What it is for is WHERE the gain change happens. With lookahead the
 * reduction is already in place when the peak arrives, so the gain moves
 * during quiet audio; without it, the clamp yanks the gain down on the peak
 * sample itself, which is a discontinuity — distortion by another name, which
 * is exactly what a limiter exists to avoid.
 *
 * So the observable property is: audio BEFORE a loud burst comes out
 * attenuated. That is what "look-ahead" means, stated as a measurement.
 * ------------------------------------------------------------------------- */
describe('LimiterKernel: the reduction arrives BEFORE the peak', () => {
  const CEIL_DB = -1
  const LOOK = 5
  const BURST = 8192
  const QUIET = 0.5 // under the -1 dB ceiling (0.891), so unlimited on its own

  const signal = (): Float32Array => {
    const n = 24000
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const amp = i < BURST ? QUIET : 4
      a[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sr)
    }
    return a
  }

  it('ducks the quiet audio leading into a burst', () => {
    const k = new LimiterKernel({ ceiling: CEIL_DB, lookahead: LOOK, release: 60 })
    const out = run(k, signal())
    const d = Math.round((LOOK / 1000) * sr)
    // the last part of the quiet section, as it appears in the output
    const lead = out.subarray(BURST + 4, BURST + d - 4)
    expect(peak(lead), 'the quiet lead-in was NOT ducked — no lookahead')
      .toBeLessThan(QUIET * 0.9)
  })

  it('and leaves quiet audio far from any burst untouched', () => {
    // the same signal, well before the window: this is the control, and it is
    // what stops the test above from passing on a limiter that just ducks
    // everything
    const k = new LimiterKernel({ ceiling: CEIL_DB, lookahead: LOOK, release: 60 })
    const out = run(k, signal())
    const early = out.subarray(2000, 5000)
    expect(peak(early)).toBeCloseTo(QUIET, 3)
  })

  it('a loud sine stays a SINE — it is limited, not clipped', () => {
    /* The distortion test. Yanking the gain down on each peak (no lookahead,
     * no instant attack) folds harmonics into a pure tone; holding a steady
     * reduction does not. Measured as energy at the third harmonic. */
    const n = sr / 2
    const f = 220
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = 3 * Math.sin((2 * Math.PI * f * i) / sr)
    const out = run(new LimiterKernel({ ceiling: CEIL_DB, lookahead: LOOK, release: 60 }), input)
    const tail = out.subarray(n - 16384)
    const fund = goertzel(tail, f, sr)
    const third = goertzel(tail, f * 3, sr)
    expect(third / fund, 'third-harmonic energy says it is clipping').toBeLessThan(0.02)
  })

  it('stays clean at a FAST release, which is what the window minimum is for', () => {
    /* The previous test used a 60 ms release, and at that setting the slow
     * recovery hides the difference: a limiter tracking only the single sample
     * `lookahead` ahead measures 0.008% third harmonic, against 0.000% with
     * the window. That is why the "no window minimum" mutation survived it.
     *
     * Turn the release down and the two separate completely — because without
     * the window the gain follows the sine's own envelope, which is amplitude
     * modulation, which is distortion:
     *
     *     release   1 ms   →  2.0%   without the window,  0.000% with it
     *     release   5 ms   →  0.31%
     *     release  60 ms   →  0.008%
     *
     * Taking the MINIMUM required gain across the whole look-ahead window
     * makes the gain constant over a steady tone whatever the release, which
     * is the property that lets the release be a musical choice rather than a
     * distortion control. */
    const n = sr / 2
    const f = 220
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = 3 * Math.sin((2 * Math.PI * f * i) / sr)
    const out = run(new LimiterKernel({ ceiling: -1, lookahead: 5, release: 1 }), input)
    const tail = out.subarray(n - 16384)
    const thd3 = goertzel(tail, f * 3, sr) / goertzel(tail, f, sr)
    expect(thd3, 'the gain is following the envelope instead of the window').toBeLessThan(0.002)
  })
})
