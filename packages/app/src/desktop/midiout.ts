/* ------------------------------------------------------------------------- *
 * Playback → the virtual MIDI port, so a DAW can record what you are coding.
 *
 * The app already sent CLOCK out (editor/midi.ts) and took MIDI in, but never
 * sent notes: there was nothing to record. This subscribes to the scheduler's
 * events and plays them out of the desktop's virtual port.
 *
 * Two decisions worth naming:
 *
 *   CHANNEL PER SYNTH. Every sound gets its own MIDI channel, assigned in
 *   first-heard order, so a DAW sees the kick, bass and lead as separate tracks
 *   instead of one channel with everything piled on it. Past 16 sounds the
 *   assignment wraps — MIDI has 16 channels and pretending otherwise would
 *   silently drop the 17th.
 *
 *   NOTES ARE SCHEDULED, NOT FIRED ON ARRIVAL. Events arrive with lookahead, so
 *   sending them the moment they appear would run everything early by the
 *   lookahead — a systematic timing error in the recording. Each note is timed
 *   against the same audio clock the engine plays it on.
 * ------------------------------------------------------------------------- */

import type { MidiSink } from './bridge'

/** One scheduled note, in the shape the editor's event fanout provides. */
export interface OutEvent {
  /** midi note number; fractional microtones are rounded (see below). */
  note: number
  /** audio-clock seconds — the same clock the engine sounds it on. */
  timeSec: number
  durSec: number
  /** the synth it routes to, which becomes the MIDI channel. */
  sound?: string
  /** 0..1, mapped to velocity. */
  velocity?: number
}

const NOTE_ON = 0x90
const NOTE_OFF = 0x80
/** MIDI has 16 channels; a 17th sound wraps rather than vanishing. */
const CHANNELS = 16

/** Assigns each sound a stable channel in first-heard order. */
export class ChannelMap {
  private readonly map = new Map<string, number>()

  /** 0-based channel for `sound`. */
  channel(sound: string | undefined): number {
    const key = sound ?? ''
    const found = this.map.get(key)
    if (found !== undefined) return found
    const next = this.map.size % CHANNELS
    this.map.set(key, next)
    return next
  }

  /** What each sound was assigned, for display. */
  entries(): [string, number][] {
    return [...this.map.entries()]
  }

  reset(): void {
    this.map.clear()
  }
}

/** MIDI velocity 1..127 from a 0..1 gain. Never 0: a zero-velocity note-on IS
 *  a note-off, so a quiet note would arrive as silence. */
export function velocityByte(v: number | undefined): number {
  const g = v === undefined || !Number.isFinite(v) ? 1 : v
  const scaled = Math.round(Math.max(0, Math.min(1, g)) * 127)
  return Math.max(1, scaled)
}

/** A fractional midi note rounded to the nearest semitone, clamped to range.
 *  Microtuning cannot survive plain MIDI — that needs per-note pitch bend — so
 *  this is lossy ON PURPOSE rather than quietly wrong. */
export function noteByte(n: number): number {
  if (!Number.isFinite(n)) return 60
  return Math.max(0, Math.min(127, Math.round(n)))
}

export interface NoteOutOpts {
  /** audio-clock now, in seconds. */
  now: () => number
  /** deferred execution, injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

/** Sends scheduled notes to a sink, timed against the audio clock. */
export class NoteOut {
  private readonly channels = new ChannelMap()
  private readonly timers = new Set<unknown>()
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  /** notes currently sounding, so a stop can release them */
  private readonly held = new Set<string>()

  constructor(private readonly sink: MidiSink, private readonly opts: NoteOutOpts) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Queue a batch of scheduled events. */
  send(events: readonly OutEvent[]): void {
    for (const ev of events) {
      const ch = this.channels.channel(ev.sound)
      const note = noteByte(ev.note)
      const vel = velocityByte(ev.velocity)
      const at = (ev.timeSec - this.opts.now()) * 1000
      const key = `${ch}:${note}`
      this.at(at, () => {
        this.held.add(key)
        this.sink.send([NOTE_ON | ch, note, vel])
      })
      // duration is musical, so the note-off rides the same clock
      this.at(at + Math.max(1, ev.durSec * 1000), () => {
        this.held.delete(key)
        this.sink.send([NOTE_OFF | ch, note, 0])
      })
    }
  }

  /** Run `fn` in `ms`, or now when that moment has passed. */
  private at(ms: number, fn: () => void): void {
    if (ms <= 1) {
      fn()
      return
    }
    const h = this.setTimer(() => {
      this.timers.delete(h)
      fn()
    }, ms)
    this.timers.add(h)
  }

  /** Transport stop: drop everything queued and release what is sounding.
   *  Without the release a DAW is left holding notes down forever — the same
   *  stuck-note failure the engine had. */
  stop(): void {
    for (const h of this.timers) this.clearTimer(h)
    this.timers.clear()
    for (const key of this.held) {
      const [ch, note] = key.split(':').map(Number)
      this.sink.send([NOTE_OFF | (ch ?? 0), note ?? 60, 0])
    }
    this.held.clear()
    // all-notes-off per channel, in case a DAW missed one
    for (let ch = 0; ch < CHANNELS; ch++) this.sink.send([0xb0 | ch, 123, 0])
  }

  /** Which sound went to which channel — for telling the user. */
  routing(): [string, number][] {
    return this.channels.entries()
  }
}
