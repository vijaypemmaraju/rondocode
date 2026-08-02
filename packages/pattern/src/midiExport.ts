/* Deterministic Standard-MIDI-File (SMF) EXPORT — the exact inverse of the
 * parser in midi.ts, sharing its conventions:
 *   - 1 cycle == 1 BAR, whose length in quarter notes comes from the project's
 *     time signature (4/4 unless it says otherwise), so tempo derives from cps
 *     as the inverse of midiCps: bpm = cps * 60 * quartersPerBar.
 *   - format 1: a tempo/meta conductor track first (set_tempo, the time
 *     signature, track name), then ONE MTrk per named track, each carrying a
 *     track-name meta event so MuseScore/DAWs label the staves.
 *   - explicit status bytes throughout (no running status — the parser
 *     accepts both; explicit is simpler and unambiguous).
 * FRACTIONAL midi numbers (custom tunings) round to the nearest semitone AND,
 * when the fraction exceeds one cent, get a pitch-bend before the note-on
 * (standard +-2 semitone bend range) with a reset to center after the
 * note-off. parseMidi skips bends, so a round trip through the repo's own
 * parser reproduces the ROUNDED pitch; the bend is for external consumers.
 * No external deps; big-endian per the SMF spec. */
import { cpsToBpm, quartersPerBar, DEFAULT_TIME_SIG } from './midi'
import type { TimeSig } from './midi'

export interface ExportNote {
  /** onset, in cycles from the start (1 cycle = 1 bar) */ timeCycles: number
  /** duration in cycles */ durCycles: number
  /** midi note number, possibly fractional (custom tunings); c4 = 60 */ midi: number
  /** 0..1 (values outside clamp); maps to 1..127, never 0 (0 = note-off) */ velocity: number
  /** track/channel name (the synth the note plays on) */ track: string
}

export interface SmfOptions {
  /** cycles per second; tempo = cps * 240 bpm (midiCps inverse). default 0.5 */
  cps?: number
  /** SMF ticks per quarter note. default 480 */
  ticksPerQuarter?: number
  /** preferred track order; tracks not listed follow in first-appearance order */
  trackOrder?: readonly string[]
  /** The project's meter (default 4/4). A cycle is one BAR, so this decides
   *  both how many quarters a cycle spans and the time-signature meta event —
   *  without it a 3/4 project exports as 4/4 and every bar line in the DAW
   *  lands in the wrong place. */
  timeSig?: TimeSig
}

/** velocity 0..1 → MIDI 1..127. Never 0: a velocity-0 note-on means note-OFF
 *  on the wire, which would silently swallow the note. */
export function velocityToMidi(v: number): number {
  return Math.max(1, Math.min(127, Math.round(v * 127)))
}

/** Pitch-bend wire value for a semitone offset under the standard +-2 range:
 *  center 8192, full scale 8192/2 per semitone, clamped to 0..16383. */
export function bendValue(semitones: number): number {
  return Math.max(0, Math.min(16383, 8192 + Math.round((semitones / 2) * 8192)))
}

/** MIDI channel for track index i: 0..15 skipping 9 (GM percussion — a
 *  melodic track on channel 10 would render as drums), wrapping past 15. */
export function trackChannel(i: number): number {
  const c = i % 15
  return c >= 9 ? c + 1 : c
}

// ---- byte-level writers ----

/** variable-length quantity: 7 bits per byte, high bit = continue */
const vlq = (n: number): number[] => {
  const out = [n & 0x7f]
  n = Math.floor(n / 128)
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  return out
}
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff]
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) & 0x7f)

/** track-name meta event (0xff 0x03) at delta 0 */
const trackNameMeta = (name: string): number[] => {
  const bytes = ascii(name)
  return [0x00, 0xff, 0x03, ...vlq(bytes.length), ...bytes]
}
const END_OF_TRACK = [0x00, 0xff, 0x2f, 0x00]

/** One channel event at an absolute tick. `order` breaks same-tick ties so
 *  the stream stays well-formed: note-offs and bend-resets land BEFORE the
 *  next note's bend + note-on at the same tick. */
interface TrackEvent {
  tick: number
  /** same-tick ordering: 0 noteOff, 1 bend reset, 2 bend set, 3 noteOn */
  order: number
  bytes: number[]
}

/** Serialize one track's absolute-tick events into an MTrk chunk. */
const buildTrackChunk = (name: string, events: TrackEvent[]): number[] => {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const data: number[] = trackNameMeta(name)
  let last = 0
  for (const e of events) {
    data.push(...vlq(e.tick - last), ...e.bytes)
    last = e.tick
  }
  data.push(...END_OF_TRACK)
  return [...ascii('MTrk'), ...be32(data.length), ...data]
}

/**
 * Encode notes as a format-1 SMF. Correctness anchor: parseMidi(notesToSmf(n))
 * reproduces every onset/duration/velocity/pitch within tick quantization —
 * startTick = round(timeCycles·4·tpq), durTick = max(1, round(durCycles·4·tpq)),
 * velocity via velocityToMidi, pitch = round(midi) clamped 0..127.
 */
