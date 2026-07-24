import './widgets.css'
import { StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { detect } from './detect'
import type { LiteralArg, WidgetDesc, WidgetKind } from './detect'
import { formatBoolean, formatNumber, literalChange, niceStep } from './rewrite'

/* ------------------------------------------------------------------------- *
 * Inline widget rendering: slider()/toggle()/pick()/xy() calls with literal
 * arguments render as interactive controls REPLACING the call text
 * (Decoration.replace with a WidgetType).
 *
 * THE TEXT IS THE SOURCE OF TRUTH. Widgets are views over the document:
 * every interaction is a normal editor transaction rewriting the literal
 * argument(s), so undo works, copy/paste reproduces the music exactly, and
 * eval semantics never depend on widget state (the scope placeholders in
 * session/scope.ts are identities). Widgets never cache document offsets
 * for interaction — each gesture re-resolves its call via posAtDOM +
 * a fresh detect(), so decorations and handlers survive unrelated edits.
 *
 * EDIT AFFORDANCE: reveal the underlying call text (the widget's range
 * joins a "revealed" state field that the decoration builder skips, and
 * the cursor moves into the call). The gesture depends on the widget's
 * primary interaction: slider/xy are DRAG-driven, so double-click/tap
 * reveals without conflict; toggle/pick are CLICK-driven — rapid taps
 * (cycling a pick!) would fire dblclick and pop the reveal + mobile
 * keyboard mid-performance — so for those a LONG-PRESS (500 ms, no
 * movement) reveals instead. When the cursor later leaves the range, the
 * reveal clears and the widget returns. Multi-line widget calls are never
 * decorated (view-plugin replace decorations must stay within a line) —
 * they simply stay text.
 *
 * INTERACTION → SOUND: drags rewrite the literal at most once per 30 ms
 * (trailing throttle, same cadence as scrub.ts) and ask the host for a
 * DEBOUNCED re-eval (250 ms trailing in editor.ts); toggle/pick rewrite
 * once and re-eval immediately. Re-eval is cheap and idempotent — Session
 * diffs staged synths/patterns, so unchanged synths are not redefined and
 * audio never glitches.
 *
 * PERF: detect() runs on every doc change. Docs here are <10 KB and the
 * tree is the editor's own incremental syntaxTree, so a rebuild is well
 * under a millisecond — no caching layer is warranted.
 * ------------------------------------------------------------------------- */

export interface WidgetHooks {
  /** Ask the host to re-eval the current doc. `immediate` for discrete
   *  changes (toggle/pick); false → debounced (drags). */
  requestEval(immediate: boolean): void
}

/* ------------------------------- reveal state --------------------------- */

interface Range {
  from: number
  to: number
}

const revealEffect = StateEffect.define<Range>({
  map: (v, m) => ({ from: m.mapPos(v.from), to: m.mapPos(v.to, 1) }),
})
const clearReveal = StateEffect.define<null>()

/** Ranges whose widget is temporarily suppressed so the text can be edited.
 *  Mapped through changes; cleared when the cursor leaves (listener below). */
const revealField = StateField.define<Range[]>({
  create: () => [],
  update(value, tr) {
    let out = value
    if (tr.docChanged) {
      out = out
        .map((r) => ({ from: tr.changes.mapPos(r.from), to: tr.changes.mapPos(r.to, 1) }))
        .filter((r) => r.to > r.from)
    }
    for (const e of tr.effects) {
      if (e.is(revealEffect)) out = [...out, e.value]
      else if (e.is(clearReveal)) out = []
    }
    return out
  },
})

/* ------------------------------ pure builders --------------------------- */

/** Widget descriptors that should actually render, given the doc text and
 *  the currently revealed ranges: single-line calls only, minus revealed.
 *  Pure — unit-tested headlessly. */
export function renderableWidgets(doc: string, widgets: WidgetDesc[], revealed: Range[]): WidgetDesc[] {
  return widgets
    .filter((w) => !doc.slice(w.from, w.to).includes('\n'))
    .filter((w) => !revealed.some((r) => r.from < w.to && r.to > w.from))
}

/* ------------------------------ dom helpers ----------------------------- */

type SyncEl = HTMLElement & { _wKind?: WidgetKind; _wSync?: (desc: WidgetDesc) => void }

/** Drag rewrite cadence — matches SCRUB_THROTTLE_MS in scrub.ts. */
const DRAG_THROTTLE_MS = 30
/** Still-press duration that reveals a click-driven widget's text. */
const REVEAL_HOLD_MS = 500
/** Finger travel that cancels a reveal long-press. */
const HOLD_SLOP_PX = 8

/** Trailing-edge throttle: at most one call per DRAG_THROTTLE_MS window,
 *  never dropping the final position. */
const throttled = <A extends unknown[]>(fn: (...args: A) => void): ((...args: A) => void) => {
  let last = 0
  let trailing: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(trailing)
    const wait = DRAG_THROTTLE_MS - (Date.now() - last)
    if (wait <= 0) {
      last = Date.now()
      fn(...args)
    } else {
      trailing = setTimeout(() => {
        last = Date.now()
        fn(...args)
      }, wait)
    }
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.className = className
  return node
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Re-resolve THIS widget's descriptor against the current doc — the only
 *  correct source of literal offsets once any edit has happened. */
const currentDesc = (view: EditorView, dom: HTMLElement, kind: WidgetKind): WidgetDesc | null => {
  try {
    const pos = view.posAtDOM(dom)
    const { widgets } = detect(view.state.doc.toString(), syntaxTree(view.state))
    return widgets.find((w) => w.from === pos && w.kind === kind) ?? null
  } catch {
    return null
  }
}

/** Long-press (500 ms, still) reveal for CLICK-driven widgets (toggle/
 *  pick): their natural gesture is rapid tapping, which fires dblclick —
 *  that must never yank the text open + pop the mobile keyboard. Register
 *  BEFORE the action click listener: the capture-order guarantee lets the
 *  post-reveal click be swallowed via stopImmediatePropagation. */
const addLongPressReveal = (view: EditorView, dom: SyncEl, kind: WidgetKind): void => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let suppressClick = false
  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const { clientX, clientY } = e
    clearTimeout(timer)
    timer = setTimeout(() => {
      suppressClick = true
      revealWidget(view, dom, kind)
    }, REVEAL_HOLD_MS)
    const cancel = (): void => {
      clearTimeout(timer)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cancel)
      window.removeEventListener('pointercancel', cancel)
    }
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return
      if (Math.hypot(ev.clientX - clientX, ev.clientY - clientY) > HOLD_SLOP_PX) cancel()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cancel)
    window.addEventListener('pointercancel', cancel)
  })
  dom.addEventListener('click', (e) => {
    if (!suppressClick) return
    suppressClick = false
    e.stopImmediatePropagation()
    e.preventDefault()
  })
}

