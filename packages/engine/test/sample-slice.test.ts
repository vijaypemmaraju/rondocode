import { describe, expect, it } from 'vitest'
import { SampleKernel } from '../src/dsp/sample'
import type { SampleSliceConfig } from '../src/dsp/sample'
import { SampleBank } from '../src/samples'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'
import type { RenderEvent } from '../src/render'
import { goertzel } from './util/goertzel'

/* SAMPLE SLICING: playing PART of a buffer — a start/end window, a reversed
 * read, and `slices: N` chops the note picks between. The buffers here are
 * mostly ramps and per-region constants so "which region did we hear" is an
 * exact value, not a correlation. */

/** Run a kernel over n samples with a constant-on gate rising at i=0. */
const run = (
  k: SampleKernel,
  n: number,
  sampleRate: number,
  opts?: { speed?: number; gate?: Float32Array; pitch?: number },
): number[] => {
  const gate = opts?.gate ?? new Float32Array(n).fill(1)
  const inputs: Record<string, Float32Array> = { gate }
  if (opts?.speed !== undefined) inputs['speed'] = new Float32Array(n).fill(opts.speed)
  if (opts?.pitch !== undefined) inputs['pitch'] = new Float32Array(n).fill(opts.pitch)
  const out = new Float32Array(n)
  k.process(n, inputs, out, { sampleRate })
  return [...out]
}

const ramp = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => i)

/** The pitch-input value a note carries when `root` selects slice 0. */
const ratio = (note: number, root = 60): number => Math.pow(2, (note - root) / 12)

/** 8 regions of 100 frames; region k holds the constant k + 1. */
const marked = (): Float32Array => Float32Array.from({ length: 800 }, (_, i) => ((i / 100) | 0) + 1)

describe('SampleKernel: start/end window', () => {
  it('plays exactly the windowed region, frame for frame', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(100), 48000) // frame i holds i, so the output IS the region read
    // window [0.25, 0.5) of 100 frames = frames 25..49
    const k = new SampleKernel('r', false, bank, { start: 0.25, end: 0.5, fade: 0 })
    const out = run(k, 30, 48000)
    expect(out.slice(0, 25)).toEqual([...Array(25)].map((_, i) => 25 + i))
    expect(out.slice(25)).toEqual([0, 0, 0, 0, 0]) // one-shot ends with the WINDOW, not the buffer
  })

  it('reverse plays the same region backwards, frame for frame', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(100), 48000)
    const k = new SampleKernel('r', false, bank, { start: 0.25, end: 0.5, reverse: true, fade: 0 })
    const out = run(k, 30, 48000)
    // the exact mirror of the forward read above: 49, 48, ... 25
    expect(out.slice(0, 25)).toEqual([...Array(25)].map((_, i) => 49 - i))
    expect(out.slice(25)).toEqual([0, 0, 0, 0, 0])
  })

  it('a loop wraps INSIDE the window and never leaks the rest of the buffer', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(100), 48000)
    const k = new SampleKernel('r', true, bank, { start: 0.25, end: 0.5, fade: 0 })
    const out = run(k, 250, 48000) // ten times round the 25-frame window
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(25)
      expect(v).toBeLessThan(50)
    }
    expect(out.slice(0, 25)).toEqual(out.slice(25, 50)) // and it is exactly periodic
    expect(out.slice(0, 25)).toEqual(out.slice(225, 250))
  })

  it('speed composes with the window (2x reads every other frame of the region)', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(100), 48000)
    const k = new SampleKernel('r', false, bank, { start: 0.5, end: 0.75, fade: 0 })
    const out = run(k, 20, 48000, { speed: 2 })
    expect(out.slice(0, 13)).toEqual([50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74])
    expect(out.slice(13)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('windows by FRACTION at 44.1k, with no 48k frame count baked in', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(441), 44100) // 44.1k buffer through a 44.1k engine: 1 frame per sample
    const k = new SampleKernel('r', false, bank, { start: 0.5, end: 0.6, fade: 0 })
    const out = run(k, 50, 44100)
    // 0.5..0.6 of 441 frames = 220.5..264.6, so the read starts interpolated at 220.5
    expect(out[0]).toBeCloseTo(220.5, 4)
    expect(out[44]).toBeCloseTo(264.5, 4)
    expect(out.slice(45)).toEqual(new Array(5).fill(0)) // 44.1 frames of window, then done
  })
})

