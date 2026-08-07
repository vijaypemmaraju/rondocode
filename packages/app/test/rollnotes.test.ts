import { describe, expect, it } from 'vitest'
import { mini, TimeSpan, F } from '@rondocode/pattern'
import { barSpans, cellToNote, editNote, grabKind, pitchDelta, slotDelta, transposeNote, notesOf, parseBar, placeNote, slotsToText, toSlots } from '../src/editor/rondo/rollnotes'

/* The roll draws cells by QUERYING the compiled pattern, so a cell has no
 * back-reference to its text. Dragging a note therefore needs a model that
 * turns "this note, moved and resized" back into mini-notation.
 *
 * The failure mode is a rewrite of the WRONG note — silent, and it destroys
 * music someone wrote. So the rules are pinned directly, and the last block
 * closes the loop the only way that counts: it puts the rewritten bar through
 * the REAL parser and asks where the notes actually landed. A serializer bug
 * that a hand-written expectation would have agreed with cannot survive that. */

/** Where the real mini-notation parser puts each note of a bar, in slots. */
const readBack = (barText: string, slotCount: number): { value: string; start: number; length: number }[] =>
  mini(`[${barText}]`)
    .query(new TimeSpan(F(0), F(1)))
    .filter((h) => h.whole !== undefined)
    .map((h) => {
      const b = h.whole!.begin.valueOf()
      const e = h.whole!.end.valueOf()
      return {
        value: String((h.value as { value?: unknown })?.value ?? h.value),
        start: Math.round(b * slotCount),
        length: Math.round((e - b) * slotCount),
      }
    })
    .sort((a, b) => a.start - b.start)

describe('parseBar', () => {
  it('reads bare tokens as one slot and @N as N', () => {
    expect(parseBar('0 ~ 3 5')?.map((t) => [t.value, t.weight])).toEqual([['0', 1], ['~', 1], ['3', 1], ['5', 1]])
    expect(parseBar('4@2 0@2')?.map((t) => [t.value, t.weight])).toEqual([['4', 2], ['0', 2]])
  })

  it('carries spans, so a rewrite can be surgical', () => {
    const t = parseBar('0 ~ 3', 100)!
    expect([t[2]!.from, t[2]!.to]).toEqual([104, 105])
  })

  it('refuses what is NOT a slot grid rather than pretending', () => {
    // a nested group has no slots to move between; a euclid is not a list
    for (const bad of ['[0 3] 5', '<0 3>', 'bd(3,8)', '0!2 3', '0 3*2', '0@1.5 3']) {
      expect(parseBar(bad), bad).toBeNull()
    }
  })
})

describe('slots', () => {
  it('expands weights and comes back unchanged', () => {
    for (const bar of ['0 ~ 3 5', '4@2 0@2 4@2 0@2', '~ ~ 3@2', '0@3 ~']) {
      expect(slotsToText(toSlots(parseBar(bar)!)), bar).toBe(bar)
    }
  })

  it('names the notes a roll cell would correspond to', () => {
    expect(notesOf(toSlots(parseBar('4@2 ~ 0 3@4')!))).toEqual([
      { value: '4', start: 0, length: 2, id: 0 },
      { value: '0', start: 3, length: 1, id: 1 },
      { value: '3', start: 4, length: 4, id: 2 },
    ])
  })

  it('does not merge two adjacent notes of the SAME value', () => {
    // `3 3` is two notes, not one twice as long — merging them would delete
    // one of someone's notes on the first drag of an unrelated one
    expect(notesOf(toSlots(parseBar('3 3')!))).toHaveLength(2)
    expect(slotsToText(toSlots(parseBar('3 3')!))).toBe('3 3')
  })
})

