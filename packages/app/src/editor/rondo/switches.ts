/* ------------------------------------------------------------------------- *
 * The Switch: a knob with two fixed values instead of a range.
 *
 * A tap does not move a number, it changes which of two numbers the control is
 * resting on. That makes the write different in kind from every other widget
 * here, and it is why this scan reports WRITES rather than a value — the two
 * languages do not even rewrite the same number of spans:
 *
 *   rondo   fat = switch 1 9                  TWO spans, swapped. There is no
 *                                             separate default; the value
 *                                             written first IS the state.
 *   JS      param('fat', 1, {values:[1,9]})   ONE span, the default. `values`
 *                                             is the set, so reordering it as
 *                                             well would change nothing.
 *
 * A write says which POSITION in the pair it occupies, and after a toggle it
 * reads `toggled(m)[holds]`. Both spellings collapse to that, so the widget
 * never learns which language it is in — exactly like the knob and the
 * envelope before it.
 *
 * Why reorder rather than mark the active one some other way: the source is
 * the whole truth here, so the resting value has to be READABLE from the
 * source alone. `switch 9 1` says "currently 9, tap for 1" with no second
 * place for the state to live and get out of sync.
 * ------------------------------------------------------------------------- */

/** One span the toggle rewrites.
 *
 *  `holds` is the span's POSITION in the pair, not its value: after a toggle
 *  the span reads `toggled(m)[holds]`. Position rather than value is what
 *  makes rondo's swap and JavaScript's single default-rewrite the same
 *  operation to the widget. */
export interface SwitchWrite {
  from: number
  to: number
  /** index into `values` of what this span currently reads. */
  holds: 0 | 1
}

export interface SwitchMatch {
  /** the pair in SOURCE order; [0] is the value it is resting on. */
  values: [number, number]
  writes: SwitchWrite[]
  /** char offset just past the control — where the widget anchors. */
  at: number
  /** the param name, so a tap can reach the running voice. */
  name: string
  /** the enclosing `synth NAME`; absent for a project-wide switch. */
  synth?: string
  /** a top-level `switch NAME A B`: the tap fans out to every destination. */
  macro?: true
}

/** What the source should read after a tap: the pair, reversed. */
export const toggled = (m: SwitchMatch): [number, number] => [m.values[1], m.values[0]]

const stripComment = (raw: string): string => {
  const m = /(^|\s)#/.exec(raw)
  return m === null ? raw : raw.slice(0, m.index + (m[1] ? m[1].length : 0))
}

const NUM = String.raw`-?\d*\.?\d+`

/**
 * Every switch in a rondo document.
 *
 * Two spellings, one shape: an indented `NAME = switch A B` inside a synth,
 * and a top-level `switch NAME A B` that declares a project-wide one. Both
 * yield two spans to swap; the top-level form is flagged `macro` because a tap
 * on it moves every synth that names it.
 *
 * Pure — the failure mode is a span pointing at the wrong number, which is
 * silent and rewrites the wrong part of someone's patch.
 */
export function scanSwitches(text: string): SwitchMatch[] {
  const out: SwitchMatch[] = []
  let off = 0
  let synth: string | undefined
  for (const raw of text.split('\n')) {
    const line = stripComment(raw)
    const header = /^([a-zA-Z_]\w*)\b(?:[ \t]+([a-zA-Z_]\w*))?/.exec(line)
    if (header !== null && /^\S/.test(line)) synth = header[1] === 'synth' ? header[2] : undefined

    const top = new RegExp(String.raw`^switch[ \t]+([a-zA-Z_]\w*)[ \t]+(${NUM})[ \t]+(${NUM})[ \t]*$`).exec(line)
    if (top !== null) {
      const m = pair(line, off, top, top[1]!, top[2]!, top[3]!)
      if (m !== null) { m.macro = true; out.push(m) }
      off += raw.length + 1
      continue
    }
    const bind = new RegExp(String.raw`^[ \t]+([a-zA-Z_]\w*)[ \t]*=[ \t]*switch[ \t]+(${NUM})[ \t]+(${NUM})[ \t]*$`).exec(line)
    if (bind !== null) {
      const m = pair(line, off, bind, bind[1]!, bind[2]!, bind[3]!)
      if (m !== null) {
        if (synth !== undefined) m.synth = synth
        out.push(m)
      }
    }
    off += raw.length + 1
  }
  return out
}

/** Locate the two number tokens within a matched line. Searched from the END
 *  so a name containing digits cannot be mistaken for the first value. */
function pair(
  line: string,
  off: number,
  m: RegExpExecArray,
  name: string,
  aRaw: string,
  bRaw: string,
): SwitchMatch | null {
  const a = Number(aRaw)
  const b = Number(bRaw)
  // equal values are a control that cannot do anything, and rondo already
  // errors on them — no widget, so the diagnostic is what you see
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null
  const bAt = line.lastIndexOf(bRaw)
  const aAt = line.lastIndexOf(aRaw, bAt - 1)
  if (aAt < 0 || bAt < 0) return null
  return {
    values: [a, b],
    writes: [
      { from: off + aAt, to: off + aAt + aRaw.length, holds: 0 },
      { from: off + bAt, to: off + bAt + bRaw.length, holds: 1 },
    ],
    at: off + m[0].replace(/[ \t]+$/, '').length,
    name,
  }
}
