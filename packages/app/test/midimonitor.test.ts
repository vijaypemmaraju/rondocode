import { describe, expect, it } from 'vitest'
import { MONITOR_MAX, MidiMonitor, describeMidi, noteLabel } from '../src/midi/monitor'
import { noteNameToMidi } from '@rondocode/pattern'

/* ------------------------------------------------------------------------- *
 * Reported by a user whose two controllers were DETECTED and whose notes never
 * played. From outside the app every possible cause looks the same -- silence:
 * the port delivered nothing, or it delivered something of a kind we ignore, or
 * it delivered fine and the note was dropped for want of a running synth.
 *
 * So what is asserted here is mostly that NOTHING IS DROPPED. A monitor that
 * quietly skips what it does not understand has the same failure mode as the
 * bug it was built to find.
 * ------------------------------------------------------------------------- */

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b)
const line = (...b: number[]) => describeMidi('A-800 PRO', bytes(...b))

describe('describeMidi', () => {
  it('decodes a note on, with the name a musician reads', () => {
    const l = line(0x90, 60, 100)
    expect(l.kind).toBe('note on')
    expect(l.detail).toBe('C4 (60) vel 100')
    expect(l.channel).toBe(1)
    expect(l.raw).toBe('90 3C 64')
  })

  it('reads note-on velocity 0 as a note OFF', () => {
    // half the controllers in the world release notes this way, and reading it
    // as a note-on would show a stuck note in the log
    const l = line(0x90, 60, 0)
    expect(l.kind).toBe('note off')
  })

  it('reports the CHANNEL, which is the first thing to check on a silent rig', () => {
    expect(line(0x93, 60, 1).channel).toBe(4)
    expect(line(0x9f, 60, 1).channel).toBe(16)
  })

  it('decodes the rest of the channel messages', () => {
    expect(line(0x80, 60, 0).kind).toBe('note off')
    expect(line(0xb0, 74, 64).kind).toBe('cc')
    expect(line(0xb0, 74, 64).detail).toBe('#74 = 64')
    expect(line(0xc0, 5).kind).toBe('program')
    expect(line(0xa0, 60, 20).kind).toBe('aftertouch')
    expect(line(0xd0, 20).kind).toBe('pressure')
  })

  it('decodes pitch bend as a SIGNED number around centre', () => {
    expect(line(0xe0, 0, 64).detail).toBe('0') // centre
    expect(line(0xe0, 0, 0).detail).toBe('-8192') // full down
    expect(line(0xe0, 127, 127).detail).toBe('8191') // full up
  })

  it('names the system messages', () => {
    expect(line(0xf8).kind).toBe('clock')
    expect(line(0xfa).kind).toBe('start')
    expect(line(0xfc).kind).toBe('stop')
    expect(line(0xfe).kind).toBe('active sensing')
    expect(line(0xf0, 0x7e).kind).toBe('sysex')
  })

  it('marks ONLY the flooding messages as noisy', () => {
    expect(line(0xf8).noisy, 'clock').toBe(true)
    expect(line(0xfe).noisy, 'active sensing').toBe(true)
    expect(line(0xfa).noisy, 'start is rare and worth seeing').toBe(false)
    expect(line(0x90, 60, 1).noisy).toBe(false)
  })

  it('still produces a line for bytes it cannot name', () => {
    // the whole point: an unrecognised message is a CLUE, not a thing to hide
    const l = describeMidi('weird', bytes(0xf4, 0x01))
    expect(l.kind).toBe('system')
    expect(l.raw).toBe('F4 01')
  })

  it('carries the device name through, always', () => {
    for (const b of [[0x90, 60, 1], [0xf8], [0xb0, 1, 1], [0xf4]]) {
      expect(describeMidi('Korg microKEY', bytes(...b)).device).toBe('Korg microKEY')
    }
  })
})

describe('noteLabel', () => {
  it('matches the numbering the rest of the app uses', () => {
    /* Asserted by ROUND TRIP against the shared parser rather than by writing
     * the octave numbers out: a monitor that labels middle C differently from
     * the notation in the buffer sends you hunting for a transposition bug that
     * is not there. */
    for (let n = 0; n <= 127; n++) {
      expect(noteNameToMidi(noteLabel(n).toLowerCase()), `midi ${n}`).toBe(n)
    }
    expect(noteLabel(60)).toBe('C4')
    expect(noteLabel(0)).toBe('C-1')
  })
})

describe('MidiMonitor', () => {
  it('lists newest first', () => {
    const m = new MidiMonitor()
    m.add(describeMidi('d', bytes(0x90, 60, 1)))
    m.add(describeMidi('d', bytes(0x90, 62, 1)))
    expect(m.recent().map((l) => l.detail)).toEqual(['D4 (62) vel 1', 'C4 (60) vel 1'])
  })

  it('COUNTS clock instead of listing it', () => {
    /* A running clock is 24 messages a beat -- 48 a second at 120bpm. Listed,
     * it pushes the note you just played out of the log before you can read
     * it, which is exactly the failure this was built to avoid. */
    const m = new MidiMonitor()
    m.add(describeMidi('d', bytes(0x90, 60, 1)))
    for (let i = 0; i < 500; i++) m.add(describeMidi('d', bytes(0xf8)))
    expect(m.recent()).toHaveLength(1)
    expect(m.recent()[0]?.kind).toBe('note on')
    expect(m.noisyCount()).toBe(500)
  })

  it('bounds the log, keeping the NEWEST', () => {
    const m = new MidiMonitor()
    for (let i = 0; i < MONITOR_MAX + 50; i++) m.add(describeMidi('d', bytes(0xb0, 1, i & 127)))
    expect(m.recent()).toHaveLength(MONITOR_MAX)
    expect(m.recent()[0]?.detail).toBe(`#1 = ${(MONITOR_MAX + 49) & 127}`)
  })

  it('records which ports have actually SPOKEN', () => {
    /* The multi-port question, answered. An A-800 Pro presents three ports and
     * only one carries the keys; enumeration alone cannot say which. */
    const m = new MidiMonitor()
    m.add(describeMidi('A-800 PRO PORT 2', bytes(0x90, 60, 1)))
    expect([...m.speaking]).toEqual(['A-800 PRO PORT 2'])
  })

  it('counts a clock-only port as speaking, because it IS delivering', () => {
    const m = new MidiMonitor()
    m.add(describeMidi('Safire', bytes(0xf8)))
    expect(m.speaking.has('Safire'), 'silent and clock-only are different diagnoses').toBe(true)
  })

  it('clears everything', () => {
    const m = new MidiMonitor()
    m.add(describeMidi('d', bytes(0x90, 60, 1)))
    m.add(describeMidi('d', bytes(0xf8)))
    m.clear()
    expect(m.recent()).toEqual([])
    expect(m.noisyCount()).toBe(0)
    expect(m.speaking.size).toBe(0)
  })
})
