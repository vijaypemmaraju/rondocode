import { describe, expect, it } from 'vitest'
import { SampleKernel } from '../src/dsp/sample'
import { SampleBank } from '../src/samples'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'
import type { RenderEvent } from '../src/render'
import { goertzel } from './util/goertzel'

/** Run a kernel over n samples with a constant-on gate that rises at i=0
 *  (prevGate starts 0), optional constant speed. Returns the output. */
const run = (
  k: SampleKernel,
  n: number,
  sampleRate: number,
  opts?: { speed?: number; gate?: Float32Array },
): number[] => {
  const gate = opts?.gate ?? new Float32Array(n).fill(1)
  const inputs: Record<string, Float32Array> = { gate }
  if (opts?.speed !== undefined) inputs['speed'] = new Float32Array(n).fill(opts.speed)
  const out = new Float32Array(n)
  k.process(n, inputs, out, { sampleRate })
  return [...out]
}

const ramp = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => i)

describe('SampleKernel', () => {
  it('plays a buffer back frame-for-frame at natural rate, then one-shot silence', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(8), 48000)
    const out = run(new SampleKernel('r', false, bank), 10, 48000)
    expect(out.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(out.slice(8)).toEqual([0, 0]) // one-shot: past the end -> silence
  })

  it('pitches up: speed 2 reads every other frame', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(8), 48000)
    const out = run(new SampleKernel('r', false, bank), 6, 48000, { speed: 2 })
    expect(out.slice(0, 4)).toEqual([0, 2, 4, 6])
    expect(out.slice(4)).toEqual([0, 0])
  })

  it('resamples on sample-rate mismatch (24k in 48k plays natural pitch)', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(8), 24000) // half the engine rate -> advance 0.5/sample
    const out = run(new SampleKernel('r', false, bank), 8, 48000)
    // linear interp at 0, 0.5, 1, 1.5, ...
    expect(out).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5])
  })

  it('loops when loop=true (wraps at the end)', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(4), 48000)
    const out = run(new SampleKernel('r', true, bank), 9, 48000)
    expect(out).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0])
  })

  it('retriggers from the start on a fresh gate edge (one-shot plays through note-off)', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(8), 48000)
    const k = new SampleKernel('r', false, bank)
    // gate on for 3, off for 1, on again. A one-shot IGNORES the note-off and
    // keeps reading (drums finish their sample; gating is the amp env's job) —
    // so it reads 0,1,2,3 straight through, then the rising edge at i=4 resets
    // the read head to 0 -> 0,1,2,3 again.
    const gate = Float32Array.from([1, 1, 1, 0, 1, 1, 1, 0])
    const out = run(k, 8, 48000, { gate })
    expect(out).toEqual([0, 1, 2, 3, 0, 1, 2, 3])
  })

  it('a missing/unloaded sample is silence, not a crash', () => {
    const out = run(new SampleKernel('nope', false, new SampleBank()), 4, 48000)
    expect(out).toEqual([0, 0, 0, 0])
    // no bank at all
    const out2 = run(new SampleKernel('nope', false, undefined), 4, 48000)
    expect(out2).toEqual([0, 0, 0, 0])
  })

  it('scrubs non-finite sample data to 0 on load', () => {
    const bank = new SampleBank()
    bank.set('bad', Float32Array.from([1, NaN, Infinity, 2]), 48000)
    const out = run(new SampleKernel('bad', false, bank), 4, 48000)
    expect(out.every(Number.isFinite)).toBe(true)
    expect(out).toEqual([1, 0, 0, 2])
  })
})

