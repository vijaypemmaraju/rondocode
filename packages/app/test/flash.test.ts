import { describe, expect, it } from 'vitest'
import type { SchedulerEvent } from '@rondocode/pattern'
import {
  EventFlasher,
  FLASH_MS,
  MAX_PENDING_FLASHES,
  collectStringLiterals,
  locToDocRanges,
} from '../src/editor/flash'

/* Pure parts of event flashing: string-literal collection and mini-Loc →
 * doc-range mapping (see src/editor/flash.ts module doc for the policy). */

describe('collectStringLiterals', () => {
  it('collects escape-free string literals with their content offsets', () => {
    const src = `p('bass', n('0 3 5').sound('acid'))`
    const lits = collectStringLiterals(src)
    expect(lits.map((l) => l.content)).toEqual(['bass', '0 3 5', 'acid'])
    const degrees = lits[1]!
    expect(src.slice(degrees.contentStart, degrees.contentStart + degrees.content.length)).toBe(
      '0 3 5',
    )
  })

  it('skips literals with escapes (raw ≠ cooked breaks offset math)', () => {
    expect(collectStringLiterals(`const x = 'a\\'b'`)).toEqual([])
  })

  it('returns [] for unparseable source instead of throwing', () => {
    expect(collectStringLiterals('const = )')).toEqual([])
  })

  it('collects a no-substitution template literal (incl. multi-line) with exact offsets', () => {
    const src = "note(`[c3,e3,g3] [f3,a3,c4]\n  [g3,b3,d4]`).sound('piano')"
    const lits = collectStringLiterals(src)
    const chord = lits.find((l) => l.content.includes('c3'))!
    expect(chord.content).toBe('[c3,e3,g3] [f3,a3,c4]\n  [g3,b3,d4]')
    // the content offset maps back to the exact source text (so flash lands right)
    expect(src.slice(chord.contentStart, chord.contentStart + chord.content.length)).toBe(chord.content)
  })

  it('skips template literals with ${} interpolation (offset math would break)', () => {
    expect(collectStringLiterals('note(`a3 ${x} e4`)')).toEqual([])
  })

  it('collects a `+` concatenation as ONE assembled literal', () => {
    // The pattern engine numbers locs against the assembled value, so the
    // concatenation must be one StringLit whose content is the joined string.
    const src = `note('a3 c4' + ' e4 g4')`
    const lits = collectStringLiterals(src)
    expect(lits.map((l) => l.content)).toEqual(['a3 c4 e4 g4'])
    expect(lits[0]!.pieces).toHaveLength(2)
  })

  it('does NOT merge `+` with a non-string operand', () => {
    const lits = collectStringLiterals(`const x = 'a' + y + 'b'`)
    expect(lits.map((l) => l.content)).toEqual(['a', 'b'])
  })
})

