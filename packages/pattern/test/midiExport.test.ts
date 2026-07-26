import { describe, expect, it } from 'vitest'
import {
  parseMidi,
  midiCps,
  notesToSmf,
  velocityToMidi,
  bendValue,
  trackChannel,
} from '../src/index'
import type { ExportNote, MidiFile } from '../src/index'

/* The correctness anchor for the SMF WRITER is the repo's own PARSER:
 * parseMidi(notesToSmf(notes)) must reproduce every onset, duration, pitch
 * and velocity within tick quantization. That symmetry is the point — the
 * importer and exporter share one set of conventions (1 cycle = 1 bar,
 * tempo via midiCps and its inverse, format 1 with a conductor track). */

const TPQ = 480
const TPC = TPQ * 4 // ticks per cycle (1 cycle = 1 bar of 4/4)

const note = (timeCycles: number, durCycles: number, midi: number, velocity: number, track: string): ExportNote => ({
  timeCycles, durCycles, midi, velocity, track,
})

/** The round-trip contract for one note (what the parser must give back). */
const expectTick = (n: ExportNote) => ({
  pitch: Math.max(0, Math.min(127, Math.round(n.midi))),
  startTick: Math.round(n.timeCycles * TPC),
  durTick: Math.max(1, Math.round(n.durCycles * TPC)),
  velocity: velocityToMidi(n.velocity),
})

/** Order-independent compare for same-tick chord notes. */
const sorted = <T extends { startTick: number; pitch: number; durTick: number; velocity: number }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch || a.durTick - b.durTick || a.velocity - b.velocity)

/** Round-trip: write, parse back, compare each named track's note multiset. */
function roundTrip(notes: ExportNote[], cps: number): MidiFile {
  const f = parseMidi(notesToSmf(notes, { cps }))
  const byTrack = new Map<string, ExportNote[]>()
  for (const n of notes) {
    const list = byTrack.get(n.track) ?? []
    list.push(n)
    byTrack.set(n.track, list)
  }
  for (const [name, list] of byTrack) {
    const tr = f.tracks.find((t) => t.name === name)
    expect(tr, `track '${name}' missing from the file`).toBeDefined()
    const got = sorted(tr!.notes.map(({ pitch, startTick, durTick, velocity }) => ({ pitch, startTick, durTick, velocity })))
    const want = sorted(list.map(expectTick))
    expect(got).toEqual(want)
  }
  return f
}

