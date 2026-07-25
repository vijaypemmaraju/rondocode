import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { compile } from '@rondocode/rondo'
import { SECTIONS } from '../src/docs/content'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* The guide claims every code block is a COMPLETE, copy-paste-ready program
 * (content.ts header). Pin that: every kind:'code' block must eval clean
 * against the real scope + staging — the exact path the docs' Run button and
 * "open in editor" take — with zero error diagnostics. RONDO blocks take the
 * docs page's exact path too: compile() first, then eval the output. Catches
 * a snippet that drifts out of sync with either language.
 *
 * Beyond evaling, snippets are held to the EXAMPLES bar (examples.test.ts):
 * every registered pattern must produce sounding events — a numeric note plus
 * a sound naming a synth the same snippet defines — because a docs snippet
 * that runs silently is as broken to a reader as one that throws. */

const codeBlocks = SECTIONS.flatMap((s) =>
  s.blocks.filter((b) => b.kind === 'code').map((b) => ({ id: s.id, text: b.text, lang: b.lang })),
)

/** Section ids whose snippets legitimately produce no sounding events (none
 *  today — every current snippet sounds; add an id here WITH a reason if a
 *  purely visual / mic-only snippet ever lands). */
const SILENT_OK = new Set<string>([])

describe('docs guide snippets', () => {
  it('has code blocks in both languages', () => {
    expect(codeBlocks.filter((b) => b.lang === undefined).length).toBeGreaterThan(10)
    expect(codeBlocks.filter((b) => b.lang === 'rondo').length).toBeGreaterThanOrEqual(8)
  })

  for (const { id, text, lang } of codeBlocks) {
    it(`section '${id}' ${lang ?? 'js'} snippet evals clean and sounds`, () => {
      let source = text
      if (lang === 'rondo') {
        const r = compile(text)
        expect(r.ok, `rondo compile: ${JSON.stringify(r.ok ? [] : r.errors)}`).toBe(true)
        if (!r.ok) return
        source = r.code
      }
      const result = evalCode(source, baseScope)
      const errors = result.diagnostics.filter((d) => d.severity === 'error')
      expect(errors, `errors: ${JSON.stringify(errors)}`).toEqual([])
      expect(result.ok).toBe(true)
      expect(result.patterns.size).toBeGreaterThanOrEqual(1)
      if (SILENT_OK.has(id)) return
      // the examples bar: sounding events routed to synths this snippet defines
      const span = new TimeSpan(F(0), F(2))
      for (const [name, pat] of result.patterns) {
        const sounding = pat
          .query(span)
          .filter(hasOnset)
          .filter((h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string')
        expect(sounding.length, `pattern '${name}' produces no sounding events`).toBeGreaterThanOrEqual(1)
        for (const h of sounding) {
          expect(result.synths.has(h.value.sound as string), `pattern '${name}' routes to undefined sound '${String(h.value.sound)}'`).toBe(true)
        }
      }
    })
  }
})
