import { describe, it, expect } from 'vitest'
import { synth } from '../src/builder'
import type { SynthDef } from '../src/builder'
import { renderOffline } from '../src/render'
import type { RenderEvent } from '../src/render'
import { goertzel } from './util/goertzel'

const SR = 48000

/** The design-doc acid synth (same as builder.test.ts). r = 0.1 matters for
 *  the release test below. */
const acid = (): SynthDef =>
  synth(({ note, gate, param, saw, square, ladder, adsr }) => {
    const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })
    const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
    const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)
    return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)
  })

/** noise * gate: output is nonzero from the exact noteOn sample and zero the
 *  exact sample the gate drops — ideal for sample-accuracy tests. */
const gateNoise = (): SynthDef => synth(({ gate, noise }) => noise().mul(gate))

/** sine * gate: clean single tone per note for spectral presence tests. */
const gateSine = (): SynthDef => synth(({ note, gate, sine }) => sine(note.freq).mul(gate))

/** saw -> ladder with a plain cutoff param (no envelope on cutoff) so param
 *  events map directly to spectral change. */
const sweepable = (): SynthDef =>
  synth(({ note, gate, param, saw, ladder }) =>
    ladder(saw(note.freq), param('cutoff', 800, { min: 80, max: 8000 }), { res: 0.3 }).mul(gate),
  )

const rms = (buf: Float32Array): number => {
  let s = 0
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!
  return Math.sqrt(s / buf.length)
}

/** Slice [t0, t1) seconds out of a buffer. */
const seg = (buf: Float32Array, t0: number, t1: number): Float32Array =>
  buf.subarray(Math.floor(t0 * SR), Math.floor(t1 * SR))

const hasNaN = (buf: Float32Array): boolean => {
  for (let i = 0; i < buf.length; i++) if (Number.isNaN(buf[i]!)) return true
  return false
}