const revealWidget = (view: EditorView, dom: HTMLElement, kind: WidgetKind): void => {
  const desc = currentDesc(view, dom, kind)
  if (desc === null) return
  view.dispatch({
    effects: revealEffect.of({ from: desc.from, to: desc.to }),
    selection: { anchor: desc.from },
  })
  view.focus()
}

/** Slider range/step: min/max from args 2/3, else a sane span around the
 *  value; step from arg 4, else a nice 1/2/5 step near (max−min)/200. */
const sliderParams = (
  desc: WidgetDesc,
): { value: number; min: number; max: number; step: number } => {
  const value = desc.args[0]!.value as number
  const min = (desc.args[1]?.value as number | undefined) ?? Math.min(0, value * 2)
  let max = (desc.args[2]?.value as number | undefined) ?? Math.max(1, value * 2)
  if (max <= min) max = min + 1
  const step = (desc.args[3]?.value as number | undefined) ?? niceStep((max - min) / 200)
  return { value, min, max, step }
}

const display = (arg: LiteralArg): string =>
  typeof arg.value === 'string' ? arg.value : arg.raw

/* -------------------------------- widgets ------------------------------- */

abstract class BaseWidget extends WidgetType {
  constructor(
    readonly desc: WidgetDesc,
    protected readonly hooks: WidgetHooks,
  ) {
    super()
  }

