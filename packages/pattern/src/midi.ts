import { Fraction } from './fraction'
import { TimeSpan, hap } from './types'
import type { Hap } from './types'
import { Pattern } from './pattern'
import type { ControlMap } from './controls'

/* Deterministic Standard-MIDI-File (SMF) import. Everything the hand-conversion
 * used to GUESS — tempo, time signature, note onsets/durations, track split —
 * is read exactly from the file. Two consumers share one parser:
 *   - midiNotesToPattern(): a LOSSLESS runtime Pattern (exact fractional cycle
 *     timing; a note can even sustain across bar lines).
 *   - midiNotesToVoices():  EDITABLE mini-notation text (onsets/durations
 *     snapped to a grid; held notes via `@` weights; polyphony via voice-split).
 * 1 cycle == 1 bar throughout. No external deps; big-endian per the SMF spec. */

export interface MidiNote {
  /** midi note number (c4 = 60) */ pitch: number
  startTick: number
  durTick: number
  velocity: number
  channel: number
}

export interface MidiTrack {
  name?: string
  /** GM program (0-127) from the first program-change, if any */ program?: number
  /** channel of the first note */ channel?: number
  /** true when any note is on channel 10 (index 9) — GM percussion */ isDrum: boolean
  notes: MidiNote[]
}

export interface MidiFile {
  format: number
  /** ticks per quarter note */ ppq: number
  /** first tempo in the file (bpm); 120 if none */ tempoBpm: number
  timeSig: { num: number; den: number }
  tracks: MidiTrack[]
}

/** Cursor over a byte array with the big-endian + VLQ reads SMF needs. */
class Reader {
  pos = 0
  constructor(readonly b: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.b.length) throw new MidiParseError('unexpected end of data')
    return this.b[this.pos++]!
  }
  u16(): number {
    return (this.u8() << 8) | this.u8()
  }
  u32(): number {
    return (this.u8() * 0x1000000) + (this.u8() << 16) + (this.u8() << 8) + this.u8()
  }
  bytes(n: number): Uint8Array {
    const out = this.b.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  str(n: number): string {
    return String.fromCharCode(...this.bytes(n))
  }
  /** variable-length quantity: 7 bits/byte, high bit = continue */
  vlq(): number {
    let v = 0
    for (;;) {
      const c = this.u8()
      v = (v << 7) | (c & 0x7f)
      if (!(c & 0x80)) return v
    }
  }
}

export class MidiParseError extends Error {}