describe('placeNote', () => {
  const slots = (bar: string) => toSlots(parseBar(bar)!)

  it('moves a note without changing the bar length', () => {
    const out = placeNote(slots('0 ~ ~ ~'), 0, 2, 1)
    expect(slotsToText(out)).toBe('~@2 0 ~')
    expect(out).toHaveLength(4)
  })

  it('resizes a note over what follows it', () => {
    expect(slotsToText(placeNote(slots('0 ~ ~ 5'), 0, 0, 3))).toBe('0@3 5')
  })

  it('overwrites what it lands on, like dropping a note on a busy bar', () => {
    expect(slotsToText(placeNote(slots('0 3 5 7'), 0, 1, 2))).toBe('~ 0@2 7')
  })

  it('leaves a note it PARTLY covered still playable, not headless', () => {
    // covering a note's first slot used to leave the rest of it with no start,
    // and the next read would drop it entirely
    const out = placeNote(slots('0 3@3'), 0, 1, 1)
    expect(notesOf(out).map((n) => n.value)).toEqual(['0', '3'])
    expect(slotsToText(out)).toBe('~ 0 3@2')
  })

  it('clamps at the edges instead of refusing', () => {
    // a drag that runs off the end should stop there, not snap back
    expect(slotsToText(placeNote(slots('0 ~ ~ ~'), 0, 99, 1))).toBe('~@3 0')
    expect(slotsToText(placeNote(slots('~ ~ ~ 0'), 0, -5, 1))).toBe('0 ~@3')
    expect(slotsToText(placeNote(slots('0 ~ ~ ~'), 0, 3, 99))).toBe('~@3 0')
  })
})

describe('editNote', () => {
  it('writes only the bar, at its own offset', () => {
    const e = editNote('0 ~ ~ ~', 40, 0, 1, 1)!
    expect([e.from, e.to]).toEqual([40, 47])
    expect(e.text).toBe('~ 0 ~@2')
  })

  it('writes NOTHING when the drag quantizes back to where it started', () => {
    // otherwise every stray pixel fills the undo history with no-ops
    expect(editNote('0 ~ 3 5', 0, 0, 0, 1)).toBeNull()
  })

  it('declines a bar that is not a slot grid', () => {
    expect(editNote('[0 3] 5', 0, 0, 1, 1)).toBeNull()
  })
})

/* THE LOOP CLOSED. Everything above agrees with my model of mini-notation;
 * this asks the parser. */
describe('the rewritten bar reads back as the notes intended', () => {
  const cases: [string, number, number, number][] = [
    ['0 ~ ~ ~', 0, 2, 1], // move
    ['0 ~ ~ 5', 0, 0, 3], // resize over a rest
    ['4@2 0@2 4@2 0@2', 2, 5, 2], // move inside a real @-weighted bar
    ['4@2 0@2 4@2 0@2', 0, 0, 3], // resize inside one
    ['0 3 5 7', 3, 0, 1], // move a note to the front, over another
  ]
  for (const [bar, index, start, length] of cases) {
    it(`${bar}  note ${index} -> slot ${start} len ${length}`, () => {
      const total = toSlots(parseBar(bar)!).reduce((n) => n + 1, 0)
      const e = editNote(bar, 0, index, start, length)
      const text = e === null ? bar : e.text
      const got = readBack(text, total)
      const want = notesOf(placeNote(toSlots(parseBar(bar)!), index, start, length))
      expect(got.map((g) => `${g.value}@${g.start}+${g.length}`)).toEqual(
        want.map((w) => `${w.value}@${w.start}+${w.length}`),
      )
    })
  }
})

describe('barSpans', () => {
  it('splits an alternation into its bars, with spans into the source', () => {
    const n = '<[0 3] [5 7]>'
    const bars = barSpans(n)
    expect(bars.map((b) => b.text)).toEqual(['0 3', '5 7'])
    // the spans must point at the bar's INSIDE, so a rewrite cannot eat a bracket
    for (const b of bars) expect(n.slice(b.from, b.to)).toBe(b.text)
  })

  it('treats one bracketed bar, and a bare list, as a single bar', () => {
    expect(barSpans('[0 3 5]').map((b) => b.text)).toEqual(['0 3 5'])
    expect(barSpans('0 3 5').map((b) => b.text)).toEqual(['0 3 5'])
  })
})

/* THE MAPPING, END TO END. The roll draws cells by querying the pattern, so
 * this walks the SAME query and asks: does every drawn cell map back to the
 * note that produced it? A mapping that is off by one silently rewrites the
 * wrong note, which is the one failure this whole file exists to prevent. */
