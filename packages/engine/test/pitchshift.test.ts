import { describe, expect, it } from 'vitest'
import { PitchShiftKernel, ratioFor } from '../src/dsp/pitchshift'
import { synth, renderOffline } from '../src/index'
import { goertzel } from './util/goertzel'

/* A pitch shifter moves a signal in semitones and leaves its LENGTH alone.
 * That is the whole contract, and it is what separates it from the two things
 * the engine could already do — `sample speed:` moves both together, and
 * `granular` is a texture generator rather than something you can put a
 * microphone through.
 *
 * So the tests ask the only question that matters: after shifting by N, where
 * is the energy? Measured with a Goertzel at the frequencies a musician would
 * name, never by eyeballing a buffer.
 *
 * Magnitudes are only ever compared WITHIN one rendered signal. Goertzel is
 * not normalised the same way across signals of different harmonic content,
 * so "440 beats 220 in this buffer" is meaningful and "this buffer's 440 beats
 * that buffer's 220" is not.
 */

const sr = 48000

/** `mix` is a per-sample SIGNAL input now, so the harness supplies one. */
function run(k: PitchShiftKernel, input: Float32Array, block = 128, rate = sr, mix = 1): Float32Array {
  const out = new Float32Array(input.length)
  for (let d = 0; d < input.length; d += block) {
    const len = Math.min(block, input.length - d)
    k.process(
      len,
      { in: input.subarray(d, d + len), mix: new Float32Array(len).fill(mix) },
      out.subarray(d, d + len),
      { sampleRate: rate },
    )
  }
  return out
}

const sine = (n: number, hz: number, amp = 0.7, rate = sr): Float32Array => {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
  return a
}

const peak = (a: Float32Array): number => {
  let p = 0
  for (const v of a) p = Math.max(p, Math.abs(v))
  return p
}

const rms = (a: Float32Array): number => {
  let s = 0
  for (const v of a) s += v * v
  return Math.sqrt(s / a.length)
}

describe('ratioFor', () => {
  it('an octave up is twice the rate, an octave down is half', () => {
    expect(ratioFor(12)).toBeCloseTo(2, 12)
    expect(ratioFor(-12)).toBeCloseTo(0.5, 12)
  })

  it('is exactly 1 at zero — the value the bypass depends on', () => {
    expect(ratioFor(0)).toBe(1)
  })

  it('a fifth is the 3:2 a musician expects, near enough for equal temperament', () => {
    expect(ratioFor(7)).toBeCloseTo(1.498, 3)
  })
})

describe('PitchShiftKernel moves the pitch', () => {
  /** The dominant of a set of candidate frequencies in the settled tail. */
  const dominant = (out: Float32Array, hzs: number[]): number => {
    const tail = out.subarray(out.length - 16384)
    let best = hzs[0]!, bestMag = -1
    for (const hz of hzs) {
      const m = goertzel(tail, hz, sr)
      if (m > bestMag) { bestMag = m; best = hz }
    }
    return best
  }

  const CANDIDATES = [110, 165, 220, 330, 440]

  it('+12 semitones puts a 220 Hz tone at 440', () => {
    const out = run(new PitchShiftKernel({ semitones: 12 }), sine(sr, 220))
    expect(dominant(out, CANDIDATES)).toBe(440)
  })

  it('-12 semitones puts it at 110', () => {
    const out = run(new PitchShiftKernel({ semitones: -12 }), sine(sr, 220))
    expect(dominant(out, CANDIDATES)).toBe(110)
  })

  it('+7 semitones is a fifth: 220 lands on 330', () => {
    const out = run(new PitchShiftKernel({ semitones: 7 }), sine(sr, 220))
    expect(dominant(out, CANDIDATES)).toBe(330)
  })

  it('-5 semitones is a fourth down: 220 lands on 165', () => {
    const out = run(new PitchShiftKernel({ semitones: -5 }), sine(sr, 220))
    expect(dominant(out, CANDIDATES)).toBe(165)
  })

  it('and the ORIGINAL pitch is gone, not merely joined', () => {
    // a shifter that only ADDED a harmonic would pass every test above
    const out = run(new PitchShiftKernel({ semitones: 12 }), sine(sr, 220))
    const tail = out.subarray(out.length - 16384)
    expect(goertzel(tail, 440, sr), 'the original 220 survived the shift')
      .toBeGreaterThan(goertzel(tail, 220, sr) * 8)
  })
})

