import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { detect, scanNumbersText } from './detect'
import type { ScrubLit } from './detect'
import { formatNumber, niceStep } from './rewrite'

/* ------------------------------------------------------------------------- *
 * Number scrubbing: ANY plain numeric literal (outside widget calls) can be
 * dragged horizontally to change its value — the signature "everything is
 * live" move.
 *
 * ACTIVATION — two paths, chosen to never fight normal editing:
 * - Desktop: Alt+drag. preventDefault on pointerdown, so no selection ever
 *   starts.
 * - Touch/pen: INSTANT sideways engage — touch a number and drag
 *   horizontally, no long-press. The first ~8 px of travel decide the
 *   gesture: sideways ⇒ scrub (the doc line-wraps, so horizontal has no
 *   native meaning; `.cm-scrub { touch-action: pan-y }` tells the browser
 *   the same), vertical ⇒ cancel and let native scrolling run, an unmoved
 *   tap ⇒ falls through to normal caret placement. No hold window means
 *   the iOS text loupe / selection UI never races the gesture — the
 *   control-surface feel of touching a value and hearing it change.
 *   Scroll is blocked (passive:false touchmove) only once a scrub is live.
 *
 * DISCOVERABILITY: every scrubbable literal carries a faint dotted
 * underline, always on (not just while a modifier is held) — on phones
 * there is no modifier to hold, and a permanently visible hint teaches the
 * gesture on both form factors. It is deliberately dim (see style.css) so
 * code stays readable.
 *
 * VALUE MATH (pure, tested): the per-100px delta is 10% of |start value|
 * with a floor of 0.01 (1 for integer literals, so small ints move at a
 * usable rate). Results are quantized to a "nice" 1/2/5-step so the
 * rewritten literals stay short and readable; integer literals (no decimal
 * point in the source) always stay integers.
 *
 * Rewrites are throttled to one dispatch per 30 ms (trailing), re-eval is
 * the caller's debounced callback and is only ever requested when a
 * rewrite actually happened — an unmoved press must not eval unrelated
 * un-run edits. The scrubbed range is tracked locally across our OWN
 * rewrites; any external doc change mid-gesture (another widget, HMR,
 * collaborative edit) ABORTS the gesture — the tracked range is stale and
 * guessing at a remap is worse than ending the drag. detect() runs fresh
 * at engage time and on each pointerdown, so stale literals cannot leak
 * between gestures.
 * ------------------------------------------------------------------------- */

export const SCRUB_MIN_STEP = 0.01
export const SCRUB_THROTTLE_MS = 30
/** Finger travel that decides a touch gesture: sideways past this = scrub
 *  engages instantly; vertical past this = it's a scroll, hand it back. */
const TOUCH_ENGAGE_PX = 8

/** Per-pixel delta and output quantum for a scrub starting at `start`. */
export function scrubStep(start: number, isInt: boolean): { perPixel: number; quantum: number } {
  const per100 = Math.max(Math.abs(start) * 0.1, isInt ? 1 : SCRUB_MIN_STEP)
  const quantum = isInt ? Math.max(1, niceStep(per100 / 10)) : niceStep(per100 / 10)
  return { perPixel: per100 / 100, quantum }
}

/** New value after dragging `dxPx` pixels from `start` (quantized). */
export function scrubValue(start: number, dxPx: number, isInt: boolean): number {
  const { perPixel, quantum } = scrubStep(start, isInt)
  const raw = start + dxPx * perPixel
  if (isInt) return Math.round(Math.round(raw / quantum) * quantum)
  return Math.round(raw / quantum) * quantum
}

/** Source text for the scrubbed value — integer literals stay integers,
 *  floats print exactly the quantum's decimals (no float noise). */
export function scrubText(start: number, dxPx: number, isInt: boolean): string {
  const { quantum } = scrubStep(start, isInt)
  const v = scrubValue(start, dxPx, isInt)
  return isInt ? String(v) : formatNumber(v, { step: quantum })
}

/* ---------------------------------- extension --------------------------- */

const scrubMark = Decoration.mark({ class: 'cm-scrub' })

interface ActiveScrub {
  pointerId: number
  x0: number
  v0: number
  isInt: boolean
  from: number
  to: number
  lastText: string | null
  lastApply: number
  trailing: ReturnType<typeof setTimeout> | undefined
  lastDx: number
  /** Tear down listeners/classes WITHOUT flushing (external-change abort). */
  abort: () => void
}

/** Clamp the lens' center-x so the pill never leaves the viewport. Pure. */
export function lensClampX(x: number, pillWidth: number, viewportWidth: number): number {
  const half = pillWidth / 2
  return Math.min(Math.max(x, half + 4), Math.max(half + 4, viewportWidth - half - 4))
}

