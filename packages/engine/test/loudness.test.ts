import { describe, expect, it } from 'vitest'
import {
  formatDbTp,
  formatLufs,
  integratedLufs,
  kWeightingFilters,
  LOUDNESS_TARGETS,
  measureLoudness,
  samplePeakDb,
  truePeakDb,
} from '../src/loudness'

/* ------------------------------------------------------------------------- *
 * BS.1770-4 against signals whose answer is known independently. A loudness
 * meter that is quietly 3 LU off still returns a plausible-looking number,
 * so every expectation here is a value the standard (or arithmetic) fixes,
 * not a snapshot of what the code happened to print.
 * ------------------------------------------------------------------------- */

const SR = 48000

/** `seconds` of a sine at `freq`, peak amplitude `amp`, phase offset in radians. */
const sine = (freq: number, amp: number, seconds: number, sampleRate = SR, phase = 0): Float32Array => {
  const n = Math.round(seconds * sampleRate)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase)
  return x
}

describe('K-weighting filters', () => {
  it('reproduces the coefficients BS.1770-4 tabulates at 48 kHz', () => {
    const [shelf, hp] = kWeightingFilters(48000)
    // Table 1 (stage 1, high shelf) and Table 2 (stage 2, RLB high-pass).
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10)
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10)
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 10)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10)
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 10)
    expect([hp.b0, hp.b1, hp.b2]).toEqual([1, -2, 1])
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 10)
    expect(hp.a2).toBeCloseTo(0.99007225036621, 10)
  })

  it('designs a different (finite) filter at other rates', () => {
    for (const rate of [44100, 96000]) {
      const [shelf, hp] = kWeightingFilters(rate)
      for (const v of [shelf.b0, shelf.b1, shelf.b2, shelf.a1, shelf.a2, hp.a1, hp.a2]) {
        expect(Number.isFinite(v)).toBe(true)
      }
      expect(shelf.b0).not.toBeCloseTo(1.53512485958697, 4) // rate really is in the design
    }
  })

  it('rejects a nonsense sample rate', () => {
    expect(() => kWeightingFilters(0)).toThrowError(/sampleRate/)
  })
})

describe('integrated loudness', () => {
  it('reads a -20 dBFS 1 kHz stereo sine as -20.0 LUFS (the BS.1770 calibration)', () => {
    // Peak amplitude 0.1 in BOTH channels. Summing the two channels' mean
    // squares gives 0.1^2, and K-weighting's +0.691 dB at 1 kHz is exactly
    // what the -0.691 offset cancels, so the meter must read -20.0. Measured:
    // -20.00 LUFS. (Same calibration as EBU Tech 3341 case 1 at -23 LUFS.)
    const s = sine(1000, 0.1, 5)
    expect(integratedLufs(s, s, SR)).toBeCloseTo(-20, 1)
  })

  it('holds that calibration at 44.1 kHz too (the filter design, not a 48 kHz table)', () => {
    const s = sine(1000, 0.1, 5, 44100)
    expect(integratedLufs(s, s, 44100)).toBeCloseTo(-20, 1)
  })

  it('tracks level one-for-one: 6 dB quieter measures 6 LU quieter', () => {
    const loud = sine(1000, 0.1, 5)
    const quiet = sine(1000, 0.05, 5)
    const delta = integratedLufs(loud, loud, SR) - integratedLufs(quiet, quiet, SR)
    expect(delta).toBeCloseTo(20 * Math.log10(2), 2)
  })

  it('reads one channel of a stereo pair 3 dB quieter than both (channels sum, they do not average)', () => {
    const s = sine(1000, 0.1, 5)
    const silent = new Float32Array(s.length)
    expect(integratedLufs(s, silent, SR)).toBeCloseTo(-20 - 10 * Math.log10(2), 1)
  })

  it('gates silence to -Infinity, and audio under the absolute -70 LUFS gate too', () => {
    const n = SR * 2
    expect(integratedLufs(new Float32Array(n), new Float32Array(n), SR)).toBe(-Infinity)
    const whisper = sine(1000, 1e-5, 2) // about -100 LUFS, below the absolute gate
    expect(integratedLufs(whisper, whisper, SR)).toBe(-Infinity)
  })

  it('drops the quiet passage via the relative -10 LU gate', () => {
    // 5 s at -20 LUFS then 5 s at -50: the quiet half sits far below the
    // relative gate (mean -23.0 LUFS, gate -33.0), so it is discarded and the
    // answer stays at the loud half's own -20. Without the relative gate the
    // energy mean of both halves would read -23.0, which is what this
    // separates. Measured: -20.13, the 0.13 being the handful of 400 ms
    // blocks that STRADDLE the join and are legitimately kept.
    const loud = sine(1000, 0.1, 5)
    const quiet = sine(1000, 0.1 * Math.pow(10, -30 / 20), 5)
    const cat = new Float32Array(loud.length + quiet.length)
    cat.set(loud, 0)
    cat.set(quiet, loud.length)
    const v = integratedLufs(cat, cat, SR)
    expect(v).toBeGreaterThan(-20.3)
    expect(v).toBeLessThan(-19.9)
  })

  it('has no honest answer for less than one 400 ms block', () => {
    const s = sine(1000, 0.5, 0.3)
    expect(integratedLufs(s, s, SR)).toBe(-Infinity)
  })

  it('rejects mismatched channels', () => {
    expect(() => integratedLufs(new Float32Array(4), new Float32Array(5), SR)).toThrowError(/mismatch/)
  })
})