describe('locToDocRanges', () => {
  const src = `p('bass', n('0 0 3 5').scale('a minor').sound('acid'))`
  const lits = collectStringLiterals(src)

  it('maps a degree atom loc into the doc via its literal', () => {
    // '3' is at offset 4..5 inside "0 0 3 5"
    const ranges = locToDocRanges(lits, { start: 4, end: 5 }, { n: 3, note: 60, sound: 'acid' })
    expect(ranges).toHaveLength(1)
    expect(src.slice(ranges[0]!.from, ranges[0]!.to)).toBe('3')
  })

  it('maps a sound atom loc ("acid" at 0..4 of its own string)', () => {
    const ranges = locToDocRanges(lits, { start: 0, end: 4 }, { sound: 'acid' })
    expect(ranges.map((r) => src.slice(r.from, r.to))).toContain('acid')
  })

  it('maps note-name atoms through noteNameToMidi', () => {
    const drumSrc = `p('kick', note('c2*4').sound('kick'))`
    const drumLits = collectStringLiterals(drumSrc)
    const ranges = locToDocRanges(drumLits, { start: 0, end: 2 }, { note: 36, sound: 'kick' })
    expect(ranges.map((r) => drumSrc.slice(r.from, r.to))).toEqual(['c2'])
  })

  it('maps a chord atom via its notes (chord names are not note names)', () => {
    // Cmaj7 = C3 E3 G3 B3 = [48, 52, 55, 59]; each note event carries the
    // "Cmaj7" atom's loc, so the atom lights when any of them fires.
    const chordSrc = `p('m', chord('Cmaj7').sound('keys'))`
    const chordLits = collectStringLiterals(chordSrc)
    const ranges = locToDocRanges(chordLits, { start: 0, end: 5, src: 'Cmaj7' }, { note: 52 })
    expect(ranges).toHaveLength(1)
    expect(chordSrc.slice(ranges[0]!.from, ranges[0]!.to)).toBe('Cmaj7')
  })

  it('maps an atom in the SECOND chunk of a concatenation to the doc', () => {
    // Regression: the arpLine bug — measures past the first literal never lit.
    // 'g4' lives at assembled offset 9..11, which is inside the second chunk.
    const concatSrc = `note('a3 c4' + ' e4 g4').sound('lead')`
    const concatLits = collectStringLiterals(concatSrc)
    const ranges = locToDocRanges(concatLits, { start: 9, end: 11 }, { note: 67 })
    expect(ranges).toHaveLength(1)
    expect(concatSrc.slice(ranges[0]!.from, ranges[0]!.to)).toBe('g4')
  })

  it('rejects out-of-range and non-matching locs (defensive)', () => {
    expect(locToDocRanges(lits, { start: 100, end: 104 }, { n: 0 })).toEqual([])
    expect(locToDocRanges(lits, { start: 4, end: 5 }, { n: 7 })).toEqual([]) // text '3' ≠ degree 7
    expect(locToDocRanges(lits, { start: 3, end: 3 }, { n: 0 })).toEqual([]) // empty range
    expect(locToDocRanges(lits, { start: -1, end: 2 }, { n: 0 })).toEqual([])
  })

  it('flashes every literal where the same atom matches at the same offsets', () => {
    const twoSrc = `p('a', n('0 5').sound('x'))\np('b', n('0 7').sound('y'))`
    const twoLits = collectStringLiterals(twoSrc)
    // degree 0 at offset 0..1 exists in BOTH degree strings — both flash
    const ranges = locToDocRanges(twoLits, { start: 0, end: 1 }, { n: 0 })
    expect(ranges).toHaveLength(2)
    for (const r of ranges) expect(twoSrc.slice(r.from, r.to)).toBe('0')
  })

  it('flashes a TRANSPOSED note via its stamped loc — octave/add shift the note, not the atom', () => {
    // Regression: `.octave(1)` (and .add/.invert/.voicing) transpose the note
    // value while the source atom text stays put, so the fired note (e4=64) no
    // longer equals the atom text ("e3"=52). A stamped loc.src must still light
    // the origin — earlier the atomMatches gate dropped every shifted note.
    const s = `p('m', note('e3 a3').octave(1).sound('lead'))`
    const l = collectStringLiterals(s)
    const ranges = locToDocRanges(l, { start: 0, end: 2, src: 'e3 a3' }, { note: 64, sound: 'lead' })
    expect(ranges).toHaveLength(1)
    expect(s.slice(ranges[0]!.from, ranges[0]!.to)).toBe('e3')
  })

  it('with a stamped loc.src, flashes ONLY the originating literal (the q0/q1/q2 bug)', () => {
    // degree 0 sits at the same offset in both voices — without src both light
    // (above); WITH src the parser stamps, only the source literal lights.
    const twoSrc = `p('a', n('0 5').sound('x'))\np('b', n('0 7').sound('y'))`
    const twoLits = collectStringLiterals(twoSrc)
    const ranges = locToDocRanges(twoLits, { start: 0, end: 1, src: '0 7' }, { n: 0 })
    expect(ranges).toHaveLength(1)
    expect(twoSrc.slice(ranges[0]!.from, ranges[0]!.to)).toBe('0')
    // ...and it's the '0' inside the '0 7' literal, not the '0 5' one
    expect(ranges[0]!.from).toBe(twoSrc.indexOf('0 7'))
  })
})

/* EventFlasher lifecycle with injected timers (mirrors session.test.ts's
 * injected-interval pattern): scheduling delay, firing/removal dispatches,
 * the pending cap, dirty skips, clearPending and dispose. */

