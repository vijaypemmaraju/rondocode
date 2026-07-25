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
  trackData.push(...EOT)
  return smfRaw(ppq, 0, [trackData])
}

/** Wrap raw track-data byte arrays in MThd/MTrk headers — for byte-level
 *  cases buildSmf cannot express (running status, vel-0 note-offs, sysex...). */
function smfRaw(ppq: number, format: number, trackDatas: number[][]): Uint8Array {
  const out = [...ascii('MThd'), ...be32(6), ...be16(format), ...be16(trackDatas.length), ...be16(ppq)]
  for (const td of trackDatas) out.push(...ascii('MTrk'), ...be32(td.length), ...td)
  return new Uint8Array(out)
}
const EOT = [0x00, 0xff, 0x2f, 0x00] // delta 0 + end-of-track meta
const TEMPO_120 = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] // 500000 µs/quarter

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

  it('treats a 0x90 with velocity 0 as note-off (no real 0x80 in the file)', () => {
    const smf = smfRaw(480, 0, [[
      0x00, 0x90, 62, 100, // note on d4
      ...vlq(960), 0x90, 62, 0, // note ON status, velocity 0 = note off
      ...EOT,
    ]])
    expect(parseMidi(smf).tracks[0]!.notes).toEqual([
      { pitch: 62, startTick: 0, durTick: 960, velocity: 100, channel: 0 },
    ] satisfies MidiNote[])
  })

  it('flags channel 10 (index 9) as drums', () => {
    const smf = buildSmf(480, 120, { num: 4, den: 4 }, [{ pitch: 36, start: 0, dur: 60, ch: 9 }])
    expect(parseMidi(smf).tracks[0]!.isDrum).toBe(true)
  })

  it('rejects non-MIDI input', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4]))).toThrow(MidiParseError)
  })
})

