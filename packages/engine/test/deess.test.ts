import { describe, expect, it } from 'vitest'
import { DeessKernel, deessGain } from '../src/dsp/deess'
import { goertzel } from './util/goertzel'

/* A de-esser is a compressor that only hears the sibilance. The failure it
 * exists to avoid is the broadband one: duck enough to tame the "s" and the
 * whole word ducks with it, which is the pumping everyone recognises as a
 * badly de-essed vocal. So the load-bearing property is SELECTIVITY — a loud
 * low tone must come through untouched, and a loud high one must not. */

const sr = 48000
const dbToLin = (db: number): number => Math.pow(10, db / 20)

/** Peak amplitude of `seconds` of a sine at `hz`, after the kernel. */
function runTone(k: DeessKernel, hz: number, amp: number, seconds: number, sr2 = sr): number {
  const n = Math.round(seconds * sr2)
  const BLOCK = 128
  let peakLate = 0
  const settleAfter = Math.floor(n * 0.6) // ignore the attack transient
  for (let done = 0; done < n; done += BLOCK) {
    const len = Math.min(BLOCK, n - done)
    const input = new Float32Array(len)
    for (let i = 0; i < len; i++) input[i] = amp * Math.sin((2 * Math.PI * hz * (done + i)) / sr2)
    const out = new Float32Array(len)
    k.process(len, { in: input }, out, { sampleRate: sr2 })
    if (done >= settleAfter) for (let i = 0; i < len; i++) peakLate = Math.max(peakLate, Math.abs(out[i]!))
  }
  return peakLate
}

describe('deessGain (the static curve)', () => {
  it('leaves anything below the threshold alone', () => {
    expect(deessGain(-40, -30, 4)).toBe(1)
    expect(deessGain(-30, -30, 4)).toBe(1)
  })

  it('ducks above it, by (1 - 1/ratio) of the overshoot', () => {
    // 12 dB over at 4:1 keeps 3, so it pulls down 9
    expect(20 * Math.log10(deessGain(-18, -30, 4))).toBeCloseTo(-9, 5)
  })

  it('ratio 1 never ducks, whatever the level', () => {
    for (const db of [-40, -10, 0]) expect(deessGain(db, -30, 1)).toBeCloseTo(1)
  })

  it('is monotonic — louder in never means louder out', () => {
    let prev = Infinity
    for (let db = -60; db <= 0; db += 1) {
      const g = deessGain(db, -30, 6)
      expect(g).toBeLessThanOrEqual(prev + 1e-12)
      prev = g
    }
  })
})

