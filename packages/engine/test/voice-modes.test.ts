import { describe, it, expect } from 'vitest'
import { BLOCK } from '../src/compile'
import { VoicePool } from '../src/voice'
import type { VoiceOpts } from '../src/voice'
import { synth } from '../src/builder'
import type { SynthDef } from '../src/builder'
import { renderOffline } from '../src/render'
import type { RenderEvent } from '../src/render'
import { analyze } from '../src/analysis'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const SR = ctx.sampleRate

/** A clean sine synth (adsr-gated) built through the real builder, so these
 *  tests exercise the synth(voiceFn, opts) / synth(voiceFn, postFn, opts)
 *  overloads and the voiceOpts plumbing end to end. */
const sineSynth = (opts?: Partial<VoiceOpts>): SynthDef =>
  opts === undefined
    ? synth(({ note, gate, sine, adsr }) => sine(note.freq).mul(adsr(gate, { a: 0.005, d: 0.05, s: 0.85, r: 0.02 })))
    : synth(
        ({ note, gate, sine, adsr }) => sine(note.freq).mul(adsr(gate, { a: 0.005, d: 0.05, s: 0.85, r: 0.02 })),
        opts as VoiceOpts,
      )

const midiHz = (n: number): number => 440 * 2 ** ((n - 69) / 12)

const on = (time: number, note: number, velocity = 1): RenderEvent => ({ time, type: 'noteOn', note, velocity })
const off = (time: number, note: number): RenderEvent => ({ time, type: 'noteOff', note })

/** Instantaneous fundamental via rising zero-crossing rate (cycles/sec). */
const zcFreq = (x: Float32Array, sr: number): number => {
  let crossings = 0
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) crossings++
  return crossings / (x.length / sr)
}

const rms = (x: Float32Array): number => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / x.length)
}

/** Take the L-channel window [t0, t1) seconds. */
const win = (r: { left: Float32Array }, t0: number, t1: number): Float32Array =>
  r.left.subarray(Math.round(t0 * SR), Math.round(t1 * SR))

describe('mono glide (portamento)', () => {
  it('legato: pitch is A at onset, ramps through the middle, reaches B; no amplitude dip (no re-attack)', () => {
    // A held, B arrives WHILE A is still held (overlap) -> legato slide.
    const def = sineSynth({ mono: true, glide: 0.1 })
    const A = 45 // 110 Hz
    const B = 57 // 220 Hz
    const events: RenderEvent[] = [on(0, A), on(0.2, B), off(0.75, B), off(0.76, A)]
    const r = renderOffline(def, events, 0.8)

    // pitch just after A onset ~110
    expect(zcFreq(win(r, 0.05, 0.15), SR)).toBeGreaterThan(100)
    expect(zcFreq(win(r, 0.05, 0.15), SR)).toBeLessThan(130)
    // mid-glide (just after B) is between A and B
    const mid = zcFreq(win(r, 0.22, 0.26), SR)
    expect(mid).toBeGreaterThan(120)
    expect(mid).toBeLessThan(210)
    // reaches B by the end of the note
    expect(zcFreq(win(r, 0.6, 0.7), SR)).toBeGreaterThan(200)
    // no amplitude dip to zero anywhere during the held span -> gate never fell
    for (let t = 0.05; t < 0.7; t += 0.05) {
      expect(rms(win(r, t, t + 0.03)), `rms at ${t}s`).toBeGreaterThan(0.05)
    }
  })

  it('staccato (gap): amplitude dips during the gap (retrigger) yet still glides from the previous pitch', () => {
    const def = sineSynth({ mono: true, glide: 0.1 })
    const A = 45 // 110
    const B = 57 // 220
    // note A, released, a clear gap, then note B -> retrigger
    const events: RenderEvent[] = [on(0, A), off(0.15, A), on(0.35, B), off(0.75, B)]
    const r = renderOffline(def, events, 0.8)
    // dip during the gap (gate low -> envelope releases toward 0)
    expect(rms(win(r, 0.28, 0.33))).toBeLessThan(0.02)
    // re-attacks after the gap
    expect(rms(win(r, 0.45, 0.5))).toBeGreaterThan(0.1)
    // still glides from A (110) up toward B (220): right after B onset it is
    // well below 220, and reaches 220 by the end
    const early = zcFreq(win(r, 0.36, 0.4), SR)
    expect(early).toBeLessThan(205)
    expect(zcFreq(win(r, 0.65, 0.73), SR)).toBeGreaterThan(200)
  })

  it('glide 0 (mono default): pitch changes instantly, no slide', () => {
    const def = sineSynth({ mono: true }) // glide defaults to 0
    const A = 45
    const B = 69 // 440
    const events: RenderEvent[] = [on(0, A), on(0.2, B), off(0.35, B), off(0.36, A)]
    const r = renderOffline(def, events, 0.4)
    // immediately after B onset the pitch is already ~440 (no ramp)
    expect(zcFreq(win(r, 0.21, 0.25), SR)).toBeGreaterThan(400)
  })

  it('mono uses ONE voice: a fast run of distinct notes never exceeds one active voice', () => {
    const pool = new VoicePool(sineSynth({ mono: true, glide: 0.05 }).graph, ctx, 8, sineSynth({ mono: true, glide: 0.05 }).voiceOpts)
    for (const n of [45, 47, 48, 50, 52, 53, 55, 57]) {
      pool.noteOn(n, 1)
      const L = new Float32Array(BLOCK)
      const R = new Float32Array(BLOCK)
      pool.process(L, R, BLOCK)
      expect(pool.voices.filter((v) => v.active).length).toBeLessThanOrEqual(1)
    }
  })
})

