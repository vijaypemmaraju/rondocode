/* ------------------------------------------------------------------------- *
 * The first-run tour's brain: a tiny pure step machine, fully node-testable.
 * Each step names an anchor (the DOM layer resolves it), carries the coach
 * copy, and advances on a REAL action event, never a Next button:
 *
 *   play   → 'played'    (the transport actually started)
 *   widget → 'edited'    (a widget drag rewrites the doc; typing counts too)
 *   chips  → 'edited'    (a chip tap inserts code)
 *   docs   → 'dismissed' (the only tap-to-close step, at the end)
 *
 * The chips step is entered BY an edit, often mid-knob-drag, and a drag emits
 * a continuous stream of doc changes that would blow straight through it. So
 * an 'edited' advance can require a quiet gap (editGapMs) since the previous
 * edit: the drag stream keeps resetting the clock, and only a fresh gesture
 * after a pause counts. Time is injected (now) so tests control it.
 *
 * Finishing OR skipping writes the done flag; the tour never auto-shows again
 * (shouldShowTour). The options panel can clear the flag and restart it.
 * ------------------------------------------------------------------------- */

export type TourEvent = 'played' | 'edited' | 'dismissed'
export type TourStepId = 'play' | 'widget' | 'chips' | 'docs'

export interface TourStep {
  id: TourStepId
  copy: string
  advance: TourEvent
  /** For 'edited' advances: the minimum quiet time since the last edit (or
   *  since entering the step) before an edit counts. Undefined = first edit
   *  advances immediately. */
  editGapMs?: number
}

/** Which scrubbable number the drag step should point at, given their texts in
 *  document order (returns an index, or -1 when there are none).
 *
 *  The first number in a track is usually an envelope time — the JS welcome
 *  track's is `0.01`, the attack — and dragging that is very nearly inaudible,
 *  which is a poor thing to ask someone to do in the one step that has to prove
 *  "the code is the instrument". Prefer the first number big enough to be a
 *  frequency or a cutoff (>= 100), where a drag is unmistakable. */
export function bestScrubIndex(values: readonly string[]): number {
  const big = values.findIndex((v) => {
    const n = Math.abs(Number.parseFloat(v))
    return Number.isFinite(n) && n >= 100
  })
  return big !== -1 ? big : values.length > 0 ? 0 : -1
}

/** localStorage key set once the tour is finished or skipped. */
export const TOUR_DONE_KEY = 'rc.tourDone'

/** The gap that separates "still the same drag" from "a new gesture". */
export const EDIT_GAP_MS = 800

/** The storage seam (localStorage-shaped); tests inject a stub. */
export interface TourStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** What the drag step can actually point at, which differs by language AND
 *  by input device:
 *    'knob'        rondo renders a knob widget for `knob …` — grab and drag it.
 *    'number-touch' no widget, but touch scrubs a number the moment you slide.
 *    'number-mouse' no widget, and a mouse must hold ALT to scrub (scrub.ts) —
 *                   plain dragging selects text, so saying "drag" is a lie.
 *  JavaScript mode only renders widgets for explicit slider()/toggle()/pick()/
 *  xy() calls, and the welcome track has none, so a JS user gets a number. */
export type DragTarget = 'knob' | 'number-touch' | 'number-mouse'

const DRAG_COPY: Record<DragTarget, string> = {
  knob: 'Drag this knob while it plays. The code follows your finger.',
  'number-touch': 'Drag this number sideways while it plays. The code follows your finger.',
  'number-mouse': 'Alt-drag this number while it plays. The code follows your cursor.',
}

/** The ordered steps. `chips` = the rondo tap palette is on screen (rondo
 *  mode); without it the chips step is dropped, not shown pointing at air.
 *  `drag` picks the wording for step 2 the same way — a user who was told to
 *  "drag this control" in JavaScript mode on a desktop was pointed at an
 *  envelope number that does nothing without Alt (reported). */