  /** Positions are re-resolved at interaction time, so equality is by kind
   *  + argument VALUES only — widgets shifted by unrelated edits keep
   *  their DOM (and any active pointer capture). */
  override eq(other: WidgetType): boolean {
    if (!(other instanceof BaseWidget) || other.desc.kind !== this.desc.kind) return false
    const a = this.desc.args
    const b = other.desc.args
    return a.length === b.length && a.every((arg, i) => arg.raw === b[i]!.raw)
  }

  /** Same-kind DOM is updated in place (value readouts etc.) instead of
   *  being rebuilt — REQUIRED so a mid-drag rewrite doesn't destroy the
   *  element holding the pointer capture. */
  override updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    const s = dom as SyncEl
    if (s._wKind !== this.desc.kind || s._wSync === undefined) return false
    s._wSync(this.desc)
    return true
  }

  override ignoreEvent(): boolean {
    return true // all pointer/click handling is the widget's own
  }
}

class SliderWidget extends BaseWidget {
  override toDOM(view: EditorView): HTMLElement {
    const wrap = el('span', 'cm-w cm-w-slider') as SyncEl
    const track = el('span', 'cm-w-track')
    const fill = el('span', 'cm-w-fill')
    const readout = el('span', 'cm-w-readout')
    track.append(fill)
    wrap.append(track, readout)

    const sync = (desc: WidgetDesc): void => {
      const { value, min, max, step } = sliderParams(desc)
      fill.style.width = `${clamp01((value - min) / (max - min)) * 100}%`
      readout.textContent = formatNumber(value, { step, min })
      // Pin the readout to the widest value in range so the widget's total
      // width never changes as the value updates. Without this, a value going
      // from e.g. 9500 -> 13000 grows the readout, and a slider near the right
      // edge wraps/unwraps across the soft-wrap boundary every frame (mobile
      // flicker). tabular-nums (CSS) keeps digits equal-width.
      const widest = Math.max(
        formatNumber(min, { step, min }).length,
        formatNumber(max, { step, min }).length,
        3,
      )
      readout.style.width = `${widest}ch`
    }
    wrap._wKind = 'slider'
    wrap._wSync = sync
    sync(this.desc)

    const applyDrag = (e: PointerEvent): void => {
      const desc = currentDesc(view, wrap, 'slider')
      if (desc === null) return
      const { min, max, step } = sliderParams(desc)
      const rect = track.getBoundingClientRect()
      const frac = clamp01((e.clientX - rect.left) / rect.width)
      const text = formatNumber(min + frac * (max - min), { step, min })
      if (text !== desc.args[0]!.raw) {
        view.dispatch({ changes: literalChange(desc.args[0]!, text) })
        this.hooks.requestEval(false)
      }
    }
    const drag = throttled(applyDrag)
    // Handlers live on WRAP: the inflated 44px ::before hitbox belongs to
    // wrap, so track-bound listeners would never see presses landing in
    // the inflated region. The frac math reads the track rect regardless.
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      // presses on the readout (right of the track) must not slam the
      // value to max — that zone is the dblclick-to-edit affordance
      if (e.clientX > track.getBoundingClientRect().right + HOLD_SLOP_PX) return
      e.preventDefault()
      wrap.setPointerCapture(e.pointerId)
      applyDrag(e) // jump-to-position immediately; moves are throttled
    })
    wrap.addEventListener('pointermove', (e) => {
      if (wrap.hasPointerCapture(e.pointerId)) drag(e)
    })
    wrap.addEventListener('dblclick', () => revealWidget(view, wrap, 'slider'))
    return wrap
  }
}

