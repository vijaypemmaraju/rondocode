import type { EditorHandle, EditorLang } from '../editor/editor'
import type { LibraryHandle } from '../editor/library'
import { readShareHash } from '../session/share'
import { anchorPopover } from './viewport'
import { bestScrubIndex, createTourMachine, shouldShowTour, TOUR_DONE_KEY } from './tour-machine'
import type { DragTarget, TourMachine, TourStep, TourStepId, TourStorage } from './tour-machine'
import {
  SURVEY_OPTIONS,
  SURVEY_SKIP_LABEL,
  SURVEY_TITLE,
  WELCOME_PROJECT_NAME,
  surveyLang,
  welcomeCode,
  writeLangPref,
} from './onboarding'
import type { SurveyChoice } from './onboarding'

/* ------------------------------------------------------------------------- *
 * Onboarding v2, the thin DOM layer. The flow (pure halves in onboarding.ts
 * and tour-machine.ts):
 *
 *   1. survey: one centered card, one question; the answer sets the default
 *      language (rc.langPref) - skip keeps the per-device default.
 *   2. welcome project: a dedicated project (library's own "new" path, the
 *      current project is kept) seeded with the welcome track in the chosen
 *      language, so every coach-mark anchor exists by construction.
 *   3. coach marks: one small bubble at a time, anchored near its target with
 *      a soft highlight ring. There is NO overlay on this part: every step
 *      asks the user to actually DO something (press run, drag a control,
 *      tap a chip), so nothing may sit between finger and app.
 *
 * Replay (options panel) re-runs the WHOLE flow: survey again, then reopen
 * the saved welcome project (or recreate it) - never whatever doc happens to
 * be loaded, which is what broke v1 replays from other projects.
 * ------------------------------------------------------------------------- */

export interface TourHandle {
  /** Re-run the whole flow: survey, welcome project, coach marks. */
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
      // The two languages render DIFFERENT widget layers: rondo draws
      // .rondo-knob for the welcome track's `knob …`, while JavaScript only
      // makes widgets (.cm-w) for explicit slider()/toggle()/pick()/xy()
      // calls — which the welcome track has none of. So in JS this lands on a
      // scrubbable number (.cm-scrub), and the copy says so. Ringing
      // .cm-content, the old last resort, highlighted the whole editor and
      // pointed "drag this control" at nothing in particular (reported).
      return q('.rondo-knob') ?? q('.cm-w') ?? bestScrub() ?? q('.cm-content')
    case 'chips':
      return q('.rondo-palette')
    case 'docs':
      // on phones the docs button lives inside the "…" menu; point at that
      return q('.docs-btn') ?? q('.more-btn')
  }
}

/** The scrubbable number worth demonstrating (see bestScrubIndex): the first
 *  one is typically an envelope time, where a drag is inaudible. */
const bestScrub = (): HTMLElement | null => {
  const marks = Array.from(document.querySelectorAll('.cm-scrub')).filter(visible)
  const i = bestScrubIndex(marks.map((m) => m.textContent ?? ''))
  return i === -1 ? null : marks[i]!
}

/** Which drag affordance step 2 is about to point at. Asked at flow start,
 *  once the welcome track is loaded, so it reflects what is really on screen:
 *  a knob widget if one rendered, otherwise a number — and a number needs ALT
 *  on a mouse but not on touch (see widgets/scrub.ts). */
const dragTarget = (): DragTarget => {
  if (visible(document.querySelector('.rondo-knob')) || visible(document.querySelector('.cm-w'))) return 'knob'
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  return coarse ? 'number-touch' : 'number-mouse'
}