describe('SampleKernel: slices — the note picks the chop', () => {
  it('maps note numbers to regions, wrapping past the last slice', () => {
    const bank = new SampleBank()
    bank.set('m', marked(), 48000)
    const played = (note: number): number =>
      run(new SampleKernel('m', false, bank, { slices: 8, fade: 0 }), 100, 48000, { pitch: ratio(note) })[50]!
    // the reference note (60) is slice 0; every semitone steps one slice along
    expect([60, 61, 62, 63, 64, 65, 66, 67].map(played)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // ...and it WRAPS both ways: 68 is slice 0 again, 59 is the last slice
    expect(played(68)).toBe(1)
    expect(played(72)).toBe(5)
    expect(played(59)).toBe(8)
    // the wrap is over SLICES, not octaves: 12 semitones down into 8 slices
    // lands on slice 4, not back on slice 0
    expect(played(48)).toBe(5)
  })

  it('a slice plays ONLY its region and stops, at natural speed', () => {
    const bank = new SampleBank()
    bank.set('m', marked(), 48000)
    const k = new SampleKernel('m', false, bank, { slices: 8, fade: 0 })
    const out = run(k, 150, 48000, { pitch: ratio(62) }) // slice 2 = frames 200..299
    expect(out.slice(0, 100)).toEqual(new Array(100).fill(3))
    expect(out.slice(100)).toEqual(new Array(50).fill(0)) // exactly 100 frames, then silence
  })

  it('latches the slice on the gate EDGE — a mid-note pitch change does not jump', () => {
    const bank = new SampleBank()
    bank.set('m', marked(), 48000)
    const k = new SampleKernel('m', false, bank, { slices: 8, fade: 0 })
    const gate = new Float32Array(100).fill(1)
    const pitch = new Float32Array(100).fill(ratio(61))
    pitch.fill(ratio(66), 20) // the pitch input swings mid-hit
    const out = new Float32Array(100)
    k.process(100, { gate, pitch }, out, { sampleRate: 48000 })
    expect([...out]).toEqual(new Array(100).fill(2)) // still slice 1 all the way through
  })

  it('slices divide the start/end WINDOW, not the whole buffer', () => {
    const bank = new SampleBank()
    bank.set('m', marked(), 48000)
    // chop only the back half (frames 400..799) into 4 slices of 100
    const cfg: SampleSliceConfig = { start: 0.5, end: 1, slices: 4, fade: 0 }
    const played = (note: number): number =>
      run(new SampleKernel('m', false, bank, cfg), 100, 48000, { pitch: ratio(note) })[50]!
    expect([60, 61, 62, 63, 64].map(played)).toEqual([5, 6, 7, 8, 5])
  })

  it('reverse + loop stay inside the chosen slice', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(800), 48000)
    const k = new SampleKernel('r', true, bank, { slices: 8, reverse: true, fade: 0 })
    const out = run(k, 400, 48000, { pitch: ratio(63) }) // slice 3 = frames 300..399
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(300)
      expect(v).toBeLessThan(400)
    }
    expect(out[0]).toBe(399) // backwards from the slice end
    expect(out[99]).toBe(300)
    expect(out[100]).toBe(399) // wraps back to the slice end, not the buffer end
  })
})

