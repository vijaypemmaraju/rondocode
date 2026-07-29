import { describe, expect, it } from 'vitest'
import { HeldNotes, LiveArp, degreeToNote, formatArpSteps, parseArpSteps } from '../src/midi/livearp'

/* The Cthulhu idea under test: a step names a chord DEGREE, so one pattern
 * re-voices onto any chord. Everything here is about that holding true as the
 * chord changes under a running sequence. */

const Am = [57, 60, 64] // a c e
const F = [53, 57, 60] // f a c

describe('degrees, not notes', () => {
  it('wraps past the top of the chord an octave up, rather than clamping', () => {
    // a 4-step pattern over a triad must CLIMB, not repeat its top note
    expect([0, 1, 2, 3, 4].map((d) => degreeToNote(Am, d))).toEqual([57, 60, 64, 69, 72])
  })

  it('wraps downward for negative degrees, so a pattern can reach below', () => {
    expect([-1, -2, -3].map((d) => degreeToNote(Am, d))).toEqual([52, 48, 45])
  })

  it('is null with nothing held', () => {
    expect(degreeToNote([], 0)).toBeNull()
  })
})

describe('the same pattern over a different chord', () => {
  const arp = new LiveArp({ steps: [{ degrees: [0] }, { degrees: [2] }, { degrees: [1] }, { degrees: [3] }] })

  it('re-voices onto whatever is held — the whole point', () => {
    const over = (held: number[]) => [0, 1, 2, 3].map((t) => arp.at(t, held)[0]!.note)
    expect(over(Am)).toEqual([57, 64, 60, 69]) // a e c a'
    expect(over(F)).toEqual([53, 60, 57, 65]) // f c a f'  — same shape
  })

  it('keeps its rhythm when the chord size changes mid-sequence', () => {
    const two = [60, 67]
    expect(arp.at(0, two)[0]!.note).toBe(60)
    expect(arp.at(3, two)[0]!.note).toBe(67 + 12) // degree 3 of a dyad
  })
})

describe('steps carry more than pitch', () => {
  it('an empty degree list is a rest, which is how rhythm is written', () => {
    const a = new LiveArp({ steps: [{ degrees: [0] }, { degrees: [] }] })
    expect(a.at(0, Am)).toHaveLength(1)
    expect(a.at(1, Am)).toEqual([])
  })

  it('several degrees in one step is a stab', () => {
    const a = new LiveArp({ steps: [{ degrees: [0, 1, 2] }] })
    expect(a.at(0, Am).map((n) => n.note)).toEqual([57, 60, 64])
  })

  it('a tie extends the previous note instead of retriggering', () => {
    const a = new LiveArp({ steps: [{ degrees: [0], gate: 0.5 }, { tie: true, degrees: [] }] })
    expect(a.at(0, Am)[0]!.steps).toBeCloseTo(1.5) // 0.5 gate + 1 tied step
    expect(a.at(1, Am)).toEqual([]) // the tie itself sounds nothing
  })

  it('velocity and per-step octave apply', () => {
    const a = new LiveArp({ steps: [{ degrees: [0], velocity: 0.5, octave: 1 }] })
    const n = a.at(0, Am)[0]!
    expect(n.note).toBe(57 + 12)
    expect(n.velocity).toBe(64)
  })

  it('never emits a velocity of 0, which would read as a note-off', () => {
    const a = new LiveArp({ steps: [{ degrees: [0], velocity: 0 }] })
    expect(a.at(0, Am)[0]!.velocity).toBeGreaterThan(0)
  })

  it('drops a degree that lands outside MIDI range rather than wrapping it', () => {
    const a = new LiveArp({ steps: [{ degrees: [0], octave: 9 }] })
    expect(a.at(0, Am)).toEqual([])
  })
})

describe('octave range repeats the whole pattern up', () => {
  it('plays the pattern again an octave higher', () => {
    const a = new LiveArp({ steps: [{ degrees: [0] }, { degrees: [1] }], octaves: 2 })
    expect([0, 1, 2, 3].map((t) => a.at(t, Am)[0]!.note)).toEqual([57, 60, 69, 72])
  })
})

describe('simple modes share the pattern arp’s order table', () => {
  it('walks up, down and updown the same way .arp() does', () => {
    const up = new LiveArp({ mode: 'up' })
    expect([0, 1, 2].map((t) => up.at(t, Am)[0]!.note)).toEqual([57, 60, 64])
    const down = new LiveArp({ mode: 'down' })
    expect([0, 1, 2].map((t) => down.at(t, Am)[0]!.note)).toEqual([64, 60, 57])
    const ud = new LiveArp({ mode: 'updown' })
    // up then back down WITHOUT repeating the endpoints
    expect([0, 1, 2, 3].map((t) => ud.at(t, Am)[0]!.note)).toEqual([57, 60, 64, 60])
  })

  it('an unknown mode falls back to up rather than going silent', () => {
    const a = new LiveArp({ mode: 'nonsense' })
    expect(a.at(0, Am)[0]!.note).toBe(57)
  })
})