describe('true peak', () => {
  it('finds the inter-sample peak a half-sample-shifted sine hides', () => {
    // 12 kHz at 48 kHz is 4 samples per cycle. Shifted a half sample (pi/4),
    // every stored sample sits at +-sin(pi/4) = 0.7071 of the amplitude, so
    // the SAMPLE peak reads -3.01 dBFS while the waveform really reaches full
    // scale between samples. Measured: sample peak -3.01 dBFS, true peak
    // +0.11 dBTP, a 3.1 dB gap the sample peak cannot see. (The exact answer
    // is 0.0 dBTP; a finite oversampling filter is allowed a little error,
    // and reading slightly HIGH is the safe direction for a ceiling check.)
    const s = sine(12000, 1, 0.5, SR, Math.PI / 4)
    const sp = samplePeakDb(s, s)
    const tp = truePeakDb(s, s, SR)
    expect(sp).toBeCloseTo(-3.01, 1)
    expect(tp).toBeGreaterThan(sp + 2.5)
    expect(Math.abs(tp)).toBeLessThan(0.25) // 0 dBTP within a quarter dB
  })

  it('agrees with the sample peak when the peak IS a sample', () => {
    // A slow sine sampled densely has no meaningful inter-sample overshoot.
    const s = sine(100, 0.5, 0.5)
    expect(truePeakDb(s, s, SR)).toBeCloseTo(samplePeakDb(s, s), 1)
    expect(samplePeakDb(s, s)).toBeCloseTo(20 * Math.log10(0.5), 2)
  })

  it('never reads below the sample peak, and takes the louder channel', () => {
    const quiet = sine(1000, 0.1, 0.3)
    const loud = sine(1000, 0.4, 0.3)
    expect(truePeakDb(quiet, loud, SR)).toBeGreaterThanOrEqual(samplePeakDb(quiet, loud) - 1e-9)
    expect(truePeakDb(quiet, loud, SR)).toBeCloseTo(20 * Math.log10(0.4), 1)
  })

  it('reports silence as -Infinity', () => {
    const z = new Float32Array(1000)
    expect(truePeakDb(z, z, SR)).toBe(-Infinity)
    expect(samplePeakDb(z, z)).toBe(-Infinity)
  })
})

describe('measureLoudness (the reported bundle)', () => {
  it('carries all three numbers and the reference targets', () => {
    const s = sine(1000, 0.1, 2)
    const r = measureLoudness(s, s, SR)
    expect(r.integratedLufs).toBeCloseTo(-20, 1)
    expect(r.samplePeakDb).toBeCloseTo(-20, 1)
    expect(r.truePeakDb).toBeGreaterThanOrEqual(r.samplePeakDb - 1e-9)
    expect(LOUDNESS_TARGETS).toEqual({ streaming: -14, club: -9, ceilingDbTp: -1 })
  })

  it('formats one decimal, and says silent instead of -Infinity', () => {
    expect(formatLufs(-13.94)).toBe('-13.9 LUFS')
    expect(formatLufs(-Infinity)).toBe('silent')
    expect(formatDbTp(-0.96)).toBe('-1.0 dBTP')
    expect(formatDbTp(-Infinity)).toBe('silent')
  })
})
