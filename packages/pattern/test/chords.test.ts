import { describe, expect, it } from 'vitest'
import { chord, parseChord } from '../src/index'
import type { ControlMap, Pattern } from '../src/index'
import { q, qw } from './helpers'

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

  // Regression: arp used to reconstruct only from ONSET haps, so any query
  // window not containing the CHORD's onset produced no arp notes at all —
  // the live scheduler (which queries small successive windows) lost every
  // note but the first. Arp must reconstruct from the hap's WHOLE, like the
  // other structural combinators, so each arp note's onset is discoverable
  // in whatever window contains it.
  const onsetsIn = (p: Pattern<ControlMap>, b: number, e: number): [number, number][] =>
    qw(p, b, e)
      .filter((h) => h.whole !== null && h.part[0] === h.whole[0])
      .map((h) => [h.part[0], (h.value as ControlMap).note!])

  it('scheduler-shaped windows yield the same onsets as the aligned query', () => {
    const p = chord('C').arp('up')
    const aligned = onsetsIn(p, 0, 1)
    expect(aligned).toEqual([
      [0, 48],
      [1 / 3, 52],
      [2 / 3, 55],
    ])
    const windows: [number, number][] = [[0, 0.1], [0.1, 0.4], [0.4, 0.7], [0.7, 1]]
    expect(windows.flatMap(([b, e]) => onsetsIn(p, b, e))).toEqual(aligned)
  })

  it('partial windows over multi-cycle alternated chords keep every onset', () => {
    const p = chord('<Cmaj7 Am7>').arp('up')
    const aligned = onsetsIn(p, 0, 2)
    expect(aligned).toEqual([
      [0, 48], [0.25, 52], [0.5, 55], [0.75, 59],
      [1, 57], [1.25, 60], [1.5, 64], [1.75, 67],
    ])
    const windows: [number, number][] = [[0, 0.1], [0.1, 0.6], [0.6, 1.1], [1.1, 1.6], [1.6, 2]]
    expect(windows.flatMap(([b, e]) => onsetsIn(p, b, e))).toEqual(aligned)
  })

  it('a mid-note window returns the covering arp note as a tail (whole intact)', () => {
    // [0.4, 0.5) sits inside the 52-note's slot [1/3, 2/3): the fragment must
    // carry the full slot as its whole (no onset), not vanish.
    const evs = qw(chord('C').arp('up'), 0.4, 0.5)
    expect(evs).toEqual([
      { whole: [1 / 3, 2 / 3], part: [0.4, 0.5], value: expect.objectContaining({ note: 52 }) },
    ])
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
    // Cmaj7 [48,52,55,59] -octave(1)-> [60,64,67,71] -invert(1)-> [64,67,71,72];
    // Am7 [57,60,64,67] -> [69,72,76,79] -> [72,76,79,81]. Pinned onsets AND
    // pitches (4 quarter-step notes per cycle, low→high).
    const p = chord('<Cmaj7 Am7>').octave(1).invert(1)
    const arped = q(p.arp('up'), 0, 2)
    expect(arped.map((e) => [e[0], e[1], (e[2] as ControlMap).note!])).toEqual([
      [0, 0.25, 64], [0.25, 0.5, 67], [0.5, 0.75, 71], [0.75, 1, 72],
      [1, 1.25, 72], [1.25, 1.5, 76], [1.5, 1.75, 79], [1.75, 2, 81],
    ])
  })

  it('an unknown voicing name falls back to close', () => {
    expect(sorted(chord('C').voicing('nope'))).toEqual([48, 52, 55])
  })
})

describe('voiceLead', () => {
  const prog = () => chord('<Cmaj7 Fmaj7 Bm7b5 E7>')
  const cycleNotes = (p: ReturnType<typeof chord>, c: number): number[] =>
    notesOf(q(p, c, c + 1)).sort((a, b) => a - b)

  it('voices every chord toward its predecessor (pinned pitches; identity fails)', () => {
    // Root positions are Cmaj7 [48,52,55,59], Fmaj7 [53,57,60,64],
    // Bm7b5 [59,62,65,69], E7 [52,56,59,62] — all already inside a wide
    // register band, so a band check cannot catch a broken voiceLead. Pin the
    // exact voiced pitches instead (cycle 0 leads from the wrapped E7).
    const led = prog().voiceLead(60)
    expect(cycleNotes(led, 0)).toEqual([52, 55, 59, 60])
    expect(cycleNotes(led, 1)).toEqual([48, 52, 53, 57])
    expect(cycleNotes(led, 2)).toEqual([53, 57, 59, 62])
    expect(cycleNotes(led, 3)).toEqual([59, 62, 64, 68])
    // and at least one cycle differs from root position (identity fails)
    expect(cycleNotes(led, 0)).not.toEqual(cycleNotes(prog(), 0))
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
    // With a repeating progression, the first chord is voiced relative to the
    // LAST one (cycle -1 = E7 [52,56,59,62]), not the center anchor. Leading
    // Cmaj7 [48,52,55,59] from E7 lifts only the root: [52,55,59,60]. Without
    // the lookback (ref = [60]) it would come out [55,59,60,64] — pin the
    // wrap-around result exactly so deleting the lookback fails.
    const led = prog().voiceLead(60)
    expect(cycleNotes(led, 0)).toEqual([52, 55, 59, 60])
    expect(cycleNotes(led, 0)).not.toEqual([55, 59, 60, 64]) // the center-anchored voicing
  })

  it('anchors to center only when no prior chord is in range (sparse progression)', () => {
    // a chord that onsets every 8 cycles has no predecessor within the lookback,
    // so cycle 0 anchors its register to center
    const ns = cycleNotes(chord('Cmaj7').slow(8).voiceLead(72), 0)
    const mean = ns.reduce((s, n) => s + n, 0) / ns.length
    expect(Math.abs(mean - 72)).toBeLessThan(8)
  })
})
