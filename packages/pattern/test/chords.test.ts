import { describe, expect, it } from 'vitest'
import { CHORD_QUALITIES, chord, parseChord } from '../src/index'
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

  /* `<D2 Bm9 Gadd9 Asus>` — an ordinary pop progression, and `D2` was the one
   * atom of it that parsed as nothing at all. */
  describe('added tones that KEEP the third', () => {
    it('reads the chart spelling `D2`', () => {
      expect(parseChord('D2')).toEqual([50, 52, 54, 57]) // D E F# A
    })

    it('is NOT sus2 — a sus REPLACES the third, a 2 adds to it', () => {
      // the whole reason this is its own quality: same name in casual use,
      // different chord, and the third is what tells them apart
      expect(parseChord('Dsus2')).toEqual([50, 52, 57]) // D E A — no third
      expect(parseChord('D2')).toContain(54) // F#
      expect(parseChord('Dsus2')).not.toContain(54)
    })

    it('is NOT add9 either — the 9th sits an octave up and does not rub', () => {
      expect(parseChord('Dadd9')).toEqual([50, 54, 57, 64])
      // both hold the same pitch classes; the VOICING is the point
      expect(parseChord('D2')!.map((n) => n % 12).sort()).toEqual(
        parseChord('Dadd9')!.map((n) => n % 12).sort(),
      )
      expect(parseChord('D2')).not.toEqual(parseChord('Dadd9'))
    })

    it('covers the rest of the family, major and minor', () => {
      expect(parseChord('Cadd2')).toEqual(parseChord('C2'))
      expect(parseChord('Cm2')).toEqual([48, 50, 51, 55]) // minor third
      expect(parseChord('Cadd4')).toEqual([48, 52, 53, 55])
      expect(parseChord('Cadd11')).toEqual([48, 52, 55, 65]) // the 4th, octave up
    })

    it('takes a slash bass like any other quality', () => {
      expect(parseChord('C2/E')!.slice(1)).toEqual(parseChord('C2'))
    })

    it('the whole progression that reported this parses', () => {
      for (const name of ['D2', 'Bm9', 'Gadd9', 'Asus']) {
        expect(parseChord(name), name).toBeDefined()
      }
    })

    it('and PLAYS: <D2 Bm9 Gadd9 Asus> gives four chords, one per cycle', () => {
      // end to end through chord(), because parsing is only half the claim —
      // `chord()` THROWS on an atom it cannot read, so before this the whole
      // progression was an error, not three good chords and one bad one
      const p = chord('<D2 Bm9 Gadd9 Asus>')
      const cycle = (c: number): number[] => notesOf(q(p, c, c + 1)).sort((a, b) => a - b)
      expect(cycle(0)).toEqual([50, 52, 54, 57]) // D2   D E F# A
      expect(cycle(1)).toEqual([59, 62, 66, 69, 73]) // Bm9
      expect(cycle(2)).toEqual([55, 59, 62, 69]) // Gadd9
      expect(cycle(3)).toEqual([57, 62, 64]) // Asus
    })
  })
})