describe('renderOffline', () => {
  it('acid patch, single 1s note: audible, finite, fundamental present', () => {
    const events: RenderEvent[] = [{ time: 0, type: 'noteOn', note: 45 }] // midi 45 = 110 Hz
    const { left, right, sampleRate } = renderOffline(acid(), events, 1)
    expect(sampleRate).toBe(SR)
    expect(left.length).toBe(SR)
    expect(right.length).toBe(SR)
    expect(hasNaN(left) || hasNaN(right)).toBe(false)
    expect(rms(left)).toBeGreaterThan(0.01)
    // [0.3, 0.9]s = 0.6 s: 110 Hz fits exactly 66 cycles (leakage-free bin);
    // 137 Hz is not a harmonic of 110 or 55 — energy there is leakage only
    const steady = seg(left, 0.3, 0.9)
    expect(goertzel(steady, 110, SR)).toBeGreaterThan(50 * goertzel(steady, 137, SR))
  })

  it('auto-scales amplitude by note velocity (velocity 0.5 is ~half of 1.0)', () => {
    // gateSine graph never touches the velocity signal — the voice applies it.
    const full = renderOffline(gateSine(), [{ time: 0, type: 'noteOn', note: 60, velocity: 1 }], 0.5)
    const half = renderOffline(gateSine(), [{ time: 0, type: 'noteOn', note: 60, velocity: 0.5 }], 0.5)
    const a = rms(seg(full.left, 0.1, 0.4))
    const b = rms(seg(half.left, 0.1, 0.4))
    expect(b).toBeGreaterThan(0.01)
    expect(a / b).toBeCloseTo(2, 1)
  })

  it('events land sample-accurately mid-block (block splitting)', () => {
    // t = 0.5004 s -> sample 24019.2 -> rounds to 24019, which is NOT a
    // multiple of BLOCK=128 (24019 = 187*128 + 83): forces a partial block
    const events: RenderEvent[] = [{ time: 0.5004, type: 'noteOn', note: 60 }]
    const { left } = renderOffline(gateNoise(), events, 1)
    let first = -1
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== 0) {
        first = i
        break
      }
    }
    expect(first).toBeGreaterThanOrEqual(0)
    expect(Math.abs(first - 24019)).toBeLessThanOrEqual(2)
  })

  it('noteOff releases: r=0.1 note released 0.5s before end decays out', () => {
    const events: RenderEvent[] = [
      { time: 0, type: 'noteOn', note: 45 },
      { time: 1.5, type: 'noteOff', note: 45 },
    ]
    const { left, right } = renderOffline(acid(), events, 2)
    // sounding before release, near-silent in the last 100 ms
    expect(rms(seg(left, 1.0, 1.5))).toBeGreaterThan(0.01)
    expect(rms(seg(left, 1.9, 2.0))).toBeLessThan(1e-3)
    expect(rms(seg(right, 1.9, 2.0))).toBeLessThan(1e-3)
  })

  it('param event mid-render changes the spectrum (cutoff 300 -> 5000)', () => {
    const events: RenderEvent[] = [
      { time: 0, type: 'param', name: 'cutoff', value: 300 },
      { time: 0, type: 'noteOn', note: 45 },
      { time: 1, type: 'param', name: 'cutoff', value: 5000 },
    ]
    const { left } = renderOffline(sweepable(), events, 2)
    // 2200 Hz = 20th harmonic of 110 Hz; 0.5 s windows hold 1100 exact cycles
    const hiFirst = goertzel(seg(left, 0.4, 0.9), 2200, SR)
    const hiSecond = goertzel(seg(left, 1.4, 1.9), 2200, SR)
    expect(hiSecond).toBeGreaterThan(50 * hiFirst)
  })

  it('same-timestamp noteOff + noteOn: noteOff sorts first, note survives', () => {
    // Deliberately listed noteOn BEFORE noteOff at t=0.5: the renderer must
    // reorder to noteOff-then-noteOn or the retriggered note is instantly
    // killed by its own predecessor's noteOff.
    const events: RenderEvent[] = [
      { time: 0, type: 'noteOn', note: 60 },
      { time: 0.5, type: 'noteOn', note: 60 },
      { time: 0.5, type: 'noteOff', note: 60 },
    ]
    const { left } = renderOffline(gateNoise(), events, 1)
    expect(rms(seg(left, 0.8, 1.0))).toBeGreaterThan(0.1)
  })

  it('same SAMPLE but unequal float times: noteOff still sorts first', () => {
    // Classic sequencer full-gate idiom: the noteOff time comes from float
    // accumulation (13 * 0.1 = 1.3000000000000003) while the next noteOn is
    // written as 1.3. Both round to sample 62400 — ordering must happen in
    // the sample domain, or the "later" noteOff time sorts after the noteOn
    // and kills the retriggered note.
    const events: RenderEvent[] = [
      { time: 0, type: 'noteOn', note: 60 },
      { time: 1.3, type: 'noteOn', note: 60 },
      { time: 1.3000000000000003, type: 'noteOff', note: 60 },
    ]
    const { left } = renderOffline(gateNoise(), events, 2)
    expect(rms(seg(left, 1.7, 2.0))).toBeGreaterThan(0.1)
  })

  it('same-sample tie order noteOff < param < noteOn: retrigger gets the new value', () => {
    // All three collide on one sample (scrambled input order): the note must
    // survive (noteOff first) and the new cutoff must be in effect for the
    // retriggered note (param before noteOn).
    const events: RenderEvent[] = [
      { time: 0, type: 'param', name: 'cutoff', value: 300 },
      { time: 0, type: 'noteOn', note: 45 },
      { time: 1, type: 'noteOn', note: 45 },
      { time: 1, type: 'param', name: 'cutoff', value: 5000 },
      { time: 1, type: 'noteOff', note: 45 },
    ]
    const { left } = renderOffline(sweepable(), events, 2)
    expect(rms(seg(left, 1.4, 1.9))).toBeGreaterThan(0.01) // survived
    const hiBefore = goertzel(seg(left, 0.4, 0.9), 2200, SR)
    const hiAfter = goertzel(seg(left, 1.4, 1.9), 2200, SR)
    expect(hiAfter).toBeGreaterThan(50 * hiBefore) // new cutoff applied
  })

  it('polyphony: two overlapping notes are both present spectrally', () => {
    const events: RenderEvent[] = [
      { time: 0, type: 'noteOn', note: 60 }, // 261.63 Hz
      { time: 0, type: 'noteOn', note: 64 }, // 329.63 Hz
    ]
    const { left } = renderOffline(gateSine(), events, 1)
    const steady = seg(left, 0.25, 0.75)
    const c4 = goertzel(steady, 261.63, SR)
    const e4 = goertzel(steady, 329.63, SR)
    const off = goertzel(steady, 400, SR) // no tone here — leakage floor only
    expect(c4).toBeGreaterThan(100)
    expect(e4).toBeGreaterThan(100)
    expect(off).toBeLessThan(10)
  })

  it('noteOff without a matching noteOn is a no-op', () => {
    const events: RenderEvent[] = [{ time: 0.1, type: 'noteOff', note: 60 }]
    const { left } = renderOffline(gateNoise(), events, 0.5)
    expect(rms(left)).toBe(0)
  })

  it('events at or beyond duration are ignored', () => {
    const events: RenderEvent[] = [{ time: 0.6, type: 'noteOn', note: 60 }]
    const { left } = renderOffline(gateNoise(), events, 0.5)
    expect(rms(left)).toBe(0)
  })

  it('validates duration', () => {
    expect(() => renderOffline(gateNoise(), [], 0)).toThrow(RangeError)
    expect(() => renderOffline(gateNoise(), [], -1)).toThrow(RangeError)
    expect(() => renderOffline(gateNoise(), [], 400)).toThrow(RangeError)
    expect(() => renderOffline(gateNoise(), [], Number.NaN)).toThrow(RangeError)
  })

  it('validates malformed events', () => {
    expect(() =>
      renderOffline(gateNoise(), [{ time: 0, type: 'noteOn' }], 1),
    ).toThrow(TypeError)
    expect(() =>
      renderOffline(gateNoise(), [{ time: 0, type: 'param', name: 'cutoff' }], 1),
    ).toThrow(TypeError)
    expect(() =>
      renderOffline(gateNoise(), [{ time: -0.1, type: 'noteOn', note: 60 }], 1),
    ).toThrow(RangeError)
  })
})
