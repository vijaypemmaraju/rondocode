/* The widget GESTURE PROTOCOL, in one place.
 *
 * Every inline widget that rewrites the document obeys the same correctness
 * rules, learned one live bug at a time:
 *
 *  1. SINGLE-FLIGHT — one widget gesture at a time, across ALL widgets. A
 *     second touch (same widget or another) would capture source ranges the
 *     first gesture is about to shift, and the interleaved rewrites splice
 *     garbage into the code.
 *  2. POINTER-ID FILTERING — window-level move/end handlers receive EVERY
 *     pointer's events; only the pointer that started the gesture may drive
 *     or end it.
 *  3. WRITE-VERIFY — before any rewrite, the text under the target range must
 *     be exactly what the gesture last wrote (or first read). Any concurrent
 *     edit (scrub, live typing, another gesture that slipped through) aborts
 *     the remaining writes instead of splicing blind.
 *  4. LIFECYCLE — `drag.active` spans exactly the gesture (the decoration
 *     plugin suppresses rebuilds while it is set and maps ranges instead);
 *     listeners always detach; a gesture that changed the doc sets
 *     `drag.ended` so the next update rebuilds ONCE with fresh ranges.
 *
 * attachGesture() owns 1, 2, and 4's plumbing. LiveWriter / verifiedChanges
 * own 3 for the two write shapes (live per-move rewrites, and deferred
 * commit-at-end splices). Widgets keep only their own geometry + semantics. */

/** Shared drag state (one per editor): `active` suppresses decoration
 *  rebuilds mid-gesture (the dragged DOM and its pointer capture survive);
 *  `ended` forces ONE rebuild on the next update after a gesture. */
export interface Drag {
  active: boolean
  ended: boolean
}

export interface GestureHandlers {
  /** per-move, already filtered to the starting pointer. */
  onMove?: (e: PointerEvent) => void
  /** exactly once, on pointerup OR pointercancel (filtered too). Runs after
   *  drag.active is cleared, so its dispatches rebuild via drag.ended. */
  onEnd?: (e: PointerEvent) => void
}

/** Attach the gesture protocol to an element. `begin` runs on an accepted
 *  pointerdown and returns the gesture's handlers, or null to reject (e.g.
 *  the pointer wasn't on a cell). `target` is where move/end listen:
 *  'window' for drags that leave the element (knob, envelope), 'element'
 *  for capture-bound surfaces (grids). */
export function attachGesture(
  el: HTMLElement,
  drag: Drag,
  target: 'window' | 'element',
  begin: (e: PointerEvent) => GestureHandlers | null,
): void {
  el.addEventListener('pointerdown', (e) => {
    if (drag.active) return // single-flight, across every widget
    const h = begin(e)
    if (h === null) return
    e.preventDefault()
    e.stopPropagation()
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // capture is best-effort; the listeners below carry the drag regardless
    }
    drag.active = true
    const tgt: EventTarget = target === 'window' ? window : el
    const pid = e.pointerId
    const move = (ev: Event): void => {
      const pe = ev as PointerEvent
      if (pe.pointerId !== pid) return
      h.onMove?.(pe)
    }
    const end = (ev: Event): void => {
      const pe = ev as PointerEvent
      if (pe.pointerId !== pid) return
      tgt.removeEventListener('pointermove', move)
      tgt.removeEventListener('pointerup', end)
      tgt.removeEventListener('pointercancel', end)
      drag.active = false
      h.onEnd?.(pe)
    }
    tgt.addEventListener('pointermove', move)
    tgt.addEventListener('pointerup', end)
    tgt.addEventListener('pointercancel', end)
  })
}

/** The slice of EditorView the writers need — injectable for tests. */
export interface WriteHost {
  state: { doc: { sliceString(from: number, to: number): string } }
  dispatch(spec: {
    changes: { from: number; to: number; insert: string } | { from: number; to: number; insert: string }[]
  }): void
}

/** Serial LIVE rewrites of one range across a gesture, with write-verify:
 *  each write replaces [from, to) only if the current text there is exactly
 *  what this writer last wrote (seeded from the doc at construction). The
 *  first mismatch — any concurrent edit — permanently aborts this writer, so
 *  a compromised gesture goes quiet instead of splicing garbage. */
export class LiveWriter {
  private toPos: number
  private expected: string
  private aborted = false

  constructor(
    private readonly view: WriteHost,
    readonly from: number,
    to: number,
  ) {
    this.toPos = to
    this.expected = view.state.doc.sliceString(from, to)
  }

  /** current END of the range (tracks the last written text's length). */
  get to(): number {
    return this.toPos
  }

  /** the text this writer believes sits at [from, to) right now. */
  get text(): string {
    return this.expected
  }

  write(text: string): boolean {
    if (this.aborted) return false
    if (this.view.state.doc.sliceString(this.from, this.toPos) !== this.expected) {
      this.aborted = true
      return false
    }
    if (text !== this.expected) {
      this.view.dispatch({ changes: { from: this.from, to: this.toPos, insert: text } })
      this.toPos = this.from + text.length
      this.expected = text
    }
    return true
  }
}

/** One-shot verified splice(s) for deferred commit-at-end writes: dispatch
 *  only when EVERY range still holds its expected text — a single stale
 *  range drops the WHOLE write (the caller resyncs from the text instead).
 *  Ranges must be non-overlapping; positions are all pre-write coordinates. */
export function verifiedChanges(
  view: WriteHost,
  changes: { from: number; to: number; expected: string; insert: string }[],
): boolean {
  for (const c of changes) {
    if (view.state.doc.sliceString(c.from, c.to) !== c.expected) return false
  }
  if (changes.length === 0) return true
  view.dispatch({ changes: changes.map(({ from, to, insert }) => ({ from, to, insert })) })
  return true
}
