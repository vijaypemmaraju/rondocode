import { describe, expect, it } from 'vitest'
import { parseMelodyMini, assembleGuide } from '../src/sing/warp'
import type { Seg } from '../src/sing/warp'

/* RESTS are musical time. A melody's silence has to survive into the baked
 * clip: a pickup that ignores its leading rest sings ahead of the beat, and
 * every later note drifts early. Measured, never guessed. */

/** A stand-in syllable: short onset, a bit of vowel, no coda. */
const seg = (sr: number): Seg => ({
  onset: new Float32Array(Math.floor(0.02 * sr)).fill(0.5),
  vowel: new Float32Array(Math.floor(0.05 * sr)).fill(0.5),
  coda: new Float32Array(0),
})

describe('parseMelodyMini start times', () => {
  it('a leading rest pushes the first note later (the pickup case)', () => {
    // 1 cycle = 2s at cps .5; `~@10` of 16 = 1.25s of silence first
    const m = parseMelodyMini('~@10 e4@2 f4@2 g4@2', 0.5)
    expect(m).toHaveLength(3)
    expect(m[0]!.start).toBeCloseTo(1.25, 6)
    expect(m[0]!.dur).toBeCloseTo(0.25, 6)
    expect(m[2]!.start).toBeCloseTo(1.75, 6)
  })

  it('an INNER rest leaves a gap between notes', () => {
    const m = parseMelodyMini('c4 ~ e4 g4', 0.5) // 4 slots x .5s
    expect(m.map((n) => n.start)).toEqual([0, 1, 1.5])
    // the note before the rest does not stretch into it
    expect(m[0]!.start + m[0]!.dur).toBeCloseTo(0.5, 6)
  })

  it('multi-cycle keeps rests in later cycles too', () => {
    const m = parseMelodyMini('<[~ c4] [e4 g4]>', 0.5, 2)
    expect(m.map((n) => n.start)).toEqual([1, 2, 3])
  })
})

describe('assembleGuide with rests', () => {
  const sr = 16000

  it('the clip spans the whole phrase, not just the sung notes', () => {
    const notes = parseMelodyMini('~@10 e4@2 f4@2 g4@2', 0.5) // phrase = 2s
    const segs = notes.map(() => seg(sr))
    const g = assembleGuide(segs, notes, sr, 2)
    // 2 seconds of clip, though only 0.75s of it sings
    expect(g.guide.length).toBe(2 * sr)
  })

  it('the leading rest is SILENT and the first syllable lands on its beat', () => {
    const notes = parseMelodyMini('~@10 e4@2 f4@2 g4@2', 0.5)
    const segs = notes.map(() => seg(sr))
    const { guide, f0, fps } = assembleGuide(segs, notes, sr, 2)
    // silence through the rest (a small lead-in for the first onset is allowed)
    const restEnd = Math.floor(1.25 * sr)
    let energy = 0
    for (let i = 0; i < restEnd - Math.floor(0.03 * sr); i++) energy += Math.abs(guide[i]!)
    expect(energy).toBe(0)
    // ...and audio right after the beat
    let after = 0
    for (let i = restEnd; i < restEnd + Math.floor(0.05 * sr); i++) after += Math.abs(guide[i]!)
    expect(after).toBeGreaterThan(0)
    // f0 is unvoiced during the rest, voiced on the note
    expect(f0[Math.floor(0.5 * fps)]).toBe(0)
    expect(f0[Math.floor(1.35 * fps)]).toBeGreaterThan(0)
  })

  it('without a rest the timing is unchanged (backward compatible)', () => {
    const notes = parseMelodyMini('c4 e4', 0.5)
    const segs = notes.map(() => seg(sr))
    const g = assembleGuide(segs, notes, sr, 2)
    expect(g.guide.length).toBe(2 * sr)
    expect(notes.map((n) => n.start)).toEqual([0, 1])
  })
})