describe('nothing held', () => {
  it('sounds nothing rather than throwing', () => {
    expect(new LiveArp().at(0, [])).toEqual([])
    expect(new LiveArp({ mode: 'up' }).at(5, [])).toEqual([])
  })

  it('a negative tick still lands in range', () => {
    const a = new LiveArp({ steps: [{ degrees: [0] }, { degrees: [1] }] })
    expect(a.at(-1, Am)[0]!.note).toBe(60)
  })
})

describe('held notes and latch', () => {
  it('sorts ascending, so degree 0 is always the lowest', () => {
    const h = new HeldNotes()
    h.noteOn(64); h.noteOn(57); h.noteOn(60)
    expect(h.notes()).toEqual([57, 60, 64])
  })

  it('unlatched, releasing a key removes it', () => {
    const h = new HeldNotes()
    h.noteOn(60); h.noteOn(64); h.noteOff(60)
    expect(h.notes()).toEqual([64])
  })

  it('latched, the chord survives letting go — the point of latch', () => {
    const h = new HeldNotes(true)
    h.noteOn(57); h.noteOn(60); h.noteOn(64)
    h.noteOff(57); h.noteOff(60); h.noteOff(64)
    expect(h.notes()).toEqual([57, 60, 64]) // still arpeggiating
  })

  it('latched, a NEW press starts a fresh chord instead of piling on', () => {
    const h = new HeldNotes(true)
    h.noteOn(57); h.noteOn(60)
    h.noteOff(57); h.noteOff(60)
    h.noteOn(53) // new chord
    expect(h.notes()).toEqual([53])
  })

  it('latched, adding a key WHILE holding extends the same chord', () => {
    const h = new HeldNotes(true)
    h.noteOn(57)
    h.noteOn(60) // still holding 57
    expect(h.notes()).toEqual([57, 60])
  })

  it('turning latch off drops the latched chord', () => {
    const h = new HeldNotes(true)
    h.noteOn(57); h.noteOff(57)
    h.setLatch(false)
    expect(h.notes()).toEqual([])
  })
})

/* ------------------------------------------------------------------------- *
 * The step-pattern notation.
 *
 * Degrees, not notes: the same figure re-voices itself onto whatever chord you
 * hold, which is what makes a pattern reusable instead of a transcription.
 * Everything here is about how a WRITTEN pattern becomes steps — and about
 * what a typo costs, since this is parsed on every keystroke.
 * ------------------------------------------------------------------------- */
describe('parseArpSteps', () => {
  it('reads degrees in order', () => {
    expect(parseArpSteps('0 2 1 4')).toEqual([
      { degrees: [0] }, { degrees: [2] }, { degrees: [1] }, { degrees: [4] },
    ])
  })

  it('`~` is a rest, which is how rhythm gets written', () => {
    expect(parseArpSteps('0 ~ 2')).toEqual([{ degrees: [0] }, { degrees: [] }, { degrees: [2] }])
  })

  it('`_` ties, so a note can last longer than one step', () => {
    expect(parseArpSteps('0 _')).toEqual([{ degrees: [0] }, { degrees: [], tie: true }])
  })

  it('brackets stab several degrees at once', () => {
    expect(parseArpSteps('[0,2,4] 1')).toEqual([{ degrees: [0, 2, 4] }, { degrees: [1] }])
  })

  it('carries velocity and octave, including on a stab', () => {
    expect(parseArpSteps('0:.6 1^-1 [0,2]:.5^1')).toEqual([
      { degrees: [0], velocity: 0.6 },
      { degrees: [1], octave: -1 },
      { degrees: [0, 2], velocity: 0.5, octave: 1 },
    ])
  })

  it('negative degrees reach below the chord', () => {
    expect(parseArpSteps('-1 0')).toEqual([{ degrees: [-1] }, { degrees: [0] }])
  })

  it('DROPS a bad step instead of guessing, and keeps the rest', () => {
    // parsed on every keystroke: a half-typed token must cost that step, not
    // the pattern
    expect(parseArpSteps('0 zz 2')).toEqual([{ degrees: [0] }, { degrees: [2] }])
    expect(parseArpSteps('0 [ 2')).toEqual([{ degrees: [0] }, { degrees: [2] }])
  })

  it('an out-of-range velocity is ignored rather than clamped silently', () => {
    expect(parseArpSteps('0:9')).toEqual([{ degrees: [0] }])
  })

  it('empty input yields nothing, so the caller keeps its default', () => {
    expect(parseArpSteps('   ')).toEqual([])
  })

  it('round-trips through formatArpSteps', () => {
    for (const src of ['0 2 1 4', '0 ~ 2 _', '[0,2] 1', '0:0.6 1^-1', '-1 0']) {
      expect(formatArpSteps(parseArpSteps(src))).toBe(src)
    }
  })

  it('a parsed pattern really drives the arp over a held chord', () => {
    const arp = new LiveArp({ steps: parseArpSteps('0 ~ [0,2] 1') })
    const held = [60, 64, 67] // C major
    expect(arp.at(0, held).map((n) => n.note)).toEqual([60])
    expect(arp.at(1, held)).toEqual([]) // the rest
    expect(arp.at(2, held).map((n) => n.note)).toEqual([60, 67])
    expect(arp.at(3, held).map((n) => n.note)).toEqual([64])
  })
})