class ToggleWidget extends BaseWidget {
  override toDOM(view: EditorView): HTMLElement {
    const btnEl = el('button', 'cm-w cm-w-toggle')
    btnEl.type = 'button'
    const btn = btnEl as SyncEl
    const sync = (desc: WidgetDesc): void => {
      const on = desc.args[0]!.value === true
      btn.textContent = formatBoolean(on)
      btn.classList.toggle('on', on)
    }
    btn._wKind = 'toggle'
    btn._wSync = sync
    sync(this.desc)
    addLongPressReveal(view, btn, 'toggle') // before the action: may swallow the click
    btn.addEventListener('click', () => {
      const desc = currentDesc(view, btn, 'toggle')
      if (desc === null) return
      view.dispatch({
        changes: literalChange(desc.args[0]!, formatBoolean(desc.args[0]!.value !== true)),
      })
      this.hooks.requestEval(true)
    })
    return btn
  }
}

class PickWidget extends BaseWidget {
  override toDOM(view: EditorView): HTMLElement {
    const btnEl = el('button', 'cm-w cm-w-pick')
    btnEl.type = 'button'
    const btn = btnEl as SyncEl
    const sync = (desc: WidgetDesc): void => {
      btn.textContent = `${display(desc.args[0]!)} ↺`
    }
    btn._wKind = 'pick'
    btn._wSync = sync
    sync(this.desc)
    addLongPressReveal(view, btn, 'pick') // before the action: may swallow the click
    btn.addEventListener('click', () => {
      const desc = currentDesc(view, btn, 'pick')
      if (desc === null) return
      // cycle: the option AFTER the one matching the current value (raw
      // match first, falling back to cooked value), else the first option
      const options = desc.args.slice(1)
      const cur = desc.args[0]!
      let idx = options.findIndex((o) => o.raw === cur.raw)
      if (idx === -1) idx = options.findIndex((o) => o.value === cur.value)
      const next = options[(idx + 1) % options.length]!
      // re-inserting the option's raw source preserves its quote style
      view.dispatch({ changes: literalChange(cur, next.raw) })
      this.hooks.requestEval(true)
    })
    return btn
  }
}

/** xy(x, y): both axes span 0..1 (matching the placeholder's docs — there
 *  are no range arguments). The inline button expands into a 160×160
 *  floating pad while touched; the drag is RELATIVE (pad-widths of travel,
 *  not absolute finger position) so values never jump on touch-down. */
