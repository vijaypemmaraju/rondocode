/* ------------------------------------------------------------------------- *
 * THE BEND LANE — a note's expression curve, drawn where there is room.
 *
 * The first attempt drew each note's curve inside its piano-roll cell. The
 * cell is 12px square (16 on touch), which is enough to say "this note is
 * bent" and nowhere near enough to say HOW: at that size every curve reads
 * the same, and the grab strip for editing it was a 9px band that looked like
 * a rendering fault.
 *
 * So the curve moves to its own full-width lane under the notation, the same
 * placement a multi-cycle figure already uses for its clip overview. The
 * inline roll keeps a plain tick — enough to see WHICH notes carry a value —
 * and the lane is where the shape lives.
 *
 * IT ONLY APPEARS WHERE IT IS EARNED. A line with no expression values gets
 * no lane at all, so ordinary notation is untouched and the editor does not
 * grow a row of empty automation under every pattern.
 *
 * The text stays the source of truth: dragging a curve rewrites the `'value`
 * suffix on that note, and the same number is independently draggable in the
 * source, because it is a number in the source.
 * ------------------------------------------------------------------------- */
import { Decoration, WidgetType } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import { LiveWriter, attachGesture } from './gesture'
import type { Drag } from './gesture'
import { STEP_RE, accValue, exprValue, laneValues, stepText } from './widgets'
import type { Hooks, WidgetScan } from './widgets'
import { RONDO_SCAN } from './widgets'

/** One note's slot in a lane: its degree, its value, and where its text is. */
export interface BendNote {
  /** index among the notation's whitespace-separated tokens. */
  i: number
  step: number | null
  acc: number | undefined
  expr: number | undefined
  /** every lane on the note, so a bend drag cannot delete a `'gain:` beside it. */
  lanes: Record<string, number> | undefined
}

export interface BendLane {
  /** notation start/end in the document. */
  from: number
  to: number
  content: string
  notes: BendNote[]
}

/** Lanes for every simple degree line that carries at least one expression.
 *  Pure, so the decision to render is testable without an editor. */
export function scanBendLanes(text: string, scan: WidgetScan = RONDO_SCAN): BendLane[] {
  const out: BendLane[] = []
  for (const p of scan.plays(text)) {
    const toks = p.content.trim().split(/\s+/).filter(Boolean)
    const notes: BendNote[] = toks.map((tk, i) => {
      if (tk === '~') return { i, step: null, acc: undefined, expr: undefined, lanes: undefined }
      const m = STEP_RE.exec(tk)
      return m === null
        ? { i, step: null, acc: undefined, expr: undefined, lanes: undefined }
        : { i, step: Number(m[1]), acc: accValue(m[2]), expr: exprValue(m[3]), lanes: laneValues(m[3]) }
    })
    // no value anywhere on the line → no lane. An empty automation row under
    // every pattern would be pure cost.
    if (!notes.some((n) => n.expr !== undefined)) continue
    out.push({ from: p.from, to: p.to, content: p.content, notes })
  }
  return out
}

/** Spell a whole lane back out as notation. Extracted from the drag so it is
 *  testable: a drag must round-trip everything it did not touch — an
 *  accidental it silently dropped would move the note a semitone, which is a
 *  far worse bug than the one the drag was fixing. */
export function laneText(notes: readonly BendNote[]): string {
  return notes.map((n) => stepText(n.step, n.acc, n.expr, n.lanes)).join(' ')
}

/**
 * The value IN EFFECT at each note, which is not the same as the value each
 * note carries.
 *
 * A lane whose name the engine does not know sets a PARAM, and a param is a
 * control setting rather than a property of a note: it keeps whatever it was
 * last given. So one note carrying `'0.9` holds every note after it at 0.9,
 * and the engine emits exactly ONE param event for four notes.
 *
 * The lane used to draw those later notes flat, at rest, while the engine was
 * still holding them displaced. That is the one thing this widget must not do
 * (see `bendPath`): it may only draw what it actually knows, and what it knows
 * is that the value persists.
 *
 * A rest gets `undefined` because it sounds nothing, but it does NOT clear the
 * held value: the note after a rest inherits across it, exactly as the param
 * does.
 */
export function effectiveExpr(notes: readonly BendNote[]): (number | undefined)[] {
  let held: number | undefined
  return notes.map((n) => {
    if (n.expr !== undefined) held = n.expr
    return n.step === null ? undefined : held
  })
}

const LANE_H = 46
/** Value range a drag spans, and what the curve is drawn against. */
export const BEND_RANGE = 1

/**
 * The SVG path for one note's slot: a LEVEL at its value, not a trajectory.
 *
 * The first version drew a curve rising or falling into the note, and it was
 * a lie. The lane knows the note's VALUE and nothing else — the trajectory is
 * whatever the synth's own shape does with it, and that is arbitrary code
 * (`bend = shape * expr + 1` could be a scoop, a fall, a vibrato depth or a
 * filter sweep). Drawing a specific curve claimed knowledge the widget does
 * not have, and it was wrong for the very example on screen: that envelope
 * starts AT pitch, rises, and comes back, while the drawing showed it
 * starting displaced and settling.
 *
 * So it draws what it actually knows, the way an automation lane does: the
 * value, held across the note. Same honesty rule as the filter curves.
 */
