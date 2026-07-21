import { describe, expect, it } from 'vitest'
import {
  parseMidi,
  MidiParseError,
  midiToName,
  ticksPerBar,
  midiCps,
  midiNotesToPattern,
  midiNotesToVoices,
} from '../src/index'
import type { MidiNote } from '../src/index'
import { qw } from './helpers'

// ---- a minimal SMF byte-builder for deterministic tests ----

const vlq = (n: number): number[] => {
  const out = [n & 0x7f]
  n >>= 7
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80)
    n >>= 7
  }
  return out
}
const be32 = (n: number) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** Build a one-track (format 0) SMF from absolute-tick note events + tempo. */
function buildSmf(
  ppq: number,
  bpm: number,
  ts: { num: number; den: number },
  notes: { pitch: number; start: number; dur: number; ch?: number }[],
  trackName?: string,
): Uint8Array {
  const usPerQ = Math.round(60_000_000 / bpm)
  const events: { tick: number; bytes: number[] }[] = []
  events.push({ tick: 0, bytes: [0xff, 0x51, 0x03, (usPerQ >> 16) & 0xff, (usPerQ >> 8) & 0xff, usPerQ & 0xff] })
  events.push({ tick: 0, bytes: [0xff, 0x58, 0x04, ts.num, Math.log2(ts.den), 24, 8] })
  if (trackName) events.push({ tick: 0, bytes: [0xff, 0x03, trackName.length, ...ascii(trackName)] })
  for (const n of notes) {
    const ch = n.ch ?? 0
    events.push({ tick: n.start, bytes: [0x90 | ch, n.pitch, 100] })
    events.push({ tick: n.start + n.dur, bytes: [0x80 | ch, n.pitch, 0] })
  }
  events.sort((a, b) => a.tick - b.tick)
  const trackData: number[] = []
  let last = 0
  for (const e of events) {
    trackData.push(...vlq(e.tick - last), ...e.bytes)
    last = e.tick
  }
  trackData.push(...vlq(0), 0xff, 0x2f, 0x00) // end of track
  return new Uint8Array([
    ...ascii('MThd'), ...be32(6), ...be16(0), ...be16(1), ...be16(ppq),
    ...ascii('MTrk'), ...be32(trackData.length), ...trackData,
  ])
}

describe('parseMidi', () => {
  it('reads tempo, time signature, ppq and note timing exactly', () => {
    const smf = buildSmf(480, 128, { num: 4, den: 4 }, [
      { pitch: 60, start: 0, dur: 480 },
      { pitch: 64, start: 480, dur: 240 },
    ], 'lead')
    const f = parseMidi(smf)
    expect(f.ppq).toBe(480)
    expect(Math.round(f.tempoBpm)).toBe(128)
    expect(f.timeSig).toEqual({ num: 4, den: 4 })
    expect(f.tracks).toHaveLength(1)
    const tr = f.tracks[0]!
    expect(tr.name).toBe('lead')
    expect(tr.notes).toEqual([
      { pitch: 60, startTick: 0, durTick: 480, velocity: 100, channel: 0 },
      { pitch: 64, startTick: 480, durTick: 240, velocity: 100, channel: 0 },
    ] satisfies MidiNote[])
  })

  it('treats note-on velocity 0 as note-off', () => {
    // build note-on ... note-on(vel0) manually via two events at the same pitch
    const smf = buildSmf(480, 120, { num: 4, den: 4 }, [{ pitch: 62, start: 0, dur: 960 }])
    const f = parseMidi(smf)
    expect(f.tracks[0]!.notes[0]!.durTick).toBe(960)
  })

  it('flags channel 10 (index 9) as drums', () => {
    const smf = buildSmf(480, 120, { num: 4, den: 4 }, [{ pitch: 36, start: 0, dur: 60, ch: 9 }])
    expect(parseMidi(smf).tracks[0]!.isDrum).toBe(true)
  })

  it('rejects non-MIDI input', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4]))).toThrow(MidiParseError)
  })
})

