import { describe, expect, it } from 'vitest'
import { chord, parseChord } from '../src/index'
import type { ControlMap } from '../src/index'
import { q } from './helpers'

const notesOf = (evs: [number, number, unknown][]): number[] =>
  evs.map((e) => (e[2] as ControlMap).note!)

describe('parseChord', () => {
  it('parses common qualities (root octave 3)', () => {
    expect(parseChord('C')).toEqual([48, 52, 55]) // c3 e3 g3
    expect(parseChord('Cmaj7')).toEqual([48, 52, 55, 59])
    expect(parseChord('Am')).toEqual([57, 60, 64]) // a3 c4 e4
    expect(parseChord('Am7')).toEqual([57, 60, 64, 67])
    expect(parseChord('F#m')).toEqual([54, 57, 61])
    expect(parseChord('Gsus4')).toEqual([55, 60, 62])
    expect(parseChord('C7')).toEqual([48, 52, 55, 58])
    expect(parseChord('Dm7')).toEqual([50, 53, 57, 60])
  })

  it('supports a slash bass placed below the root', () => {
    const slash = parseChord('C/E')!
    expect(slash[0]!).toBeLessThan(48) // E placed below the C3 root
    expect(slash.slice(1)).toEqual([48, 52, 55])
  })

  it('returns undefined for non-chords', () => {
    expect(parseChord('xyz')).toBeUndefined()
    expect(parseChord('Cwhat')).toBeUndefined()
  })
})

describe('chord()', () => {
  it('expands a name into a stack of simultaneous notes', () => {
    const evs = q(chord('Cmaj7'), 0, 1)
    expect(evs).toHaveLength(4)
    expect(evs.every((e) => e[0] === 0 && e[1] === 1)).toBe(true) // all at [0,1)
    expect(notesOf(evs).sort((a, b) => a - b)).toEqual([48, 52, 55, 59])
  })

  it('alternates chords per cycle with <>', () => {
    const p = chord('<Cmaj7 Am7>')
    expect(notesOf(q(p, 0, 1)).sort((a, b) => a - b)).toEqual([48, 52, 55, 59])
    expect(notesOf(q(p, 1, 2)).sort((a, b) => a - b)).toEqual([57, 60, 64, 67])
  })

  it('throws on a non-chord atom', () => {
    expect(() => chord('Cmaj7 xyz')).toThrow()
  })
})

describe('.arp()', () => {
  it("'up' spreads chord notes low→high across the step", () => {
    const evs = q(chord('C').arp('up'), 0, 1) // C = [48, 52, 55]
    expect(notesOf(evs)).toEqual([48, 52, 55])
    expect(evs[0]![0]).toBe(0)
    expect(evs[0]![1]).toBeCloseTo(1 / 3)
    expect(evs[2]![0]).toBeCloseTo(2 / 3)
  })

  it("'down' reverses the order", () => {
    expect(notesOf(q(chord('C').arp('down'), 0, 1))).toEqual([55, 52, 48])
  })

  it("'updown' bounces without repeating the ends", () => {
    expect(notesOf(q(chord('C').arp('updown'), 0, 1))).toEqual([48, 52, 55, 52])
  })
})

describe('chord voicings', () => {
  const sorted = (p: ReturnType<typeof chord>): number[] =>
    notesOf(q(p, 0, 1)).sort((a, b) => a - b)

  it('invert(k) lifts the lowest voices up an octave (wrapping)', () => {
    // C major = [48, 52, 55]
    expect(sorted(chord('C').invert(1))).toEqual([52, 55, 60]) // root up 8ve
    expect(sorted(chord('C').invert(2))).toEqual([55, 60, 64]) // lowest two up
    expect(sorted(chord('C').invert(3))).toEqual([60, 64, 67]) // full octave up
  })

  it('negative invert drops the highest voices down', () => {
    expect(sorted(chord('C').invert(-1))).toEqual([43, 48, 52]) // top (55) down 8ve
  })

  it('octave(n) transposes the whole chord', () => {
    expect(sorted(chord('C').octave(1))).toEqual([60, 64, 67])
    expect(sorted(chord('C').octave(-1))).toEqual([36, 40, 43])
  })

  it('voicing modes re-space the chord', () => {
    // Cmaj7 = [48, 52, 55, 59]
    expect(sorted(chord('Cmaj7').voicing('close'))).toEqual([48, 52, 55, 59])
    expect(sorted(chord('C').voicing('open'))).toEqual([48, 55, 64]) // 2nd voice up 8ve
    expect(sorted(chord('Cmaj7').voicing('drop2'))).toEqual([43, 48, 52, 59]) // 2nd-from-top down
    expect(sorted(chord('Cmaj7').voicing('drop3'))).toEqual([40, 48, 55, 59]) // 3rd-from-top down
    expect(sorted(chord('Cmaj7').voicing('spread'))).toEqual([48, 55, 64, 71]) // alt voices up
  })

  it('voicings compose and still arpeggiate', () => {
    const p = chord('<Cmaj7 Am7>').octave(1).invert(1)
    // 8 note-events over two cycles once arpeggiated (4 per chord)
    const arped = q(p.arp('up'), 0, 2)
    expect(arped.length).toBe(8)
  })

  it('an unknown voicing name falls back to close', () => {
    expect(sorted(chord('C').voicing('nope'))).toEqual([48, 52, 55])
  })
})