export function bendPath(expr: number | undefined, w: number, h: number): string {
  const mid = h / 2
  if (expr === undefined || expr === 0) return `M0 ${mid} L${w} ${mid}`
  const v = Math.max(-BEND_RANGE, Math.min(BEND_RANGE, expr)) / BEND_RANGE
  const y = (mid - v * (h / 2 - 4)).toFixed(1)
  // a step up to the level, held across the note, and back — it reads as a
  // lane and never implies a pitch path the synth may not take
  return `M0 ${mid} L0 ${y} L${w.toFixed(1)} ${y} L${w.toFixed(1)} ${mid}`
}

export class BendLaneWidget extends WidgetType {
  constructor(
    readonly lane: BendLane,
    readonly width: number,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  override eq(o: BendLaneWidget): boolean {
    return o.width === this.width
      && o.lane.from === this.lane.from
      && o.lane.content === this.lane.content
  }

  override toDOM(view: EditorView): HTMLElement {
    const notes = this.lane.notes.map((n) => ({ ...n }))
    const wrap = document.createElement('div')
    wrap.className = 'rondo-bendlane'
    wrap.setAttribute('role', 'group')
    wrap.setAttribute('aria-label', 'note bend lane')
    const w = Math.max(120, this.width)
    const slot = w / Math.max(1, notes.length)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', `0 0 ${w} ${LANE_H}`)
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.style.width = '100%'
    svg.style.height = `${LANE_H}px`
    wrap.appendChild(svg)

    // the centre line: the written pitch, which every curve resolves back to
    const zero = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    zero.setAttribute('class', 'bl-zero')
    zero.setAttribute('x1', '0'); zero.setAttribute('x2', String(w))
    zero.setAttribute('y1', String(LANE_H / 2)); zero.setAttribute('y2', String(LANE_H / 2))
    svg.appendChild(zero)

    const paths: SVGPathElement[] = []
    const curveClass = (n: BendNote, eff: number | undefined): string =>
      'bl-curve'
      + (n.step === null ? ' rest' : '')
      // `held` says "this note did not set the value, it inherited it", which
      // is the difference between the note you can edit here and the notes it
      // reaches
      + (n.expr === undefined && eff !== undefined ? ' held' : '')
    notes.forEach((n, i) => {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('transform', `translate(${(i * slot).toFixed(2)} 0)`)
      g.setAttribute('class', 'bl-slot')
      g.dataset['i'] = String(i)
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      hit.setAttribute('class', 'bl-hit')
      hit.setAttribute('x', '0'); hit.setAttribute('y', '0')
      hit.setAttribute('width', String(slot)); hit.setAttribute('height', String(LANE_H))
      hit.dataset['i'] = String(i)
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const eff0 = effectiveExpr(notes)[i]
      path.setAttribute('class', curveClass(n, eff0))
      path.setAttribute('d', bendPath(n.expr ?? eff0, slot - 2, LANE_H))
      g.appendChild(hit); g.appendChild(path)
      svg.appendChild(g)
      paths.push(path)
    })

    // the WHOLE lane, not one slot: changing a value moves every note after
    // it that was inheriting the old one
    const redraw = (): void => {
      const eff = effectiveExpr(notes)
      paths.forEach((p, k) => {
        const n = notes[k]!
        p.setAttribute('class', curveClass(n, eff[k]))
        p.setAttribute('d', bendPath(n.expr ?? eff[k], slot - 2, LANE_H))
      })
    }

    attachGesture(wrap, this.drag, 'element', (e) => {
      const hit = (e.target as Element).closest?.('.bl-hit, .bl-slot') as SVGElement | null
      if (hit === null) return null
      const i = Number((hit as unknown as { dataset: DOMStringMap }).dataset['i'])
      if (!Number.isFinite(i) || notes[i] === undefined || notes[i]!.step === null) return null
      const start = notes[i]!.expr ?? 0
      const y0 = e.clientY
      const writer = new LiveWriter(view, this.lane.from, this.lane.to)
      const commit = (): void => {
        if (writer.write(laneText(notes))) this.hooks.requestEval(false)
      }
      return {
        onMove: (ev) => {
          // the lane is LANE_H tall and spans -1..1, so a drag across it is
          // the whole range: no hunting for a hidden sensitivity
          const next = start - ((ev.clientY - y0) / (LANE_H / 2)) * BEND_RANGE
          const cl = Math.max(-BEND_RANGE, Math.min(BEND_RANGE, next))
          const snapped = Math.abs(cl) < 0.02 ? undefined : Number(cl.toFixed(2))
          if (notes[i]!.expr === snapped) return
          notes[i]!.expr = snapped
          redraw()
          commit()
        },
        onEnd: () => {
          this.drag.ended = true
          view.dispatch({})
          this.hooks.requestEval(false)
        },
      }
    })
    return wrap
  }

  override ignoreEvent(): boolean { return true }
}

/** Block decorations: one lane under each notation line that carries values. */
export function bendLaneBlockDecos(
  text: string,
  width: number,
  hooks: Hooks,
  drag: Drag,
  scan: WidgetScan = RONDO_SCAN,
): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  for (const lane of scanBendLanes(text, scan)) {
    const nl = text.indexOf('\n', lane.to)
    const lineEnd = nl === -1 ? text.length : nl
    out.push(Decoration.widget({
      widget: new BendLaneWidget(lane, width, hooks, drag),
      side: 1,
      block: true,
    }).range(lineEnd))
  }
  return out
}
