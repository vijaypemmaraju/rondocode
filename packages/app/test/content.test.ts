import { describe, expect, it } from 'vitest'
import { GOTCHAS } from '../src/docs/gotchas'
import { BROKEN_ON_PURPOSE, runnableCodeBlocks } from '../src/docs/content'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { compile } from '@rondocode/rondo'
import { SECTIONS } from '../src/docs/content'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'
import { EXTERNAL_OUTPUTS } from '../src/session/Session'

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

/* Troubleshooting sections show a DELIBERATELY broken snippet beside its fix,
 * so "every snippet on this page runs" cannot hold there. The exclusion is per
 * BLOCK, not per section: the fixed half still has to meet the same bar as the
 * rest of the page. And the broken half is not merely skipped — gotchas.test.ts
 * asserts it still fails, in the exact way its entry claims, so nothing can
 * quietly rot behind this caption. */
const codeBlocks = runnableCodeBlocks()

/** Section ids whose snippets legitimately produce no sounding events (none
 *  today — every current snippet sounds; add an id here WITH a reason if a
 *  purely visual / mic-only snippet ever lands). */
const SILENT_OK = new Set<string>([])

/* The caption is load-bearing now, so pin that it still matches something.
 * A renamed caption would silently re-include every broken snippet — or, if
 * the match got looser, silently EXCLUDE working ones from the guarantee. */
const excluded = SECTIONS.flatMap((s) => s.blocks).filter(
  (b) => b.kind === 'code' && (b.caption ?? '').startsWith(BROKEN_ON_PURPOSE),
)

describe('docs guide snippets', () => {
  it('excludes exactly the deliberately-broken snippets, one per gotcha', () => {
    expect(excluded).toHaveLength(GOTCHAS.length)
  })

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
        const onsets = pat.query(span).filter(hasOnset)
        // a pattern routed to an output outside the engine (the LED mask)
        // does not sound; it has to have events, and every one must go there
        if (onsets.length > 0 && onsets.every((h) => EXTERNAL_OUTPUTS.has(h.value.sound as string))) continue
        const sounding = onsets.filter((h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string')
        expect(sounding.length, `pattern '${name}' produces no sounding events`).toBeGreaterThanOrEqual(1)
        for (const h of sounding) {
          expect(result.synths.has(h.value.sound as string), `pattern '${name}' routes to undefined sound '${String(h.value.sound)}'`).toBe(true)
        }
      }
    })
  }
})
