import { describe, expect, it } from 'vitest'
import type { SchedulerEvent } from '@rondocode/pattern'
import {
  EventFlasher,
  FLASH_MS,
  MAX_LIT_MS,
  MAX_PENDING_FLASHES,
  collectPulseSpans,
  collectStringLiterals,
  jsRegionLiterals,
  locToDocRanges,
  rondoNoteLiterals,
} from '../src/editor/flash'
import type { FlashArrangement, StringLit } from '../src/editor/flash'

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

describe('rondoNoteLiterals (note-play flash in rondo mode)', () => {
  it('maps a mini-Loc into the notation’s buffer range', () => {
    // notation "0 3 5 7" lives at char offset 30 in the rondo buffer
    const lits = rondoNoteLiterals([{ content: '0 3 5 7', from: 30 }])
    // the "5" is at index 4..5 of the notation; loc.src pins the exact string
    const ranges = locToDocRanges(lits, { start: 4, end: 5, src: '0 3 5 7' }, { n: 5, note: 65, sound: 's' })
    expect(ranges).toEqual([{ from: 34, to: 35 }])
  })
  it('ignores a loc whose src is a different notation (no cross-lighting)', () => {
    const lits = rondoNoteLiterals([{ content: '0 3 5 7', from: 30 }])
    expect(locToDocRanges(lits, { start: 0, end: 2, src: 'c4 e4' }, { note: 60 })).toEqual([])
  })

  it('a velocity-stripped beat span maps through its pieces (hat:.6 rows flash)', () => {
    // buffer: `~ hat:.6 ~ hat` at offset 0; emitted mini: `~ hat ~ hat`
    const lits = rondoNoteLiterals([{
      content: '~ hat ~ hat',
      from: 0,
      pieces: [
        { assembledStart: 0, sourceStart: 0, length: 5 }, // `~ hat`
        { assembledStart: 5, sourceStart: 8, length: 6 }, // ` ~ hat` (after `:.6`)
      ],
    }])
    // second hat: loc 8..11 in the stripped string → buffer 11..14
    expect(locToDocRanges(lits, { start: 8, end: 11, src: '~ hat ~ hat' }, {}))
      .toEqual([{ from: 11, to: 14 }])
  })
})

describe('jsRegionLiterals (note-play flash inside rondo js escapes)', () => {
  it('scans a region slice and shifts every offset back to the buffer', () => {
    // a rondo buffer whose js block holds a pattern; the region covers the JS
    const src = "synth s1\n  saw\n\njs\n  p('x', n('0 3 5').sound('s1'))\n"
    const from = src.indexOf("  p('x'")
    const to = src.length - 1
    const lits = jsRegionLiterals(src, [{ from, to }])
    const degrees = lits.find((l) => l.content === '0 3 5')!
    expect(degrees).toBeDefined()
    expect(src.slice(degrees.contentStart, degrees.contentStart + degrees.content.length)).toBe('0 3 5')
    // an event on the '3' atom maps to the exact buffer chars
    const ranges = locToDocRanges(lits, { start: 2, end: 3, src: '0 3 5' }, {})
    expect(ranges).toHaveLength(1)
    expect(src.slice(ranges[0]!.from, ranges[0]!.to)).toBe('3')
  })

  it('handles concatenations inside a region (piece offsets shift too)', () => {
    const src = "js{ n('0 3' + ' 5 7') }"
    const lits = jsRegionLiterals(src, [{ from: 3, to: src.length - 1 }])
    expect(lits.map((l) => l.content)).toEqual(['0 3 5 7'])
    const ranges = locToDocRanges(lits, { start: 4, end: 5, src: '0 3 5 7' }, {})
    expect(src.slice(ranges[0]!.from, ranges[0]!.to)).toBe('5')
  })

  it('an unparseable region contributes nothing (never throws)', () => {
    expect(jsRegionLiterals('js{ const = ) }', [{ from: 3, to: 13 }])).toEqual([])
  })
})