describe('EventFlasher', () => {
  const SRC = `p('a', n('0 3'))` // literal "0 3"; atom '0' at 0..1, '3' at 2..3

  const makeRig = () => {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const dispatches: { effects: unknown[] }[] = []
    const host = {
      dispatch: (spec: { effects: unknown[] }) => {
        dispatches.push(spec)
      },
      state: { doc: { length: SRC.length } },
    }
    const rig = {
      timers,
      dispatches,
      now: 0,
      dirty: false,
      /** Run (and consume) every not-yet-cleared timer callback once. */
      runTimers() {
        for (const t of timers.splice(0)) if (!t.cleared) t.fn()
      },
      flasher: undefined as unknown as EventFlasher,
    }
    rig.flasher = new EventFlasher(
      host,
      () => rig.now,
      () => rig.dirty,
      {
        setTimeoutImpl: (fn, ms) => {
          const h = { fn, ms, cleared: false }
          timers.push(h)
          return h
        },
        clearTimeoutImpl: (h) => {
          ;(h as { cleared: boolean }).cleared = true
        },
      },
    )
    rig.flasher.onGoodEval(SRC)
    return rig
  }

  const ev = (timeSec: number, loc?: { start: number; end: number }): SchedulerEvent => ({
    timeSec,
    durSec: 0.1,
    cycle: 0,
    controls: { n: 0 },
    ...(loc !== undefined ? { loc } : {}),
  })

  it('schedules at (timeSec − now)·1000 ms, clamping past events to 0', () => {
    const rig = makeRig()
    rig.now = 0.2
    rig.flasher.onEvents([ev(0.5, { start: 0, end: 1 }), ev(0.1, { start: 0, end: 1 })])
    expect(rig.timers).toHaveLength(2)
    expect(rig.timers[0]!.ms).toBeCloseTo(300)
    expect(rig.timers[1]!.ms).toBe(0)
  })

  it('firing dispatches the add effect, then a removal after FLASH_MS', () => {
    const rig = makeRig()
    rig.flasher.onEvents([ev(0, { start: 0, end: 1 })])
    rig.runTimers() // the flash timer fires
    expect(rig.dispatches).toHaveLength(1) // add
    expect(rig.timers).toHaveLength(1) // the removal timer it scheduled
    expect(rig.timers[0]!.ms).toBe(FLASH_MS)
    rig.runTimers()
    expect(rig.dispatches).toHaveLength(2) // remove
  })

  it('events without loc schedule nothing', () => {
    const rig = makeRig()
    rig.flasher.onEvents([ev(0)])
    expect(rig.timers).toHaveLength(0)
  })

  it('caps concurrently pending flashes at MAX_PENDING_FLASHES', () => {
    const rig = makeRig()
    const evs = Array.from({ length: MAX_PENDING_FLASHES + 40 }, () =>
      ev(1, { start: 0, end: 1 }),
    )
    rig.flasher.onEvents(evs)
    expect(rig.timers).toHaveLength(MAX_PENDING_FLASHES)
    // Firing drains the pending set: capacity comes back.
    rig.runTimers()
    rig.flasher.onEvents([ev(1, { start: 0, end: 1 })])
    expect(rig.timers.length).toBeGreaterThan(0)
  })

  it('dirty doc skips scheduling; going dirty before fire suppresses the flash', () => {
    const rig = makeRig()
    rig.dirty = true
    rig.flasher.onEvents([ev(0, { start: 0, end: 1 })])
    expect(rig.timers).toHaveLength(0)

    rig.dirty = false
    rig.flasher.onEvents([ev(0, { start: 0, end: 1 })])
    expect(rig.timers).toHaveLength(1)
    rig.dirty = true // doc edited while the flash was in flight
    rig.runTimers()
    expect(rig.dispatches).toHaveLength(0)
  })

  it('clearPending cancels unfired flashes and frees their slots', () => {
    const rig = makeRig()
    rig.flasher.onEvents([ev(1, { start: 0, end: 1 }), ev(1, { start: 2, end: 3 })])
    const scheduled = [...rig.timers]
    rig.flasher.clearPending()
    expect(scheduled.every((t) => t.cleared)).toBe(true)
    rig.runTimers()
    expect(rig.dispatches).toHaveLength(0)
    // Slots freed: new events schedule again.
    rig.flasher.onEvents([ev(1, { start: 0, end: 1 })])
    expect(rig.timers).toHaveLength(1)
  })

  it('dispose cancels pending flashes and ignores later batches', () => {
    const rig = makeRig()
    rig.flasher.onEvents([ev(1, { start: 0, end: 1 })])
    rig.flasher.dispose()
    expect(rig.timers.every((t) => t.cleared)).toBe(true)
    rig.flasher.onEvents([ev(1, { start: 0, end: 1 })])
    rig.runTimers()
    expect(rig.dispatches).toHaveLength(0)
  })
})
