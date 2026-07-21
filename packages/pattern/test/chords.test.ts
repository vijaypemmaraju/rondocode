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