describe('SampleKernel: edge fades kill the chop click', () => {
  /** Largest sample-to-sample jump over the whole one-shot, counting the step
   *  out of silence at the start and back into silence at the end. That step
   *  IS the click. */
  const maxJump = (out: number[]): number => {
    let m = 0
    let prev = 0
    for (const v of out) {
      m = Math.max(m, Math.abs(v - prev))
      prev = v
    }
    return m
  }

  /** Steepest sample-to-sample step strictly INSIDE [from, to) — the audio's
   *  own slope, with no silence-to-signal edge counted. */
  const maxSlope = (out: number[], from: number, to: number): number => {
    let m = 0
    for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(out[i]! - out[i - 1]!))
    return m
  }

  /** The step into and out of silence at the window edges. */
  const edgeStep = (out: number[]): number => {
    let last = 0
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] !== 0) {
        last = out[i]!
        break
      }
    }
    return Math.max(Math.abs(out[0]!), Math.abs(last))
  }

  it('a 3 ms fade drops the chop discontinuity into the waveform noise floor', () => {
    const SR = 48000
    const bank = new SampleBank()
    // 337 Hz: neither window edge lands on a zero crossing
    bank.set('s', Float32Array.from({ length: SR }, (_, i) => 0.9 * Math.sin((2 * Math.PI * 337 * i) / SR)), SR)
    const win = { start: 0.3111, end: 0.6222 }
    const raw = run(new SampleKernel('s', false, bank, { ...win, fade: 0 }), SR, SR)
    const faded = run(new SampleKernel('s', false, bank, win), SR, SR) // default 3 ms
    // the unfaded chop really does slam out of and back into silence
    expect(edgeStep(raw)).toBeGreaterThan(0.5) // measured 0.8038
    expect(edgeStep(faded)).toBeLessThan(0.01) // measured 0.0045 (a 3 ms ramp on a 0.9 peak)
    expect(edgeStep(faded)).toBeLessThan(edgeStep(raw) / 100) // 180x quieter
    // the waveform's own steepest step is 0.0397 at 337 Hz: unfaded, the chop
    // edge is 20x steeper than anything in the audio; faded, the loudest step
    // in the whole chop IS the waveform's own slope, which is what "no click"
    // means -- there is no longer a discontinuity to hear
    const body = raw.findLastIndex((v) => v !== 0)
    const slope = maxSlope(raw, 100, body - 100)
    expect(maxJump(raw)).toBeGreaterThan(slope * 15)
    expect(maxJump(faded)).toBeLessThanOrEqual(slope)
    // and the fade costs nothing in the body: the middle is untouched
    expect(faded[SR / 4]).toBeCloseTo(raw[SR / 4]!, 6)
  })

  it('the fade never exceeds unity and covers both window edges', () => {
    const bank = new SampleBank()
    bank.set('dc', new Float32Array(1000).fill(1), 48000)
    const out = run(new SampleKernel('dc', false, bank, { start: 0.25, end: 0.75 }), 520, 48000)
    for (const v of out) expect(v).toBeLessThanOrEqual(1)
    expect(out[0]).toBeCloseTo(0, 6) // ramps up out of silence
    expect(out[499]).toBeLessThan(0.02) // and back down into it
    expect(out[250]).toBe(1) // full level through the body (3 ms of a 500-frame window)
  })

  it('a window shorter than two fades gets a triangle, never a gain above 1', () => {
    const bank = new SampleBank()
    bank.set('dc', new Float32Array(1000).fill(1), 48000)
    // a 20-frame window: 3 ms would be 144 frames, so the fade caps at half the window
    const out = run(new SampleKernel('dc', false, bank, { start: 0, end: 0.02 }), 25, 48000)
    for (const v of out) expect(v).toBeLessThanOrEqual(1)
    expect(Math.max(...out)).toBeCloseTo(1, 6) // peaks in the middle
    expect(out[0]).toBeCloseTo(0, 6)
    expect(out[19]).toBeLessThan(0.2)
  })

  it('un-sliced playback is untouched: no fade unless you ask for one', () => {
    const bank = new SampleBank()
    bank.set('dc', new Float32Array(8).fill(1), 48000)
    expect(run(new SampleKernel('dc', false, bank), 8, 48000)).toEqual(new Array(8).fill(1))
    // ...but an explicit fade applies even to a whole-buffer read
    const faded = run(new SampleKernel('dc', false, bank, { fade: 4 / 48000 }), 8, 48000)
    expect(faded[0]).toBeCloseTo(0, 6)
    expect(faded[4]).toBe(1)
  })
})

describe('SampleKernel: slice guards cannot poison playback', () => {
  const whole = [0, 1, 2, 3, 4, 5, 6, 7]

  it('an inverted or degenerate window falls back to the whole buffer', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(8), 48000)
    for (const cfg of [{ start: 0.8, end: 0.2 }, { start: 0.5, end: 0.5 }, { start: 1, end: 1 }]) {
      expect(run(new SampleKernel('r', false, bank, { ...cfg, fade: 0 }), 8, 48000)).toEqual(whole)
    }
  })

  it('NaN / Infinity / out-of-range window bounds fall back to the whole buffer', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(8), 48000)
    for (const cfg of [
      { start: NaN, end: 1 },
      { start: 0, end: NaN },
      { start: -5, end: 9 },
      { start: 0, end: Infinity },
    ]) {
      const out = run(new SampleKernel('r', false, bank, { ...cfg, fade: 0 }), 8, 48000)
      expect(out.every(Number.isFinite)).toBe(true)
      expect(out).toEqual(whole)
    }
  })

  it('a sub-frame window still plays (it cannot be read, so the whole buffer is)', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(8), 48000)
    const out = run(new SampleKernel('r', false, bank, { start: 0.5, end: 0.51, fade: 0 }), 8, 48000)
    expect(out).toEqual(whole)
  })

  it('a NaN pitch or a garbage slice count never reads outside the buffer', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(800), 48000)
    for (const pitch of [NaN, -1, 0, Infinity, 1e9]) {
      const out = run(new SampleKernel('r', false, bank, { slices: 8, fade: 0 }), 200, 48000, { pitch })
      expect(out.every(Number.isFinite)).toBe(true)
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThan(800)
      }
    }
    // more slices than frames: clamped, so a slice is never sub-frame
    const tiny = new SampleKernel('r', false, bank, { slices: 100000, fade: 0 })
    expect(run(tiny, 16, 48000, { pitch: 1 }).every(Number.isFinite)).toBe(true)
  })

  it('a NaN speed inside a slice recovers without leaving the slice', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(800), 48000)
    const k = new SampleKernel('r', true, bank, { start: 0.25, end: 0.5, fade: 0 })
    const gate = new Float32Array(600).fill(1)
    const speed = new Float32Array(600).fill(1)
    speed[5] = NaN
    const out = new Float32Array(600)
    k.process(600, { gate, speed }, out, { sampleRate: 48000 })
    for (let i = 50; i < 600; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true)
      expect(out[i]!).toBeGreaterThanOrEqual(200)
      expect(out[i]!).toBeLessThan(400)
    }
  })
})

