import { describe, expect, it } from 'vitest'
import { note } from '../src/index'
import type { ControlMap } from '../src/index'
import { q } from './helpers'

const gains = (evs: [number, number, unknown][]): (number | undefined)[] =>
  evs.map((e) => (e[2] as ControlMap).gain)
const pans = (evs: [number, number, unknown][]): (number | undefined)[] =>
  evs.map((e) => (e[2] as ControlMap).pan)
const begins = (evs: [number, number, unknown][]): number[] => evs.map((e) => e[0])

// only the events that actually fire (onsets), which is what the scheduler
// plays; late copies also leave non-onset tails from the previous cycle.
describe('echo', () => {
  it('layers count taps, each `time` cycles later and `feedback` quieter', () => {
    const evs = q(note('c4').echo(3, 0.25, 0.5).onsetsOnly(), 0, 1)
    expect(evs.length).toBe(3)
    expect(begins(evs)).toEqual([0, 0.25, 0.5]) // dry, +1/4, +1/2
    expect(gains(evs)).toEqual([undefined, 0.5, 0.25]) // 1, 1/2, 1/4
    for (const e of evs) expect((e[2] as ControlMap).note).toBe(60)
  })

  it('multiplies any gain already set (does not overwrite it)', () => {
    const evs = q(note('c4').gain(0.8).echo(2, 0.5, 0.5).onsetsOnly(), 0, 1)
    expect(gains(evs)).toEqual([0.8, 0.4]) // 0.8, 0.8 * 0.5
  })

  it('defaults feedback to 0.5 and count>=1', () => {
    expect(q(note('c4').echo(1, 0.25).onsetsOnly(), 0, 1).length).toBe(1) // just the dry tap
    expect(gains(q(note('c4').echo(2, 0.25).onsetsOnly(), 0, 1))).toEqual([undefined, 0.5])
  })
})

describe('ping', () => {
  it('alternates the taps right/left for a ping-pong stereo delay', () => {
    const evs = q(note('c4').ping(3, 0.25, 0.5).onsetsOnly(), 0, 1)
    expect(begins(evs)).toEqual([0, 0.25, 0.5])
    expect(gains(evs)).toEqual([undefined, 0.5, 0.25])
    expect(pans(evs)).toEqual([undefined, 0.85, 0.15]) // dry centered, then R, L
  })
})
