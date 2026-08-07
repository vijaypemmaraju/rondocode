/* ------------------------------------------------------------------------- *
 * DIRECT NOTE EDITING IN THE PIANO ROLL — the pure model.
 *
 * The roll draws cells by QUERYING the compiled pattern, so a drawn cell has
 * no back-reference to the text that produced it. To drag a note the way an
 * FL-style roll does, something has to turn "this cell, moved two slots right
 * and one slot longer" back into mini-notation. That is this file.
 *
 * THE MODEL IS SLOTS, which is what mini-notation already is:
 *
 *   [4@2 0@2 4@2 0@2]   is 8 slots: 4 4 0 0 4 4 0 0
 *   0 ~ 3 5             is 4 slots: 0 . 3 5
 *
 * A bar's token weights sum to its slot count, so expanding to slots and
 * re-serializing runs is lossless — and once a bar IS a slot array, moving a
 * note is writing it at a different index and resizing is writing it over a
 * different span. Both are the same operation, and both always produce a bar
 * that reads back.
 *
 * Everything here is pure and span-carrying. The failure mode of this code is
 * a rewrite of the WRONG note, which is silent and destroys music someone
 * wrote, so the rules are tested directly rather than only through a drag.
 * ------------------------------------------------------------------------- */

/** The rest token. */
export const REST = '~'

/** One token of a bar: a value (or a rest) and how many slots it covers. */
export interface BarToken {
  /** the value as written — a degree, a note name, or `~` for a rest */
  value: string
  /** slots covered; `x@3` is 3, a bare `x` is 1 */
  weight: number
  /** absolute span of the whole token (`4@2`) within the string parsed */
  from: number
  to: number
}

/** A bar expanded to one entry per slot. `null` is a rest; a note occupies
 *  `start` at its head and repeats its id across its length. */
export interface Slot {
  value: string | null
  /** index of the note this slot belongs to (its order in the bar), or -1 */
  note: number
  /** true on the note's FIRST slot */
  start: boolean
}

/** A note as the roll sees it: where it starts, how long, what it says. */
export interface RollNote {
  value: string
  /** first slot */
  start: number
  /** length in slots (>= 1) */
  length: number
  /** the slot array's id for this note. Carried because a move has to CLEAR
   *  where the note was, and value+position cannot identify it: two notes of
   *  the same value in one bar are two notes, and clearing by value would
   *  erase the wrong one. */
  id: number
}

const TOKEN = /^([^@\s]+)(?:@(\d+(?:\.\d+)?))?$/

/**
 * Split one bar's text into tokens, with spans.
 *
 * `text` is the INSIDE of a bar — no enclosing brackets — and must be flat:
 * a nested group is not a slot grid and cannot be edited this way, so this
 * returns null rather than pretending. Returns null too for a weight that is
 * not a whole number, because a fractional weight has no slot to be.
 */