describe('sample() slicing through synth() + renderOffline', () => {
  it('rejects a window it could never play, at build time', () => {
    expect(() => synth(({ gate, sample }) => sample(gate, 's', { start: 0.6, end: 0.2 }))).toThrow(
      /end \(0\.2\) must be greater than start \(0\.6\)/,
    )
    expect(() => synth(({ gate, sample }) => sample(gate, 's', { start: 2 }))).toThrow(/fraction of the buffer in 0\.\.1/)
    expect(() => synth(({ gate, sample }) => sample(gate, 's', { end: NaN }))).toThrow(/fraction of the buffer in 0\.\.1/)
    expect(() => synth(({ gate, sample }) => sample(gate, 's', { slices: 0 }))).toThrow(/whole number of slices/)
    expect(() => synth(({ gate, sample }) => sample(gate, 's', { slices: 3.5 }))).toThrow(/whole number of slices/)
    expect(() => synth(({ gate, sample }) => sample(gate, 's', { fade: -1 }))).toThrow(/seconds >= 0/)
  })

  it('renders the chop the NOTE selected — each slice is its own tone', () => {
    const SR = 48000
    // four 0.25 s regions, each a different pitch: 400 / 800 / 1200 / 1600 Hz
    const hz = [400, 800, 1200, 1600]
    const region = SR / 4
    const buf = Float32Array.from({ length: SR }, (_, i) =>
      0.9 * Math.sin((2 * Math.PI * hz[(i / region) | 0]! * (i % region)) / SR),
    )
    const def = synth(({ gate, sample, adsr }) =>
      sample(gate, 'chop', { slices: 4 }).mul(adsr(gate, { a: 0.002, d: 0.2, s: 1, r: 0.01 })),
    )
    const heard = (note: number): number[] => {
      const events: RenderEvent[] = [
        { time: 0, type: 'noteOn', note, velocity: 1 },
        { time: 0.2, type: 'noteOff', note },
      ]
      const r = renderOffline(def, events, 0.25, { sampleRate: SR, samples: { chop: { data: buf, sampleRate: SR } } })
      const w = r.left.subarray(Math.round(0.03 * SR), Math.round(0.18 * SR))
      return hz.map((f) => goertzel(w, f, SR))
    }
    // 60 -> slice 0 -> 400 Hz, 61 -> 800, 62 -> 1200, 63 -> 1600, 64 wraps to 400
    for (const [i, note] of [60, 61, 62, 63].entries()) {
      const bins = heard(note)
      expect(bins.indexOf(Math.max(...bins)), `note ${note} should sound region ${i}`).toBe(i)
      expect(bins[i]!).toBeGreaterThan(bins[(i + 1) % 4]! * 20)
    }
    const wrapped = heard(64)
    expect(wrapped.indexOf(Math.max(...wrapped))).toBe(0)
  })

  it('start/end + reverse survive the offline render, sample for sample', () => {
    const SR = 48000
    // a slow ramp so "backwards" is unmistakable in the rendered signal
    const buf = Float32Array.from({ length: SR }, (_, i) => (i / SR) * 1.8 - 0.9)
    const render = (reverse: boolean): Float32Array =>
      renderOffline(
        synth(({ gate, sample }) => sample(gate, 'r', { start: 0.25, end: 0.75, reverse, fade: 0 })),
        [{ time: 0, type: 'noteOn', note: 60, velocity: 1 }],
        0.6, // the window is 0.5 s long, so the tail proves it STOPS there
        { sampleRate: SR, samples: { r: { data: buf, sampleRate: SR } } },
      ).left
    const fwd = render(false)
    const rev = render(true)
    // the window is the middle HALF of the buffer: it runs for exactly SR/2
    // samples and its midpoint is the buffer's midpoint, where the ramp is 0
    expect(fwd[SR / 4]!).toBeCloseTo(0, 3)
    expect(fwd[SR / 2 + 100]!).toBe(0)
    expect(fwd[0]!).toBeLessThan(-0.2) // rising through the window
    expect(fwd[SR / 2 - 2]!).toBeGreaterThan(0.2)
    expect(fwd[0]!).toBeCloseTo(-fwd[SR / 2 - 2]!, 3)
    // ...and the reverse read is its exact mirror (the ramp is odd about 0)
    expect(rev[SR / 2 + 100]!).toBe(0)
    for (let i = 0; i < SR / 2 - 4; i += 997) expect(rev[i]!).toBeCloseTo(-fwd[i]!, 4)
  })
})
