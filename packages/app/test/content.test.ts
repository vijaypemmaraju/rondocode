import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { SECTIONS } from '../src/docs/content'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* The guide claims every code block is a COMPLETE, copy-paste-ready program
 * (content.ts header). Pin that: every kind:'code' block must eval clean
 * against the real scope + staging — the exact path the docs' Run button and
 * "open in editor" take — with zero error diagnostics. RONDO blocks take the
 * docs page's exact path too: compile() first, then eval the output. Catches
 * a snippet that drifts out of sync with either language. */

const codeBlocks = SECTIONS.flatMap((s) =>
  s.blocks.filter((b) => b.kind === 'code').map((b) => ({ id: s.id, text: b.text, lang: b.lang })),
)

describe('docs guide snippets', () => {
  it('has code blocks in both languages', () => {
    expect(codeBlocks.filter((b) => b.lang === undefined).length).toBeGreaterThan(10)
    expect(codeBlocks.filter((b) => b.lang === 'rondo').length).toBeGreaterThanOrEqual(8)
  })

  for (const { id, text, lang } of codeBlocks) {
    it(`section '${id}' ${lang ?? 'js'} snippet evals clean`, () => {
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
    })
  }
})
