/* ------------------------------------------------------------------------- *
 * The breakpoint editor's SCAN.
 *
 * `adsr` has four values in fixed roles, so its widget has three handles in
 * known places. `env` has as many breakpoints as you type, each a time and a
 * level and possibly its own curve — so the shape has to be read out of the
 * source rather than assumed, and every number needs its own span because a
 * drag rewrites one point and must leave the rest spelled as they were.
 *
 * Pure and separate from the widget so the parsing rules are testable without
 * a DOM: the failure mode is a span that points at the wrong number, which is
 * silent and rewrites the wrong part of someone's envelope.
 * ------------------------------------------------------------------------- */

/** A character range in the document. */
export interface Span {
  from: number
  to: number
}

/** One breakpoint, with the spans a drag writes back to. */
export interface EnvPoint {
  time: number
  level: number
  /** that segment's own shape, when the source wrote `level:curve`. */
  curve?: number
  timeSpan: Span
  levelSpan: Span
  /** span of the curve number, when present. */
  curveSpan?: Span
  /** Where to WRITE a curve when the point has none yet, and the glue that
   *  must precede it. rondo spells it `1:3` and JS `[0.15, 0.4, 3]` — the same
   *  number, different punctuation — so the scanner supplies the punctuation
   *  and the drag stays language-agnostic, like every other writer here. */
  curveInsert?: { at: number; prefix: string }
}

/** One `env …` call found in the document. */
export interface EnvPointsScan {
  points: EnvPoint[]
  /** char offset just past the whole call — where the widget anchors. */
  at: number
  /** the enclosing `synth NAME`, so the widget can follow that synth's notes. */
  synth?: string
  /** envelope-wide curve from `curve:`, the default for points without one. */
  curve?: number
}

const stripComment = (raw: string): string => {
  const m = /(^|\s)#/.exec(raw)
  return m === null ? raw : raw.slice(0, m.index + (m[1] ? m[1].length : 0))
}

/** `NUMBER` or `NUMBER:NUMBER` (a level carrying its own curve). */
const NUM = /(-?\d*\.?\d+)(?::(-?\d*\.?\d+))?/y
/** A named argument ends the breakpoint run: `release:.3`, `loop:1`. */
const NAMED = /[ \t]*[a-zA-Z_]\w*[ \t]*:/y

/**
 * Every `env` breakpoint list in the document.
 *
 * Only a call with an EVEN, non-zero number of values is returned: an odd one
 * is mid-typing (or a compile error), and drawing a shape for half a
 * breakpoint would put a handle somewhere the source cannot represent.
 */
export function scanEnvPoints(text: string): EnvPointsScan[] {
  const out: EnvPointsScan[] = []
  let off = 0
  let synth: string | undefined
  for (const raw of text.split('\n')) {
    const line = stripComment(raw)
    const header = /^(synth|play|beat|sing|bus|section|cps|bpm|js|macro|visual)\b(?:[ \t]+([a-zA-Z_]\w*))?/.exec(line)
    if (header) synth = header[1] === 'synth' ? header[2] : undefined

    const call = /\benv[ \t]+/g
    let m: RegExpExecArray | null
    while ((m = call.exec(line)) !== null) {
      let i = m.index + m[0].length
      const nums: { v: number; span: Span; curve?: number; curveSpan?: Span }[] = []
      for (;;) {
        NAMED.lastIndex = i
        if (NAMED.exec(line) !== null) break // a named arg ends the run
        NUM.lastIndex = i
        const n = NUM.exec(line)
        if (n === null) break
        const v = Number(n[1])
        if (!Number.isFinite(v)) break
        const start = i
        const entry: { v: number; span: Span; curve?: number; curveSpan?: Span } = {
          v,
          span: { from: off + start, to: off + start + n[1]!.length },
        }
        if (n[2] !== undefined) {
          entry.curve = Number(n[2])
          const cFrom = off + start + n[0].length - n[2].length
          entry.curveSpan = { from: cFrom, to: cFrom + n[2].length }
        }
        nums.push(entry)
        i = start + n[0].length
        // skip the separating whitespace; anything else ends the run
        const ws = /^[ \t]+/.exec(line.slice(i))
        if (ws === null) break
        i += ws[0].length
      }
      if (nums.length < 2 || nums.length % 2 !== 0) continue
      const points: EnvPoint[] = []
      for (let k = 0; k + 1 < nums.length; k += 2) {
        const t = nums[k]!
        const l = nums[k + 1]!
        const p: EnvPoint = { time: t.v, level: l.v, timeSpan: t.span, levelSpan: l.span }
        if (l.curve !== undefined) { p.curve = l.curve; p.curveSpan = l.curveSpan! }
        else p.curveInsert = { at: l.span.to, prefix: ':' }
        points.push(p)
      }
      const wide = /\bcurve[ \t]*:[ \t]*(-?\d*\.?\d+)/.exec(line)
      const scan: EnvPointsScan = { points, at: off + i }
      if (synth !== undefined) scan.synth = synth
      if (wide !== null) scan.curve = Number(wide[1])
      out.push(scan)
      call.lastIndex = i
    }
    off += raw.length + 1
  }
  return out
}

/** The polyline for a breakpoint list, in a `w` x `h` box.
 *
 *  X is CUMULATIVE time normalised to the total, so segment widths are
 *  proportional to their durations — an envelope whose decay is ten times its
 *  attack should look like it. Levels are drawn against a fixed 0..1 range
 *  rather than the envelope's own maximum, so raising one point does not
 *  silently rescale every other point under the cursor. */
/** The engine's easing, so a curve number looks like what it sounds like. */
const ease = (f: number, c: number): number =>
  c === 0 ? f : (1 - Math.exp(-c * f)) / (1 - Math.exp(-c))

/** SVG path for a breakpoint list, with each segment BENT by its own curve.
 *
 *  Straight lines would be a lie the moment curves became draggable: you would
 *  be moving a number and watching nothing happen. Segments with no bend emit
 *  a single `L`, so an ordinary envelope is the same path it always was. */
export function envPath(
  points: readonly EnvPoint[],
  w: number,
  h: number,
  pad = 4,
  globalCurve = 0,
  steps = 12,
): string {
  const g = envGeometry(points, w, h, pad)
  let d = `M ${g[0]!.x.toFixed(1)} ${g[0]!.y.toFixed(1)}`
  for (let i = 0; i < points.length; i++) {
    const a = g[i]!
    const b = g[i + 1]!
    const c = points[i]!.curve ?? globalCurve
    if (c === 0) {
      d += ` L ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
      continue
    }
    for (let k = 1; k <= steps; k++) {
      const f = k / steps
      const x = a.x + (b.x - a.x) * f
      const y = a.y + (b.y - a.y) * ease(f, c)
      d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`
    }
  }
  return d
}

export function envGeometry(
  points: readonly EnvPoint[],
  w: number,
  h: number,
  pad = 4,
): { x: number; y: number }[] {
  const total = points.reduce((n, p) => n + Math.max(0, p.time), 0)
  const span = w - pad * 2
  const out: { x: number; y: number }[] = [{ x: pad, y: h - pad }]
  let acc = 0
  for (const p of points) {
    acc += Math.max(0, p.time)
    const x = total > 0 ? pad + (acc / total) * span : pad + span
    const lv = Math.max(0, Math.min(1, p.level))
    out.push({ x, y: h - pad - lv * (h - pad * 2) })
  }
  return out
}
