import { describe, it, expect } from 'vitest'
import { psola, estimateF0, olaStretch } from '../src/sing/psola'

/* TD-PSOLA port verification: it must genuinely PITCH (not merely time-stretch)
 * and time-stretch without changing pitch. Uses a synthetic glottal source (a
 * band-limited pulse train — one clear epoch per period) so pitch marks are
 * unambiguous. Mirrors the offline Python reference's F0-check. */

const sr = 44100

/** A saw-ish glottal source at f0: harmonics phase-aligned → one peak/period. */
function glottal(f0: number, dur: number): Float32Array {
  const n = Math.floor(dur * sr)
  const x = new Float32Array(n)
  const H = 12
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 1; k <= H; k++) s += Math.sin((2 * Math.PI * k * f0 * i) / sr) / k
    x[i] = s
  }
  let pk = 0
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]!))
  for (let i = 0; i < n; i++) x[i]! /= pk || 1
  return x
}

describe('psola port', () => {
  it('estimateF0 recovers the fundamental', () => {
    expect(estimateF0(glottal(150, 0.4), sr)).toBeCloseTo(150, -1) // within ~5 Hz
    expect(estimateF0(glottal(220, 0.4), sr)).toBeCloseTo(220, -1)
  })

  it('shifts pitch UP an octave (the load-bearing property)', () => {
    const x = glottal(150, 0.4)
    const y = psola(x, sr, 1, 300, estimateF0(x, sr))
    const f0 = estimateF0(y, sr)
    expect(f0).toBeGreaterThan(270)
    expect(f0).toBeLessThan(330)
  })

  it('shifts pitch DOWN to a target note', () => {
    const x = glottal(220, 0.4)
    const y = psola(x, sr, 1, 165, estimateF0(x, sr)) // 220 -> 165 (a fourth down)
    const f0 = estimateF0(y, sr)
    expect(f0).toBeGreaterThan(150)
    expect(f0).toBeLessThan(180)
  })

  it('time-stretches ~2x WITHOUT changing pitch', () => {
    const x = glottal(150, 0.3)
    const y = psola(x, sr, 2.0, 150, estimateF0(x, sr))
    expect(y.length).toBeGreaterThan(x.length * 1.8)
    expect(y.length).toBeLessThan(x.length * 2.2)
    const f0 = estimateF0(y, sr)
    expect(f0).toBeGreaterThan(135)
    expect(f0).toBeLessThan(165)
  })

  it('unvoiced fallback (olaStretch) hits the target length and is finite', () => {
    const noise = new Float32Array(4000)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.sin(i * 0.31) * 0.3 // deterministic
    const y = olaStretch(noise, 8000, sr)
    expect(y.length).toBe(8000)
    for (let i = 0; i < y.length; i++) expect(Number.isFinite(y[i]!)).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * THE SEARCH RANGE, which nothing asserted.
 *
 * A mutation audit halved estimateF0's minimum lag — the change that turns a
 * pitch tracker into an octave-error machine — and every test stayed green,
 * because they all feed a clean glottal pulse train whose autocorrelation peak
 * is unambiguous. That is the signal an F0 estimator never has trouble with.
 *
 * `fmin` and `fmax` had no test at all, so what happens at and outside the
 * range was undefined in practice. These pin the behaviour that exists (it is
 * reasonable) rather than changing the estimator: the interesting part is that
 * an out-of-range pitch comes back CLAMPED and confident, not as a no-estimate,
 * which is worth knowing before trusting it on a real voice.
 * ------------------------------------------------------------------------- */
describe('estimateF0 search range', () => {
  /** A tone at f0 with the given harmonic amplitudes (index 0 = fundamental),
   *  scaled by `amp` — the quiet cases need a signal that is periodic but far
   *  under the estimator's energy gate. */
  const tone = (f0: number, amps: number[], amp = 1, dur = 0.4): Float32Array => {
    const n = Math.floor(dur * sr)
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let v = 0
      for (let k = 0; k < amps.length; k++) v += amps[k]! * Math.sin((2 * Math.PI * f0 * (k + 1) * i) / sr)
      x[i] = v * amp
    }
    return x
  }

  it('is not fooled by a strong second harmonic (the classic octave error)', () => {
    expect(estimateF0(tone(150, [0.4, 1]), sr)).toBeCloseTo(150, -1)
  })

  it('finds a MISSING fundamental from its harmonics, as a voice has', () => {
    expect(estimateF0(tone(150, [0, 1, 0.8, 0.6]), sr)).toBeCloseTo(150, -1)
  })

  it('honours a custom fmin rather than ignoring it', () => {
    // 150 Hz is inside the default range but below this one
    const x = tone(150, [1, 0.5, 0.3])
    expect(estimateF0(x, sr), 'default range finds it').toBeCloseTo(150, -1)
    expect(estimateF0(x, sr, 200, 400), 'a pitch below fmin is not reported').toBe(0)
  })

  it('honours a custom fmax rather than ignoring it', () => {
    /* 450 Hz sits under the default fmax of 500 and over a custom 400. The
     * lowered ceiling does not merely clip the answer — the lag it needs is
     * outside the search, so it locks onto the SUBHARMONIC at 225. That
     * distinction is the point: an fmax that was quietly ignored would keep
     * answering 450. */
    const x = tone(450, [1])
    expect(estimateF0(x, sr), 'default fmax reaches it').toBeCloseTo(450, -1)
    const narrowed = estimateF0(x, sr, 75, 400)
    expect(narrowed, 'a lowered fmax must change the answer').not.toBeCloseTo(450, -1)
    expect(narrowed, 'and it lands on the subharmonic').toBeCloseTo(225, -1)
  })

  it('never reports outside the range the lag search can express', () => {
    /* The bound is quantized, not exact: lags are integers, so the highest
     * reportable pitch is sr/floor(sr/fmax), a hair ABOVE fmax (501.1 Hz for
     * fmax 500 at 44.1k). Asserting `<= fmax` would be asserting something
     * the algorithm cannot do without a redesign, so this pins the real
     * ceiling — and would still fail if the search window moved. */
    const ceiling = sr / Math.floor(sr / 500)
    const floorHz = sr / Math.min(Math.floor(sr / 75), Math.floor(0.4 * sr) - 1)
    for (const [f0, amps] of [[60, [1, 0.5]], [900, [1]], [40, [1, 0.7]]] as [number, number[]][]) {
      const got = estimateF0(tone(f0, amps), sr)
      expect(got, `f0=${f0} escaped the search range`).toBeLessThanOrEqual(ceiling)
      if (got > 0) expect(got, `f0=${f0} below the search range`).toBeGreaterThanOrEqual(floorHz * 0.99)
    }
  })

  it('an out-of-range pitch comes back CLAMPED, not as a no-estimate', () => {
    // documented because it is a trap: 0 means "no estimate" (silence), so a
    // caller cannot distinguish "too low to track" from "tracked fine"
    const tooLow = estimateF0(tone(60, [1, 0.5]), sr)
    expect(tooLow, 'a 60 Hz tone does not report 0').toBeGreaterThan(0)
    expect(tooLow, 'it reports somewhere in range instead').toBeGreaterThan(75)
  })

  it('reports 0 — no estimate — for silence and for too-short input', () => {
    expect(estimateF0(new Float32Array(Math.floor(0.4 * sr)), sr)).toBe(0)
    expect(estimateF0(new Float32Array(8), sr)).toBe(0)
  })

  it('a frame too quiet to trust reports nothing, not a confident pitch', () => {
    /* The energy gate is the difference between "no estimate" and a number.
     * Autocorrelation is NORMALIZED, so a periodic signal at any amplitude
     * correlates just as well with itself — drop the gate and a whisper of
     * numerical noise reports a pitch as confidently as a sung note. Exact
     * digital silence does not catch this: there the ratio is 0/0 = NaN and
     * fails the confidence check anyway. It takes a signal that is quiet but
     * real. */
    expect(estimateF0(tone(150, [1], 1e-6), sr), 'well below the gate').toBe(0)
    // and the gate is not so aggressive that an ordinarily quiet take is lost
    expect(estimateF0(tone(150, [1], 1e-3), sr), 'a quiet but real note').toBeCloseTo(150, -1)
  })
})
