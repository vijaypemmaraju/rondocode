import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { compile } from '@rondocode/rondo'
import {
  LANG_PREF_KEY,
  SURVEY_OPTIONS,
  SURVEY_SKIP_LABEL,
  SURVEY_TITLE,
  WELCOME_PROJECT_NAME,
  WELCOME_RONDO,
  readLangPref,
  surveyLang,
  welcomeCode,
  writeLangPref,
} from '../src/ui/onboarding'
import type { PrefStorage } from '../src/ui/onboarding'
import { findProjectNamed } from '../src/session/projects'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* Onboarding v2's pure half: the survey -> language mapping, the persisted
 * preference's storage semantics, the replay decision (reopen the saved
 * welcome project vs recreate it), and the welcome track itself, which must
 * compile + eval clean + SOUND in both languages because the coach marks
 * point at anchors this source guarantees (a knob, a beat, a play block). */

const memStorage = (init?: Record<string, string>): PrefStorage & { data: Map<string, string> } => {
  const data = new Map(Object.entries(init ?? {}))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  }
}

describe('survey', () => {
  it('maps JavaScript writers to the JS DSL and everyone else to rondo', () => {
    expect(surveyLang('js')).toBe('rondocode')
    expect(surveyLang('simple')).toBe('rondo')
    expect(surveyLang('music')).toBe('rondo')
  })

  it('offers exactly the three options, in order', () => {
    expect(SURVEY_OPTIONS.map((o) => o.choice)).toEqual(['js', 'simple', 'music'])
    expect(SURVEY_OPTIONS.map((o) => o.label)).toEqual([
      'I write JavaScript',
      'I code, but keep it simple',
      "I'm here for the music",
    ])
  })

  it('has no em dashes anywhere in the survey copy', () => {
    for (const text of [SURVEY_TITLE, SURVEY_SKIP_LABEL, ...SURVEY_OPTIONS.map((o) => o.label)]) {
      expect(text).not.toMatch(/—/)
    }
  })
})

describe('language preference (rc.langPref)', () => {
  it('round-trips through storage', () => {
    const s = memStorage()
    writeLangPref('rondocode', s)
    expect(s.data.get(LANG_PREF_KEY)).toBe('rondocode')
    expect(readLangPref(s)).toBe('rondocode')
    writeLangPref('rondo', s)
    expect(readLangPref(s)).toBe('rondo')
  })

  it('reads null when unset or when the stored value is not a language', () => {
    expect(readLangPref(memStorage())).toBeNull()
    expect(readLangPref(memStorage({ [LANG_PREF_KEY]: 'klingon' }))).toBeNull()
  })

  it('survives a storage that throws (read -> null, write -> no throw)', () => {
    const broken: PrefStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(readLangPref(broken)).toBeNull()
    expect(() => writeLangPref('rondo', broken)).not.toThrow()
  })
})

describe('replay resolution (findProjectNamed)', () => {
  const projects = [
    { id: 'c', name: 'welcome' }, // listProjects() is updatedAt-desc: freshest first
    { id: 'a', name: 'untitled' },
    { id: 'b', name: 'welcome' },
  ]

  it('reopens the freshest project with the exact welcome name', () => {
    expect(findProjectNamed(projects, WELCOME_PROJECT_NAME)?.id).toBe('c')
  })

  it('recreates when no project has the name (deleted welcome, empty library)', () => {
    expect(findProjectNamed([], WELCOME_PROJECT_NAME)).toBeUndefined()
    expect(findProjectNamed([{ id: 'a', name: 'welcome copy' }], WELCOME_PROJECT_NAME)).toBeUndefined()
  })
})

describe('the welcome track', () => {
  it('has no em dashes in its comments', () => {
    expect(WELCOME_RONDO).not.toMatch(/—/)
  })

  it('welcomeCode returns the rondo source for rondo and the compiled twin for JS', () => {
    expect(welcomeCode('rondo')).toBe(WELCOME_RONDO)
    const c = compile(WELCOME_RONDO)
    expect(c.ok).toBe(true)
    if (c.ok) expect(welcomeCode('rondocode')).toBe(c.code)
  })

  it('guarantees the widget anchor: the rondo source declares a knob', () => {
    expect(WELCOME_RONDO).toMatch(/knob /)
  })

  // Same harness as examples.test.ts: eval against the REAL scope + staging
  // (the exact path the Run button takes) and require every pattern to
  // produce sounding events routed at synths the source defines.
  for (const lang of ['rondo', 'rondocode'] as const) {
    it(`evals clean and every pattern sounds (${lang})`, () => {
      const src = welcomeCode(lang)
      const code = lang === 'rondo' ? (() => {
        const c = compile(src)
        expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
        return c.ok ? c.code : ''
      })() : src
      const result = evalCode(code, baseScope)
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      expect(result.ok).toBe(true)
      expect(result.synths.size).toBeGreaterThanOrEqual(3) // lead, kick, hat
      expect(result.patterns.size).toBeGreaterThanOrEqual(2) // beat, lead
      const span = new TimeSpan(F(0), F(2))
      for (const [name, pat] of result.patterns) {
        const sounding = pat
          .query(span)
          .filter(hasOnset)
          .filter((h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string')
        expect(sounding.length, `pattern '${name}'`).toBeGreaterThanOrEqual(1)
        for (const h of sounding) {
          expect(result.synths.has(h.value.sound as string), `sound '${String(h.value.sound)}'`).toBe(true)
        }
      }
    })
  }
})