describe('PitchShiftKernel: zero is BIT-EXACT', () => {
  it('0 semitones returns the input untouched', () => {
    /* Two fixed taps at different delays sum to a COMB FILTER. A node that
     * colours the signal when asked to do nothing is a trap, so this is an
     * identity rather than an approximation. */
    const input = sine(4096, 300)
    const out = run(new PitchShiftKernel({ semitones: 0 }), input)
    for (let i = 0; i < input.length; i++) expect(out[i]!).toBe(input[i]!)
  })

  it('mix 0 is the dry signal, whatever the shift', () => {
    const input = sine(4096, 300)
    const out = run(new PitchShiftKernel({ semitones: 7 }), input, 128, sr, 0)
    for (let i = 0; i < input.length; i++) expect(out[i]!).toBeCloseTo(input[i]!, 12)
  })
})

describe('PitchShiftKernel: the crossfade holds the level', () => {
  it('a steady tone comes out at a steady level, not pulsing once per window', () => {
    /* The bound is MEASURED, not aspirational. The two taps are the same
     * signal at two delays, so they are coherent and they interfere; a
     * continuous sin/cos fade keeps both live at all times and this case
     * pulsed 10.8:1. The flat-top fade takes it to 1.8:1 here, with a
     * worst case of 2.1:1 across the whole tone/window/shift grid.
     *
     * So 2.5 is the honest ceiling. A test asserting near-flatness would be
     * asserting something this method cannot do, and would have to be
     * loosened by whoever next touched the crossfade. */
    const out = run(new PitchShiftKernel({ semitones: 5, window: 50 }), sine(sr, 300))
    const tail = out.subarray(out.length - 24000)
    // compare the level of successive 10 ms slices: a window-rate pulse shows
    // up here and nowhere else
    const slices: number[] = []
    for (let d = 0; d + 480 <= tail.length; d += 480) slices.push(rms(tail.subarray(d, d + 480)))
    const lo = Math.min(...slices), hi = Math.max(...slices)
    expect(hi / lo, 'the output pulses at the window rate').toBeLessThan(2.5)
  })

  it('the wrap is never a CLICK — the splice stays hidden', () => {
    /* This is the property the second read head exists for, and the only one
     * that catches its absence. A mutation audit made the point: dropping to
     * a single tap LOWERS the ripple (1.2 against 1.9, because there is
     * nothing left to interfere) while making the wrap a bare splice. Level
     * flatness can never see that. The step between adjacent samples can:
     *
     *     correct           0.11
     *     one read head     1.38
     *     continuous fade   1.40
     *
     * against an input whose own largest step is 0.027. So 0.3 sits an order
     * of magnitude below either failure and comfortably above the truth. */
    let worst = 0
    for (const hz of [110, 220, 300, 440]) {
      for (const window of [20, 50]) {
        for (const semitones of [-5, 5, 12]) {
          const out = run(new PitchShiftKernel({ semitones, window }), sine(sr, hz))
          for (let i = out.length - 24000; i < out.length; i++) {
            worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!))
          }
        }
      }
    }
    expect(worst, 'a discontinuity got through — that is an audible click').toBeLessThan(0.3)
  })

  it('keeps roughly the input level rather than halving or doubling it', () => {
    const input = sine(sr, 300)
    const out = run(new PitchShiftKernel({ semitones: 12 }), input)
    const got = rms(out.subarray(out.length - 16384))
    expect(got).toBeGreaterThan(rms(input) * 0.6)
    expect(got).toBeLessThan(rms(input) * 1.4)
  })

  it('never exceeds the input peak by much — no wrap-point spike', () => {
    const input = sine(sr, 300)
    const out = run(new PitchShiftKernel({ semitones: -7 }), input)
    expect(peak(out)).toBeLessThan(peak(input) * 1.5)
  })
})