describe('DeessKernel selectivity', () => {
  const cfg = { freq: 6000, threshold: -30, ratio: 6, attack: 0.5, release: 20 }

  it('passes a loud LOW tone untouched — the vowel must not duck', () => {
    // this is the whole reason a de-esser is not just a compressor
    const k = new DeessKernel(cfg)
    const amp = dbToLin(-6)
    expect(runTone(k, 300, amp, 0.3)).toBeCloseTo(amp, 1)
  })

  it('ducks a loud HIGH tone', () => {
    const k = new DeessKernel(cfg)
    const amp = dbToLin(-6)
    const out = runTone(k, 9000, amp, 0.3)
    expect(out, 'sibilance came through unducked').toBeLessThan(amp * 0.6)
  })

  it('leaves a QUIET high tone alone — it only acts above the threshold', () => {
    const k = new DeessKernel(cfg)
    const amp = dbToLin(-50)
    expect(runTone(k, 9000, amp, 0.3)).toBeCloseTo(amp, 3)
  })

  it('a loud vowel does not duck the sibilance band with it', () => {
    /* The broadband failure, stated as a measurement: run a loud LOW tone,
     * then immediately a quiet HIGH one. If the detector were full-band, the
     * low tone would have pinned the gain down and the high tone would come
     * out attenuated. */
    const k = new DeessKernel(cfg)
    runTone(k, 200, dbToLin(-3), 0.2) // a loud vowel
    const amp = dbToLin(-45)
    expect(runTone(k, 9000, amp, 0.05)).toBeCloseTo(amp, 3)
  })

  it('more ratio ducks harder', () => {
    const amp = dbToLin(-6)
    const gentle = runTone(new DeessKernel({ ...cfg, ratio: 2 }), 9000, amp, 0.3)
    const hard = runTone(new DeessKernel({ ...cfg, ratio: 12 }), 9000, amp, 0.3)
    expect(hard).toBeLessThan(gentle)
  })

  it('the split frequency decides what counts as sibilance', () => {
    const amp = dbToLin(-6)
    // 4 kHz is ABOVE a 3 kHz split and BELOW a 9 kHz one
    const lowSplit = runTone(new DeessKernel({ ...cfg, freq: 3000 }), 4000, amp, 0.3)
    const highSplit = runTone(new DeessKernel({ ...cfg, freq: 9000 }), 4000, amp, 0.3)
    expect(lowSplit, 'inside the ducked band').toBeLessThan(highSplit * 0.9)
  })

  it('the two bands sum back to the input when nothing is ducking', () => {
    // low + high === input by construction (high is input - low), so a
    // below-threshold signal must be passed through bit-for-bit in level
    const k = new DeessKernel({ ...cfg, threshold: 0 })
    const amp = dbToLin(-20)
    for (const hz of [200, 2000, 9000]) {
      expect(runTone(k, hz, amp, 0.2), `${hz} Hz`).toBeCloseTo(amp, 2)
    }
  })

  it('never emits a non-finite sample, even fed NaN', () => {
    const k = new DeessKernel({})
    const out = new Float32Array(128)
    k.process(128, { in: new Float32Array(128).fill(NaN) }, out, { sampleRate: sr })
    k.process(128, { in: new Float32Array(128).fill(0.4) }, out, { sampleRate: sr })
    expect(out.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('works at 44.1k as well as 48k', () => {
    for (const rate of [44100, 48000]) {
      const k = new DeessKernel(cfg)
      const amp = dbToLin(-6)
      expect(runTone(k, 300, amp, 0.3, rate), `${rate} low passes`).toBeCloseTo(amp, 1)
    }
  })
})

/* ------------------------------------------------------------------------- *
 * SELECTIVITY, MEASURED PER BAND.
 *
 * The tests above feed ONE frequency at a time, and a mutation audit showed
 * that is not enough to pin the two properties that matter. Ducking the low
 * band as well ("(low + high) * g") survived, because a lone 300 Hz tone
 * never triggers the detector, so g stays 1 and nothing is ducked either way.
 * Feeding the detector the FULL signal survived too, because a lone loud low
 * tone had released by the time the next tone was measured.
 *
 * A voice does not arrive one frequency at a time. These feed a loud vowel
 * and a sibilant TOGETHER and measure each component with a Goertzel, which
 * is the only way to say "that one went down and this one did not".
 * ------------------------------------------------------------------------- */
describe('DeessKernel with a vowel and a sibilant at once', () => {
  const cfg = { freq: 6000, threshold: -30, ratio: 8, attack: 0.5, release: 20 }
  const LOW = 300
  const HIGH = 9000

  /** Sum of a low and a high sine, run through the kernel; returns the
   *  magnitude of each component in the settled tail. */
  function bands(k: DeessKernel, lowAmp: number, highAmp: number, seconds = 0.3): { low: number; high: number } {
    const n = Math.round(seconds * sr)
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      input[i] = lowAmp * Math.sin((2 * Math.PI * LOW * i) / sr) + highAmp * Math.sin((2 * Math.PI * HIGH * i) / sr)
    }
    const out = new Float32Array(n)
    const BLOCK = 128
    for (let d = 0; d < n; d += BLOCK) {
      const len = Math.min(BLOCK, n - d)
      k.process(len, { in: input.subarray(d, d + len) }, out.subarray(d, d + len), { sampleRate: sr })
    }
    // measure the settled tail only, past the attack
    const tail = out.subarray(Math.floor(n * 0.6))
    return { low: goertzel(tail, LOW, sr), high: goertzel(tail, HIGH, sr) }
  }

  it('ducks the sibilant and leaves the vowel STANDING, in the same signal', () => {
    // the property a broadband compressor cannot have
    const loud = dbToLin(-6)
    const dry = bands(new DeessKernel({ ...cfg, ratio: 1 }), loud, loud)
    const wet = bands(new DeessKernel(cfg), loud, loud)
    expect(wet.high, 'the sibilant was not ducked').toBeLessThan(dry.high * 0.5)
    expect(wet.low, 'the VOWEL was ducked — this is the pumping failure')
      .toBeGreaterThan(dry.low * 0.9)
  })

  it('a loud vowel does not pull down a quiet sibilant sharing the signal', () => {
    // with a full-band detector the vowel would dominate the detector and
    // duck a high band that was never loud
    const dry = bands(new DeessKernel({ ...cfg, ratio: 1 }), dbToLin(-3), dbToLin(-50))
    const wet = bands(new DeessKernel(cfg), dbToLin(-3), dbToLin(-50))
    expect(wet.high, 'the quiet high band was ducked by the loud vowel')
      .toBeGreaterThan(dry.high * 0.8)
  })
})
