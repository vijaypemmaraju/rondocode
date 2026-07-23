import { describe, expect, it } from 'vitest'
import { SECTIONS } from '../src/docs/content'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* The guide claims every code block is a COMPLETE, copy-paste-ready program
 * (content.ts header). Pin that: every kind:'code' block must eval clean
 * against the real scope + staging — the exact path the docs' Run button and
 * "open in editor" take — with zero error diagnostics. Catches a snippet that
 * drifts out of sync with the DSL (a renamed ctx member, a removed method). */

const codeBlocks = SECTIONS.flatMap((s) =>
  s.blocks.filter((b) => b.kind === 'code').map((b) => ({ id: s.id, text: b.text })),
)

describe('docs guide snippets', () => {
  it('has a code block in most sections', () => {
    expect(codeBlocks.length).toBeGreaterThan(10)
  })

  for (const { id, text } of codeBlocks) {
    it(`section '${id}' snippet evals clean`, () => {
      const result = evalCode(text, baseScope)
      const errors = result.diagnostics.filter((d) => d.severity === 'error')
      expect(errors, `errors: ${JSON.stringify(errors)}`).toEqual([])
      expect(result.ok).toBe(true)
      expect(result.patterns.size).toBeGreaterThanOrEqual(1)
    })
  }
})
