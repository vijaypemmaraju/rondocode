import { describe, it, expect } from 'vitest'
import { HUMANIZE_CENTS, HUMANIZE_DELAY_MS } from '../src/voice'
import type { VoiceOpts } from '../src/voice'
import { synth } from '../src/builder'
import type { SynthDef } from '../src/builder'
import { renderOffline } from '../src/render'
import type { RenderEvent } from '../src/render'

/* ------------------------------------------------------------------------- *
 * Per-voice HUMANIZE: a small deterministic pitch + timing offset per voice
 * so a stack of unison voices (or a stacked chord) stops being N identical
 * copies. The three claims that must hold are DETERMINISM (the same render
 * twice is bit-identical), that 0 is byte-identical to the pre-feature
 * engine, and that at full amount the offsets stay inside the documented
 * ±8 cents / 0..14 ms bounds.
 * ------------------------------------------------------------------------- */

const SR = 48000

const sineSynth = (opts?: Partial<VoiceOpts>): SynthDef =>
  opts === undefined
    ? synth(({ note, gate, sine, adsr }) => sine(note.freq).mul(adsr(gate, { a: 0.002, d: 0.02, s: 0.9, r: 0.02 })))
    : synth(
        ({ note, gate, sine, adsr }) => sine(note.freq).mul(adsr(gate, { a: 0.002, d: 0.02, s: 0.9, r: 0.02 })),
        opts as VoiceOpts,
      )

const on = (time: number, note: number, velocity = 1): RenderEvent => ({ time, type: 'noteOn', note, velocity })
const off = (time: number, note: number): RenderEvent => ({ time, type: 'noteOff', note })

const chord: RenderEvent[] = [
  on(0, 48), on(0, 52), on(0, 55), on(0, 59),
  off(1.4, 48), off(1.4, 52), off(1.4, 55), off(1.4, 59),
]

const identical = (a: Float32Array, b: Float32Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('humanize: determinism', () => {
  it('the same render twice is BIT-identical (no Math.random anywhere)', () => {
    const def = sineSynth({ unison: 5, detune: 12, humanize: 1 })
    const a = renderOffline(def, chord, 1.5)
    const b = renderOffline(def, chord, 1.5)
    expect(identical(a.left, b.left)).toBe(true)
    expect(identical(a.right, b.right)).toBe(true)
  })

  it('a FRESH synth definition with the same opts renders identically too', () => {
    // The hash key is (voice slot, midi note) — nothing carried from a
    // previous render, and nothing seeded from wall-clock or allocation order.
    const a = renderOffline(sineSynth({ unison: 5, humanize: 0.7 }), chord, 1)
    const b = renderOffline(sineSynth({ unison: 5, humanize: 0.7 }), chord, 1)
    expect(identical(a.left, b.left)).toBe(true)
  })

  it('a different amount gives a different render (it is actually doing something)', () => {
    const a = renderOffline(sineSynth({ unison: 5, humanize: 0.7 }), chord, 1)
    const b = renderOffline(sineSynth({ unison: 5, humanize: 0.3 }), chord, 1)
    expect(identical(a.left, b.left)).toBe(false)
  })
})

describe('humanize: 0 is exactly today', () => {
  it('humanize 0 is BYTE-identical to a synth with no humanize opt at all', () => {
    const plain = renderOffline(sineSynth({ unison: 5, detune: 12 }), chord, 1.5)
    const zero = renderOffline(sineSynth({ unison: 5, detune: 12, humanize: 0 }), chord, 1.5)
    expect(identical(plain.left, zero.left)).toBe(true)
    expect(identical(plain.right, zero.right)).toBe(true)
  })

  it('humanize 0 leaves a plain poly synth byte-identical as well', () => {
    const plain = renderOffline(sineSynth(), chord, 1)
    const zero = renderOffline(sineSynth({ humanize: 0 }), chord, 1)
    expect(identical(plain.left, zero.left)).toBe(true)
  })

  it('a nonzero amount is audibly different from 0', () => {
    const zero = renderOffline(sineSynth({ unison: 5, humanize: 0 }), chord, 1)
    const some = renderOffline(sineSynth({ unison: 5, humanize: 1 }), chord, 1)
    expect(identical(zero.left, some.left)).toBe(false)
  })
})

/* --- bounds ---------------------------------------------------------------
 * Both offsets are measured from a ONE-voice-per-note render: a single held
 * sine per voice slot, so the pitch is readable by zero crossings and the
 * onset by the first sample that leaves silence. */

/** Cycles per second from rising zero crossings over a steady window. */
const zcFreq = (x: Float32Array, sr: number): number => {
  let first = -1
  let last = -1
  let crossings = 0
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1]! < 0 && x[i]! >= 0) {
      if (first < 0) first = i
      last = i
      crossings++
    }
  }
  // measure between the FIRST and LAST crossing so the window edges don't
  // bias the count — that is worth ~1 cent at these window lengths
  return first < 0 || crossings < 2 ? 0 : ((crossings - 1) * sr) / (last - first)
}

