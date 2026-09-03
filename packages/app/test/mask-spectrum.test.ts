import { describe, expect, it } from 'vitest'
import { RHYTHM_BANDS, RHYTHM_LEVEL_MAX } from '../src/mask/protocol'
import { MaskSpectrum, RhythmLevels, spectrumBands } from '../src/mask/spectrum'
import type { SpectrumSource } from '../src/mask/spectrum'

/* The analyser's spectrum → the 24 levels the mask's live visualizers draw.
 * Two halves, each pure: the fold from FFT bins into log-spaced bands, and
 * the app-style normalisation that turns dB bytes into 0..9 against a
 * decaying ceiling, so the loudest recent band fills its bar and silence
 * stays dark. */

// an AnalyserNode of fftSize 2048 at 48 kHz: 1024 bins, 23.4375 Hz each
const BINS = 1024
const BIN_HZ = 48000 / 2048

const freqWith = (hits: [hz: number, byte: number][]): Uint8Array => {
  const f = new Uint8Array(BINS)
  for (const [hz, v] of hits) f[Math.round(hz / BIN_HZ)] = v
  return f
}

const lit = (bands: ArrayLike<number>): number[] => Array.from(bands, (v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0)

describe('spectrumBands', () => {
  it('folds the bins into 24 log-spaced bands over 40 Hz to 16 kHz, loudest bin wins', () => {
    // band edges are floor(40 * 400^(i/24) / binHz): 100 Hz is bin 4, inside
    // band 4 = [4, 5); 1 kHz is bin 43, the first bin of band 13 = [43, 56);
    // 8 kHz is bin 341, in band 21 = [322, 414)
    const bands = spectrumBands(freqWith([[100, 200], [1000, 150], [8000, 100]]), BIN_HZ)
    expect(bands.length).toBe(RHYTHM_BANDS)
    expect(lit(bands)).toEqual([4, 13, 21])
    expect([bands[4], bands[13], bands[21]]).toEqual([200, 150, 100])
    // two bins in one band: the louder one is the band
    const two = spectrumBands(freqWith([[8000, 100], [8500, 180]]), BIN_HZ)
    expect(two[21]).toBe(180)
  })

  it('ignores what lies above the top band', () => {
    // 20 kHz is bin 853, past band 23's end at bin 682
    expect(lit(spectrumBands(freqWith([[20000, 255]]), BIN_HZ))).toEqual([])
  })

  it('gives a narrow low band its nearest bin rather than nothing', () => {
    // at this resolution bands 1 and 2 both want bin 2 (47 Hz): they share
    // it, and neither is silent for the width of the bin
    const bands = spectrumBands(freqWith([[47, 120]]), BIN_HZ)
    expect(bands[1]).toBe(120)
    expect(bands[2]).toBe(120)
  })

  it('reuses the output buffer it is given', () => {
    const out = new Float32Array(RHYTHM_BANDS)
    expect(spectrumBands(freqWith([[100, 200]]), BIN_HZ, out)).toBe(out)
    expect(out[4]).toBe(200)
    spectrumBands(new Uint8Array(BINS), BIN_HZ, out)
    expect(out[4]).toBe(0) // cleared, not left over
  })
})

describe('RhythmLevels', () => {
  const only = (band: number, v: number): number[] => {
    const a = new Array<number>(RHYTHM_BANDS).fill(0)
    a[band] = v
    return a
  }
  const flat = (v: number): number[] => new Array<number>(RHYTHM_BANDS).fill(v)
  // no tilt, so the arithmetic below is checkable by hand; the tilt has its own test
  const opts = { floor: 80, tilt: 0, decay: 1 }

  it('keeps silence dark, and stays dark', () => {
    const rl = new RhythmLevels(opts)
    for (let i = 0; i < 10; i++) expect([...rl.update(flat(0))]).toEqual(flat(0))
    // the tilt alone never lights a band: it lifts the highs, it does not invent them
    const tilted = new RhythmLevels({ ...opts, tilt: 60 })
    expect([...tilted.update(flat(0))]).toEqual(flat(0))
  })

  it('fills the loudest band and leaves the rest where they are', () => {
    const rl = new RhythmLevels(opts)
    expect([...rl.update(only(4, 200))]).toEqual(only(4, RHYTHM_LEVEL_MAX))
    // ceiling now 200: a band at 140 reads ceil(9 * (140 - 80) / (200 - 80)) = 5
    const two = only(4, 200)
    two[10] = 140
    const lv = rl.update(two)
    expect(lv[4]).toBe(9)
    expect(lv[10]).toBe(5)
  })

  it('reads 0 at the floor and 1 just above it', () => {
    const rl = new RhythmLevels(opts)
    rl.update(only(0, 250)) // a ceiling to measure against
    expect(rl.update(only(0, 80))[0]).toBe(0)
    expect(rl.update(only(0, 81))[0]).toBe(1)
  })

  it('lets a quieter passage climb back to full as the ceiling decays', () => {
    const rl = new RhythmLevels(opts)
    rl.update(only(4, 200))
    const first = rl.update(only(4, 140))[4]!
    expect(first).toBeLessThan(RHYTHM_LEVEL_MAX)
    let last = first
    for (let i = 0; i < 60; i++) last = rl.update(only(4, 140))[4]!
    expect(last).toBe(RHYTHM_LEVEL_MAX)
    // and a louder frame raises the ceiling at once
    const loud = only(4, 140)
    loud[6] = 220
    const lv = rl.update(loud)
    expect(lv[6]).toBe(9)
    expect(lv[4]).toBeLessThan(RHYTHM_LEVEL_MAX)
  })

  it('tilts towards the highs: a flat spectrum never falls as the band rises', () => {
    const rl = new RhythmLevels({ ...opts, tilt: 60 })
    const lv = [...rl.update(flat(200))]
    for (let i = 1; i < lv.length; i++) expect(lv[i]).toBeGreaterThanOrEqual(lv[i - 1]!)
    expect(lv[0]).toBeLessThan(RHYTHM_LEVEL_MAX)
    expect(lv[RHYTHM_BANDS - 1]).toBe(RHYTHM_LEVEL_MAX)
  })

  it('never exceeds 9 whatever the input', () => {
    const rl = new RhythmLevels(opts)
    for (const v of rl.update(flat(255))) expect(v).toBeLessThanOrEqual(RHYTHM_LEVEL_MAX)
    for (const v of rl.update(flat(1e9))) expect(v).toBeLessThanOrEqual(RHYTHM_LEVEL_MAX)
    for (const v of rl.update(flat(NaN))) expect(v).toBe(0)
  })

  it('forgets its ceiling on reset', () => {
    const rl = new RhythmLevels(opts)
    rl.update(only(0, 250))
    rl.reset()
    expect(rl.update(only(0, 100))[0]).toBe(RHYTHM_LEVEL_MAX)
  })
})

describe('MaskSpectrum', () => {
  it('reads the analyser and hands back 24 levels', () => {
    const data = freqWith([[100, 220]])
    const src: SpectrumSource = {
      frequencyBinCount: BINS,
      getByteFrequencyData: (out) => out.set(data),
    }
    const sp = new MaskSpectrum(src, 48000)
    const lv = sp.levels()
    expect(lv.length).toBe(RHYTHM_BANDS)
    expect(lit(lv)).toEqual([4])
    expect(lv[4]).toBe(RHYTHM_LEVEL_MAX)
  })
})
