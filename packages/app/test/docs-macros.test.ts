import { describe, expect, it } from 'vitest'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'
import { SECTIONS } from '../src/docs/content'
import { compile } from '@rondocode/rondo'

/* The guide teaches macros in both languages, and a sample that does not run
 * is worse than no sample: it is the first thing a reader copies. */

describe.each(['macros', 'curves'])('the %s guide section', (id) => {
  const sec = SECTIONS.find((s) => s.id === id)!
  const blocks = sec.blocks.filter((b): b is Extract<typeof b, { kind: 'code' }> => b.kind === 'code')

  it('every JS sample it shows actually evals', () => {
    for (const b of blocks) {
      if ((b as { lang?: string }).lang === 'rondo') continue
      const r = evalCode(b.text, baseScope)
      expect(r.diagnostics.filter((d) => d.severity === 'error'), b.text.slice(0, 50)).toEqual([])
    }
  })

  it('every rondo sample it shows actually compiles', () => {
    for (const b of blocks) {
      if ((b as { lang?: string }).lang !== 'rondo') continue
      const c = compile(b.text)
      expect(c.ok, JSON.stringify(c.errors)).toBe(true)
    }
  })
})
