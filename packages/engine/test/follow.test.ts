import { describe, expect, it } from 'vitest'
import { FollowKernel, detect } from '../src/dsp/follow'
import { synth, renderOffline } from '../src/index'
import { goertzel } from './util/goertzel'

/* An envelope follower turns audio into a control signal. The properties that
 * make one useful, and that a naive implementation gets wrong:
 *
 *   it TRACKS LEVEL, not the waveform — a steady tone must give a steady
 *     output, not a copy of the tone at half amplitude
 *   ATTACK AND RELEASE ARE INDEPENDENT — the asymmetry is the entire craft;
 *     equal times give a tremolo of the source's own cycle
 *   rms READS POWER, peak reads crest, and the difference is measurable
 *     (3 dB on a sine) rather than a matter of taste
 */

const sr = 48000

function run(k: FollowKernel, input: Float32Array, block = 128, rate = sr): Float32Array {
  const out = new Float32Array(input.length)
  for (let d = 0; d < input.length; d += block) {
    const len = Math.min(block, input.length - d)
    k.process(len, { in: input.subarray(d, d + len) }, out.subarray(d, d + len), { sampleRate: rate })
  }
  return out
}

const sine = (n: number, hz: number, amp: number, rate = sr): Float32Array => {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
  return a
}

/** Mean of the settled tail — what "the level it reports" means. */
const tailMean = (a: Float32Array, frac = 0.5): number => {
  const from = Math.floor(a.length * frac)
  let s = 0
  for (let i = from; i < a.length; i++) s += a[i]!
  return s / (a.length - from)
}

const tailRipple = (a: Float32Array, frac = 0.5): number => {
  const from = Math.floor(a.length * frac)
  let lo = Infinity, hi = -Infinity
  for (let i = from; i < a.length; i++) { lo = Math.min(lo, a[i]!); hi = Math.max(hi, a[i]!) }
  return hi - lo
}

