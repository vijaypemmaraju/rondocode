/* Inline rondo widgets — the prototype's controls, made real in the editor.
 *
 * v1: the KNOB. A `knob DEF lo..hi [log|lin]` binding renders a small draggable
 * dial right after its default value. Dragging it rewrites DEF in the source
 * (mapped through the range + curve) and re-evals live — the same "the text is
 * the source of truth" contract the rondocode slider()/scrub widgets use.
 *
 * Only active in rondo mode: this extension is bundled into rondoLanguage()'s
 * LanguageSupport, so it comes and goes with the language Compartment.
 *
 * Drag robustness: while dragging we edit only DEF (everything before it is
 * fixed), so the widget's anchor never moves; the plugin suppresses decoration
 * rebuilds mid-drag (mapping through our own edits instead) so the dial DOM —
 * and its pointer capture — survive. */

import { RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { formatNumber, niceStep } from '../widgets/rewrite'

/** `knob DEF lo..hi [curve]` — groups: 1=prefix(`knob `), 2=DEF, 3=lo, 4=hi, 5=curve. */
const KNOB_RE = /\b(knob\s+)(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\.\.(-?\d*\.?\d+)(?:\s+(log|lin))?/g

interface Hooks { requestEval: (immediate: boolean) => void }
interface Drag { active: boolean }

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

/** value → normalized 0..1 position on the knob (log or linear). */
export function toNorm(v: number, lo: number, hi: number, log: boolean): number {
  if (log && lo > 0 && hi > 0) return clamp(Math.log(v / lo) / Math.log(hi / lo), 0, 1)
  return clamp((v - lo) / (hi - lo || 1), 0, 1)
}
/** normalized 0..1 → value. */
export function fromNorm(t: number, lo: number, hi: number, log: boolean): number {
  return log && lo > 0 && hi > 0 ? lo * Math.pow(hi / lo, t) : lo + t * (hi - lo)
}

export interface KnobMatch {
  /** char offset of the DEF value within the scanned text. */
  defFrom: number
  defTo: number
  value: number
  lo: number
  hi: number
  log: boolean
}

/** Find every `knob DEF lo..hi [curve]` in `text` (pure — unit tested). */
export function scanKnobs(text: string): KnobMatch[] {
  const out: KnobMatch[] = []
  KNOB_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KNOB_RE.exec(text)) !== null) {
    const value = Number(m[2]), lo = Number(m[3]), hi = Number(m[4])
    if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi)) continue
    const defFrom = m.index + m[1]!.length
    out.push({ defFrom, defTo: defFrom + m[2]!.length, value, lo, hi, log: m[5] === 'log' })
  }
  return out
}

class KnobWidget extends WidgetType {
  constructor(
    readonly defFrom: number,
    readonly value: number,
    readonly lo: number,
    readonly hi: number,
    readonly log: boolean,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: KnobWidget): boolean {
    return o.defFrom === this.defFrom && o.value === this.value &&
      o.lo === this.lo && o.hi === this.hi && o.log === this.log
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'rondo-knob'
    wrap.setAttribute('role', 'slider')
    wrap.setAttribute('aria-label', 'knob')
    wrap.title = 'drag to set'
    wrap.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 15 15">' +
      '<circle cx="7.5" cy="7.5" r="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>' +
      '<line class="ptr" x1="7.5" y1="7.5" x2="7.5" y2="2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg>'
    const ptr = wrap.querySelector('.ptr') as SVGLineElement
    const setDial = (t: number): void => { ptr.setAttribute('transform', `rotate(${-135 + 270 * t} 7.5 7.5)`) }
    setDial(toNorm(this.value, this.lo, this.hi, this.log))

    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      wrap.setPointerCapture(e.pointerId)
      this.drag.active = true
      wrap.classList.add('active')
      const startY = e.clientY
      const t0 = toNorm(this.value, this.lo, this.hi, this.log)
      const step = niceStep(Math.abs(this.hi - this.lo) / 200)
      const from = this.defFrom
      let toPos = from + String(this.value).length // current DEF end (only DEF changes)
      const move = (ev: PointerEvent): void => {
        const t = clamp(t0 + (startY - ev.clientY) / 170, 0, 1)
        const v = fromNorm(t, this.lo, this.hi, this.log)
        const text = formatNumber(v, { step, min: Math.min(this.lo, this.hi) })
        view.dispatch({ changes: { from, to: toPos, insert: text } })
        toPos = from + text.length
        setDial(t)
        this.hooks.requestEval(false)
      }
      const end = (): void => {
        this.drag.active = false
        wrap.classList.remove('active')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        this.hooks.requestEval(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    })
    return wrap
  }

  ignoreEvent(): boolean { return true }
}

/** Scan the visible doc for knob bindings → a widget after each DEF value. */
function build(view: EditorView, hooks: Hooks, drag: Drag): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (const k of scanKnobs(view.state.sliceDoc(from, to))) {
      const defFrom = from + k.defFrom
      const defTo = from + k.defTo
      b.add(defTo, defTo, Decoration.widget({
        widget: new KnobWidget(defFrom, k.value, k.lo, k.hi, k.log, hooks, drag),
        side: 1,
      }))
    }
  }
  return b.finish()
}

/** The rondo inline-widget extension (currently: the knob). */
export function rondoWidgets(hooks: Hooks): Extension {
  const drag: Drag = { active: false }
  return ViewPlugin.fromClass(
    class {
      decos: DecorationSet
      constructor(view: EditorView) { this.decos = build(view, hooks, drag) }
      update(u: ViewUpdate): void {
        // Keep the dragged knob's DOM stable: map our own edits through instead
        // of rebuilding (which would destroy the element mid-gesture).
        if (drag.active) { this.decos = this.decos.map(u.changes); return }
        if (u.docChanged || u.viewportChanged) this.decos = build(u.view, hooks, drag)
      }
    },
    { decorations: (v) => v.decos },
  )
}