/** Parse SMF bytes into notes grouped by track, with exact tick timing. */
export function parseMidi(input: Uint8Array | ArrayBuffer): MidiFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const r = new Reader(bytes)
  if (r.str(4) !== 'MThd') throw new MidiParseError("not a MIDI file (missing 'MThd')")
  const headLen = r.u32()
  const format = r.u16()
  const ntrks = r.u16()
  const division = r.u16()
  r.pos += headLen - 6 // skip any extra header bytes
  if (division & 0x8000) throw new MidiParseError('SMPTE time division is not supported (expected ticks-per-quarter)')
  const ppq = division

  const tracks: MidiTrack[] = []
  // tempo / time-sig collected globally with their absolute tick, first wins
  let tempo: { tick: number; bpm: number } | undefined
  let tsig: { tick: number; num: number; den: number } | undefined

  for (let t = 0; t < ntrks; t++) {
    if (r.str(4) !== 'MTrk') throw new MidiParseError(`expected 'MTrk' for track ${t}`)
    const len = r.u32()
    const end = r.pos + len
    let tick = 0
    let running = 0
    let name: string | undefined
    let program: number | undefined
    let firstChannel: number | undefined
    let isDrum = false
    const notes: MidiNote[] = []
    // note-ons awaiting their note-off, keyed by channel*128+pitch (FIFO stack)
    const pending = new Map<number, { startTick: number; velocity: number; channel: number }[]>()

    const closeNote = (channel: number, pitch: number, endTick: number) => {
      const key = channel * 128 + pitch
      const stack = pending.get(key)
      const on = stack?.shift()
      if (on) notes.push({ pitch, startTick: on.startTick, durTick: Math.max(0, endTick - on.startTick), velocity: on.velocity, channel })
    }

    while (r.pos < end) {
      tick += r.vlq()
      let status = r.b[r.pos]!
      if (status & 0x80) {
        r.pos++
        running = status
      } else {
        status = running // running status: reuse last status byte
        if (!(status & 0x80)) throw new MidiParseError(`running status with no prior status at track ${t}`)
      }
      const hi = status & 0xf0
      const channel = status & 0x0f
      if (hi === 0x90) {
        // note on
        const pitch = r.u8()
        const vel = r.u8()
        if (firstChannel === undefined) firstChannel = channel
        if (channel === 9) isDrum = true
        if (vel > 0) {
          const key = channel * 128 + pitch
          let stack = pending.get(key)
          if (!stack) pending.set(key, (stack = []))
          stack.push({ startTick: tick, velocity: vel, channel })
        } else {
          closeNote(channel, pitch, tick) // vel 0 = note off
        }
      } else if (hi === 0x80) {
        // note off
        const pitch = r.u8()
        r.u8() // release velocity
        closeNote(channel, pitch, tick)
      } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
        r.pos += 2 // aftertouch / control-change / pitch-bend: 2 data bytes
      } else if (hi === 0xc0) {
        program = r.u8() // program change (first one for the track)
        if (firstChannel === undefined) firstChannel = channel
      } else if (hi === 0xd0) {
        r.pos += 1 // channel pressure: 1 data byte
      } else if (status === 0xff) {
        // meta event
        const type = r.u8()
        const mlen = r.vlq()
        const data = r.bytes(mlen)
        if (type === 0x03 && name === undefined) name = String.fromCharCode(...data).trim() || undefined
        else if (type === 0x51 && mlen === 3) {
          const usPerQuarter = (data[0]! << 16) | (data[1]! << 8) | data[2]!
          const bpm = 60_000_000 / usPerQuarter
          if (!tempo || tick < tempo.tick) tempo = { tick, bpm }
        } else if (type === 0x58 && mlen >= 2) {
          const num = data[0]!
          const den = 2 ** data[1]!
          if (!tsig || tick < tsig.tick) tsig = { tick, num, den }
        }
        // 0x2f end-of-track and all others: nothing to do (length already consumed)
      } else if (status === 0xf0 || status === 0xf7) {
        r.pos += r.vlq() // sysex: skip
      } else {
        throw new MidiParseError(`unknown status 0x${status.toString(16)} at track ${t}`)
      }
    }
    r.pos = end // be robust to trailing bytes / mis-tracked lengths
    notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch)
    tracks.push({ name, program, channel: firstChannel, isDrum, notes })
  }

  return {
    format,
    ppq,
    tempoBpm: tempo?.bpm ?? 120,
    timeSig: { num: tsig?.num ?? 4, den: tsig?.den ?? 4 },
    tracks,
  }
}

// ---- shared timing helpers (1 cycle == 1 bar) ----

const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
/** midi note number → rondocode note name (sharps), c4 = 60. */
export function midiToName(m: number): string {
  return NAMES[((m % 12) + 12) % 12]! + (Math.floor(m / 12) - 1)
}

/** ticks in one bar, given ppq and time signature. */
export function ticksPerBar(ppq: number, timeSig: { num: number; den: number }): number {
  return (ppq * 4 * timeSig.num) / timeSig.den
}

/** cps such that 1 cycle == 1 bar at the file's tempo (den-note = one beat). */
export function midiCps(tempoBpm: number, timeSig: { num: number; den: number }): number {
  const beatsPerBar = (timeSig.num * 4) / timeSig.den / (4 / timeSig.den) // = timeSig.num
  return tempoBpm / 60 / beatsPerBar
}

// ---- LOSSLESS: notes → runtime Pattern<ControlMap> ----

/** Build an exact Pattern from notes. Timing is rational (no grid); a note
 *  whose duration exceeds a bar sustains across cycle lines. Attach a synth with
 *  `.sound(name)` on the result. */
export function midiNotesToPattern(
  notes: readonly MidiNote[],
  ppq: number,
  timeSig: { num: number; den: number },
): Pattern<ControlMap> {
  const tpb = ticksPerBar(ppq, timeSig)
  const haps = notes.map((nt) => {
    const begin = Fraction.of(nt.startTick, tpb)
    const end = Fraction.of(nt.startTick + Math.max(1, nt.durTick), tpb)
    return { whole: new TimeSpan(begin, end), value: { note: nt.pitch } as ControlMap }
  })
  return new Pattern<ControlMap>((span) => {
    const out: Hap<ControlMap>[] = []
    for (const h of haps) {
      const part = h.whole.intersection(span)
      if (part) out.push(hap(h.whole, part, h.value))
    }
    return out
  })
}

// ---- EDITABLE: notes → mini-notation voice strings ----

export interface MiniOptions {
  /** grid resolution: steps per beat (4 = 1/16 in x/4). default 4 */ stepsPerBeat?: number
  /** cap voices per track; extra overlapping notes are dropped. default 8 */ maxVoices?: number
}