describe('detect (the instantaneous value the smoother chases)', () => {
  it('peak is magnitude, rms is the square', () => {
    expect(detect(-0.5, 'peak')).toBe(0.5)
    expect(detect(-0.5, 'rms')).toBe(0.25)
  })

  it('is never negative and never non-finite', () => {
    for (const v of [-3, 0, 3, NaN, Infinity, -Infinity]) {
      for (const m of ['peak', 'rms'] as const) {
        const d = detect(v, m)
        expect(Number.isFinite(d), `${v} ${m}`).toBe(true)
        expect(d).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('FollowKernel tracks LEVEL', () => {
  it('a steady sine gives a steady output near its amplitude (peak)', () => {
    const k = new FollowKernel({ attack: 1, release: 50, mode: 'peak' })
    const out = run(k, sine(sr / 2, 200, 0.5))
    expect(tailMean(out)).toBeGreaterThan(0.35)
    expect(tailMean(out)).toBeLessThanOrEqual(0.5 + 1e-6)
  })

  it('rms reads about 3 dB below peak on a sine — 0.707 of it', () => {
    /* The measurable difference between the two modes. A sine of amplitude A
     * has rms A/sqrt2; a follower that ignored `mode` would fail this. */
    const input = sine(sr / 2, 200, 0.8)
    const rms = tailMean(run(new FollowKernel({ attack: 1, release: 200, mode: 'rms' }), input))
    expect(rms).toBeCloseTo(0.8 / Math.SQRT2, 2)
  })

  it('scales with the input: twice as loud reads twice as high', () => {
    const cfg = { attack: 1, release: 200, mode: 'rms' } as const
    const quiet = tailMean(run(new FollowKernel(cfg), sine(sr / 2, 200, 0.25)))
    const loud = tailMean(run(new FollowKernel(cfg), sine(sr / 2, 200, 0.5)))
    expect(loud / quiet).toBeCloseTo(2, 1)
  })

  it('and it is a LEVEL, not a copy of the waveform', () => {
    /* The failure a missing smoother gives you: out = |in|, which ripples
     * across every half cycle. With a slow release the tail must be flat. */
    const out = run(new FollowKernel({ attack: 1, release: 300, mode: 'rms' }), sine(sr / 2, 200, 0.5))
    expect(tailRipple(out), 'the output is following the waveform, not the level')
      .toBeLessThan(0.02)
  })
})

describe('FollowKernel: attack and release are independent', () => {
  /** A burst of tone then silence, so both edges can be measured. */
  const burst = (): Float32Array => {
    const a = new Float32Array(sr / 2)
    const on = sine(sr / 4, 300, 0.8)
    a.set(on, 0)
    return a
  }

  it('a faster attack reaches the level sooner', () => {
    const at = (attack: number): number => {
      const out = run(new FollowKernel({ attack, release: 100 }), burst())
      return out.subarray(0, Math.round(sr * 0.01)).reduce((m, v) => Math.max(m, v), 0)
    }
    expect(at(1), 'the fast attack did not arrive first').toBeGreaterThan(at(200))
  })

  it('a slower release holds the level longer after the sound stops', () => {
    const after = (release: number): number => {
      const out = run(new FollowKernel({ attack: 1, release }), burst())
      return out[Math.round(sr * 0.3)]! // 50 ms after the burst ended
    }
    expect(after(500), 'the slow release decayed as fast as the quick one')
      .toBeGreaterThan(after(10) * 5)
  })

  it('it does fall back to zero once the sound is gone', () => {
    const out = run(new FollowKernel({ attack: 1, release: 20 }), burst())
    expect(out[out.length - 1]!).toBeLessThan(0.01)
  })

  it('a fast attack with a slow release does not chatter between transients', () => {
    /* Equal attack and release is the classic way to make a follower useless:
     * it tracks each half-cycle instead of the envelope. The asymmetric one
     * must be visibly steadier on the SAME signal. */
    const input = sine(sr / 2, 120, 0.6) // low tone: long half-cycles, worst case
    const symmetric = tailRipple(run(new FollowKernel({ attack: 1, release: 1, mode: 'peak' }), input))
    const asymmetric = tailRipple(run(new FollowKernel({ attack: 1, release: 300, mode: 'peak' }), input))
    expect(asymmetric).toBeLessThan(symmetric * 0.2)
  })
})

describe('FollowKernel robustness', () => {
  it('never emits a non-finite or negative sample, even fed NaN', () => {
    const k = new FollowKernel({})
    const out = new Float32Array(256)
    k.process(128, { in: new Float32Array(128).fill(NaN) }, out.subarray(0, 128), { sampleRate: sr })
    k.process(128, { in: sine(128, 300, 0.5) }, out.subarray(128), { sampleRate: sr })
    expect(out.every((v) => Number.isFinite(v) && v >= 0)).toBe(true)
  })

  it('gives the same answer across block sizes, including ragged ones', () => {
    const input = sine(sr / 4, 300, 0.7)
    const ref = tailMean(run(new FollowKernel({ attack: 2, release: 80 }), input, 128))
    for (const block of [1, 7, 333, 4096]) {
      expect(tailMean(run(new FollowKernel({ attack: 2, release: 80 }), input, block)), `block ${block}`)
        .toBeCloseTo(ref, 5)
    }
  })

  it('works at 44.1k as well as 48k', () => {
    for (const rate of [44100, 48000]) {
      const out = run(new FollowKernel({ attack: 1, release: 200, mode: 'rms' }), sine(rate / 2, 200, 0.6, rate), 128, rate)
      expect(tailMean(out), `${rate}`).toBeCloseTo(0.6 / Math.SQRT2, 1)
    }
  })

  it('reset() clears the envelope rather than carrying it into the next voice', () => {
    const k = new FollowKernel({ attack: 1, release: 2000 })
    run(k, sine(sr / 4, 300, 0.9))
    k.reset()
    const out = run(k, new Float32Array(256))
    expect(out[0]!).toBe(0)
  })
})

/* ------------------------------------------------------------------------- *
 * THE POINT OF THE NODE, end to end: audio controlling a parameter.
 *
 * This is what the engine could not do before. `sidechain` reacts to note
 * onsets; nothing reacted to LEVEL. Here the microphone's own loudness opens
 * a filter, and the test asserts the thing you would listen for — more high
 * end when the input is loud, measured with a Goertzel rather than by ear.
 * ------------------------------------------------------------------------- */
describe('follow drives a parameter from audio', () => {
  const dur = 0.4

  /** Render a saw through a ladder whose cutoff is driven by the mic level. */
  const through = (micAmp: number): Float32Array => {
    const mic = sine(Math.round(sr * dur), 200, micAmp)
    const s = synth(({ note, gate, adsr, saw, ladder, follow, mic: micIn }) =>
      ladder(saw(note.freq), follow(micIn(), { attack: 5, release: 80, mode: 'rms' }).range(300, 6000), { res: 0.2 })
        .mul(adsr(gate, { a: 0.001, d: 0.05, s: 1, r: 0.05 })))
    return renderOffline(
      s,
      [{ time: 0, type: 'noteOn', note: 45 }, { time: dur - 0.01, type: 'noteOff', note: 45 }],
      dur,
      { mic },
    ).left
  }

  it('a LOUD input opens the filter and a quiet one does not', () => {
    const quiet = through(0.02)
    const loud = through(0.9)
    const win = (a: Float32Array): Float32Array => a.subarray(Math.round(sr * 0.2), Math.round(sr * 0.38))
    // energy well above the closed cutoff: present only when the filter opened
    const hiQuiet = goertzel(win(quiet), 3000, sr)
    const hiLoud = goertzel(win(loud), 3000, sr)
    expect(hiLoud, 'the mic level did not open the filter').toBeGreaterThan(hiQuiet * 4)
  })

  it('and the voice is audible either way — this is a filter, not a gate', () => {
    for (const [name, buf] of [['quiet', through(0.02)], ['loud', through(0.9)]] as const) {
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v))
      expect(peak, `${name} produced no sound`).toBeGreaterThan(0.01)
    }
  })
})