describe('CHORD_QUALITIES', () => {
  it('lists every quality the parser accepts, and only those', () => {
    for (const q of CHORD_QUALITIES) {
      expect(parseChord(`C${q}`), `C${q}`).toBeDefined()
    }
    expect(CHORD_QUALITIES).toContain('2')
    expect(CHORD_QUALITIES, 'the bare-root major is not a suffix').not.toContain('')
  })

  it('is longest-first, so a listing shows maj7 before maj', () => {
    expect(CHORD_QUALITIES.indexOf('maj7')).toBeLessThan(CHORD_QUALITIES.indexOf('maj'))
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

/* ------------------------------------------------------------------------- *
 * WHAT EVERY QUALITY ACTUALLY SPELLS.
 *
 * The suite checked the table with `expect(parseChord(`C${q}`)).toBeDefined()`
 * — which passes for ANY intervals. A mutation audit changed `dim7` from
 * [0,3,6,9] to a plain [0,3,6] and the whole suite stayed green; 29 of the 43
 * qualities had no assertion about the notes they produce at all.
 *
 * This is data where a mistake is silent: nothing crashes when a chord is
 * spelled wrong, it just sounds wrong, in a project, later. So every quality
 * is pinned to its semitones from the root.
 * ------------------------------------------------------------------------- */
const SPELLINGS: [string, number[]][] = [
  // triads and the power chord
  ['maj', [0, 4, 7]],
  ['major', [0, 4, 7]],
  ['M', [0, 4, 7]],
  ['min', [0, 3, 7]],
  ['minor', [0, 3, 7]],
  ['m', [0, 3, 7]],
  ['dim', [0, 3, 6]],
  ['aug', [0, 4, 8]],
  ['5', [0, 7]],
  // sevenths
  ['7', [0, 4, 7, 10]],
  ['dom7', [0, 4, 7, 10]],
  ['maj7', [0, 4, 7, 11]],
  ['M7', [0, 4, 7, 11]],
  ['m7', [0, 3, 7, 10]],
  ['min7', [0, 3, 7, 10]],
  ['m7b5', [0, 3, 6, 10]],
  ['dim7', [0, 3, 6, 9]],
  // sixths
  ['6', [0, 4, 7, 9]],
  ['m6', [0, 3, 7, 9]],
  ['min6', [0, 3, 7, 9]],
  // extensions
  ['9', [0, 4, 7, 10, 14]],
  ['maj9', [0, 4, 7, 11, 14]],
  ['m9', [0, 3, 7, 10, 14]],
  ['11', [0, 4, 7, 10, 14, 17]],
  ['m11', [0, 3, 7, 10, 14, 17]],
  ['13', [0, 4, 7, 10, 14, 21]],
  ['m13', [0, 3, 7, 10, 14, 21]],
  // suspensions
  ['sus2', [0, 2, 7]],
  ['sus4', [0, 5, 7]],
  ['sus', [0, 5, 7]],
  ['7sus4', [0, 5, 7, 10]],
  // added tones (the third stays)
  ['2', [0, 2, 4, 7]],
  ['add2', [0, 2, 4, 7]],
  ['4', [0, 4, 5, 7]],
  ['add4', [0, 4, 5, 7]],
  ['add9', [0, 4, 7, 14]],
  ['add11', [0, 4, 7, 17]],
  // added tones over a minor third
  ['m2', [0, 2, 3, 7]],
  ['madd2', [0, 2, 3, 7]],
  ['m4', [0, 3, 5, 7]],
  ['madd4', [0, 3, 5, 7]],
  ['madd9', [0, 3, 7, 14]],
  ['madd11', [0, 3, 7, 17]],
]

describe('every chord quality spells the chord it names', () => {
  it('covers the whole table (a short list here would hide a new quality)', () => {
    expect(SPELLINGS.map(([q]) => q).sort()).toEqual([...CHORD_QUALITIES].sort())
  })

  it.each(SPELLINGS)('C%s is %j semitones from the root', (quality, intervals) => {
    const notes = parseChord(`C${quality}`)
    expect(notes, `C${quality} did not parse`).toBeDefined()
    expect(notes!.map((n) => n - notes![0])).toEqual(intervals)
  })

  it('the aliases really are aliases, not near-misses', () => {
    // maj/major/M and min/minor/m are three spellings of one chord each; a
    // table this long is exactly where one of them drifts a semitone
    for (const group of [['maj', 'major', 'M'], ['min', 'minor', 'm'], ['7', 'dom7'],
                         ['maj7', 'M7'], ['m7', 'min7'], ['m6', 'min6'], ['sus4', 'sus'],
                         ['2', 'add2'], ['4', 'add4'], ['m2', 'madd2'], ['m4', 'madd4']]) {
      const spellings = group.map((q) => JSON.stringify(parseChord(`C${q}`)))
      expect(new Set(spellings).size, `${group.join(' / ')} disagree`).toBe(1)
    }
  })
})
