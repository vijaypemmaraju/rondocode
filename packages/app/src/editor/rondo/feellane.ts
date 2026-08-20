/* ------------------------------------------------------------------------- *
 * THE FEEL LANE — where each hit actually lands, draggable sideways.
 *
 * `'push:` places a note off the grid by a fraction of its own step, and a
 * fraction in a text buffer is the wrong tool for a feel judgment: the ear
 * decides whether the snare sits 6% or 9% behind the beat, not the keyboard.
 * Eval is hot, so the loop this lane exists for is drag, listen, drag again.
 *
 * It draws the written grid as a ruler and one mark per note at the position
 * the engine will actually play it. Dragging a mark sideways rewrites that
 * note's `'push:` and nothing else; one slot of drag is one full step, the
 * whole legal range, so there is no hidden sensitivity to hunt for. A mark
 * released within a whisker of its gridpoint snaps to NO lane at all, so
 * exploring and returning leaves the source exactly as it was.
 *
 * IT ONLY APPEARS WHERE IT IS EARNED, like the bend lane: a line with no
 * `'push:` gets no lane. Write `'push:.01` on one note to summon it, then
 * tune the number by ear here.
 *
 * The text stays the source of truth: the lane rewrites the suffix on the
 * note, and the same number is independently draggable in the source,
 * because it is a number in the source.
 * ------------------------------------------------------------------------- */
import { Decoration, WidgetType } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import { LiveWriter, attachGesture } from './gesture'
import type { Drag } from './gesture'
import type { Hooks, WidgetScan } from './widgets'
import { RONDO_SCAN } from './widgets'
import { laneText, scanLaneRows } from './bendlane'
import type { BendLane } from './bendlane'

/** Value range a drag spans: `'push:` is parse-checked to ±1 of a step. */
export const FEEL_RANGE = 1

/** Lanes for every simple degree line that carries at least one `'push:`.
 *  Pure, so the decision to render is testable without an editor. */
export function scanFeelLanes(text: string, scan: WidgetScan = RONDO_SCAN): BendLane[] {
  // no push anywhere on the line → no lane, same earned-ness rule as the
  // bend lane: ordinary notation must not grow empty automation rows.
  return scanLaneRows(text, scan).filter((l) =>
    l.notes.some((n) => n.lanes?.['push'] !== undefined))
}

/** X of a note's mark: its gridpoint plus its push, in slot units. Pure —
 *  this is the drawing's one claim, that the mark sits where the engine
 *  plays the note relative to the written grid. */
export function feelMarkX(i: number, push: number | undefined, slot: number): number {
  return (i + (push ?? 0)) * slot
}

/** A horizontal drag folded into the next `'push:` value: one slot of travel
 *  is the full ±1 range, clamped, and a whisker from the gridpoint is NO
 *  value — so a note dragged back where it started carries no residue. */
export function dragPush(start: number, dx: number, slot: number): number | undefined {
  const next = start + dx / Math.max(1, slot)
  const cl = Math.max(-FEEL_RANGE, Math.min(FEEL_RANGE, next))
  return Math.abs(cl) < 0.02 ? undefined : Number(cl.toFixed(2))
}

const LANE_H = 34

