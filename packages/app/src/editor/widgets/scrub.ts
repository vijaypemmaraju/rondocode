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
 * - Touch: long-press (350 ms) then drag. We must NOT preventDefault on
 *   touchstart — that would kill scrolling and caret placement for every
 *   tap that happens to land on a number — so the browser's own long-press
 *   behaviors (iOS text loupe) race us. Tradeoff accepted: we fire at
 *   350 ms (before the ~500 ms native loupe), suppress user-select while
 *   scrubbing, and block scroll only once the hold has fired (a
 *   passive:false touchmove blocker installed for the drag's duration).
 *   Moving >8 px before the hold fires cancels it, so scrolling that
 *   starts on a number still scrolls.
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
 * at long-press fire time and on each pointerdown, so stale literals
 * cannot leak between gestures.
 * ------------------------------------------------------------------------- */

export const SCRUB_MIN_STEP = 0.01
export const SCRUB_HOLD_MS = 350
export const SCRUB_THROTTLE_MS = 30
/** Finger travel that cancels an armed (not yet fired) long-press. */
const HOLD_SLOP_PX = 8

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

export function scrubExtension(hooks: { requestEval: (immediate: boolean) => void }): Extension {
  /** The literal under the pointer, from a FRESH detect (cheap: <10 KB docs). */
  const litAt = (view: EditorView, x: number, y: number): ScrubLit | null => {
    const pos = view.posAtCoords({ x, y })
    if (pos === null) return null
    const doc = view.state.doc.toString()
    let numbers = detect(doc, syntaxTree(view.state)).numbers
    // The tree walk is JS-grammar-specific; in rondo mode (a StreamLanguage
    // tree) it finds nothing, so fall back to a plain-text scan — every number
    // stays scrubbable regardless of the active language.
    if (numbers.length === 0) numbers = scanNumbersText(doc)
    return numbers.find((n) => pos >= n.from && pos <= n.to) ?? null
  }

  let active: ActiveScrub | null = null
  let hold: { timer: ReturnType<typeof setTimeout>; cancel: () => void } | null = null
  /** True while OUR dispatch is in flight — distinguishes our own doc
   *  changes from external ones in the plugin's update hook. */
  let selfDispatch = false

  const blockTouch = (e: TouchEvent): void => e.preventDefault()

  const startScrub = (view: EditorView, lit: ScrubLit, e: PointerEvent): void => {
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
    const apply = (dx: number): void => {
      const a = active
      if (a === null) return
      a.lastApply = Date.now()
      const text = scrubText(a.v0, dx, a.isInt)
      if (text === a.lastText) return
      a.lastText = text
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

  /** `_lit` gated the arming (we know the press is on a number) but the
   *  literal itself is re-resolved when the hold fires — see the timer. */
  const armLongPress = (view: EditorView, _lit: ScrubLit, e: PointerEvent): void => {
    hold?.cancel() // one armed hold at a time — a second touch re-arms
    const { pointerId, clientX, clientY } = e
    const target = e.target
    // cancel closes over ITS OWN timer/listeners, so a stale hold record
    // can never clear a newer one (multi-touch safety)
    const cancel = (): void => {
      clearTimeout(timer)
      if (hold !== null && hold.cancel === cancel) hold = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cancel)
      window.removeEventListener('pointercancel', cancel)
    }
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      if (Math.hypot(ev.clientX - clientX, ev.clientY - clientY) > HOLD_SLOP_PX) cancel()
    }
    const timer = setTimeout(() => {
      cancel()
      // RE-RESOLVE at fire time: the doc may have changed during the hold
      // (debounced eval, another widget) — the armed literal could be stale
      const fresh = litAt(view, clientX, clientY)
      if (fresh === null) return
      // re-fire with the original press point as the drag origin
      startScrub(view, fresh, {
        pointerId,
        clientX,
        clientY,
        target,
      } as PointerEvent)
    }, SCRUB_HOLD_MS)
    hold = { timer, cancel }
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
        const { numbers } = detect(view.state.doc.toString(), syntaxTree(view.state))
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
            if (e.pointerType === 'touch') armLongPress(view, lit, e)
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