/** First sample index whose magnitude clears an audible floor. */
const onsetIndex = (x: Float32Array): number => {
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > 1e-3) return i
  return -1
}

describe('humanize: the documented bounds', () => {
  const NOTES = [36, 43, 48, 55, 60, 64, 67, 72]

  /** One note through a one-voice pool: slot 0 every time, so the sweep varies
   *  the OTHER half of the hash key (the midi note) and each reading is a
   *  single clean sine whose pitch and onset are directly measurable. */
  const solo = (note: number, humanize: number): { freq: number; onset: number } => {
    const r = renderOffline(sineSynth({ humanize }), [on(0, note), off(0.9, note)], 1, { maxVoices: 1 })
    return {
      freq: zcFreq(r.left.subarray(Math.round(0.3 * SR), Math.round(0.85 * SR)), SR),
      onset: onsetIndex(r.left),
    }
  }

  it('pitch stays inside ±8 cents at humanize 1, and moves for most notes', () => {
    let maxCents = 0
    let moved = 0
    for (const n of NOTES) {
      const nominal = 440 * 2 ** ((n - 69) / 12)
      const cents = 1200 * Math.log2(solo(n, 1).freq / nominal)
      expect(Number.isFinite(cents)).toBe(true)
      expect(Math.abs(cents), `note ${n}: ${cents.toFixed(2)} cents`).toBeLessThanOrEqual(HUMANIZE_CENTS + 1)
      if (Math.abs(cents) > 0.5) moved++
      if (Math.abs(cents) > maxCents) maxCents = Math.abs(cents)
    }
    // measured over these 8 notes: offsets -7.02, +4.24, -6.96, +6.38, -7.06,
    // +3.33, +4.34, +6.33 cents — worst 7.06, all 8 moved
    expect(moved).toBeGreaterThanOrEqual(6)
    expect(maxCents).toBeGreaterThan(2)
  })

  it('pitch is EXACT at humanize 0 (same measurement, zero offset)', () => {
    for (const n of NOTES) {
      const nominal = 440 * 2 ** ((n - 69) / 12)
      const cents = 1200 * Math.log2(solo(n, 0).freq / nominal)
      expect(Math.abs(cents), `note ${n}`).toBeLessThan(0.5)
    }
  })

  it('the onset is held back by 0..14 ms at humanize 1, never early', () => {
    const maxSamples = Math.round((HUMANIZE_DELAY_MS / 1000) * SR)
    let maxDelay = 0
    let delayed = 0
    for (const n of NOTES) {
      const base = solo(n, 0).onset
      const late = solo(n, 1).onset
      expect(base).toBeGreaterThanOrEqual(0)
      // one-sided: a humanized voice is never EARLY
      expect(late, `note ${n}`).toBeGreaterThanOrEqual(base)
      // and never later than the documented ceiling (+1 sample of rounding)
      expect(late - base, `note ${n}: ${late - base} samples`).toBeLessThanOrEqual(maxSamples + 1)
      if (late - base > 4) delayed++
      if (late - base > maxDelay) maxDelay = late - base
    }
    // measured over these 8 notes: 3.69, 8.25, 4.00, 8.15, 2.48, 6.13, 11.19,
    // 11.04 ms of hold-back — worst 11.19 ms, all 8 delayed
    expect(delayed).toBeGreaterThanOrEqual(6)
    expect(maxDelay).toBeGreaterThan(Math.round(0.002 * SR))
  })

  it('scales with the amount: half the humanize, at most half the offset', () => {
    for (const n of NOTES) {
      const base = solo(n, 0)
      const half = solo(n, 0.5)
      const full = solo(n, 1)
      const nominal = 440 * 2 ** ((n - 69) / 12)
      const c = (f: number): number => 1200 * Math.log2(f / nominal)
      // the same hash draw scaled by the amount, so the ratio is exactly 2
      // (within the ~0.2 cent resolution of the zero-crossing estimate)
      expect(Math.abs(c(half.freq)), `note ${n}`).toBeLessThanOrEqual(Math.abs(c(full.freq)) / 2 + 0.3)
      expect(half.onset - base.onset).toBeLessThanOrEqual(Math.ceil((full.onset - base.onset) / 2) + 1)
    }
  })
})