export function tourSteps(opts: { chips: boolean; drag?: DragTarget }): TourStep[] {
  const steps: TourStep[] = [
    {
      id: 'play',
      copy: 'This code is already a track. Press run to hear it.',
      advance: 'played',
    },
    {
      id: 'widget',
      copy: DRAG_COPY[opts.drag ?? 'knob'],
      advance: 'edited',
    },
  ]
  if (opts.chips) {
    steps.push({
      id: 'chips',
      copy: 'These chips write code for you. Tap a note and it plays as it lands.',
      advance: 'edited',
      editGapMs: EDIT_GAP_MS,
    })
  }
  steps.push({
    id: 'docs',
    copy: 'The whole language lives in docs. Have fun.',
    advance: 'dismissed',
  })
  return steps
}

/** Should onboarding auto-show on this visit? Only when it has never been
 *  finished or skipped, and the visit is not opening a share link. There is
 *  no pristine-buffer condition anymore: the flow creates its own dedicated
 *  welcome project, so it never narrates (or clobbers) the user's own work,
 *  and any first-time visitor gets it even after editing first. */
export function shouldShowTour(args: {
  storage: TourStorage
  /** The share payload from location.hash (session/share.readShareHash). */
  shareHash: string | null
}): boolean {
  let flag: string | null
  try {
    flag = args.storage.getItem(TOUR_DONE_KEY)
  } catch {
    // No readable storage means no way to remember a dismissal; showing the
    // tour on EVERY visit would be worse than never showing it.
    return false
  }
  if (flag !== null) return false
  return args.shareHash === null
}

export interface TourMachine {
  /** The current step, or null when idle/finished. */
  step(): TourStep | null
  /** 0-based index of the current step (-1 when idle/finished). */
  stepIndex(): number
  /** Total number of steps (for "1 of 4" progress copy). */
  count(): number
  /** (Re)start from the first step. */
  start(): void
  /** Feed a real action event; advances only when the current step wants it. */
  handle(ev: TourEvent): void
  /** Bail out from any step: marks the tour done and deactivates. */
  skip(): void
  /** True once finished or skipped (the done flag was written). */
  done(): boolean
  /** Fires with the new step on every change, null on finish/skip. */
  onChange(fn: (step: TourStep | null) => void): () => void
}

export function createTourMachine(opts: {
  chips: boolean
  drag?: DragTarget
  storage: TourStorage
  now?: () => number
}): TourMachine {
  const steps = tourSteps({ chips: opts.chips, ...(opts.drag !== undefined ? { drag: opts.drag } : {}) })
  const now = opts.now ?? Date.now
  let index = -1
  let isDone = false
  let lastEditAt = 0
  const listeners = new Set<(step: TourStep | null) => void>()

  const emit = (): void => {
    const cur = index >= 0 && index < steps.length ? steps[index]! : null
    for (const fn of listeners) {
      try {
        fn(cur)
      } catch (e) {
        console.warn('[tour] listener failed', e)
      }
    }
  }

  const writeDone = (): void => {
    isDone = true
    try {
      opts.storage.setItem(TOUR_DONE_KEY, '1')
    } catch {
      // storage full / private mode: the tour just may show again next visit
    }
  }

  const finish = (): void => {
    writeDone()
    index = -1
    emit()
  }

  return {
    step: () => (index >= 0 && index < steps.length ? steps[index]! : null),
    stepIndex: () => index,
    count: () => steps.length,
    start: () => {
      index = 0
      isDone = false
      lastEditAt = now()
      emit()
    },
    handle: (ev) => {
      const cur = index >= 0 && index < steps.length ? steps[index] : undefined
      if (cur === undefined) return
      if (ev !== cur.advance) return
      if (ev === 'edited' && cur.editGapMs !== undefined) {
        const t = now()
        const gap = t - lastEditAt
        lastEditAt = t
        if (gap < cur.editGapMs) return // still the same drag stream
      }
      index += 1
      if (index >= steps.length) {
        finish()
        return
      }
      lastEditAt = now() // quiet clock restarts at step entry
      emit()
    },
    skip: () => {
      if (index < 0) return
      index = -1
      writeDone()
      emit()
    },
    done: () => isDone,
    onChange: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
