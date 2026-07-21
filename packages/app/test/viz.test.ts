import { describe, expect, it } from 'vitest'
import {
  SPECTRUM_MAX_HZ,
  SPECTRUM_MIN_HZ,
  barBinRange,
  dprSize,
  freqToBar,
} from '../src/viz/viz'

/* Pure viz helpers only — canvas/rAF/DOM code is exercised in the browser.
 * Numbers use the real deployment shape: 48kHz context, fftSize 2048 →
 * 1024 bins of 23.4375 Hz. */

const BIN_HZ = 48000 / 2048
const BIN_COUNT = 1024

describe('freqToBar: log-frequency bar mapping', () => {
  it('pins the edges: minHz → first bar, maxHz → last bar (clamped)', () => {
    expect(freqToBar(SPECTRUM_MIN_HZ, 32)).toBe(0)
    expect(freqToBar(SPECTRUM_MAX_HZ, 32)).toBe(31)
    expect(freqToBar(1, 32)).toBe(0) // below range clamps low
    expect(freqToBar(30000, 32)).toBe(31) // above range clamps high
  })

  it('is logarithmic: the geometric midpoint splits a two-bar spectrum', () => {
    // With min 40 and max 16000 the ratio is 400; the log midpoint is
    // 40·√400 = 800 Hz — equal OCTAVE spans per bar, not equal Hz spans.
    expect(freqToBar(799, 2, 40, 16000)).toBe(0)
    expect(freqToBar(801, 2, 40, 16000)).toBe(1)
  })

  it('is monotonic non-decreasing across a sweep', () => {
    let prev = 0
    for (let f = SPECTRUM_MIN_HZ; f <= SPECTRUM_MAX_HZ; f *= 1.09) {
      const bar = freqToBar(f, 48)
      expect(bar).toBeGreaterThanOrEqual(prev)
      prev = bar
    }
    expect(prev).toBe(47) // the sweep reaches the last bar
  })
})

describe('barBinRange: FFT bins feeding each bar', () => {
  it('every bar gets a non-empty, in-range bin span', () => {
    const bars = 48
    for (let bar = 0; bar < bars; bar++) {
      const [lo, hi] = barBinRange(bar, bars, BIN_COUNT, BIN_HZ)
      expect(lo).toBeGreaterThanOrEqual(0)
      expect(hi).toBeGreaterThan(lo) // never empty, even for sub-bin-wide low bars
      expect(hi).toBeLessThanOrEqual(BIN_COUNT)
    }
  })

  it('spans are monotonic: a later bar never starts before an earlier one', () => {
    const bars = 48
    let prevLo = -1
    for (let bar = 0; bar < bars; bar++) {
      const [lo] = barBinRange(bar, bars, BIN_COUNT, BIN_HZ)
      expect(lo).toBeGreaterThanOrEqual(prevLo)
      prevLo = lo
    }
  })

  it('round-trips with freqToBar: a bar covers frequencies that map to it', () => {
    const bars = 32
    const [lo, hi] = barBinRange(20, bars, BIN_COUNT, BIN_HZ)
    // The midpoint frequency of the span's bins maps back to bar 20.
    const midHz = ((lo + hi) / 2) * BIN_HZ
    expect(freqToBar(midHz, bars)).toBe(20)
  })
})

describe('dprSize: CSS px → device px', () => {
  it('rounds and never collapses to zero', () => {
    expect(dprSize(300, 2)).toBe(600)
    expect(dprSize(333.34, 1.5)).toBe(500)
    expect(dprSize(0, 1)).toBe(1)
    expect(dprSize(10, 3)).toBe(30)
  })
})