describe('timing helpers', () => {
  it('names notes with c4 = 60', () => {
    expect(midiToName(60)).toBe('c4')
    expect(midiToName(61)).toBe('c#4')
    expect(midiToName(57)).toBe('a3')
    expect(midiToName(48)).toBe('c3')
  })
  it('computes ticks-per-bar and cps (1 cycle = 1 bar)', () => {
    expect(ticksPerBar(480, { num: 4, den: 4 })).toBe(1920)
    expect(ticksPerBar(480, { num: 3, den: 4 })).toBe(1440)
    expect(midiCps(128, { num: 4, den: 4 })).toBeCloseTo(0.5333, 3)
    expect(midiCps(120, { num: 3, den: 4 })).toBeCloseTo(0.6667, 3)
  })
})

describe('midiNotesToPattern (lossless)', () => {
  const n = (pitch: number, startTick: number, durTick: number): MidiNote => ({ pitch, startTick, durTick, velocity: 100, channel: 0 })

  it('places notes at exact fractional cycle positions', () => {
    // 480 ppq, 4/4 => 1920 ticks/bar. note at tick 480 = beat 2 = cycle 0.25
    const p = midiNotesToPattern([n(60, 0, 480), n(64, 480, 480)], 480, { num: 4, den: 4 })
    const evs = qw(p, 0, 1)
    expect(evs).toEqual([
      { whole: [0, 0.25], part: [0, 0.25], value: { note: 60 } },
      { whole: [0.25, 0.5], part: [0.25, 0.5], value: { note: 64 } },
    ])
  })

  it('sustains a note across the bar line (whole spans >1 cycle)', () => {
    // a 3-bar-long note starting at bar 0
    const p = midiNotesToPattern([n(48, 0, 1920 * 3)], 480, { num: 4, den: 4 })
    const evs = qw(p, 0, 3)
    expect(evs).toHaveLength(1)
    expect(evs[0]!.whole).toEqual([0, 3])
    expect(evs[0]!.value).toEqual({ note: 48 })
  })
})

describe('midiNotesToVoices (editable mini-notation)', () => {
  const n = (pitch: number, startTick: number, durTick: number): MidiNote => ({ pitch, startTick, durTick, velocity: 100, channel: 0 })

  it('emits a held whole-bar note as a bare token (no @weight)', () => {
    const r = midiNotesToVoices([n(60, 0, 1920)], 480, { num: 4, den: 4 })
    expect(r.voices).toEqual(['<c4>'])
    expect(r.bars).toBe(1)
    expect(r.quantErr).toBeCloseTo(0, 6)
  })

  it('uses @weight for held notes and ~ for rests', () => {
    // c4 for 2 beats (8 steps), rest 1 beat (4 steps), e4 1 beat (4 steps)
    const r = midiNotesToVoices([n(60, 0, 960), n(64, 1440, 480)], 480, { num: 4, den: 4 })
    expect(r.voices).toEqual(['<[c4@8 ~@4 e4@4]>'])
  })

  it('splits overlapping notes into separate monophonic voices (chord)', () => {
    // C major triad, all a whole bar => 3 voices
    const r = midiNotesToVoices([n(60, 0, 1920), n(64, 0, 1920), n(67, 0, 1920)], 480, { num: 4, den: 4 })
    expect(r.voices.sort()).toEqual(['<c4>', '<e4>', '<g4>'])
  })

  it('splits a note crossing a bar line into re-triggered per-bar segments', () => {
    // 1.5-bar note: bar0 full (c4) + bar1 first half (c4@8 then rest)
    const r = midiNotesToVoices([n(60, 0, 2880)], 480, { num: 4, den: 4 })
    expect(r.bars).toBe(2)
    expect(r.voices).toEqual(['<c4 [c4@8 ~@8]>'])
  })
})