describe('sample() through synth() + renderOffline', () => {
  it('a sample synth renders audible output; root tracks pitch (octave up reads 2x)', () => {
    // a recognizable source: a 500 Hz sine, so playback speed is measurable
    // as the output's frequency (Goertzel), not just "some sound came out".
    const SR = 48000
    const buf = Float32Array.from({ length: SR / 2 }, (_, i) => Math.sin((2 * Math.PI * 500 * i) / SR))
    const def = synth(({ gate, sample }) => sample(gate, 'tone', { root: 60 }))
    const render = (note: number) =>
      renderOffline(
        def,
        [{ time: 0, type: 'noteOn', note, velocity: 1 }, { time: 0.4, type: 'noteOff', note }],
        0.45,
        { sampleRate: SR, samples: { tone: { data: buf, sampleRate: SR } } },
      )
    const win = (r: { left: Float32Array }) => r.left.subarray(Math.round(0.05 * SR), Math.round(0.2 * SR))
    const atRoot = win(render(60)) // note == root -> natural speed -> 500 Hz
    const octUp = win(render(72)) // root + 12 -> 2x speed -> 1000 Hz
    // natural pitch at the root: 500 Hz dominates, no energy at 1000
    expect(goertzel(atRoot, 500, SR)).toBeGreaterThan(goertzel(atRoot, 1000, SR) * 100)
    // an octave above the root reads ~2x: the tone lands at 1000 Hz, not 500
    expect(goertzel(octUp, 1000, SR)).toBeGreaterThan(goertzel(octUp, 500, SR) * 100)
    // and both actually made sound
    let peak = 0
    for (let i = 0; i < atRoot.length; i++) peak = Math.max(peak, Math.abs(atRoot[i]!))
    expect(peak).toBeGreaterThan(0.05)
    expect(atRoot.every(Number.isFinite)).toBe(true)
    expect(octUp.every(Number.isFinite)).toBe(true)
  })

  it('an unknown sample name renders silence without throwing', () => {
    const def = synth(({ gate, sample }) => sample(gate, 'missing'))
    const r = renderOffline(def, [{ time: 0, type: 'noteOn', note: 60 }], 0.1, { sampleRate: 48000 })
    let peak = 0
    for (let i = 0; i < r.left.length; i++) peak = Math.max(peak, Math.abs(r.left[i]!))
    expect(peak).toBe(0)
  })
})

describe('SampleKernel: NaN / out-of-bounds hygiene', () => {
  it('reverse (negative) speed stays finite — loop wraps both directions', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(100), 48000)
    const out = run(new SampleKernel('r', true, bank), 600, 48000, { speed: -1 })
    expect(out.every(Number.isFinite)).toBe(true)
  })

  it('a one-shot with negative speed stops cleanly (no NaN, no dead voice)', () => {
    const bank = new SampleBank()
    // offset ramp (100..199) so "playing the buffer" is distinguishable from 0
    bank.set('r', Float32Array.from({ length: 100 }, (_, i) => 100 + i), 48000)
    const k = new SampleKernel('r', false, bank)
    const out = run(k, 600, 48000, { speed: -1 })
    expect(out.every(Number.isFinite)).toBe(true)
    // stops CLEANLY: it reads frame 0 once, runs off the front, and the whole
    // tail is actual silence (zeros), not garbage or a stuck read head
    expect(out[0]).toBe(100)
    for (let i = 1; i < out.length; i++) expect(out[i]).toBe(0)
    // ...and the voice is not dead: a fresh gate edge on the SAME kernel
    // retriggers from the start and sounds again
    const gate = new Float32Array(8)
    gate.fill(1, 4) // low for 4 samples (clears prevGate), then a rising edge
    const again = run(k, 8, 48000, { gate })
    expect(again.slice(0, 4)).toEqual([0, 0, 0, 0])
    expect(again.slice(4)).toEqual([100, 101, 102, 103])
  })

  it('a transient NaN speed does not permanently poison the voice', () => {
    const bank = new SampleBank()
    bank.set('r', ramp(100), 48000)
    const k = new SampleKernel('r', true, bank)
    const gate = new Float32Array(600).fill(1)
    const speed = new Float32Array(600).fill(1)
    speed[5] = NaN
    const out = new Float32Array(600)
    k.process(600, { gate, speed }, out, { sampleRate: 48000 })
    expect([...out.slice(50)].every(Number.isFinite)).toBe(true) // recovered after the NaN
  })
})