describe('collectPulseSpans (loc-less patterns pulse their expression)', () => {
  it('finds a non-literal n() argument inside p() and names it by .sound()', () => {
    const src = `p('x', n(irand(8).segment(8)).scale('e minor').sound('s1'))`
    const spans = collectPulseSpans(src)
    expect(spans).toHaveLength(1)
    expect(src.slice(spans[0]!.from, spans[0]!.to)).toBe('irand(8).segment(8)')
    expect(spans[0]!.sound).toBe('s1')
  })

  it('falls back to the p() channel name without a .sound()', () => {
    const spans = collectPulseSpans(`p('bass', n(rand.range(0, 7).segment(4)))`)
    expect(spans[0]!.sound).toBe('bass')
  })

  it('string-literal n() args produce NO pulse (they flash per atom)', () => {
    expect(collectPulseSpans(`p('x', n('0 3 5').sound('s1'))`)).toEqual([])
  })

  it('unparseable source → [] (never throws)', () => {
    expect(collectPulseSpans('const = )')).toEqual([])
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

  it('a loc-less NOTE pulses its channel span; loc-less automation does not', () => {
    const rig = makeRig()
    // the vocal's channel has a pulse span (a loc-less expression under p())
    rig.flasher.onGoodEval(`p('vox', n(irand(8).segment(8)).sound('vox'))`)
    const at = (controls: Record<string, unknown>): SchedulerEvent => ({ timeSec: 0, durSec: 0.1, cycle: 0, controls })
    rig.flasher.onEvents([at({ sound: 'vox', note: 60 })])
    expect(rig.timers).toHaveLength(1)
    // sixteen automation steps a cycle would otherwise keep the span lit
    rig.flasher.onEvents(Array.from({ length: 16 }, () => at({ sound: 'vox', mix: 0.3 })))
    expect(rig.timers).toHaveLength(1)
    // but the notation an automation step sampled still lights up
    rig.flasher.onEvents([{ ...at({ sound: 'vox', mix: 0.3 }), locs: [{ start: 0, end: 1 }] }])
    expect(rig.timers).toHaveLength(2)
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

/* A COMPOSED FIGURE has no notes of its own. `<openB tail openA tail>` is a
 * reference to a reference, so while the arrangement it names plays, the one
 * line a reader is watching — the only line that is not literal notation —
 * was the only line that never moved. */
describe('a patdef reference lights when its notes play', () => {
  // `riff` on the play line stands for the whole figure; `tail` for part of it
  const lit = {
    contentStart: 100,
    content: '<[0 0] [1 2] [3 4]>',
    pieces: [{ assembledStart: 0, sourceStart: 100, length: 19 }],
    refs: [
      { from: 10, to: 14, assembledStart: 0, assembledEnd: 19 }, // `riff`, whole
      { from: 40, to: 44, assembledStart: 7, assembledEnd: 18 }, // `tail`, part
    ],
  }

  it('lights the reference AND the text it expands to', () => {
    // an atom inside the tail: both the definition text and `tail` light
    const out = locToDocRanges([lit], { start: 8, end: 9, src: lit.content }, { n: 1 })
    expect(out).toContainEqual({ from: 40, to: 44 }) // `tail`
    expect(out).toContainEqual({ from: 108, to: 109 }) // the atom itself
  })

  it('lights every enclosing reference, outermost included', () => {
    const out = locToDocRanges([lit], { start: 8, end: 9, src: lit.content }, { n: 1 })
    expect(out).toContainEqual({ from: 10, to: 14 }) // `riff` encloses everything
  })

  it('does NOT light a reference the atom sits outside of', () => {
    // the `[0 0]` atom is before the tail begins
    const out = locToDocRanges([lit], { start: 2, end: 3, src: lit.content }, { n: 0 })
    expect(out).not.toContainEqual({ from: 40, to: 44 })
    expect(out, 'the outer reference still covers it').toContainEqual({ from: 10, to: 14 })
  })

  it('a figure with no references behaves exactly as before', () => {
    const plain = { contentStart: 0, content: '0 3', pieces: [{ assembledStart: 0, sourceStart: 0, length: 3 }] }
    expect(locToDocRanges([plain], { start: 0, end: 1, src: '0 3' }, { n: 0 })).toEqual([{ from: 0, to: 1 }])
  })
})


/* ------------------------------------------------------------------------- *
 * HOW LONG A MARK STAYS LIT.
 *
 * The highlight means "this note is sounding now", so its lifetime has to be
 * the note's length. MAX_LIT_MS was 4000, which sounds like a generous cap and
 * is not: at the default cps of 0.5 a cycle is two seconds, so it truncated
 * anything held longer than TWO CYCLES.
 *
 * `<c3 a2 f2 g2>/4` is a chord per four cycles — eight seconds each. It lit
 * for the first two cycles of every chord and went dark while the chord was
 * still sounding, which is exactly what the reader reported.
 * ------------------------------------------------------------------------- */
describe('a long held note stays lit for as long as it sounds', () => {
  const SRC = `p('a', n('0 3'))`

  const rig = () => {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const dispatches: { effects: unknown[] }[] = []
    const f = new EventFlasher(
      { dispatch: (spec: { effects: unknown[] }) => { dispatches.push(spec) }, state: { doc: { length: SRC.length } } },
      () => 0,
      () => false,
      {
        setTimeoutImpl: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h },
        clearTimeoutImpl: (h) => { (h as { cleared: boolean }).cleared = true },
      },
    )
    f.onGoodEval(SRC)
    return { f, timers, dispatches, run: () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn() } }
  }

  const held = (durSec: number): SchedulerEvent => ({
    timeSec: 0, durSec, cycle: 0, controls: { n: 0 }, loc: { start: 0, end: 1 },
  })

  it('a four-cycle chord at cps 0.5 (8s) is lit for the whole eight seconds', () => {
    // the exact case from the report: 4 cycles / 0.5 cps = 8s
    const r = rig()
    r.f.onEvents([held(8)])
    r.run() // the scheduling timer fires and the mark goes up
    expect(r.dispatches).toHaveLength(1)
    expect(r.timers[0]!.ms, 'the mark is removed before the note stops sounding').toBe(8000)
  })

  it('still bounds a pathological duration', () => {
    const r = rig()
    r.f.onEvents([held(60 * 60)])
    r.run()
    expect(r.timers[0]!.ms).toBe(MAX_LIT_MS)
  })

  it('and a very short note is still visible', () => {
    const r = rig()
    r.f.onEvents([held(0.001)])
    r.run()
    expect(r.timers[0]!.ms).toBe(FLASH_MS)
  })

  it('the cap is longer than a four-cycle chord at the default cps', () => {
    /* The regression the number itself encodes. 4 cycles at cps 0.5 is 8s; a
     * cap under that truncates ordinary music rather than pathology. */
    expect(MAX_LIT_MS).toBeGreaterThan((4 / 0.5) * 1000)
  })

  it('STOP takes the lit marks down — what makes the longer cap safe', () => {
    /* With marks now able to stay up for many seconds, leaving them to their
     * own removal timers would keep the editor lit after the transport stops. */
    const r = rig()
    r.f.onEvents([held(8)])
    r.run()
    expect(r.dispatches).toHaveLength(1) // lit
    r.f.clearPending()
    expect(r.dispatches, 'a mark survived the stop').toHaveLength(2) // and removed
  })

  it('clearPending with nothing lit dispatches nothing', () => {
    const r = rig()
    r.f.clearPending()
    expect(r.dispatches).toHaveLength(0)
  })
})

/* SECTION-AWARE FLASHING. Two sections playing the same synth often carry the
 * exact same notation text — an event's loc.src matches BOTH copies, and both
 * lit (the reported bug). With the arrangement known, only the section(s)
 * actually sounding at the event's cycle may light; and the song line keeps
 * the currently playing name steadily lit. */

describe('locToDocRanges with an active-section set', () => {
  // two sections both play `0 2 4` on the same synth: identical content,
  // different places in the buffer
  const lits: StringLit[] = [
    { contentStart: 10, content: '0 2 4', pieces: [{ assembledStart: 0, sourceStart: 10, length: 5 }], section: 'A' },
    { contentStart: 40, content: '0 2 4', pieces: [{ assembledStart: 0, sourceStart: 40, length: 5 }], section: 'B' },
  ]
  const loc = { start: 0, end: 1, src: '0 2 4' }

  it('without an arrangement both copies light (JS mode / no sections)', () => {
    expect(locToDocRanges(lits, loc, { n: 0 })).toHaveLength(2)
  })

  it('with one, ONLY the sounding section lights (the multi-section same-synth bug)', () => {
    expect(locToDocRanges(lits, loc, { n: 0 }, new Set(['B']))).toEqual([{ from: 40, to: 41 }])
  })

  it('a `with` layer is in the active set, so the layered section lights too', () => {
    expect(locToDocRanges(lits, loc, { n: 0 }, new Set(['A', 'B']))).toHaveLength(2)
  })

  it('a sectionless literal (top-level play) lights regardless of the active set', () => {
    const free: StringLit[] = [
      { contentStart: 3, content: '0 2 4', pieces: [{ assembledStart: 0, sourceStart: 3, length: 5 }] },
    ]
    expect(locToDocRanges(free, loc, { n: 0 }, new Set(['B']))).toHaveLength(1)
  })
})

describe('EventFlasher: the arrangement (sections + the song line)', () => {
  /* doc sketch: "song A B" with A's name at 5..6 and B's at 7..8; section A
   * runs 1 cycle, B runs 2, so the 3-cycle loop is A:[0,1) B:[1,3).
   * B plays `with A`, so both names are active while B sounds. */
  const ARR: FlashArrangement = {
    slots: [
      { name: 'A', len: 1, from: 5, to: 6 },
      { name: 'B', len: 2, from: 7, to: 8 },
    ],
    included: { A: ['A'], B: ['B', 'A'] },
  }
  // the same synth playing the same text in both sections
  const LITS: StringLit[] = [
    { contentStart: 10, content: '0', pieces: [{ assembledStart: 0, sourceStart: 10, length: 1 }], section: 'A' },
    { contentStart: 20, content: '0', pieces: [{ assembledStart: 0, sourceStart: 20, length: 1 }], section: 'B' },
  ]

  const makeRig = () => {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const dispatches: { effects: unknown[] }[] = []
    const host = {
      dispatch: (spec: { effects: unknown[] }) => {
        dispatches.push(spec)
      },
      state: { doc: { length: 100 } },
    }
    const flasher = new EventFlasher(host, () => 0, () => false, {
      setTimeoutImpl: (fn, ms) => {
        const h = { fn, ms, cleared: false }
        timers.push(h)
        return h
      },
      clearTimeoutImpl: (h) => {
        ;(h as { cleared: boolean }).cleared = true
      },
    })
    flasher.onGoodEvalLiterals(LITS, [], ARR)
    const runTimers = (): void => {
      for (const t of timers.splice(0)) if (!t.cleared) t.fn()
    }
    /** the {from,to}/id payloads of dispatch i's effects */
    const vals = (i: number): unknown[] =>
      dispatches[i]!.effects.map((e) => (e as { value: unknown }).value)
    return { timers, dispatches, flasher, runTimers, vals }
  }

  const ev = (cycle: number): SchedulerEvent => ({
    timeSec: 0,
    durSec: 0.1,
    cycle,
    controls: { n: 0 },
    loc: { start: 0, end: 1, src: '0' },
  })

  it('lights only the sounding section, and the song line lights its name', () => {
    const r = makeRig()
    r.flasher.onEvents([ev(0)]) // cycle 0 → slot A
    r.runTimers()
    // dispatch 0: the song mark on "A"; dispatch 1: the note flash
    expect(r.dispatches).toHaveLength(2)
    expect(r.vals(0)).toMatchObject([{ from: 5, to: 6 }])
    expect(r.vals(1)).toMatchObject([{ from: 10, to: 11 }]) // A's copy only
  })

  it("a `with` layer's line lights while the layered section plays", () => {
    const r = makeRig()
    r.flasher.onEvents([ev(1)]) // cycle 1 → slot B (which plays with A)
    r.runTimers()
    expect(r.vals(1)).toMatchObject([{ from: 10, to: 11 }, { from: 20, to: 21 }])
  })

  it('the song mark MOVES on a slot change and holds through repeated events', () => {
    const r = makeRig()
    r.flasher.onEvents([ev(0)])
    r.runTimers()
    r.flasher.onEvents([ev(0)]) // same slot again: no new song-mark dispatch
    r.runTimers()
    const before = r.dispatches.length
    r.flasher.onEvents([ev(2)]) // cycle 2 ∈ [1,3) → slot B
    r.runTimers()
    // slot changed: ONE dispatch removes "A"'s mark and adds "B"'s (other
    // dispatches in the window are the earlier flashes' removal timers)
    const after = r.dispatches.slice(before).map((d) => d.effects.map((e) => (e as { value: unknown }).value))
    const moved = after.find((v) => v.some((x) => (x as { from?: number } | number) instanceof Object && (x as { from?: number }).from === 7))
    expect(moved).toBeDefined()
    expect(moved).toHaveLength(2) // [removeFlash id, addFlash {7,8}]
    expect(moved![1]).toMatchObject({ from: 7, to: 8 })
  })

  it('the arrangement LOOPS: past the total, the first slot lights again', () => {
    const r = makeRig()
    r.flasher.onEvents([ev(3)]) // 3 mod 3 = 0 → slot A
    r.runTimers()
    expect(r.vals(0)).toMatchObject([{ from: 5, to: 6 }])
  })

  it('clearPending takes the song mark down with the note marks', () => {
    const r = makeRig()
    r.flasher.onEvents([ev(0)])
    r.runTimers()
    const before = r.dispatches.length
    r.flasher.clearPending()
    // clearLit removes the note mark, clearSongMark removes the song mark
    expect(r.dispatches.length).toBe(before + 2)
    r.flasher.clearPending() // idempotent: nothing left to remove
    expect(r.dispatches.length).toBe(before + 2)
  })
})