describe('humanize: the stack stops being identical copies', () => {
  it('a unison stack beats (the sub-voices drift) where the un-humanized one does not', () => {
    // Unison detune 0 means every sub-voice is a bit-identical copy: the sum
    // is a clean N-times-louder sine. Humanize alone must break that.
    const flat = renderOffline(sineSynth({ unison: 5, detune: 0, spread: 0 }), [on(0, 57), off(1.4, 57)], 1.5)
    const human = renderOffline(sineSynth({ unison: 5, detune: 0, spread: 0, humanize: 1 }), [on(0, 57), off(1.4, 57)], 1.5)
    /** Coefficient of variation of windowed RMS — a proxy for beating. */
    const cov = (x: Float32Array, from: number, to: number, win: number): number => {
      const r: number[] = []
      for (let i = from; i + win <= to; i += win) {
        let s = 0
        for (let j = 0; j < win; j++) s += x[i + j]! * x[i + j]!
        r.push(Math.sqrt(s / win))
      }
      const m = r.reduce((a, b) => a + b, 0) / r.length
      return Math.sqrt(r.reduce((a, b) => a + (b - m) * (b - m), 0) / r.length) / m
    }
    const w = Math.round(0.02 * SR)
    const flatCov = cov(flat.left, Math.round(0.1 * SR), Math.round(1.3 * SR), w)
    const humanCov = cov(human.left, Math.round(0.1 * SR), Math.round(1.3 * SR), w)
    // measured: flat 0.0075 (windowing residue on a dead-steady tone),
    // humanized 0.2563 — the stack breathes
    expect(flatCov).toBeLessThan(0.02)
    expect(humanCov).toBeGreaterThan(0.1)
  })
})

describe('humanize at 44.1 kHz', () => {
  it('the onset delay is in MILLISECONDS, not samples', () => {
    const SR44 = 44100
    const note = 60
    const base = renderOffline(sineSynth({ humanize: 0 }), [on(0, note), off(0.9, note)], 1, { sampleRate: SR44, maxVoices: 1 })
    const late = renderOffline(sineSynth({ humanize: 1 }), [on(0, note), off(0.9, note)], 1, { sampleRate: SR44, maxVoices: 1 })
    const d48 = (() => {
      const b = renderOffline(sineSynth({ humanize: 0 }), [on(0, note), off(0.9, note)], 1, { maxVoices: 1 })
      const l = renderOffline(sineSynth({ humanize: 1 }), [on(0, note), off(0.9, note)], 1, { maxVoices: 1 })
      return (onsetIndex(l.left) - onsetIndex(b.left)) / SR
    })()
    const d44 = (onsetIndex(late.left) - onsetIndex(base.left)) / SR44
    expect(d44).toBeLessThanOrEqual(HUMANIZE_DELAY_MS / 1000 + 1 / SR44)
    // the SAME hash draw, so the two rates must agree in SECONDS to a sample
    expect(Math.abs(d44 - d48)).toBeLessThan(2 / SR44)
  })
})
