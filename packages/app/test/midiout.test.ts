import { describe, expect, it, vi } from 'vitest'
import { ChannelMap, NoteOut, noteByte, velocityByte } from '../src/desktop/midiout'
import type { OutEvent } from '../src/desktop/midiout'

/* Notes going OUT to a DAW. The failure modes here are all silent-but-wrong —
 * a note that records early, a velocity that lands as a note-off, a held note
 * left down after stop — so each gets its own test. */

const sinkSpy = (): { sent: number[][]; send: (b: Uint8Array | number[]) => void } => {
  const sent: number[][] = []
  return { sent, send: (b) => void sent.push([...b]) }
}

/** A NoteOut over a controllable clock and timer queue. */
const rig = (nowSec = 0) => {
  const sink = sinkSpy()
  const queue: { at: number; fn: () => void }[] = []
  let now = nowSec
  const out = new NoteOut(sink, {
    now: () => now,
    setTimer: (fn, ms) => {
      const h = { at: ms, fn }
      queue.push(h)
      return h
    },
    clearTimer: (h) => {
      const i = queue.indexOf(h as { at: number; fn: () => void })
      if (i >= 0) queue.splice(i, 1)
    },
  })
  return { out, sink, queue, runAll: () => [...queue].forEach((q) => q.fn()), setNow: (s: number) => (now = s) }
}

describe('velocity and note bytes', () => {
  it('never emits velocity 0, which IS a note-off', () => {
    expect(velocityByte(0)).toBe(1)
    expect(velocityByte(undefined)).toBe(127)
    expect(velocityByte(1)).toBe(127)
    expect(velocityByte(0.5)).toBe(64)
  })

  it('rounds microtones and clamps to MIDI range', () => {
    // plain MIDI cannot carry 60.5 — lossy on purpose, not quietly wrong
    expect(noteByte(60.5)).toBe(61)
    expect(noteByte(-5)).toBe(0)
    expect(noteByte(999)).toBe(127)
    expect(noteByte(NaN)).toBe(60)
  })
})

describe('channel per synth', () => {
  it('gives each sound its own channel in first-heard order', () => {
    const m = new ChannelMap()
    expect(m.channel('kick')).toBe(0)
    expect(m.channel('bass')).toBe(1)
    expect(m.channel('kick')).toBe(0) // stable
  })

  it('wraps past 16 rather than dropping the 17th sound', () => {
    const m = new ChannelMap()
    for (let i = 0; i < 16; i++) m.channel(`s${i}`)
    expect(m.channel('s16')).toBe(0)
  })
})

describe('scheduling', () => {
  it('times notes against the audio clock, not on arrival', () => {
    const { out, sink, queue } = rig(10)
    const ev: OutEvent = { note: 60, timeSec: 10.5, durSec: 0.25, sound: 'lead', velocity: 1 }
    out.send([ev])
    // nothing yet: the note is half a second away
    expect(sink.sent).toEqual([])
    expect(queue[0]!.at).toBeCloseTo(500, 0) // note on at +500ms
    expect(queue[1]!.at).toBeCloseTo(750, 0) // off at +500+250
  })

  it('fires immediately for an event already due', () => {
    const { out, sink } = rig(10)
    out.send([{ note: 64, timeSec: 9.9, durSec: 0.1, sound: 'x' }])
    expect(sink.sent[0]).toEqual([0x90, 64, 127])
  })

  it('emits note-on then note-off on the sound’s channel', () => {
    const { out, sink, runAll } = rig(0)
    out.send([{ note: 60, timeSec: 1, durSec: 0.5, sound: 'a', velocity: 0.5 }])
    out.send([{ note: 67, timeSec: 1, durSec: 0.5, sound: 'b', velocity: 1 }])
    runAll()
    expect(sink.sent).toContainEqual([0x90, 60, 64]) // channel 0
    expect(sink.sent).toContainEqual([0x80, 60, 0])
    expect(sink.sent).toContainEqual([0x91, 67, 127]) // channel 1
  })
})

describe('stop', () => {
  it('releases held notes so the DAW is not left holding them down', () => {
    const { out, sink, queue } = rig(0)
    out.send([{ note: 60, timeSec: 0, durSec: 10, sound: 'a' }]) // long note, on NOW
    expect(sink.sent).toContainEqual([0x90, 60, 127])
    sink.sent.length = 0
    out.stop()
    expect(sink.sent).toContainEqual([0x80, 60, 0]) // the release
    expect(queue.length).toBe(0) // and the pending note-off was cancelled
  })

  it('sends all-notes-off on every channel as a backstop', () => {
    const { out, sink } = rig(0)
    out.stop()
    const cc123 = sink.sent.filter((m) => (m[0]! & 0xf0) === 0xb0 && m[1] === 123)
    expect(cc123).toHaveLength(16)
  })

  it('drops queued notes that have not sounded yet', () => {
    const { out, sink, queue, runAll } = rig(0)
    out.send([{ note: 60, timeSec: 5, durSec: 1, sound: 'a' }])
    out.stop()
    sink.sent.length = 0
    runAll() // nothing left to run
    expect(queue).toHaveLength(0)
    expect(sink.sent).toEqual([])
  })
})