export function parseBar(text: string, offset = 0): BarToken[] | null {
  const out: BarToken[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    // any structural character means this is not a flat bar
    if (/[[\]<>{}(),!/*?]/.test(raw)) return null
    const t = TOKEN.exec(raw)
    if (t === null) return null
    const weight = t[2] === undefined ? 1 : Number(t[2])
    if (!Number.isInteger(weight) || weight < 1) return null
    out.push({ value: t[1]!, weight, from: offset + m.index, to: offset + m.index + raw.length })
  }
  return out.length > 0 ? out : null
}

/** Expand tokens to one entry per slot. The slot count is the weight sum. */
export function toSlots(tokens: readonly BarToken[]): Slot[] {
  const slots: Slot[] = []
  let note = 0
  for (const t of tokens) {
    const isRest = t.value === REST
    const id = isRest ? -1 : note++
    for (let i = 0; i < t.weight; i++) {
      slots.push({ value: isRest ? null : t.value, note: id, start: i === 0 })
    }
  }
  return slots
}

/** The notes of a slot array, in bar order — what a roll cell corresponds to. */
export function notesOf(slots: readonly Slot[]): RollNote[] {
  const out: RollNote[] = []
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!
    if (s.value === null || !s.start) continue
    let length = 1
    while (i + length < slots.length && slots[i + length]!.note === s.note && !slots[i + length]!.start) length++
    out.push({ value: s.value, start: i, length, id: s.note })
  }
  return out
}

/** Serialize slots back to bar text: runs of the same note become `v@n`, and
 *  runs of rest become `~@n`. A run of one omits the weight, which is how the
 *  notation is written by hand. */
export function slotsToText(slots: readonly Slot[]): string {
  const parts: string[] = []
  let i = 0
  while (i < slots.length) {
    const s = slots[i]!
    let n = 1
    while (
      i + n < slots.length &&
      slots[i + n]!.value === s.value &&
      slots[i + n]!.note === s.note &&
      !slots[i + n]!.start
    ) n++
    const v = s.value ?? REST
    parts.push(n === 1 ? v : `${v}@${n}`)
    i += n
  }
  return parts.join(' ')
}

/**
 * Write note `index` at `start` for `length` slots, clearing where it was.
 *
 * This is BOTH operations: a drag moves it (new start, same length) and an
 * edge-drag resizes it (same start, new length). Anything it lands on is
 * overwritten, exactly as dropping a note on a busy bar does in a piano roll
 * — the slot count never changes, so the bar stays the same length however
 * many times it is edited.
 *
 * Clamped rather than rejected: a drag that runs off the end should stop at
 * the end, not refuse and leave the note where it was.
 */
export function placeNote(slots: readonly Slot[], index: number, start: number, length: number): Slot[] {
  const total = slots.length
  const notes = notesOf(slots)
  const target = notes[index]
  if (target === undefined) return [...slots]
  // START clamps first, then the length to whatever is left. The other order
  // is subtly wrong for a RESIZE: dragging the right edge past the end would
  // clamp the length to the whole bar and then drag the note's START back to
  // slot 0, moving a note the user was only lengthening.
  const at = Math.max(0, Math.min(start, total - 1))
  const len = Math.max(1, Math.min(length, total - at))
  const out: Slot[] = slots.map((s) => (s.note === target.id ? { value: null, note: -1, start: false } : { ...s }))
  for (let i = 0; i < len; i++) {
    out[at + i] = { value: target.value, note: target.id, start: i === 0 }
  }
  // A note this one landed on may now be headless (its start was overwritten)
  // or split in two. Re-head every run so the array stays well formed —
  // without this a later notesOf() would drop or merge somebody's note.
  return reseat(out)
}

/** Re-establish `start` flags: the first slot of every run of one note id. */
function reseat(slots: readonly Slot[]): Slot[] {
  const out = slots.map((s) => ({ ...s }))
  for (let i = 0; i < out.length; i++) {
    const s = out[i]!
    if (s.value === null) { s.note = -1; s.start = false; continue }
    const prev = out[i - 1]
    s.start = prev === undefined || prev.value === null || prev.note !== s.note
  }
  return out
}

/** One editable bar of a notation: the text INSIDE its brackets, and where. */
export interface BarSpan {
  text: string
  from: number
  to: number
}

/**
 * The top-level bars of a notation, in the order the roll draws them.
 *
 * `<[a] [b]>` is two bars; `[a b]` and a bare `a b` are one. Only the OUTER
 * layer is walked — a bar containing a nested group is returned as it stands
 * and parseBar will decline it, which is the honest answer: there is no slot
 * grid inside a nesting to move a note within.
 */
export function barSpans(notation: string, offset = 0): BarSpan[] {
  const trimmed = notation.trim()
  const lead = notation.indexOf(trimmed)
  const base = offset + (lead < 0 ? 0 : lead)
  // an alternation: each top-level [..] group is one bar
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    const out: BarSpan[] = []
    let depth = 0
    let open = -1
    for (let i = 1; i < trimmed.length - 1; i++) {
      const c = trimmed[i]!
      if (c === '[' || c === '<' || c === '{') {
        if (depth === 0) open = i
        depth++
      } else if (c === ']' || c === '>' || c === '}') {
        depth--
        if (depth === 0 && open >= 0) {
          out.push({ text: trimmed.slice(open + 1, i), from: base + open + 1, to: base + i })
          open = -1
        }
      }
    }
    return out
  }
  // a single bracketed bar, or a bare token list
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return [{ text: trimmed.slice(1, -1), from: base + 1, to: base + trimmed.length - 1 }]
  }
  return [{ text: trimmed, from: base, to: base + trimmed.length }]
}

/**
 * Which note of which bar a drawn cell is.
 *
 * The roll's cells come from querying the pattern, so a cell knows only WHERE
 * it sounds: `x0` in bars, `x1` its end. That is enough — the bar is the whole
 * part, and the note is the one whose slot span contains the cell's start.
 * Matching on the START rather than on the value is what keeps two notes of
 * the same value in one bar distinct.
 */
export function cellToNote(
  bars: readonly BarSpan[],
  x0: number,
): { bar: number; barText: string; from: number; to: number; index: number; slots: number } | null {
  const b = Math.floor(x0 + 1e-9)
  const span = bars[b]
  if (span === undefined) return null
  const tokens = parseBar(span.text, span.from)
  if (tokens === null) return null
  const slots = toSlots(tokens)
  const notes = notesOf(slots)
  const at = Math.round((x0 - b) * slots.length)
  const index = notes.findIndex((n) => n.start === at)
  if (index < 0) return null
  return { bar: b, barText: span.text, from: span.from, to: span.to, index, slots: slots.length }
}

/** The edit a drag produces: the bar's new text and where to write it. */
export interface BarEdit {
  from: number
  to: number
  text: string
}

/** Which half of a note a pointer grabbed: the right edge resizes, anything
 *  else moves. The edge zone is a fraction of the cell, floored in pixels so
 *  a very short note is still grabbable by its body. */
export function grabKind(offsetPx: number, widthPx: number): 'move' | 'resize' {
  const edge = Math.min(Math.max(widthPx * 0.28, 6), 14)
  return offsetPx >= widthPx - edge ? 'resize' : 'move'
}

/** Degree steps a vertical drag covers. Up is negative y and pitch climbs
 *  the screen, so the sign flips. */
export function pitchDelta(dy: number, rowH: number): number {
  // `|| 0` normalizes -0: a downward nudge rounds to negative zero, which is
  // not 0 to Object.is and would read as a step to anything comparing exactly.
  return Math.round(-dy / Math.max(rowH, 1)) || 0
}

/** Slots a horizontal drag of `dx` pixels covers, given the bar's width. */
export function slotDelta(dx: number, barWidthPx: number, slots: number): number {
  const per = barWidthPx / Math.max(slots, 1)
  return Math.round(dx / Math.max(per, 1))
}

/**
 * Transpose ONE note of a bar by `steps` degrees.
 *
 * One roll row is one degree step, which is what the whole-roll transpose
 * handle already means by a row (see transposeSteps) — so a single note moves
 * by the same measure the whole pattern does, and dragging one note up a row
 * lands where dragging all of them would have put it.
 *
 * DEGREES ONLY. The roll builds its rows from numeric values and skips
 * anything else, so a note-name notation (`c3 e3`) draws no cells and cannot
 * be dragged in the first place. Rather than invent note-name arithmetic for
 * cells that do not exist, this declines a non-numeric token — which is also
 * the honest answer for `bd` in a beat block.
 *
 * The new degree may have no row yet; the roll rebuilds from the document
 * after the edit, so the row appears. That is the same path any other edit
 * takes.
 */
export function transposeNote(
  barText: string,
  barFrom: number,
  index: number,
  steps: number,
): BarEdit | null {
  if (steps === 0) return null
  const tokens = parseBar(barText, barFrom)
  if (tokens === null) return null
  const notes = notesOf(toSlots(tokens))
  const note = notes[index]
  if (note === undefined) return null
  // the token this note came from: the note's id counts non-rest tokens
  let seen = -1
  const token = tokens.find((t) => t.value !== REST && ++seen === note.id)
  if (token === undefined) return null
  const deg = Number(token.value)
  if (!Number.isFinite(deg)) return null
  const next = String(deg + steps)
  return { from: token.from, to: token.from + token.value.length, text: next }
}

/**
 * Move or resize one note of a bar, as a document edit.
 *
 * `barFrom`/`barText` are the bar's INSIDE and where it sits in the document.
 * Returns null when the bar is not a flat slot grid (nested groups have no
 * slots to move between) or when the edit changes nothing — a drag that
 * quantizes back to where it started should write nothing at all, so an
 * undo history is not filled with no-ops.
 */
export function editNote(
  barText: string,
  barFrom: number,
  index: number,
  start: number,
  length: number,
): BarEdit | null {
  const tokens = parseBar(barText, barFrom)
  if (tokens === null) return null
  const slots = toSlots(tokens)
  if (notesOf(slots)[index] === undefined) return null
  const text = slotsToText(placeNote(slots, index, start, length))
  if (text === barText.trim()) return null
  return { from: barFrom, to: barFrom + barText.length, text }
}