export interface MiniResult {
  /** one mini-notation string per monophonic voice (wrap with note(...)) */ voices: string[]
  bars: number
  /** rms onset+duration quantization error in steps (0 = perfectly on-grid) */ quantErr: number
  /** notes dropped because they exceeded maxVoices */ dropped: number
}

interface Seg {
  pitch: number
  /** absolute step index of onset */ start: number
  /** length in steps (>=1) */ len: number
}

/** Convert one track's notes to editable mini-notation voice strings.
 *  Notes are quantized to the step grid; notes crossing a bar line are split
 *  (re-triggered) at the boundary; overlapping notes are spread across voices so
 *  each voice is monophonic and expressible as a weighted sequence. */
export function midiNotesToVoices(
  notes: readonly MidiNote[],
  ppq: number,
  timeSig: { num: number; den: number },
  opts: MiniOptions = {},
): MiniResult {
  const stepsPerBeat = opts.stepsPerBeat ?? 4
  const maxVoices = opts.maxVoices ?? 8
  const stepTicks = ppq / stepsPerBeat
  const stepsPerBar = stepsPerBeat * timeSig.num
  if (notes.length === 0) return { voices: [], bars: 0, quantErr: 0, dropped: 0 }

  // 1. quantize onset + duration to the step grid, tracking error
  let errSq = 0
  let errN = 0
  const quant: Seg[] = []
  for (const nt of notes) {
    const s = Math.round(nt.startTick / stepTicks)
    const e = Math.round((nt.startTick + nt.durTick) / stepTicks)
    errSq += (nt.startTick / stepTicks - s) ** 2
    errN += 1
    quant.push({ pitch: nt.pitch, start: s, len: Math.max(1, e - s) })
  }
  const quantErr = Math.sqrt(errSq / errN)

  // 2. split segments that cross a bar boundary (re-trigger at the bar line)
  const segs: Seg[] = []
  for (const q of quant) {
    let start = q.start
    let remaining = q.len
    while (remaining > 0) {
      const barEnd = (Math.floor(start / stepsPerBar) + 1) * stepsPerBar
      const len = Math.min(remaining, barEnd - start)
      segs.push({ pitch: q.pitch, start, len })
      start += len
      remaining -= len
    }
  }
  const bars = Math.ceil(Math.max(...segs.map((s) => s.start + s.len)) / stepsPerBar)

  // 3. voice-split: greedily place each segment in the first voice whose last
  //    segment has ended, so every voice is monophonic
  segs.sort((a, b) => a.start - b.start || b.len - a.len || a.pitch - b.pitch)
  const voices: Seg[][] = []
  const voiceEnd: number[] = []
  let dropped = 0
  for (const s of segs) {
    let v = voiceEnd.findIndex((e) => e <= s.start)
    if (v === -1) {
      if (voices.length >= maxVoices) {
        dropped += 1
        continue
      }
      v = voices.length
      voices.push([])
      voiceEnd.push(0)
    }
    voices[v]!.push(s)
    voiceEnd[v] = s.start + s.len
  }

  // 4. emit each voice as `<bar bar ...>` with weighted tokens
  const voiceStrings = voices.map((vsegs) => {
    const barStrs: string[] = []
    for (let b = 0; b < bars; b++) {
      const base = b * stepsPerBar
      const inBar = vsegs.filter((s) => s.start >= base && s.start < base + stepsPerBar).sort((a, b2) => a.start - b2.start)
      barStrs.push(emitBar(inBar, base, stepsPerBar))
    }
    return `<${barStrs.join(' ')}>`
  })

  return { voices: voiceStrings, bars, quantErr, dropped }
}

/** One bar of a monophonic voice → a mini-notation term (weights sum to steps). */
function emitBar(segs: Seg[], base: number, steps: number): string {
  if (segs.length === 0) return '~'
  const tokens: string[] = []
  let cursor = 0
  const push = (name: string, w: number) => {
    if (w <= 0) return
    tokens.push(w === 1 ? name : `${name}@${w}`)
  }
  for (const s of segs) {
    const local = s.start - base
    if (local > cursor) push('~', local - cursor) // gap before the note
    push(midiToName(s.pitch), s.len)
    cursor = local + s.len
  }
  if (cursor < steps) push('~', steps - cursor) // trailing rest
  // a single token that fills the whole bar needs no brackets
  if (tokens.length === 1 && !tokens[0]!.includes('@')) return tokens[0]!
  if (tokens.length === 1 && tokens[0]!.endsWith(`@${steps}`)) return tokens[0]!.slice(0, tokens[0]!.indexOf('@'))
  return `[${tokens.join(' ')}]`
}
