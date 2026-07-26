import { describe, expect, it } from 'vitest'
import { capturePatternNotes, runPatterns, stageCode } from '../src/render-runner'
import { parseMidi, notesToSmf } from '../../pattern/src/index'

/* The MIDI-export capture: staged patterns run through the SAME virtual-clock
 * scheduler the offline render uses, so what you hear is what exports. These
 * tests pin the pattern-time contract (cycles, not seconds) over a tiny
 * staged track, then the full capture→SMF→parse path the app button takes. */

/** kick four-on-the-floor + a melody, the classic two-track smoke test. */
const TRACK_SOURCE = `
const kick = synth(({ gate, adsr, sine }) => sine(50).mul(adsr(gate, { a: 0.001, d: 0.08, s: 0, r: 0.02 })))
const lead = synth(({ note, gate, adsr, tri }) => tri(note.freq).mul(adsr(gate, { a: 0.004, d: 0.2, s: 0.3, r: 0.1 })))
p('kick', note('c1*4').sound('kick').gain(0.8))
p('mel', note('c4 e4 g4 b4').sound('lead'))
setCps(1)
`

describe('capturePatternNotes', () => {
  it('lands notes exactly where the pattern says, in cycle time', () => {
    const staged = stageCode(TRACK_SOURCE)
    if (!staged.ok) throw new Error('stage failed')
    const notes = capturePatternNotes(staged.patterns, { cycles: 2, cps: 1 })

    const kick = notes.filter((n) => n.track === 'kick')
    const mel = notes.filter((n) => n.track === 'lead')
    expect(kick).toHaveLength(8) // 4 per cycle x 2 cycles
    expect(mel).toHaveLength(8)

    // kick: c1 = midi 24 at 0, .25, .5, .75 of each cycle, quarter-cycle long
    const quarters = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]
    kick.forEach((n, i) => {
      expect(n.midi).toBe(24)
      expect(n.timeCycles).toBeCloseTo(quarters[i]!, 6)
      expect(n.durCycles).toBeCloseTo(0.25, 6)
      expect(n.velocity).toBeCloseTo(0.8, 6) // .gain flows to velocity
    })
    // melody: c4 e4 g4 b4 = 60 64 67 71, default gain -> velocity 1
    expect(mel.slice(0, 4).map((n) => n.midi)).toEqual([60, 64, 67, 71])
    mel.forEach((n, i) => {
      expect(n.timeCycles).toBeCloseTo(quarters[i]!, 6)
      expect(n.velocity).toBe(1)
    })
  })

  it('keeps pattern durations (no gate-gap shortening, unlike the render events)', () => {
    const staged = stageCode(TRACK_SOURCE)
    if (!staged.ok) throw new Error('stage failed')
    // the render path shortens gates so envelopes re-attack; notation must not
    const rendered = runPatterns(staged.patterns, { cycles: 1, cps: 1 }).get('kick')!
    const firstOff = rendered.filter((e) => e.type === 'noteOff')[0]!
    expect(firstOff.time).toBeLessThan(0.25)
    const captured = capturePatternNotes(staged.patterns, { cycles: 1, cps: 1 })
    expect(captured.find((n) => n.track === 'kick')!.durCycles).toBeCloseTo(0.25, 6)
  })

  it('is independent of tempo in cycle time (cps only scales seconds)', () => {
    const staged = stageCode(TRACK_SOURCE)
    if (!staged.ok) throw new Error('stage failed')
    const slow = capturePatternNotes(staged.patterns, { cycles: 1, cps: 0.25 })
    const fast = capturePatternNotes(staged.patterns, { cycles: 1, cps: 2 })
    expect(slow.map((n) => [n.track, n.midi, n.timeCycles.toFixed(6), n.durCycles.toFixed(6)]))
      .toEqual(fast.map((n) => [n.track, n.midi, n.timeCycles.toFixed(6), n.durCycles.toFixed(6)]))
  })

  it('cuts at the cycle count and skips events without sound or numeric note', () => {
    const staged = stageCode("p('a', n('0 1 2 3').scale('c major').sound('s'))\np('ctl', n('0 1'))")
    if (!staged.ok) throw new Error('stage failed')
    const notes = capturePatternNotes(staged.patterns, { cycles: 1, cps: 1 })
    expect(notes).toHaveLength(4) // the .sound-less pattern routes nowhere
    expect(notes.every((n) => n.track === 's' && n.timeCycles < 1)).toBe(true)
  })

  it('captures fractional pitches untouched (custom tunings round in the writer)', () => {
    const staged = stageCode(`
defineScale('quarter', [0, 0.5, 1])
p('q', n('0 1 2').scale('c quarter').sound('s'))
`)
    if (!staged.ok) throw new Error('stage failed')
    const notes = capturePatternNotes(staged.patterns, { cycles: 1, cps: 1 })
    expect(notes.map((n) => n.midi)).toEqual([60, 60.5, 61])
  })

  it('full path: capture -> notesToSmf -> parseMidi puts the track where the pattern says', () => {
    const staged = stageCode(TRACK_SOURCE)
    if (!staged.ok) throw new Error('stage failed')
    const cps = staged.cps ?? 0.5
    const notes = capturePatternNotes(staged.patterns, { cycles: 2, cps })
    const f = parseMidi(notesToSmf(notes, { cps, trackOrder: [...staged.synths.keys()] }))
    // synth definition order drives track order, after the conductor
    expect(f.tracks.map((t) => t.name)).toEqual(['rondocode', 'kick', 'lead'])
    expect(Math.round(f.tempoBpm)).toBe(240) // cps 1 = 240 bpm in 4/4
    const mel = f.tracks[2]!
    expect(mel.notes.map((n) => n.pitch)).toEqual([60, 64, 67, 71, 60, 64, 67, 71])
    // quarter notes at 480 tpq: onsets every 480 ticks, two full bars
    expect(mel.notes.map((n) => n.startTick)).toEqual([0, 480, 960, 1440, 1920, 2400, 2880, 3360])
    expect(f.tracks[1]!.notes.every((n) => n.velocity === Math.round(0.8 * 127))).toBe(true)
  })
})
