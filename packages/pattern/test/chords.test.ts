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

  it('accepts SLASH-BASS chords (regression: the mini-parser ate the / as slow)', () => {
    // 'C/E' = C major over an E bass. Documented + advertised in the error text,
    // but chord() used to throw MiniError because '/' is the slow combinator.
    expect(notesOf(q(chord('C/E'), 0, 1)).sort((a, b) => a - b)).toEqual([40, 48, 52, 55])
    expect(notesOf(q(chord('Cmaj7/E'), 0, 1)).sort((a, b) => a - b)).toEqual([40, 48, 52, 55, 59])
    // non-slash names and sequences still go through the normal path
    expect(notesOf(q(chord('Am7'), 0, 1)).sort((a, b) => a - b)).toEqual([57, 60, 64, 67])
    expect(() => chord('Q/E')).toThrow() // bad root still errors
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

describe('voiceLead', () => {
  const prog = () => chord('<Cmaj7 Fmaj7 Bm7b5 E7>')
  const cycleNotes = (p: ReturnType<typeof chord>, c: number): number[] =>
    notesOf(q(p, c, c + 1)).sort((a, b) => a - b)

  it('keeps every chord in a tight register around center (no root-position leaps)', () => {
    const led = prog().voiceLead(60)
    for (let c = 0; c < 4; c++) {
      const ns = cycleNotes(led, c)
      for (const n of ns) {
        expect(n).toBeGreaterThan(60 - 16)
        expect(n).toBeLessThan(60 + 16)
      }
    }
  })

  it('moves less between chords than root position does', () => {
    const centroid = (ns: number[]): number => ns.reduce((s, n) => s + n, 0) / ns.length
    const totalMotion = (p: ReturnType<typeof chord>): number => {
      let m = 0
      for (let c = 1; c < 4; c++) m += Math.abs(centroid(cycleNotes(p, c)) - centroid(cycleNotes(p, c - 1)))
      return m
    }
    expect(totalMotion(prog().voiceLead())).toBeLessThan(totalMotion(prog()))
  })

  it('is deterministic across query boundaries', () => {
    const led = prog().voiceLead()
    // querying one cycle in isolation matches that cycle inside a wider query
    expect(cycleNotes(led, 2)).toEqual(notesOf(q(led, 2, 3)).sort((a, b) => a - b))
    const wide = q(led, 0, 4)
      .filter((e) => e[0] >= 2 && e[0] < 3)
      .map((e) => (e[2] as ControlMap).note!)
      .sort((a, b) => a - b)
    expect(cycleNotes(led, 2)).toEqual(wide)
  })

  it('loops seamlessly: cycle 0 leads from the wrapped-around previous chord', () => {
    // with a repeating progression, the first chord is voiced relative to the
    // LAST one (cycle -1), not the center anchor — so the loop point is smooth
    const led = prog().voiceLead(60)
    for (const n of cycleNotes(led, 0)) expect(n).toBeLessThan(60 + 16) // not a root-position leap
  })

  it('anchors to center only when no prior chord is in range (sparse progression)', () => {
    // a chord that onsets every 8 cycles has no predecessor within the lookback,
    // so cycle 0 anchors its register to center
    const ns = cycleNotes(chord('Cmaj7').slow(8).voiceLead(72), 0)
    const mean = ns.reduce((s, n) => s + n, 0) / ns.length
    expect(Math.abs(mean - 72)).toBeLessThan(8)
  })
})