export class FeelLaneWidget extends WidgetType {
  constructor(
    readonly lane: BendLane,
    readonly width: number,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  override eq(o: FeelLaneWidget): boolean {
    return o.width === this.width
      && o.lane.from === this.lane.from
      && o.lane.content === this.lane.content
  }

  override toDOM(view: EditorView): HTMLElement {
    // lanes is a nested record, so the working copy has to copy IT too — a
    // shallow {...n} would write the drag's push into the widget's own
    // snapshot, and the post-gesture rebuild would diff against itself
    const notes = this.lane.notes.map((n) => ({ ...n, lanes: n.lanes === undefined ? undefined : { ...n.lanes } }))
    const wrap = document.createElement('div')
    wrap.className = 'rondo-feellane'
    wrap.setAttribute('role', 'group')
    wrap.setAttribute('aria-label', 'note timing lane')
    const w = Math.max(120, this.width)
    const slot = w / Math.max(1, notes.length)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', `0 0 ${w} ${LANE_H}`)
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.style.width = '100%'
    svg.style.height = `${LANE_H}px`
    wrap.appendChild(svg)

    // the ruler: the written grid every mark is measured against
    for (let k = 0; k <= notes.length; k++) {
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      tick.setAttribute('class', 'fl-grid')
      const x = (k * slot).toFixed(2)
      tick.setAttribute('x1', x); tick.setAttribute('x2', x)
      tick.setAttribute('y1', '0'); tick.setAttribute('y2', String(LANE_H))
      svg.appendChild(tick)
    }

    const marks = new Map<number, SVGLineElement>()
    const markClass = (push: number | undefined): string =>
      push === undefined ? 'fl-mark grid-on' : 'fl-mark'
    notes.forEach((n, i) => {
      if (n.step === null) return
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      hit.setAttribute('class', 'fl-hit')
      hit.setAttribute('x', (i * slot).toFixed(2)); hit.setAttribute('y', '0')
      hit.setAttribute('width', String(slot)); hit.setAttribute('height', String(LANE_H))
      hit.dataset['i'] = String(i)
      svg.appendChild(hit)
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      const x = feelMarkX(i, n.lanes?.['push'], slot).toFixed(2)
      mark.setAttribute('class', markClass(n.lanes?.['push']))
      mark.setAttribute('x1', x); mark.setAttribute('x2', x)
      mark.setAttribute('y1', '5'); mark.setAttribute('y2', String(LANE_H - 5))
      svg.appendChild(mark)
      marks.set(i, mark)
    })

    attachGesture(wrap, this.drag, 'element', (e) => {
      const hit = (e.target as Element).closest?.('.fl-hit') as SVGElement | null
      if (hit === null) return null
      const i = Number((hit as unknown as { dataset: DOMStringMap }).dataset['i'])
      const n = notes[i]
      if (!Number.isFinite(i) || n === undefined || n.step === null) return null
      const start = n.lanes?.['push'] ?? 0
      const x0 = e.clientX
      // clientX is in CSS pixels but slot is in viewBox units: scale the drag
      // by the actual on-screen width or a full-width editor would need a
      // longer drag for the same push than a narrow one
      const px = wrap.getBoundingClientRect().width || w
      const slotPx = (px / w) * slot
      const writer = new LiveWriter(view, this.lane.from, this.lane.to)
      const commit = (): void => {
        if (writer.write(laneText(notes))) this.hooks.requestEval(false)
      }
      return {
        onMove: (ev) => {
          const next = dragPush(start, ev.clientX - x0, slotPx)
          if (n.lanes?.['push'] === next) return
          if (next === undefined) {
            if (n.lanes !== undefined) delete n.lanes['push']
          } else {
            n.lanes = { ...(n.lanes ?? {}), push: next }
          }
          const mark = marks.get(i)
          if (mark !== undefined) {
            const x = feelMarkX(i, next, slot).toFixed(2)
            mark.setAttribute('x1', x); mark.setAttribute('x2', x)
            mark.setAttribute('class', markClass(next))
          }
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

/** Block decorations: one lane under each notation line that carries a push. */
export function feelLaneBlockDecos(
  text: string,
  width: number,
  hooks: Hooks,
  drag: Drag,
  scan: WidgetScan = RONDO_SCAN,
): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  for (const lane of scanFeelLanes(text, scan)) {
    const nl = text.indexOf('\n', lane.to)
    const lineEnd = nl === -1 ? text.length : nl
    out.push(Decoration.widget({
      widget: new FeelLaneWidget(lane, width, hooks, drag),
      side: 1,
      block: true,
    }).range(lineEnd))
  }
  return out
}