describe('notesToSmf: round-trip through the repo parser', () => {
  it('a simple melody survives exactly, with tempo and 4/4 recovered', () => {
    const notes = [
      note(0, 0.25, 60, 0.8, 'lead'),
      note(0.25, 0.25, 64, 0.8, 'lead'),
      note(0.5, 0.25, 67, 0.6, 'lead'),
      note(0.75, 0.25, 71, 1, 'lead'),
    ]
    const f = roundTrip(notes, 0.5)
    expect(f.format).toBe(1)
    expect(f.ppq).toBe(TPQ)
    expect(f.timeSig).toEqual({ num: 4, den: 4 })
    // tempo is the midiCps INVERSE: cps 0.5 -> 120 bpm, and back again
    expect(Math.round(f.tempoBpm)).toBe(120)
    expect(midiCps(f.tempoBpm, f.timeSig)).toBeCloseTo(0.5, 6)
    // conductor/meta track first, then the part
    expect(f.tracks[0]!.name).toBe('rondocode')
    expect(f.tracks[0]!.notes).toEqual([])
    expect(f.tracks[1]!.name).toBe('lead')
  })

  it('chords: three notes at the same tick all survive', () => {
    roundTrip([
      note(0, 1, 60, 0.9, 'keys'),
      note(0, 1, 64, 0.9, 'keys'),
      note(0, 1, 67, 0.9, 'keys'),
    ], 0.5)
  })

  it('overlapping notes of different pitches keep their own durations', () => {
    roundTrip([
      note(0, 1.5, 48, 0.7, 'pad'), // sustains across the bar line
      note(0.5, 0.25, 72, 0.9, 'pad'),
      note(0.625, 0.75, 65, 0.4, 'pad'),
    ], 1)
  })

  it('dotted rhythms land on exact ticks at 480 tpq', () => {
    // dotted eighth = 3/16 bar = 0.1875 cycles = 360 ticks
    const notes = [
      note(0, 0.1875, 60, 1, 'lead'),
      note(0.1875, 0.0625, 62, 1, 'lead'),
      note(0.25, 0.1875, 64, 1, 'lead'),
    ]
    const f = roundTrip(notes, 0.5)
    const ticks = f.tracks[1]!.notes.map((n) => n.startTick)
    expect(ticks).toEqual([0, 360, 480])
    expect(f.tracks[1]!.notes[0]!.durTick).toBe(360)
  })

  it('same-tick same-pitch notes keep the duration multiset (order is MIDI-ambiguous)', () => {
    roundTrip([
      note(0, 0.5, 60, 0.5, 'keys'),
      note(0, 0.25, 60, 0.5, 'keys'),
    ], 0.5)
  })

  it('a zero-duration note still emits (min duration one tick)', () => {
    const f = roundTrip([note(0.25, 0, 60, 1, 'hit')], 0.5)
    expect(f.tracks[1]!.notes[0]!.durTick).toBe(1)
  })

  it('multiple tracks: named, ordered, one channel each (skipping GM drums)', () => {
    const notes = [
      note(0, 0.25, 36, 1, 'kick'),
      note(0, 0.5, 48, 0.8, 'bass'),
      note(0.5, 0.5, 72, 0.6, 'lead'),
    ]
    const f = parseMidi(notesToSmf(notes, { cps: 0.5, trackOrder: ['kick', 'bass', 'lead'] }))
    expect(f.tracks.map((t) => t.name)).toEqual(['rondocode', 'kick', 'bass', 'lead'])
    expect(f.tracks[1]!.channel).toBe(0)
    expect(f.tracks[2]!.channel).toBe(1)
    expect(f.tracks[3]!.channel).toBe(2)
  })

  it('trackOrder ranks listed tracks first; unlisted follow in first-appearance order', () => {
    const notes = [
      note(0, 0.25, 60, 1, 'zeta'),
      note(0, 0.25, 62, 1, 'alpha'),
      note(0, 0.25, 64, 1, 'mid'),
    ]
    const f = parseMidi(notesToSmf(notes, { cps: 0.5, trackOrder: ['mid', 'ghost'] }))
    // 'ghost' played nothing: no empty MTrk for it
    expect(f.tracks.map((t) => t.name)).toEqual(['rondocode', 'mid', 'zeta', 'alpha'])
  })

  it('cycle boundaries align to whole bars (multiples of 4·tpq ticks)', () => {
    const notes = [0, 1, 2, 3].map((c) => note(c, 0.25, 60, 1, 'lead'))
    const f = roundTrip(notes, 1)
    expect(f.tracks[1]!.notes.map((n) => n.startTick)).toEqual([0, 1920, 3840, 5760])
  })

  it('rejects non-finite input and bad options loudly', () => {
    expect(() => notesToSmf([note(NaN, 1, 60, 1, 'a')])).toThrow(TypeError)
    expect(() => notesToSmf([note(0, Infinity, 60, 1, 'a')])).toThrow(TypeError)
    expect(() => notesToSmf([], { cps: 0 })).toThrow(TypeError)
    expect(() => notesToSmf([], { ticksPerQuarter: 40000 })).toThrow(TypeError)
  })
})

describe('velocity mapping', () => {
  it('maps 0..1 to 1..127 and never emits 0 (0 means note-off on the wire)', () => {
    expect(velocityToMidi(0)).toBe(1)
    expect(velocityToMidi(0.004)).toBe(1)
    expect(velocityToMidi(0.5)).toBe(64)
    expect(velocityToMidi(1)).toBe(127)
    expect(velocityToMidi(2)).toBe(127) // hot .gain clamps
    expect(velocityToMidi(-1)).toBe(1)
  })

  it('a velocity-0 note survives the round trip instead of vanishing', () => {
    const f = roundTrip([note(0, 0.5, 60, 0, 'lead')], 0.5)
    expect(f.tracks[1]!.notes[0]!.velocity).toBe(1)
  })
})

describe('track channels', () => {
  it('skips channel 9 (GM percussion) and wraps past 15', () => {
    expect([...Array(16).keys()].map(trackChannel)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 0])
  })
})

// ---- pitch bend for fractional (custom-tuning) notes ----

/** Minimal event walker over writer output (explicit status bytes only):
 *  collects channel events with absolute ticks so tests can see the pitch
 *  bends parseMidi deliberately skips. */
function channelEvents(smf: Uint8Array, trackIndex: number): { tick: number; status: number; d1: number; d2: number }[] {
  let pos = 14 // MThd is always 14 bytes here
  const readU32 = (p: number): number => smf[p]! * 0x1000000 + (smf[p + 1]! << 16) + (smf[p + 2]! << 8) + smf[p + 3]!
  for (let t = 0; t < trackIndex; t++) pos += 8 + readU32(pos + 4)
  const end = pos + 8 + readU32(pos + 4)
  pos += 8
  const out: { tick: number; status: number; d1: number; d2: number }[] = []
  let tick = 0
  while (pos < end) {
    let v = 0
    for (;;) {
      const c = smf[pos++]!
      v = (v << 7) | (c & 0x7f)
      if (!(c & 0x80)) break
    }
    tick += v
    const status = smf[pos++]!
    if (status === 0xff) {
      const mlen = smf[pos + 1]!
      pos += 2 + mlen // meta: type + single-byte length (true for writer output)
    } else {
      out.push({ tick, status, d1: smf[pos]!, d2: smf[pos + 1]! })
      pos += 2
    }
  }
  return out
}

