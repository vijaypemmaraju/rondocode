/* ------------------------------------------------------------------------- *
 * Which part of the song is sounding, and which part of the document a
 * position belongs to.
 *
 * A `song` arranges sections in time, and the editor has several live views
 * of that: note flash, playheads, curve tracking, karaoke. Every one of them
 * has to answer the same question, "does THIS event belong to THIS widget?",
 * and the answer is not the widget's text or its synth name (two sections
 * can and do hold identical lines): it is whether the section that owns the
 * widget's position is sounding at the event's cycle. This module is the
 * one place that rule lives, so the views can only agree.
 * ------------------------------------------------------------------------- */

import type { Arrangement } from './compile'
import { stripComment } from './lexer'

/** Which slot of the song sounds at `cycle` (the scheduler's global cycle
 *  number), as an index into `arr.slots`. Mirrors the pattern package's
 *  arrange(): the song loops over its total length, and the slots are laid
 *  end to end within it. Undefined without a `song`. */
export function slotAt(arr: Arrangement | undefined, cycle: number): number | undefined {
  if (arr === undefined || arr.slots.length === 0) return undefined
  let total = 0
  for (const s of arr.slots) total += s.len
  if (!(total > 0)) return undefined
  const pos = ((Math.floor(cycle) % total) + total) % total
  let offset = 0
  for (let k = 0; k < arr.slots.length; k++) {
    offset += arr.slots[k]!.len
    if (pos < offset) return k
  }
  return arr.slots.length - 1
}

/** The names sounding during `cycle`: the slot's own section plus everything
 *  it pulls in `with`. No arrangement means no `song`, and everything sounds. */
export function soundingAt(arr: Arrangement | undefined, cycle: number): ReadonlySet<string> | undefined {
  const k = slotAt(arr, cycle)
  if (k === undefined) return undefined
  const name = arr!.slots[k]!.name
  return new Set(arr!.included[name] ?? [name])
}

/** A `section` block's extent in the source: `from` is the header's start,
 *  `to` the end of its last indented line. */
export interface SectionRange {
  name: string
  from: number
  to: number
}

/**
 * Where each `section` block begins and ends. Mirrors the lexer and the
 * parser without running them: blank and comment-only lines belong to
 * whatever block they sit in, a column-0 `section NAME` opens one, and any
 * other column-0 line closes it. Only the extents matter here, so a header
 * with a bad length or a body with a stray `synth` still counts; the parser
 * reports those, this only has to agree with it about the edges.
 */
export function sectionRanges(text: string): SectionRange[] {
  const out: SectionRange[] = []
  let open: SectionRange | null = null
  let offset = 0
  for (const raw of text.split('\n')) {
    const code = stripComment(raw)
    if (code.trim() !== '') {
      if (/^[ \t]/.test(code)) {
        if (open !== null) open.to = offset + raw.replace(/\s+$/, '').length
      } else {
        if (open !== null) { out.push(open); open = null }
        const m = /^section[ \t]+([a-zA-Z_]\w*)/.exec(code)
        if (m !== null) open = { name: m[1]!, from: offset, to: offset + raw.replace(/\s+$/, '').length }
      }
    }
    offset += raw.length + 1
  }
  if (open !== null) out.push(open)
  return out
}

/** The section a document position is inside, if any. */
export function sectionAt(ranges: readonly SectionRange[], pos: number): string | undefined {
  for (const r of ranges) if (pos >= r.from && pos <= r.to) return r.name
  return undefined
}

/**
 * Does something written at `pos` sound during `cycle`? Outside every
 * section, or without a `song`, always: those lines play throughout.
 * Inside one, only while the arrangement has that section sounding.
 */
export function soundsAt(ranges: readonly SectionRange[], arr: Arrangement | undefined, pos: number, cycle: number): boolean {
  const name = sectionAt(ranges, pos)
  if (name === undefined) return true
  const active = soundingAt(arr, cycle)
  return active === undefined || active.has(name)
}