describe('every drawn cell maps back to the note that produced it', () => {
  const cellsOf = (notation: string, bars: number) => {
    const out: { x0: number; value: string }[] = []
    for (let k = 0; k < bars; k++) {
      for (const h of mini(notation).query(new TimeSpan(F(k), F(k + 1)))) {
        if (h.whole === undefined) continue
        const b = h.whole.begin.valueOf()
        if (b < k - 1e-9 || b >= k + 1 - 1e-9) continue
        out.push({ x0: b, value: String((h.value as { value?: unknown })?.value ?? h.value) })
      }
    }
    return out
  }

  for (const [notation, barCount] of [
    ['<[0 ~ 3 5] [7 ~ ~ 9]>', 2],
    ['<[4@2 0@2 4@2 0@2] [4@2 2@2 4@2 1@2]>', 2], // the real shape, @-weighted
    ['[0 3 5 7]', 1],
    ['0 ~ 3 ~', 1],
  ] as const) {
    it(notation, () => {
      const bars = barSpans(notation)
      const cells = cellsOf(notation, barCount)
      expect(cells.length, 'the notation must actually draw cells').toBeGreaterThan(0)
      for (const c of cells) {
        const hit = cellToNote(bars, c.x0)
        expect(hit, `no note under the cell at ${c.x0}`).not.toBeNull()
        const note = notesOf(toSlots(parseBar(hit!.barText, hit!.from)!))[hit!.index]!
        expect(note.value, `cell at ${c.x0} mapped to the wrong note`).toBe(c.value)
      }
    })
  }

  it('survives two notes of the same value in one bar', () => {
    // matching on VALUE would pick the first one and rewrite it instead
    const bars = barSpans('[3 ~ 3 ~]')
    expect(cellToNote(bars, 0)!.index).toBe(0)
    expect(cellToNote(bars, 0.5)!.index).toBe(1)
  })

  it('declines a cell in a bar that is not a slot grid', () => {
    expect(cellToNote(barSpans('<[[0 3] 5] [7 9]>'), 0)).toBeNull()
  })
})

describe('the drag maths', () => {
  it('grabs the right edge to resize, the body to move', () => {
    expect(grabKind(2, 60)).toBe('move')
    expect(grabKind(55, 60)).toBe('resize')
  })

  it('keeps a very short note grabbable by its body', () => {
    // a 10px cell with a proportional edge zone would be almost all edge
    expect(grabKind(1, 10)).toBe('move')
  })

  it('quantizes a drag to whole slots', () => {
    expect(slotDelta(0, 400, 8)).toBe(0)
    expect(slotDelta(50, 400, 8)).toBe(1)
    expect(slotDelta(-100, 400, 8)).toBe(-2)
    // a nudge that has not reached half a slot must not move anything
    expect(slotDelta(20, 400, 8)).toBe(0)
  })
})

describe('transposeNote', () => {
  it('moves ONE note, leaving the rest of the bar alone', () => {
    const bar = '0 3 5'
    const e = transposeNote(bar, 0, 1, 2)!
    expect(bar.slice(0, e.from) + e.text + bar.slice(e.to)).toBe('0 5 5')
  })

  it('rewrites only the value, keeping the note\'s weight', () => {
    const bar = '4@2 0@2'
    const e = transposeNote(bar, 0, 1, -3)!
    expect(bar.slice(0, e.from) + e.text + bar.slice(e.to)).toBe('4@2 -3@2')
  })

  it('counts past rests to the right note', () => {
    // the note id skips rests; matching by token index would hit the rest
    const bar = '0 ~ ~ 7'
    const e = transposeNote(bar, 0, 1, 1)!
    expect(bar.slice(0, e.from) + e.text + bar.slice(e.to)).toBe('0 ~ ~ 8')
  })

  it('declines a value that is not a degree', () => {
    // a beat block's `bd`, or a note name — the roll draws no cell for these
    expect(transposeNote('bd sn', 0, 0, 1)).toBeNull()
    expect(transposeNote('c3 e3', 0, 0, 1)).toBeNull()
  })

  it('writes nothing for a drag that did not cross a row', () => {
    expect(transposeNote('0 3', 0, 0, 0)).toBeNull()
  })

  it('reads back as the pitch intended', () => {
    const bar = '0 ~ 3 5'
    const e = transposeNote(bar, 0, 2, 4)!
    const after = bar.slice(0, e.from) + e.text + bar.slice(e.to)
    const got = mini(`[${after}]`)
      .query(new TimeSpan(F(0), F(1)))
      .filter((h) => h.whole !== undefined)
      .map((h) => String((h.value as { value?: unknown })?.value ?? h.value))
    expect(got).toEqual(['0', '3', '9'])
  })

  it('takes a vertical drag as degree steps, up being positive', () => {
    expect(pitchDelta(-12, 12)).toBe(1) // up one row
    expect(pitchDelta(24, 12)).toBe(-2) // down two
    expect(pitchDelta(4, 12)).toBe(0) // a nudge is not a step
  })
})