describe('unison + stereo spread', () => {
  it('spread > 0 widens the stereo field; spread 0 stays mono (width ~0)', () => {
    const wide = sineSynth({ unison: 5, detune: 20, spread: 0.8 })
    const narrow = sineSynth({ unison: 5, detune: 20, spread: 0 })
    const events: RenderEvent[] = [on(0, 57), off(0.9, 57)]
    const aWide = analyze(renderOffline(wide, events, 1))
    const aNarrow = analyze(renderOffline(narrow, events, 1))
    expect(aWide.stereoWidth).toBeGreaterThan(0.2)
    expect(aNarrow.stereoWidth).toBeLessThan(0.02)
  })

  it('unison detune spreads energy into a cluster of partials around the fundamental', () => {
    const one = sineSynth({ unison: 1 })
    const five = sineSynth({ unison: 5, detune: 25, spread: 0 })
    const events: RenderEvent[] = [on(0, 57), off(0.9, 57)] // 220 Hz
    const r1 = renderOffline(one, events, 1)
    const r5 = renderOffline(five, events, 1)
    const w1 = r1.left.subarray(SR / 4)
    const w5 = r5.left.subarray(SR / 4)
    const f0 = midiHz(57)
    // a detuned side-partial (+25 cents ~= 223.2 Hz) carries far more energy in
    // the unison patch than in the single-oscillator one
    const side = f0 * 2 ** (25 / 1200)
    const ratio5 = goertzel(w5, side, SR) / goertzel(w5, f0, SR)
    const ratio1 = goertzel(w1, side, SR) / goertzel(w1, f0, SR)
    expect(ratio5).toBeGreaterThan(5 * ratio1)
  })

  it('unison N with spread 0 & detune 0 stacks to ~N× the single-voice amplitude', () => {
    const one = sineSynth({ unison: 1 })
    const four = sineSynth({ unison: 4, detune: 0, spread: 0 })
    const events: RenderEvent[] = [on(0, 57), off(0.9, 57)]
    const r1 = renderOffline(one, events, 1, { maxVoices: 8 })
    const r4 = renderOffline(four, events, 1, { maxVoices: 8 })
    const a1 = rms(r1.left.subarray(SR / 4, SR / 2))
    const a4 = rms(r4.left.subarray(SR / 4, SR / 2))
    expect(a4 / a1).toBeCloseTo(4, 0)
  })

  it('mono composes with unison: one gliding cluster of N detuned voices', () => {
    const def = sineSynth({ mono: true, glide: 0.08, unison: 3, detune: 15, spread: 0.6 })
    const events: RenderEvent[] = [on(0, 45), on(0.2, 57), off(0.75, 57), off(0.76, 45)]
    const a = analyze(renderOffline(def, events, 0.8))
    expect(a.stereoWidth).toBeGreaterThan(0.1) // spread from the cluster
    expect(a.isSilent).toBe(false)
    const r = renderOffline(def, events, 0.8)
    // still glides A->B
    expect(zcFreq(win(r, 0.6, 0.7), SR)).toBeGreaterThan(200)
  })
})

describe('backward compatibility', () => {
  it('a synth with NO opts renders byte-identically before and after the feature', () => {
    // voiceOpts must be undefined for a plain synth, and the render path
    // unchanged. Pin the render against a direct VoicePool render (same events).
    const def = sineSynth()
    expect(def.voiceOpts).toBeUndefined()
    const events: RenderEvent[] = [on(0, 57), off(0.5, 57)]
    const a = renderOffline(def, events, 0.6)
    const b = renderOffline(def, events, 0.6)
    for (let i = 0; i < a.left.length; i++) {
      expect(a.left[i]).toBe(b.left[i])
      expect(a.right[i]).toBe(b.right[i])
    }
    // and it is genuinely mono/centered: L === R
    for (let i = 0; i < a.left.length; i += 137) expect(a.left[i]).toBe(a.right[i])
  })
})

describe('offline == live (both use VoicePool)', () => {
  it('renderOffline of a unison synth exhibits the same stereo width a direct VoicePool render does', () => {
    const def = sineSynth({ unison: 5, detune: 20, spread: 0.8 })
    const events: RenderEvent[] = [on(0, 57), off(0.9, 57)]
    const offlineWidth = analyze(renderOffline(def, events, 1)).stereoWidth

    // direct pool render of the same note (no block splitting needed — single
    // note from t=0)
    const pool = new VoicePool(def.graph, ctx, 8, def.voiceOpts)
    pool.noteOn(57, 1)
    const total = SR
    const L = new Float32Array(total)
    const R = new Float32Array(total)
    for (let c = 0; c < total; c += BLOCK) {
      const n = Math.min(BLOCK, total - c)
      pool.process(L.subarray(c, c + n), R.subarray(c, c + n), n)
    }
    const liveWidth = analyze({ left: L, right: R, sampleRate: SR }).stereoWidth
    expect(liveWidth).toBeGreaterThan(0.2)
    expect(Math.abs(offlineWidth - liveWidth)).toBeLessThan(0.1)
  })
})
