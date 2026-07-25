import type { EditorHandle } from '../editor/editor'
import { EXAMPLES } from '../examples'
import { readShareHash } from '../session/share'
import { anchorPopover } from './viewport'
import { createTourMachine, shouldShowTour, TOUR_DONE_KEY } from './tour-machine'
import type { TourMachine, TourStep, TourStepId, TourStorage } from './tour-machine'

/* ------------------------------------------------------------------------- *
 * The first-run tour's thin DOM layer. One small bubble at a time, anchored
 * near its target with a soft highlight ring on the anchor itself. There is
 * NO overlay: every step asks the user to actually DO something (press run,
 * drag a control, tap a chip), so nothing may sit between finger and app.
 * All sequencing lives in the pure machine (tour-machine.ts); this file only
 * resolves anchors, positions the bubble, and forwards real events.
 * ------------------------------------------------------------------------- */

export interface TourHandle {
  /** Restart the tour from the top (options panel: "show intro tour"). */
  start(): void
  dispose(): void
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** localStorage behind the machine's storage seam, throw-safe. */
const safeStorage: TourStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
}

const visible = (e: Element | null): e is HTMLElement =>
  e instanceof HTMLElement && e.getClientRects().length > 0

/** Resolve each step's anchor at show time (header buttons migrate into the
 *  "…" overflow menu on narrow screens, widgets re-render on every edit). */
const anchorFor = (id: TourStepId): HTMLElement | null => {
  const q = (sel: string): HTMLElement | null => {
    const e = document.querySelector(sel)
    return visible(e) ? e : null
  }
  switch (id) {
    case 'play':
      return q('.topbar .btn.run')
    case 'widget':
      // a live dial when the doc has one, else any drag-to-scrub number
      return q('.rondo-knob') ?? q('.cm-scrub') ?? q('.cm-content')
    case 'chips':
      return q('.rondo-palette')
    case 'docs':
      // on phones the docs button lives inside the "…" menu; point at that
      return q('.docs-btn') ?? q('.more-btn')
  }
}

export function mountTour(editor: EditorHandle): TourHandle {
  // ---- bubble DOM (one instance, retargeted per step) ----
  const pop = el('div', 'tour-bubble hidden')
  const copy = el('div', 'tour-copy')
  const actions = el('div', 'tour-actions')
  const progress = el('span', 'tour-progress')
  const skipBtn = el('button', 'tour-btn tour-skip', 'skip tour')
  skipBtn.type = 'button'
  const doneBtn = el('button', 'tour-btn tour-done', 'done')
  doneBtn.type = 'button'
  actions.append(progress, skipBtn, doneBtn)
  pop.append(copy, actions)
  document.body.append(pop)

  let machine: TourMachine | null = null
  let ringed: HTMLElement | null = null
  let current: TourStep | null = null

  const clearRing = (): void => {
    ringed?.classList.remove('tour-ring')
    ringed = null
  }

  const position = (): void => {
    if (current === null) return
    const anchor = anchorFor(current.id)
    // re-ring on every position pass: an edit can re-render the widget span
    if (anchor !== ringed) {
      clearRing()
      if (anchor !== null) {
        anchor.classList.add('tour-ring')
        ringed = anchor
      }
    }
    if (anchor !== null) {
      pop.classList.remove('tour-floating')
      anchorPopover(pop, anchor)
    } else {
      // no resolvable anchor: park the bubble thumb-reachable, bottom right
      // (clear anchorPopover's inline coords so the class's bottom/right win)
      pop.classList.add('tour-floating')
      pop.style.top = ''
      pop.style.right = ''
      pop.style.left = ''
    }
  }

  const render = (step: TourStep | null): void => {
    current = step
    if (step === null || machine === null) {
      clearRing()
      pop.classList.add('hidden')
      return
    }
    const last = step.advance === 'dismissed'
    copy.textContent = step.copy
    progress.textContent = `${machine.stepIndex() + 1} of ${machine.count()}`
    skipBtn.classList.toggle('hidden', last)
    doneBtn.classList.toggle('hidden', !last)
    pop.classList.remove('hidden') // visible first so anchorPopover can measure
    position()
  }

  // ---- real-action events → the machine ----
  let wasPlaying = editor.session.getState().playing
  const offState = editor.onState((s) => {
    const started = s.playing && !wasPlaying
    wasPlaying = s.playing
    if (started) machine?.handle('played')
    // play/stop swaps header buttons around; keep the bubble attached
    if (current !== null) requestAnimationFrame(position)
  })
  const offDoc = editor.onDoc(() => machine?.handle('edited'))

  skipBtn.addEventListener('click', () => machine?.skip())
  // the last bubble dismisses on a tap anywhere on it
  pop.addEventListener('click', () => {
    if (current?.advance === 'dismissed') machine?.handle('dismissed')
  })

  const onResize = (): void => {
    if (current !== null) position()
  }
  window.addEventListener('resize', onResize)
  window.visualViewport?.addEventListener('resize', onResize)

  /** Build a fresh machine (chips depends on the CURRENT language) and show
   *  the first step. */
  const begin = (): void => {
    machine = createTourMachine({
      chips: editor.getLang() === 'rondo',
      storage: safeStorage,
    })
    machine.onChange(render)
    machine.start()
  }

  // ---- first-run auto-start ----
  const starter = EXAMPLES[0]
  let auto = false
  try {
    auto = shouldShowTour({
      storage: safeStorage,
      shareHash: readShareHash(location.hash),
      doc: editor.getDoc(),
      starterDocs: [starter?.code, starter?.rondo],
    })
  } catch {
    auto = false // never let the tour break boot
  }
  // wait a frame so the header/palette have laid out before measuring
  if (auto) requestAnimationFrame(() => begin())

  return {
    start: () => {
      try {
        localStorage.removeItem(TOUR_DONE_KEY)
      } catch {
        // storage failures only affect remembering, not this run
      }
      begin()
    },
    dispose: () => {
      offState()
      offDoc()
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      clearRing()
      pop.remove()
      machine = null
      current = null
    },
  }
}
