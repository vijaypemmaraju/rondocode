import { describe, expect, it } from 'vitest'
import { bpmToCps, cpsToBpm, midiCps, quartersPerBar, ticksPerBar } from '../src/index'

/* The BPM face of the engine's cps truth. One cycle is one BAR everywhere in
 * this codebase (mini-notation, the scheduler, MIDI import and export), so the
 * conversion only ever needs to know how many beats that bar holds. These
 * tests pin the numbers producers actually type, the exact round trip, and the
 * agreement with the MIDI helpers — the one place the same convention was
 * already written down. */

describe('quartersPerBar: how long a bar is', () => {
  it('counts QUARTER notes, so 6/8 and 3/4 are the same length', () => {
    expect(quartersPerBar({ num: 4, den: 4 })).toBe(4)
    expect(quartersPerBar({ num: 3, den: 4 })).toBe(3)
    // six eighths and three quarters are the same amount of music; they differ
    // in how you count them, which is the metronome's problem, not the clock's
    expect(quartersPerBar({ num: 6, den: 8 })).toBe(3)
    expect(quartersPerBar({ num: 7, den: 8 })).toBe(3.5)
    expect(quartersPerBar({ num: 5, den: 4 })).toBe(5)
    expect(quartersPerBar({ num: 2, den: 2 })).toBe(4)
  })

  it('defaults to 4/4 when nobody said otherwise', () => {
    expect(quartersPerBar()).toBe(4)
  })

  it('is the ONE definition ticksPerBar and midiCps are built from', () => {
    // a second copy of this arithmetic is how a project and its exported file
    // end up disagreeing about where bar two starts
    for (const sig of [{ num: 4, den: 4 }, { num: 3, den: 4 }, { num: 7, den: 8 }, { num: 6, den: 8 }]) {
      expect(ticksPerBar(480, sig)).toBe(480 * quartersPerBar(sig))
      expect(midiCps(120, sig)).toBeCloseTo(bpmToCps(120, quartersPerBar(sig)), 12)
    }
  })
})

describe('bpmToCps / cpsToBpm', () => {
  it('converts the tempos producers type, 4 beats to the bar', () => {
    expect(bpmToCps(120)).toBeCloseTo(0.5, 10)
    // the arithmetic everyone was doing by hand: 128 bpm is the 0.5333 in the
    // examples (a rounded cps, hence the 4-decimal tolerance)
    expect(bpmToCps(128)).toBeCloseTo(0.5333, 4)
    expect(bpmToCps(174)).toBeCloseTo(0.725, 10)
    expect(bpmToCps(90)).toBeCloseTo(0.375, 10)
  })

  it('reads a cps back as BPM', () => {
    expect(cpsToBpm(0.5)).toBeCloseTo(120, 10)
    expect(cpsToBpm(0.5333)).toBeCloseTo(127.992, 3)
    expect(cpsToBpm(0.725)).toBeCloseTo(174, 10)
  })

  it('round-trips both ways, at every beat count', () => {
    for (const beats of [2, 3, 4, 5, 6, 7, 12]) {
      for (const bpm of [60, 90, 120, 128, 140, 174, 200]) {
        expect(cpsToBpm(bpmToCps(bpm, beats), beats)).toBeCloseTo(bpm, 10)
      }
      for (const cps of [0.05, 0.25, 0.5333, 1, 2.5, 4]) {
        expect(bpmToCps(cpsToBpm(cps, beats), beats)).toBeCloseTo(cps, 12)
      }
    }
  })

  it('a longer bar at the same BPM is a slower cycle', () => {
    // 120 bpm: a 3/4 bar is 1.5 s (cps 2/3), a 4/4 bar 2 s (cps 0.5)
    expect(bpmToCps(120, 3)).toBeCloseTo(2 / 3, 10)
    expect(bpmToCps(120, 4)).toBeCloseTo(0.5, 10)
    expect(bpmToCps(120, 6)).toBeCloseTo(1 / 3, 10)
    // and the reading is symmetric: the same cycle rate is a faster BPM when
    // you count more beats into the bar
    expect(cpsToBpm(0.5, 3)).toBeCloseTo(90, 10)
    expect(cpsToBpm(0.5, 6)).toBeCloseTo(180, 10)
  })

  it('agrees with the MIDI helpers: beatsPerBar is the bar in QUARTER notes', () => {
    // midiCps is bpmToCps with the beat count read off the time signature, so
    // `bpm 128` and a 128 bpm import land on the exact same cps.
    for (const ts of [{ num: 4, den: 4 }, { num: 3, den: 4 }, { num: 6, den: 8 }, { num: 7, den: 16 }, { num: 5, den: 2 }]) {
      const quartersPerBar = (ts.num * 4) / ts.den
      for (const bpm of [90, 120, 128, 174]) {
        expect(bpmToCps(bpm, quartersPerBar)).toBe(midiCps(bpm, ts))
        // and the exporter's contract, whatever the meter: cps = (ticks/sec) / ticksPerBar
        expect(bpmToCps(bpm, quartersPerBar)).toBeCloseTo(((bpm / 60) * 480) / ticksPerBar(480, ts), 10)
      }
    }
    // the default really is plain 4/4
    expect(bpmToCps(128)).toBe(midiCps(128, { num: 4, den: 4 }))
    expect(cpsToBpm(0.5333)).toBe(0.5333 * 60 * 4)
  })
})