describe('fractional midi notes (custom tunings)', () => {
  it('rounds the note and emits a pitch bend before it, resetting after', () => {
    // 60.5 = a quartertone up: pitch 61 (round-half-up) bent DOWN a quartertone
    const smf = notesToSmf([note(0.25, 0.25, 60.5, 1, 'lead')], { cps: 0.5 })
    expect(parseMidi(smf).tracks[1]!.notes).toEqual([
      { pitch: 61, startTick: 480, durTick: 480, velocity: 127, channel: 0 },
    ])
    const evs = channelEvents(smf, 1)
    const bends = evs.filter((e) => (e.status & 0xf0) === 0xe0)
    expect(bends).toHaveLength(2)
    const wire = (b: { d1: number; d2: number }): number => (b.d2 << 7) | b.d1
    // 60.5 - 61 = -0.5 semitones under a +-2 range: 8192 - 2048 = 6144
    expect(bends[0]!.tick).toBe(480)
    expect(wire(bends[0]!)).toBe(bendValue(-0.5))
    expect(wire(bends[0]!)).toBe(6144)
    // reset to center lands at the note-off tick, after the off itself
    expect(bends[1]!.tick).toBe(960)
    expect(wire(bends[1]!)).toBe(8192)
    const offIdx = evs.findIndex((e) => (e.status & 0xf0) === 0x80)
    expect(evs.indexOf(bends[1]!)).toBeGreaterThan(offIdx)
    // and the bend-in precedes its note-on
    expect(evs.indexOf(bends[0]!)).toBeLessThan(evs.findIndex((e) => (e.status & 0xf0) === 0x90))
  })

  it('skips the bend when the fraction is within one cent', () => {
    const smf = notesToSmf([note(0, 0.25, 60.005, 1, 'lead')], { cps: 0.5 })
    expect(channelEvents(smf, 1).filter((e) => (e.status & 0xf0) === 0xe0)).toHaveLength(0)
    expect(parseMidi(smf).tracks[1]!.notes[0]!.pitch).toBe(60)
  })

  it('bendValue covers the +-2 semitone range with clamping', () => {
    expect(bendValue(0)).toBe(8192)
    expect(bendValue(2)).toBe(16383) // clamped from 16384
    expect(bendValue(-2)).toBe(0)
    expect(bendValue(1)).toBe(12288)
    expect(bendValue(-3)).toBe(0)
  })
})

// ---- fuzz-lite: seeded random note lists, round-tripped ----

/** mulberry32 — tiny seeded PRNG, deterministic across runs. */
const mulberry32 = (seed: number) => (): number => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe('fuzz-lite round-trip (N=200, seeded)', () => {
  it('every generated note list survives parseMidi within tick quantization', () => {
    const rand = mulberry32(0xc0de)
    const TRACKS = ['a', 'b', 'c']
    for (let iter = 0; iter < 200; iter++) {
      const cps = 0.1 + rand() * 1.9
      const count = 1 + Math.floor(rand() * 24)
      const notes: ExportNote[] = []
      // avoid same-track same-rounded-pitch OVERLAP in tick space: overlapping
      // identical notes on one channel are genuinely ambiguous in MIDI (the
      // parser pairs offs FIFO), so the generator, like real patterns, does
      // not produce them.
      const spans = new Map<string, [number, number][]>()
      for (let i = 0; i < count; i++) {
        const n = note(
          rand() * 8,
          rand() < 0.1 ? 0 : rand() * 2,
          24 + rand() * 84, // fractional pitches included
          rand(),
          TRACKS[Math.floor(rand() * TRACKS.length)]!,
        )
        const e = expectTick(n)
        const k = `${n.track}/${e.pitch}`
        const span: [number, number] = [e.startTick, e.startTick + e.durTick]
        const clashes = (spans.get(k) ?? []).some(([s0, e0]) => span[0] < e0 && s0 < span[1])
        if (clashes) continue
        spans.set(k, [...(spans.get(k) ?? []), span])
        notes.push(n)
      }
      if (notes.length === 0) continue
      const f = roundTrip(notes, cps)
      expect(midiCps(f.tempoBpm, f.timeSig)).toBeCloseTo(cps, 3)
      const total = f.tracks.reduce((s, t) => s + t.notes.length, 0)
      expect(total).toBe(notes.length)
    }
  })
})
