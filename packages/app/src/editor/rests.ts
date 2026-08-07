/* ------------------------------------------------------------------------- *
 * FLASHING A REST.
 *
 * Notes light up as they play and rests never did, and it is not an editor
 * oversight: a rest emits NOTHING. `note('c2 ~ g2 ~')` yields two haps, and
 * miniParse drops the rests before anyone downstream could see them. There is
 * no event to hang a highlight on and no span saying when the hole is — so the
 * one part of a pattern you read rhythmically was the one part that stayed
 * dark while everything around it moved.
 *
 * THE TRICK: `~` and `0` are both ONE character, so replacing every rest with
 * a note leaves every other offset exactly where it was. Query that probe
 * pattern and the haps landing on a replaced offset ARE the rests, with their
 * real time spans — computed by the actual mini parser, so nesting, weights,
 * alternation, euclid and `!`/`*` all come out right for free instead of being
 * re-implemented here and drifting.
 *
 * Cycle-relative and pure, so the arithmetic is testable without a transport.
 * ------------------------------------------------------------------------- */

import { F, TimeSpan, n } from '@rondocode/pattern'

export interface RestSpan {
  /** char offsets of the `~` WITHIN the mini string. */
  from: number
  to: number
  /** when the hole is, relative to the start of `cycle`. */
  begin: number
  end: number
}

/** A rest is one character, so a one-character stand-in keeps every offset. */
const PROBE = '0'

/**
 * Every rest in `mini` that sounds during `cycle`, with its time span.
 *
 * Alternation means the answer differs per cycle (`<~ c3>` rests only on even
 * ones), so the cycle is an argument rather than an assumption.
 */
export function restSpans(mini: string, cycle = 0): RestSpan[] {
  const at = new Set<number>()
  for (const m of mini.matchAll(/~/g)) at.add(m.index)
  if (at.size === 0) return []
  let haps
  try {
    haps = n(mini.replace(/~/g, PROBE)).query(new TimeSpan(F(cycle), F(cycle + 1)))
  } catch {
    // an unparseable figure is not worth an exception in a render loop — the
    // editor already reports the error through the normal diagnostics path
    return []
  }
  const out: RestSpan[] = []
  for (const h of haps) {
    const loc = (h.value as { loc?: { start: number; end: number } }).loc
    if (loc === undefined || !at.has(loc.start)) continue
    out.push({
      from: loc.start,
      to: loc.end,
      begin: h.part.begin.valueOf() - cycle,
      end: h.part.end.valueOf() - cycle,
    })
  }
  return out
}

/**
 * The rests to light at cycle position `phase` (0..1).
 *
 * Half-open on purpose: at a boundary exactly one hole is lit, never two and
 * never none — a pattern of adjacent rests would otherwise flicker at every
 * seam or double-light it.
 */
export function restsAt(spans: readonly RestSpan[], phase: number): RestSpan[] {
  return spans.filter((s) => phase >= s.begin && phase < s.end)
}

/* ------------------------------------------------------------------------- *
 * The live half: lighting the hole the playhead is inside.
 *
 * Notes flash on their EVENT; a rest has none, so this is driven by the
 * transport clock instead — the only thing that knows a hole is happening.
 * One rAF loop for the document, and the per-cycle span computation is cached:
 * it is a pattern query, and doing one per literal per frame would be the
 * roll-cell repaint mistake over again.
 * ------------------------------------------------------------------------- */

/** What the highlighter needs: the mini strings on screen, and where the
 *  transport is. Structural, so both languages feed it the same way. */
export interface RestSource {
  /** Each notation string plus its chunk map back to the buffer — exactly the
   *  StringLits the flasher already builds, so there is ONE notion of "where
   *  is this pattern in the document" rather than two. */
  literals: () => readonly {
    content: string
    pieces: readonly { assembledStart: number; sourceStart: number; length: number }[]
  }[]
  /** transport position in cycles, or null when stopped. */
  cycle: () => number | null
}

/** Buffer ranges to light right now. Pure given the source, so the mapping is
 *  testable without a browser or a transport. */
export function litRestRanges(
  src: RestSource,
  cache: Map<string, RestSpan[]>,
): { from: number; to: number }[] {
  const at = src.cycle()
  if (at === null) return []
  const cycle = Math.floor(at)
  const phase = at - cycle
  const out: { from: number; to: number }[] = []
  for (const lit of src.literals()) {
    if (!lit.content.includes('~')) continue
    const key = `${cycle} ${lit.content}`
    let spans = cache.get(key)
    if (spans === undefined) {
      spans = restSpans(lit.content, cycle)
      if (cache.size > 256) cache.clear() // bounded: a long doc over many cycles
      cache.set(key, spans)
    }
    for (const r of restsAt(spans, phase)) {
      // the rest's offset is into the mini STRING; map it back to the buffer
      const piece = lit.pieces.find((p) => r.from >= p.assembledStart && r.to <= p.assembledStart + p.length)
      if (piece === undefined) continue
      const shift = piece.sourceStart - piece.assembledStart
      out.push({ from: r.from + shift, to: r.to + shift })
    }
  }
  return out.sort((a, b) => a.from - b.from)
}
