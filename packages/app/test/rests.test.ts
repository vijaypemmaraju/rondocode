import { describe, expect, it } from 'vitest'
import { litRestRanges, restSpans, restsAt } from '../src/editor/rests'

/* Notes flash as they play and rests never did, because a rest emits NOTHING:
 * `note('c2 ~ g2 ~')` yields two haps and miniParse drops the rests entirely.
 * There is no event to hang a highlight on and nothing anywhere saying WHEN
 * the hole is — so the timing has to be recovered, and this is where that
 * arithmetic is pinned. */

const spans = (mini: string, cycle = 0) =>
  restSpans(mini, cycle).map((s) => ({ at: s.from, begin: s.begin, end: s.end }))

describe('restSpans', () => {
  it('finds a rest and when it sounds', () => {
    expect(spans('0 ~ 3 ~')).toEqual([
      { at: 2, begin: 0.25, end: 0.5 },
      { at: 6, begin: 0.75, end: 1 },
    ])
  })

  it('points at the ~ in the SOURCE, so the editor can decorate it', () => {
    const mini = '0 ~ 3'
    const [s] = restSpans(mini)
    expect(mini.slice(s!.from, s!.to)).toBe('~')
  })

  it('gets a NESTED rest right, which is the whole reason not to do this by hand', () => {
    // [3 ~] occupies the second half, so its rest is the last quarter
    expect(spans('0 [3 ~]')).toEqual([{ at: 5, begin: 0.75, end: 1 }])
  })

  it('honours weights', () => {
    // @3 / @1: the rest is the last quarter, not the last half
    expect(spans('0@3 ~@1')).toEqual([{ at: 4, begin: 0.75, end: 1 }])
  })

  it('honours replication, so `~!3` is three holes and not one', () => {
    expect(restSpans('0 ~!3')).toHaveLength(3)
  })

  it('ALTERNATES per cycle — `<~ 3>` is a hole only on even cycles', () => {
    expect(spans('<~ 3>', 0)).toEqual([{ at: 1, begin: 0, end: 1 }])
    expect(spans('<~ 3>', 1)).toEqual([])
  })

  it('finds nothing in a pattern with no rests', () => {
    expect(restSpans('0 3 5')).toEqual([])
  })

  it('returns nothing rather than throwing on an unparseable figure', () => {
    // this runs in a render loop; an exception there is worse than no highlight
    expect(restSpans('0 ~ [[[')).toEqual([])
  })

  it('does not mistake a NOTE for a rest', () => {
    // the probe replaces `~` with a note, so every hap looks alike — only the
    // recorded offsets tell them apart, and getting that wrong lights the notes
    const out = restSpans('0 ~ 3')
    expect(out).toHaveLength(1)
    expect(out[0]!.from).toBe(2)
  })
})

describe('restsAt', () => {
  const s = restSpans('0 ~ 3 ~')

  it('lights the hole the playhead is inside', () => {
    expect(restsAt(s, 0.3).map((r) => r.from)).toEqual([2])
    expect(restsAt(s, 0.8).map((r) => r.from)).toEqual([6])
  })

  it('lights nothing while a NOTE is sounding', () => {
    expect(restsAt(s, 0.1)).toEqual([])
  })

  it('lights exactly one at a boundary, never two and never none', () => {
    // adjacent rests would flicker at every seam, or double-light it
    const adj = restSpans('~ ~')
    expect(restsAt(adj, 0.5).map((r) => r.from)).toEqual([2])
    expect(restsAt(adj, 0)).toHaveLength(1)
  })
})

/* Mapping a rest's position in the MINI STRING back to the document, which is
 * where this goes wrong silently: the offsets are into the pattern text, not
 * the buffer, and a wrong shift lights an arbitrary character. */
describe('litRestRanges', () => {
  const lit = (content: string, sourceStart: number) => ({
    content,
    pieces: [{ assembledStart: 0, sourceStart, length: content.length }],
  })
  const src = (content: string, at: number, cycle: number | null) => ({
    literals: () => [lit(content, at)],
    cycle: () => cycle,
  })

  it('maps the rest into the BUFFER, not the mini string', () => {
    // '0 ~ 3' is THREE atoms, so the hole runs 1/3..2/3; the string sits at
    // offset 100, so the `~` is at 102
    expect(litRestRanges(src('0 ~ 3', 100, 0.5), new Map())).toEqual([{ from: 102, to: 103 }])
  })

  it('lights nothing while the transport is stopped', () => {
    expect(litRestRanges(src('0 ~ 3', 100, null), new Map())).toEqual([])
  })

  it('lights nothing while a NOTE is sounding', () => {
    expect(litRestRanges(src('0 ~ 3', 100, 0.1), new Map())).toEqual([])
  })

  it('uses the cycle POSITION, so alternation follows the transport', () => {
    const alt = (cycle: number) => litRestRanges(src('<~ 3>', 0, cycle), new Map())
    expect(alt(0.5), 'cycle 0 is the hole').toHaveLength(1)
    expect(alt(1.5), 'cycle 1 is the note').toHaveLength(0)
  })

  it('caches per cycle rather than re-querying every frame', () => {
    const cache = new Map()
    const s = src('0 ~ 3', 0, 0.5)
    litRestRanges(s, cache)
    const size = cache.size
    litRestRanges(s, cache)
    expect(cache.size, 'a second frame in the same cycle adds nothing').toBe(size)
  })

  it('skips a literal with no rests at all', () => {
    expect(litRestRanges(src('0 3 5', 0, 0.5), new Map())).toEqual([])
  })
})