/* THE SCRUB LENS: on touch, the finger sits exactly on the number being
 * changed - so while a touch scrub is armed (press-hold) or engaged (drag),
 * a knob-style enlarged readout floats above the finger showing the live
 * value. Mouse scrubs skip it (the cursor hides nothing). One element,
 * created lazily, shared by every scrub. */
const lens = (() => {
  let el: HTMLDivElement | null = null
  const ensure = (): HTMLDivElement => {
    if (el === null) {
      el = document.createElement('div')
      el.className = 'scrub-lens'
      el.setAttribute('aria-hidden', 'true')
      document.body.append(el)
    }
    return el
  }
  return {
    show(x: number, y: number, text: string): void {
      const d = ensure()
      d.textContent = text
      d.classList.add('on')
      this.move(x, y)
    },
    move(x: number, y: number): void {
      if (el === null) return
      const w = el.offsetWidth || 64
      el.style.left = `${lensClampX(x, w, window.innerWidth)}px`
      el.style.top = `${Math.max(8, y - 64)}px`
    },
    update(text: string): void {
      if (el !== null) el.textContent = text
    },
    hide(): void {
      el?.classList.remove('on')
    },
  }
})()

export function scrubExtension(hooks: { requestEval: (immediate: boolean) => void }): Extension {
  /** The literal under the pointer, from a FRESH detect (cheap: <10 KB docs). */
  const litAt = (view: EditorView, x: number, y: number): ScrubLit | null => {
    const pos = view.posAtCoords({ x, y })
    if (pos === null) return null
    const doc = view.state.doc.toString()
    const tree = syntaxTree(view.state)
    let numbers = detect(doc, tree).numbers
    // The tree walk is JS-grammar-specific; in rondo mode (a StreamLanguage
    // tree, top node "Document" not "Script") it finds nothing, so fall back to
    // a plain-text scan — every number stays scrubbable in rondo. Gated on the
    // grammar, NOT on numbers.length: a JS doc whose only digits sit inside
    // mini-notation strings must keep them non-scrubbable as before.
    if (numbers.length === 0 && tree.type.name !== 'Script') numbers = scanNumbersText(doc)
    return numbers.find((n) => pos >= n.from && pos <= n.to) ?? null
  }

  let active: ActiveScrub | null = null
  let hold: { cancel: () => void } | null = null
  /** True while OUR dispatch is in flight — distinguishes our own doc
   *  changes from external ones in the plugin's update hook. */
  let selfDispatch = false

  const blockTouch = (e: TouchEvent): void => e.preventDefault()

  const startScrub = (view: EditorView, lit: ScrubLit, e: PointerEvent, touch = false): void => {
    active = {
      pointerId: e.pointerId,
      x0: e.clientX,
      v0: lit.value,
      isInt: lit.isInt,
      from: lit.from,
      to: lit.to,
      // seed with the CURRENT spelling: an unmoved click/press then never
      // rewrites (scrubText would otherwise normalize e.g. 1e3 → 1000)
      lastText: view.state.doc.sliceString(lit.from, lit.to),
      lastApply: 0,
      trailing: undefined,
      lastDx: 0,
      abort: () => {},
    }
    try {
      ;(e.target as Element).setPointerCapture(e.pointerId)
    } catch {
      // capture is best-effort; window listeners carry the drag regardless
    }
    view.dom.classList.add('cm-scrubbing')
    if (touch) lens.show(e.clientX, e.clientY, view.state.doc.sliceString(lit.from, lit.to))
    const apply = (dx: number): void => {
      const a = active
      if (a === null) return
      a.lastApply = Date.now()
      const text = scrubText(a.v0, dx, a.isInt)
      if (text === a.lastText) return
      a.lastText = text
      lens.update(text)
      try {
        selfDispatch = true
        view.dispatch({ changes: { from: a.from, to: a.to, insert: text } })
        a.to = a.from + text.length
        hooks.requestEval(false)
      } catch {
        cleanup() // view gone mid-drag: end silently
      } finally {
        selfDispatch = false
      }
    }
    const onMove = (ev: PointerEvent): void => {
      const a = active
      if (a === null || ev.pointerId !== a.pointerId) return
      a.lastDx = ev.clientX - a.x0
      lens.move(ev.clientX, ev.clientY)
      const wait = SCRUB_THROTTLE_MS - (Date.now() - a.lastApply)
      clearTimeout(a.trailing)
      if (wait <= 0) apply(a.lastDx)
      else a.trailing = setTimeout(() => apply(a.lastDx), wait)
    }
    const cleanup = (): void => {
      const a = active
      if (a === null) return
      clearTimeout(a.trailing)
      active = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('touchmove', blockTouch)
      view.dom.classList.remove('cm-scrubbing')
      lens.hide()
    }
    const end = (ev: PointerEvent): void => {
      const a = active
      if (a === null || ev.pointerId !== a.pointerId) return
      clearTimeout(a.trailing)
      // flush the final position — apply() self-gates: identical text
      // (e.g. an unmoved press) dispatches nothing and requests no eval
      apply(a.lastDx)
      cleanup()
    }
    active.abort = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    // scrolling must not fight the drag — but only once scrubbing is real
    window.addEventListener('touchmove', blockTouch, { passive: false })
  }

  /** Touch: engage INSTANTLY on a horizontal drag — no long-press. The first
   *  move decides: sideways ⇒ scrub (the free axis; the doc line-wraps, so
   *  horizontal has no native meaning), vertical ⇒ hand the gesture back to
   *  native scrolling. A plain tap falls through to normal caret placement.
   *  This is the control-surface feel: touch a value, drag, hear it change —
   *  with none of the selection UI a press-and-hold used to trigger. */
  const armTouchScrub = (view: EditorView, e: PointerEvent): void => {
    hold?.cancel() // one armed gesture at a time — a second touch re-arms
    const { pointerId, clientX, clientY } = e
    const target = e.target
    // PRESS-HOLD PREVIEW: a stationary hold on a number enlarges its value
    // above the finger (the lens) - the teaching moment that says "this is
    // a control". Engaging keeps the lens; lifting or scrolling hides it.
    const holdTimer = setTimeout(() => {
      if (hold !== null && hold.cancel === cancel) {
        const lit = litAt(view, clientX, clientY)
        if (lit !== null) lens.show(clientX, clientY, view.state.doc.sliceString(lit.from, lit.to))
      }
    }, 260)
    // cancel closes over ITS OWN listeners, so a stale record can never
    // clear a newer one (multi-touch safety)
    const cancel = (): void => {
      clearTimeout(holdTimer)
      if (hold !== null && hold.cancel === cancel) hold = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cancel)
      window.removeEventListener('pointercancel', cancel)
      if (active === null) lens.hide() // an engaged scrub keeps it
    }
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      const dx = ev.clientX - clientX
      const dy = ev.clientY - clientY
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > TOUCH_ENGAGE_PX) { cancel(); return } // scrolling
      if (Math.abs(dx) < TOUCH_ENGAGE_PX) return // undecided — keep watching
      cancel()
      // RE-RESOLVE at engage time: the doc may have changed since the press
      // (debounced eval, another widget) — the pressed literal could be stale
      const fresh = litAt(view, clientX, clientY)
      if (fresh === null) return
      // engage with the original press point as the drag origin
      startScrub(view, fresh, { pointerId, clientX, clientY, target } as PointerEvent, true)
    }
    hold = { cancel }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cancel)
    window.addEventListener('pointercancel', cancel)
  }

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }

      update(u: ViewUpdate): void {
        // an EXTERNAL doc change mid-gesture invalidates the tracked
        // range — abort rather than rewrite the wrong text
        if (u.docChanged && active !== null && !selfDispatch) active.abort()
        if (u.docChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = this.build(u.view)
        }
      }

      private build(view: EditorView): DecorationSet {
        const doc = view.state.doc.toString()
        const tree = syntaxTree(view.state)
        let numbers = detect(doc, tree).numbers
        // rondo mode: same fallback as litAt — without it the numbers scrub
        // but carry no underline (and no touch-action) — the one teaching
        // signal on phones, and the CSS that keeps sideways drags ours.
        if (numbers.length === 0 && tree.type.name !== 'Script') numbers = scanNumbersText(doc)
        return Decoration.set(
          numbers.map((n) => scrubMark.range(n.from, n.to)),
          true,
        )
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        pointerdown(e: PointerEvent, view: EditorView): boolean {
          try {
            if (e.button !== 0 || active !== null) return false
            const lit = litAt(view, e.clientX, e.clientY)
            if (lit === null) return false
            if (e.altKey) {
              // desktop path: claim the gesture outright — no text selection
              e.preventDefault()
              startScrub(view, lit, e)
              return true
            }
            if (e.pointerType !== 'mouse') armTouchScrub(view, e) // touch/pen: instant sideways engage
            return false // let CM place the caret / start scrolling as usual
          } catch {
            return false // scrubbing must never break pointer handling
          }
        },
      },
    },
  )

  return plugin
}