describe('parseMidi: wire-format edge cases', () => {
  it('supports running status (data bytes reuse the previous status)', () => {
    const smf = smfRaw(480, 0, [[
      0x00, 0x90, 60, 100, // note on, establishes running status 0x90
      ...vlq(240), 60, 0, // no status byte: running 0x90, vel 0 closes c4
      0x00, 64, 100, // running 0x90: e4 on
      ...vlq(240), 0x80, 64, 64, // explicit off (with release velocity)
      ...EOT,
    ]])
    expect(parseMidi(smf).tracks[0]!.notes).toEqual([
      { pitch: 60, startTick: 0, durTick: 240, velocity: 100, channel: 0 },
      { pitch: 64, startTick: 240, durTick: 240, velocity: 100, channel: 0 },
    ] satisfies MidiNote[])
  })

  it('reads a format-1 file: conductor track + one track per part', () => {
    const usPerQ = Math.round(60_000_000 / 90)
    const conductor = [
      0x00, 0xff, 0x51, 0x03, (usPerQ >> 16) & 0xff, (usPerQ >> 8) & 0xff, usPerQ & 0xff,
      0x00, 0xff, 0x58, 0x04, 3, 2, 24, 8, // 3/4
      ...EOT,
    ]
    const part1 = [0x00, 0x90, 60, 100, ...vlq(480), 0x80, 60, 0, ...EOT]
    const part2 = [0x00, 0x91, 72, 80, ...vlq(240), 0x81, 72, 0, ...EOT]
    const f = parseMidi(smfRaw(480, 1, [conductor, part1, part2]))
    expect(f.format).toBe(1)
    expect(f.tracks).toHaveLength(3)
    expect(Math.round(f.tempoBpm)).toBe(90) // tempo from the conductor track applies file-wide
    expect(f.timeSig).toEqual({ num: 3, den: 4 })
    expect(f.tracks[0]!.notes).toEqual([])
    expect(f.tracks[1]!.notes).toEqual([
      { pitch: 60, startTick: 0, durTick: 480, velocity: 100, channel: 0 },
    ] satisfies MidiNote[])
    expect(f.tracks[2]!.notes).toEqual([
      { pitch: 72, startTick: 0, durTick: 240, velocity: 80, channel: 1 },
    ] satisfies MidiNote[])
    expect(f.tracks[2]!.channel).toBe(1)
  })

  it('skips sysex, CC, pitch-bend, aftertouch and channel pressure without derailing', () => {
    const smf = smfRaw(480, 0, [[
      0x00, 0xf0, ...vlq(3), 0x01, 0x02, 0xf7, // sysex, length-prefixed
      0x00, 0xb0, 7, 100, // CC 7 (volume)
      0x00, 0xe0, 0x00, 0x40, // pitch bend center
      0x00, 0x90, 60, 90, // the actual note
      0x00, 0xa0, 60, 50, // poly aftertouch
      0x00, 0xd0, 33, // channel pressure
      ...vlq(480), 0x80, 60, 0,
      ...EOT,
    ]])
    expect(parseMidi(smf).tracks[0]!.notes).toEqual([
      { pitch: 60, startTick: 0, durTick: 480, velocity: 90, channel: 0 },
    ] satisfies MidiNote[])
  })

  it('drops a dangling note-on at end-of-track (never fabricates a duration)', () => {
    const smf = smfRaw(480, 0, [[
      ...TEMPO_120,
      0x00, 0x90, 60, 100, // on, never off
      ...vlq(240), 0x90, 64, 100, // e4 on...
      ...vlq(240), 0x80, 64, 0, // ...and off — the only complete note
      ...EOT,
    ]])
    expect(parseMidi(smf).tracks[0]!.notes).toEqual([
      { pitch: 64, startTick: 240, durTick: 240, velocity: 100, channel: 0 },
    ] satisfies MidiNote[])
  })

  it('errors on a missing MTrk chunk', () => {
    const junk = new Uint8Array([
      ...ascii('MThd'), ...be32(6), ...be16(0), ...be16(1), ...be16(480),
      ...ascii('XTrk'), ...be32(4), ...EOT,
    ])
    expect(() => parseMidi(junk)).toThrow(/expected 'MTrk'/)
  })

  it('errors on truncated data instead of looping or fabricating notes', () => {
    const whole = buildSmf(480, 120, { num: 4, den: 4 }, [{ pitch: 60, start: 0, dur: 480 }])
    expect(() => parseMidi(whole.subarray(0, whole.length - 6))).toThrow(MidiParseError)
    expect(() => parseMidi(whole.subarray(0, 10))).toThrow(MidiParseError)
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

  it('compound and irregular meters: cps agrees with ticksPerBar (bpm counts quarters)', () => {
    // 6/8 at 120 bpm: a bar is 3 quarter notes = 1.5 s → cps 2/3.
    // (The old formula divided by num and returned 1/3 — half speed.)
    expect(ticksPerBar(480, { num: 6, den: 8 })).toBe(1440)
    expect(midiCps(120, { num: 6, den: 8 })).toBeCloseTo(2 / 3, 10)
    // 7/16 at 120 bpm: a bar is 7/4 quarters = 0.875 s → cps 8/7
    expect(midiCps(120, { num: 7, den: 16 })).toBeCloseTo(8 / 7, 10)
    // the shared contract, whatever the meter: cps = (ticks/sec) / ticksPerBar
    const ticksPerSec = (120 / 60) * 480
    for (const ts of [{ num: 4, den: 4 }, { num: 6, den: 8 }, { num: 7, den: 16 }, { num: 5, den: 2 }]) {
      expect(midiCps(120, ts)).toBeCloseTo(ticksPerSec / ticksPerBar(480, ts), 10)
    }
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

  it('caps voices at maxVoices and counts the overflow in `dropped`', () => {
    // three simultaneous whole-bar notes but only two voices allowed:
    // lowest two placed (sort ties break by pitch), the third dropped
    const r = midiNotesToVoices(
      [n(60, 0, 1920), n(64, 0, 1920), n(67, 0, 1920)],
      480, { num: 4, den: 4 }, { maxVoices: 2 },
    )
    expect(r.voices.sort()).toEqual(['<c4>', '<e4>'])
    expect(r.dropped).toBe(1)
  })

  it('reports nonzero quantErr for an off-grid onset', () => {
    // stepTicks = 480/4 = 120; an onset at tick 60 sits exactly half a step
    // off the grid → rms error 0.5 steps, note snapped to step 1
    const r = midiNotesToVoices([n(60, 60, 480)], 480, { num: 4, den: 4 })
    expect(r.quantErr).toBeCloseTo(0.5, 10)
    expect(r.dropped).toBe(0)
    expect(r.voices).toEqual(['<[~ c4@4 ~@11]>'])
  })
})