export function mountTour(
  editor: EditorHandle,
  opts: { library: Promise<LibraryHandle> },
): TourHandle {
  // ---- survey DOM (one instance, shown at the top of every flow run) ----
  const surveyBackdrop = el('div', 'tour-survey-backdrop hidden')
  const survey = el('div', 'tour-survey')
  survey.setAttribute('role', 'dialog')
  survey.setAttribute('aria-modal', 'true')
  survey.setAttribute('aria-label', SURVEY_TITLE)
  survey.append(el('h2', 'tour-survey-title', SURVEY_TITLE))
  const optionBtns: HTMLButtonElement[] = []
  for (const { choice, label } of SURVEY_OPTIONS) {
    const b = el('button', 'tour-survey-opt', label)
    b.type = 'button'
    b.addEventListener('click', () => onSurveyAnswer(choice))
    optionBtns.push(b)
    survey.append(b)
  }
  const surveySkip = el('button', 'tour-survey-skip', SURVEY_SKIP_LABEL)
  surveySkip.type = 'button'
  surveySkip.addEventListener('click', () => onSurveyAnswer(null))
  survey.append(surveySkip)
  surveyBackdrop.append(survey)
  document.body.append(surveyBackdrop)

  const showSurvey = (): void => {
    surveyBackdrop.classList.remove('hidden')
    optionBtns[0]?.focus()
  }
  const hideSurvey = (): void => surveyBackdrop.classList.add('hidden')

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
      drag: dragTarget(),
      storage: safeStorage,
    })
    machine.onChange(render)
    machine.start()
  }

  /** Survey answered (or skipped, choice=null): set the language preference,
   *  open the welcome project, then run the coach marks against it. */
  const onSurveyAnswer = (choice: SurveyChoice | null): void => {
    hideSurvey()
    // Skip keeps the per-device default: rondo on mobile, the editor's
    // current language on desktop - exactly what editor.getLang() holds.
    let lang: EditorLang = editor.getLang()
    if (choice !== null) {
      lang = surveyLang(choice)
      writeLangPref(lang, safeStorage)
    }
    void (async (): Promise<void> => {
      try {
        const lib = await opts.library
        // Reopen the saved welcome project when it still exists (replay);
        // otherwise create it - the library's own "new project" path, so the
        // user's current project is saved and kept, never clobbered.
        const reopened = await lib.openByName(WELCOME_PROJECT_NAME)
        if (!reopened) {
          await lib.createAndOpen(WELCOME_PROJECT_NAME, welcomeCode(lang), lang)
        } else if (editor.getLang() !== lang) {
          // the survey answer CHANGED since this welcome was made (user
          // report: "I write JavaScript" reopened a rondo doc). Reseed the
          // project in the chosen language - predictable beats preserving
          // edits written in a language they just opted out of.
          editor.setLang(lang)
          editor.loadCode(welcomeCode(lang))
        }
      } catch (e) {
        // no project library (IDB mount failed): still land on the welcome
        // track so the coach-mark anchors exist
        console.warn('[tour] library unavailable; loading welcome buffer only', e)
        editor.setLang(lang)
        editor.loadCode(welcomeCode(lang))
      }
      // wait a frame so the header/palette re-layout before measuring anchors
      requestAnimationFrame(() => begin())
    })()
  }

  /** The whole flow, from the survey. Any in-flight coach bubble is dropped
   *  first (a replay can start while a previous run is mid-tour). */
  const runFlow = (): void => {
    machine = null
    render(null)
    showSurvey()
  }

  // ---- first-run auto-start ----
  let auto = false
  try {
    auto = shouldShowTour({
      storage: safeStorage,
      shareHash: readShareHash(location.hash),
    })
  } catch {
    auto = false // never let onboarding break boot
  }
  if (auto) requestAnimationFrame(() => runFlow())

  return {
    start: () => {
      try {
        localStorage.removeItem(TOUR_DONE_KEY)
      } catch {
        // storage failures only affect remembering, not this run
      }
      runFlow()
    },
    dispose: () => {
      offState()
      offDoc()
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      clearRing()
      pop.remove()
      surveyBackdrop.remove()
      machine = null
      current = null
    },
  }
}
