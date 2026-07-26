import { compile } from '@rondocode/rondo'
import type { EditorLang } from '../editor/editor'

/* ------------------------------------------------------------------------- *
 * Onboarding v2, the pure half (node-testable; the DOM lives in ui/tour.ts).
 *
 * The first-run flow is: one-question experience survey -> the answer sets
 * the DEFAULT LANGUAGE (persisted as rc.langPref) -> a dedicated 'welcome'
 * project is created in that language -> the coach marks run against anchors
 * the welcome source GUARANTEES (a knob, a beat, a play block). That fixes
 * v1's two flaws: the tour no longer narrates whatever doc happens to be
 * loaded, and it learns how the user wants to write music.
 * ------------------------------------------------------------------------- */

/** The three survey answers (plus skip, which is `null` at the call sites). */
export type SurveyChoice = 'js' | 'simple' | 'music'

export const SURVEY_TITLE = 'How do you want to write music?'
export const SURVEY_SKIP_LABEL = 'maybe later'

/** The survey options in display order. Copy is data so tests can pin it
 *  (house rule: no em dashes anywhere in user-facing copy). */
export const SURVEY_OPTIONS: readonly { choice: SurveyChoice; label: string }[] = [
  { choice: 'js', label: 'I write JavaScript' },
  { choice: 'simple', label: 'I code, but keep it simple' },
  { choice: 'music', label: "I'm here for the music" },
]

/** Survey answer -> default language. JavaScript writers get the JS DSL
 *  ('rondocode'); everyone else gets rondo, the terse mobile-native language. */
export const surveyLang = (choice: SurveyChoice): EditorLang =>
  choice === 'js' ? 'rondocode' : 'rondo'

/** localStorage key for the surveyed language preference. */
export const LANG_PREF_KEY = 'rc.langPref'

/** The storage seam (localStorage-shaped); tests inject a stub. */
export interface PrefStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The stored language preference, or null when unset/invalid/unreadable.
 *  Callers fall back to the per-device heuristic (editor.ts initialLang). */
export const readLangPref = (storage: PrefStorage): EditorLang | null => {
  try {
    const v = storage.getItem(LANG_PREF_KEY)
    return v === 'rondo' || v === 'rondocode' ? v : null
  } catch {
    return null
  }
}

/** Persist the surveyed preference. Throw-safe: a full/private-mode storage
 *  only costs remembering the answer, never the flow. */
export const writeLangPref = (lang: EditorLang, storage: PrefStorage): void => {
  try {
    storage.setItem(LANG_PREF_KEY, lang)
  } catch {
    // preference just won't persist across visits
  }
}

/** The dedicated onboarding project. Replay reopens it by this name. */
export const WELCOME_PROJECT_NAME = 'welcome'

/** The welcome track, in rondo: three synths (one with a knob, so the tour's
 *  widget anchor exists by construction), a beat, a play block, a tempo. */
export const WELCOME_RONDO = `# WELCOME. this is a track.
# press play, then touch things.

synth lead
  saw
  ladder cutoff res:.4
  * env
  * .8
  env = adsr .01 .15 .5 .2
  cutoff = knob 1200 100..6000 log

synth kick
  sine 55
  * env
  env = adsr .001 .12 0 .05

synth hat
  noise pink
  svf 6000 mode:hp
  * env
  * .5
  env = adsr .001 .04 0 .03

beat
  kick ~ kick ~
  ~ hat ~ hat

play lead
  0 3 5 3
  scale: a-min
  dur: .75

cps .5
`

/** The welcome source for a given language. The JavaScript twin is produced
 *  by the rondo compiler, i.e. the exact text the language toggle would show
 *  (the fallback branch is unreachable: tests pin that the source compiles). */
export const welcomeCode = (lang: EditorLang): string => {
  if (lang !== 'rondocode') return WELCOME_RONDO
  const c = compile(WELCOME_RONDO)
  return c.ok ? c.code : WELCOME_RONDO
}
