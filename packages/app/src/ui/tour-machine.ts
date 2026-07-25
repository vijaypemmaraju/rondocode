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

/** localStorage key set once the tour is finished or skipped. */
export const TOUR_DONE_KEY = 'rc.tourDone'

/** The gap that separates "still the same drag" from "a new gesture". */
export const EDIT_GAP_MS = 800

/** The storage seam (localStorage-shaped); tests inject a stub. */
export interface TourStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The ordered steps. `chips` = the rondo tap palette is on screen (rondo
 *  mode); without it the chips step is dropped, not shown pointing at air. */
export function tourSteps(opts: { chips: boolean }): TourStep[] {
  const steps: TourStep[] = [
    {
      id: 'play',
      copy: 'This code is already a track. Press run to hear it.',
      advance: 'played',
    },
    {
      id: 'widget',
      copy: 'Drag this control while it plays. The code follows your finger.',
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

/** Should the tour auto-show on this visit? Only when it has never been
 *  finished or skipped, the visit is not opening a share link, and the buffer
 *  is still a pristine starter example (an existing user's own work must not
 *  get a walkthrough dropped on top of it). */
export function shouldShowTour(args: {
  storage: TourStorage
  /** The share payload from location.hash (session/share.readShareHash). */
  shareHash: string | null
  /** The editor buffer at mount time. */
  doc: string
  /** Every starter-doc variant (both languages); undefined entries are fine. */
  starterDocs: readonly (string | undefined)[]
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
  if (args.shareHash !== null) return false
  return args.starterDocs.some((s) => s !== undefined && s === args.doc)
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
  storage: TourStorage
  now?: () => number
}): TourMachine {
  const steps = tourSteps({ chips: opts.chips })
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