describe('PitchShiftKernel robustness', () => {
  it('never emits a non-finite sample, even fed NaN', () => {
    const k = new PitchShiftKernel({ semitones: 4 })
    const out = new Float32Array(256)
    k.process(128, { in: new Float32Array(128).fill(NaN) }, out.subarray(0, 128), { sampleRate: sr })
    k.process(128, { in: sine(128, 300) }, out.subarray(128), { sampleRate: sr })
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('gives the same answer across block sizes, including ragged ones', () => {
    const input = sine(sr / 2, 300)
    const ref = run(new PitchShiftKernel({ semitones: 12 }), input, 128)
    for (const block of [1, 7, 333, 4096]) {
      const got = run(new PitchShiftKernel({ semitones: 12 }), input, block)
      for (let i = 0; i < input.length; i += 97) {
        expect(got[i]!, `block ${block} sample ${i}`).toBeCloseTo(ref[i]!, 5)
      }
    }
  })

  it('works at 44.1k as well as 48k', () => {
    for (const rate of [44100, 48000]) {
      const out = run(new PitchShiftKernel({ semitones: 12 }), sine(rate, 220, 0.7, rate), 128, rate)
      const tail = out.subarray(out.length - 16384)
      expect(goertzel(tail, 440, rate), `${rate}`).toBeGreaterThan(goertzel(tail, 220, rate) * 4)
    }
  })

  it('clamps an absurd shift instead of producing nonsense', () => {
    const out = run(new PitchShiftKernel({ semitones: 999 }), sine(sr / 4, 300))
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('reset() clears the line rather than replaying old audio', () => {
    const k = new PitchShiftKernel({ semitones: 5 })
    run(k, sine(sr / 4, 300, 0.9))
    k.reset()
    const out = run(k, new Float32Array(4096))
    expect(peak(out), 'stale audio came out after a reset').toBe(0)
  })
})

/* ------------------------------------------------------------------------- *
 * THE HARMONISER, end to end: the original and the shifted copy together.
 * ------------------------------------------------------------------------- */
describe('a harmony a third above, in a voice', () => {
  it('both the sung note and the harmony are present', () => {
    const dur = 0.5
    const s = synth(({ note, gate, adsr, sine: osc, pitchshift }) => {
      const voice = osc(note.freq).mul(adsr(gate, { a: 0.005, d: 0.05, s: 1, r: 0.05 }))
      // +4 semitones, mixed half and half: a major third over the original
      return pitchshift(voice, { semitones: 4, window: 40, mix: 0.5 }).mul(0.5)
    })
    const out = renderOffline(
      s,
      [{ time: 0, type: 'noteOn', note: 57 }, { time: dur - 0.01, type: 'noteOff', note: 57 }],
      dur,
    ).left
    // note 57 is A3 = 220 Hz; four semitones up is C#4 = 277.18
    const tail = out.subarray(Math.round(sr * 0.3), Math.round(sr * 0.48))
    const root = goertzel(tail, 220, sr)
    const third = goertzel(tail, 277.18, sr)
    const absent = goertzel(tail, 180, sr)
    expect(root, 'the original note is gone').toBeGreaterThan(absent * 4)
    expect(third, 'no harmony was added').toBeGreaterThan(absent * 4)
  })
})

describe('the shift is a SIGNAL, not construction config', () => {
  /* It used to be config only. A knob or a per-note `.ctrl` reached the node
   * as a signal, failed the config mapper's `typeof === 'number'` test, and
   * vanished -- the node then saw 0 and took the bypass, so a harmoniser whose
   * interval was meant to move returned the dry signal and said nothing.
   *
   * Measured through the whole stack on a 220 Hz saw: a per-note `0 4 7 12`
   * gave 221 Hz on every step before, and 221 / 276 / 329 / 441 after. */
  const SR = 44100
  const run = (semis: Float32Array | number, samples: number): Float32Array => {
    const k = new PitchShiftKernel(typeof semis === 'number' ? { semitones: semis, window: 40 } : { window: 40 })
    const input = new Float32Array(samples)
    for (let i = 0; i < samples; i++) input[i] = Math.sin((2 * Math.PI * 220 * i) / SR)
    const out = new Float32Array(samples)
    const inputs: Record<string, Float32Array> = { in: input }
    if (typeof semis !== 'number') inputs['semitones'] = semis
    k.process(samples, inputs, out, { sampleRate: SR } as never)
    return out
  }
  const constant = (v: number, n: number): Float32Array => new Float32Array(n).fill(v)

  it('a constant-zero SIGNAL is still bit-exact passthrough', () => {
    /* The documented guarantee, and it cannot be emergent: at 0 the read heads
     * sit at two fixed delays and sum to something that is not the input. */
    const n = 2048
    const out = run(constant(0, n), n)
    const dry = run(0, n)
    for (let i = 0; i < n; i++) expect(out[i]).toBe(dry[i])
  })

  it('a signal shifts as far as the same literal would', () => {
    const n = 8192
    const bySig = run(constant(7, n), n)
    const byCfg = run(7, n)
    let maxd = 0
    for (let i = 0; i < n; i++) maxd = Math.max(maxd, Math.abs(bySig[i]! - byCfg[i]!))
    expect(maxd, 'the two routes must agree').toBeLessThan(1e-6)
  })

  it('follows the signal when it CHANGES mid-render', () => {
    // the thing that was impossible: an interval that moves
    const n = 16384
    const semis = new Float32Array(n)
    for (let i = 0; i < n; i++) semis[i] = i < n / 2 ? 0 : 12
    const out = run(semis, n)
    const flat = run(constant(0, n), n)
    let firstHalf = 0
    let secondHalf = 0
    for (let i = 0; i < n / 2; i++) firstHalf = Math.max(firstHalf, Math.abs(out[i]! - flat[i]!))
    for (let i = n / 2; i < n; i++) secondHalf = Math.max(secondHalf, Math.abs(out[i]! - flat[i]!))
    expect(firstHalf, 'unchanged while the signal reads 0').toBeLessThan(1e-6)
    expect(secondHalf, 'and shifted once it does not').toBeGreaterThan(0.1)
  })

  it('half a block of shift is still a shift', () => {
    // the zero check has to cover the WHOLE block, or a shift that starts
    // mid-block is silently dropped for that block
    const n = 512
    const semis = new Float32Array(n)
    for (let i = n / 2; i < n; i++) semis[i] = 7
    const out = run(semis, n)
    const dry = run(constant(0, n), n)
    let d = 0
    for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(out[i]! - dry[i]!))
    expect(d).toBeGreaterThan(0)
  })

  it('clamps a signal the way it clamps config', () => {
    const n = 4096
    const wild = run(constant(96, n), n)
    const capped = run(constant(24, n), n)
    let maxd = 0
    for (let i = 0; i < n; i++) maxd = Math.max(maxd, Math.abs(wild[i]! - capped[i]!))
    expect(maxd, 'past two octaves is clamped, not followed').toBeLessThan(1e-6)
  })

  it('survives a non-finite value in the signal', () => {
    const n = 1024
    const semis = constant(7, n)
    semis[10] = Number.NaN
    semis[20] = Number.POSITIVE_INFINITY
    for (const v of run(semis, n)) expect(Number.isFinite(v)).toBe(true)
  })
})
