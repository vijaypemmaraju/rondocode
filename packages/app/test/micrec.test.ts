import { describe, expect, it } from 'vitest'
import { nextMicName, normalize, toMono, trimSilence } from '../src/editor/micrec'

/* Pure parts of mic sampling: downmix, silence trim, normalize, naming. */

describe('toMono', () => {
  it('averages channels', () => {
    const buf = {
      numberOfChannels: 2,
      length: 3,
      getChannelData: (c: number) => (c === 0 ? new Float32Array([1, 0, 0.5]) : new Float32Array([0, 1, 0.5])),
    }
    expect([...toMono(buf)]).toEqual([0.5, 0.5, 0.5])
  })
  it('passes mono through unchanged', () => {
    const buf = { numberOfChannels: 1, length: 2, getChannelData: () => new Float32Array([0.25, -0.25]) }
    expect([...toMono(buf)]).toEqual([0.25, -0.25])
  })
})

describe('trimSilence', () => {
  it('cuts leading and trailing silence, keeping a pre-roll', () => {
    const data = new Float32Array(1000)
    data[500] = 0.5
    data[600] = 0.5
    const out = trimSilence(data, 0.02, 10)
    expect(out.length).toBe(600 + 10 - (500 - 10)) // [490, 610)
    expect(out[10]).toBe(0.5)
  })
  it('clamps the pre-roll at the buffer edges', () => {
    const data = new Float32Array([0.5, 0, 0, 0.5])
    expect(trimSilence(data, 0.02, 256).length).toBe(4)
  })
  it('keeps an all-quiet take as-is (never trims to nothing)', () => {
    const data = new Float32Array(64)
    expect(trimSilence(data)).toBe(data)
  })
})

describe('normalize', () => {
  it('brings a quiet take up to the target peak', () => {
    const data = new Float32Array([0.1, -0.05])
    normalize(data, 0.9)
    expect(data[0]).toBeCloseTo(0.9)
    expect(data[1]).toBeCloseTo(-0.45)
  })
  it('brings a hot take DOWN to the target too', () => {
    const data = new Float32Array([2, -1])
    normalize(data, 0.9)
    expect(data[0]).toBeCloseTo(0.9)
  })
  it('leaves digital silence alone (no divide-by-zero blowup)', () => {
    const data = new Float32Array(8)
    normalize(data)
    expect([...data]).toEqual(new Array(8).fill(0))
  })
})

describe('nextMicName', () => {
  it('picks the first free micN', () => {
    expect(nextMicName([])).toBe('mic1')
    expect(nextMicName(['mic1', 'kick', 'mic3'])).toBe('mic2')
    expect(nextMicName(['mic1', 'mic2', 'mic3'])).toBe('mic4')
  })
})