export function notesToSmf(notes: readonly ExportNote[], opts: SmfOptions = {}): Uint8Array {
  const cps = opts.cps ?? 0.5
  const tpq = opts.ticksPerQuarter ?? 480
  if (!Number.isFinite(cps) || cps <= 0) throw new TypeError(`notesToSmf: cps must be positive and finite, got ${cps}`)
  if (!Number.isInteger(tpq) || tpq <= 0 || tpq >= 0x8000) {
    throw new TypeError(`notesToSmf: ticksPerQuarter must be an integer in 1..32767, got ${tpq}`)
  }
  const timeSig = opts.timeSig ?? DEFAULT_TIME_SIG
  if (!Number.isInteger(timeSig.num) || timeSig.num < 1 || timeSig.num > 255) {
    throw new TypeError(`notesToSmf: time signature numerator must be an integer in 1..255, got ${timeSig.num}`)
  }
  // SMF stores the denominator as a power of two, so it can only BE a power of
  // two: 4/6 is not a time signature anyone can write down.
  if (!Number.isInteger(timeSig.den) || timeSig.den < 1 || (timeSig.den & (timeSig.den - 1)) !== 0 || timeSig.den > 128) {
    throw new TypeError(`notesToSmf: time signature denominator must be a power of two in 1..128, got ${timeSig.den}`)
  }
  const ticksPerCycle = tpq * quartersPerBar(timeSig) // 1 cycle = 1 bar

  // group notes per track, in trackOrder then first-appearance order
  const byTrack = new Map<string, ExportNote[]>()
  for (const t of opts.trackOrder ?? []) byTrack.set(t, [])
  for (const [i, n] of notes.entries()) {
    if (!Number.isFinite(n.timeCycles) || !Number.isFinite(n.durCycles) || !Number.isFinite(n.midi)) {
      throw new TypeError(`notesToSmf: notes[${i}] has a non-finite timeCycles/durCycles/midi`)
    }
    let list = byTrack.get(n.track)
    if (list === undefined) byTrack.set(n.track, (list = []))
    list.push(n)
  }
  // a trackOrder name nothing played never becomes an empty MTrk
  for (const [t, list] of byTrack) if (list.length === 0) byTrack.delete(t)

  // conductor track: name + set_tempo + the time signature at tick 0
  const bpm = cpsToBpm(cps, quartersPerBar(timeSig))
  const usPerQuarter = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / bpm)))
  // The meta event stores log2(den), and the metronome byte is 24 clocks per
  // quarter scaled to the beat unit — so a 6/8 bar clicks in eighths, which is
  // what a DAW's metronome plays.
  const denPow = Math.round(Math.log2(timeSig.den))
  const clocksPerBeat = Math.max(1, Math.min(255, Math.round((24 * 4) / timeSig.den)))
  const conductor: number[] = [
    ...trackNameMeta('rondocode'),
    0x00, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff,
    0x00, 0xff, 0x58, 0x04, timeSig.num, denPow, clocksPerBeat, 8,
    ...END_OF_TRACK,
  ]
  const chunks: number[][] = [[...ascii('MTrk'), ...be32(conductor.length), ...conductor]]

  let trackIndex = 0
  for (const [name, list] of byTrack) {
    const ch = trackChannel(trackIndex++)
    const events: TrackEvent[] = []
    for (const n of list) {
      const startTick = Math.max(0, Math.round(n.timeCycles * ticksPerCycle))
      const durTick = Math.max(1, Math.round(n.durCycles * ticksPerCycle))
      const pitch = Math.max(0, Math.min(127, Math.round(n.midi)))
      const frac = n.midi - Math.round(n.midi)
      const vel = velocityToMidi(n.velocity)
      // fractional pitch beyond one cent: bend in before the on, reset after
      // the off. Bends are per-CHANNEL, so overlapping fractional notes on one
      // track share (and fight over) the wheel — inherent to MIDI, documented.
      if (Math.abs(frac) > 0.01) {
        const b = bendValue(frac)
        events.push({ tick: startTick, order: 2, bytes: [0xe0 | ch, b & 0x7f, (b >> 7) & 0x7f] })
        events.push({ tick: startTick + durTick, order: 1, bytes: [0xe0 | ch, 8192 & 0x7f, (8192 >> 7) & 0x7f] })
      }
      events.push({ tick: startTick, order: 3, bytes: [0x90 | ch, pitch, vel] })
      events.push({ tick: startTick + durTick, order: 0, bytes: [0x80 | ch, pitch, 0] })
    }
    chunks.push(buildTrackChunk(name, events))
  }

  const header = [...ascii('MThd'), ...be32(6), ...be16(1), ...be16(chunks.length), ...be16(tpq)]
  const total = header.length + chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  out.set(header, 0)
  let pos = header.length
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}