class XyWidget extends BaseWidget {
  override toDOM(view: EditorView): HTMLElement {
    const XY_STEP = 0.005
    const PAD = 160
    const btnEl = el('button', 'cm-w cm-w-xy')
    btnEl.type = 'button'
    const btn = btnEl as SyncEl
    const dot = el('span', 'cm-w-xy-dot')
    btn.append(dot)

    const place = (target: HTMLElement, desc: WidgetDesc): void => {
      const x = clamp01(desc.args[0]!.value as number)
      const y = clamp01(desc.args[1]!.value as number)
      target.style.left = `${x * 100}%`
      target.style.top = `${(1 - y) * 100}%`
    }
    let padDot: HTMLElement | null = null
    const sync = (desc: WidgetDesc): void => {
      place(dot, desc)
      if (padDot !== null) place(padDot, desc)
    }
    btn._wKind = 'xy'
    btn._wSync = sync
    sync(this.desc)

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      const start = currentDesc(view, btn, 'xy')
      if (start === null) return
      e.preventDefault()
      btn.setPointerCapture(e.pointerId)

      // floating pad, near the button, clamped to the viewport
      const pad = el('div', 'cm-w-xy-pad')
      pad.style.width = `${PAD}px`
      pad.style.height = `${PAD}px`
      const r = btn.getBoundingClientRect()
      const left = Math.min(Math.max(r.left + r.width / 2 - PAD / 2, 8), window.innerWidth - PAD - 8)
      const top = r.top - PAD - 12 >= 8 ? r.top - PAD - 12 : Math.min(r.bottom + 12, window.innerHeight - PAD - 8)
      pad.style.left = `${left}px`
      pad.style.top = `${top}px`
      padDot = el('span', 'cm-w-xy-dot')
      pad.append(padDot)
      place(padDot, start)
      document.body.append(pad)

      const x0 = e.clientX
      const y0 = e.clientY
      const v0x = clamp01(start.args[0]!.value as number)
      const v0y = clamp01(start.args[1]!.value as number)

      const move = throttled((ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        const desc = currentDesc(view, btn, 'xy')
        if (desc === null) return
        const nx = clamp01(v0x + (ev.clientX - x0) / PAD)
        const ny = clamp01(v0y - (ev.clientY - y0) / PAD)
        const tx = formatNumber(nx, { step: XY_STEP })
        const ty = formatNumber(ny, { step: XY_STEP })
        if (tx === desc.args[0]!.raw && ty === desc.args[1]!.raw) return
        view.dispatch({
          changes: [literalChange(desc.args[0]!, tx), literalChange(desc.args[1]!, ty)],
        })
        this.hooks.requestEval(false)
      })
      const up = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        btn.removeEventListener('pointermove', move)
        btn.removeEventListener('pointerup', up)
        btn.removeEventListener('pointercancel', up)
        pad.remove()
        padDot = null
        // no requestEval here: every actual change already scheduled one —
        // an unmoved press must not eval unrelated un-run edits
      }
      btn.addEventListener('pointermove', move)
      btn.addEventListener('pointerup', up)
      btn.addEventListener('pointercancel', up)
    })
    btn.addEventListener('dblclick', () => revealWidget(view, btn, 'xy'))
    return btn
  }
}

const makeWidget = (desc: WidgetDesc, hooks: WidgetHooks): BaseWidget => {
  switch (desc.kind) {
    case 'slider':
      return new SliderWidget(desc, hooks)
    case 'toggle':
      return new ToggleWidget(desc, hooks)
    case 'pick':
      return new PickWidget(desc, hooks)
    case 'xy':
      return new XyWidget(desc, hooks)
  }
}

/* ------------------------------- extension ------------------------------ */

export function widgetExtension(hooks: WidgetHooks): Extension {
  const build = (view: EditorView): DecorationSet => {
    const doc = view.state.doc.toString()
    const { widgets } = detect(doc, syntaxTree(view.state))
    const render = renderableWidgets(doc, widgets, view.state.field(revealField))
    return Decoration.set(
      render.map((w) => Decoration.replace({ widget: makeWidget(w, hooks) }).range(w.from, w.to)),
      true,
    )
  }

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = build(view)
      }

      update(u: ViewUpdate): void {
        if (
          u.docChanged ||
          syntaxTree(u.state) !== syntaxTree(u.startState) ||
          u.state.field(revealField) !== u.startState.field(revealField)
        ) {
          this.decorations = build(u.view)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  // Reveal auto-clear: once the cursor leaves every revealed range, the
  // widget comes back. Dispatching from inside an update is illegal, so
  // the clear is queued as a macrotask.
  const revealWatcher = EditorView.updateListener.of((u) => {
    if (!u.selectionSet) return
    const revealed = u.state.field(revealField)
    if (revealed.length === 0) return
    const head = u.state.selection.main.head
    if (revealed.some((r) => head >= r.from && head <= r.to)) return
    setTimeout(() => {
      try {
        if (u.view.state.field(revealField).length > 0) {
          u.view.dispatch({ effects: clearReveal.of(null) })
        }
      } catch {
        // view already destroyed
      }
    }, 0)
  })

  return [revealField, plugin, revealWatcher]
}
