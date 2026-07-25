import { describe, expect, it } from 'vitest'
import { HERO, SECTIONS } from '../src/docs/content'
import { DSL_DOCS, docsOfKind } from '../src/docs/dsl-docs'
import { docsMarkdown } from '../src/docs/markdown'

/* docsMarkdown becomes the SHIPPED /llms.txt (emitted at build) and the docs
 * page's "copy for LLMs" payload. The killer regression would be a new
 * DocEntry kind that no REF_GROUP includes — every entry of that kind would
 * silently vanish from the reference. So: every kind that EXISTS in DSL_DOCS
 * must surface its entries in the output. Structure checks are shape-ish,
 * never exact bytes (copy edits must not break this test). */

const md = docsMarkdown()

describe('docsMarkdown (llms.txt)', () => {
  it('renders every entry of every DocEntry kind (a new kind cannot silently vanish)', () => {
    const kinds = [...new Set(DSL_DOCS.map((e) => e.kind))]
    expect(kinds.length).toBeGreaterThanOrEqual(5) // global/pattern-method/synth-ctx/sig-method/mini-syntax
    for (const kind of kinds) {
      const entries = docsOfKind(kind)
      expect(entries.length, `kind '${kind}' has entries`).toBeGreaterThan(0)
      for (const e of entries) {
        expect(md, `kind '${kind}' entry '${e.name}' missing from the reference`).toContain(`\`${e.signature}\`:`)
      }
    }
  })

  it('has the hero + guide + reference skeleton', () => {
    expect(md.startsWith(`# ${HERO.title}`)).toBe(true)
    expect(md).toContain('## Guide')
    expect(md).toContain('## Reference')
    for (const s of SECTIONS) expect(md, `guide section '${s.id}'`).toContain(`### ${s.title}`)
  })

  it('fences every guide code block with its language, balanced', () => {
    const fences = md.match(/^```.*$/gm) ?? []
    expect(fences.length % 2).toBe(0)
    const opens = fences.filter((f) => f !== '```')
    const codeBlocks = SECTIONS.flatMap((s) => s.blocks.filter((b) => b.kind === 'code'))
    expect(opens.length).toBe(codeBlocks.length)
    for (const f of opens) expect(['```js', '```rondo']).toContain(f)
  })

  it('is tidy text: no triple blank lines, single trailing newline', () => {
    expect(md).not.toMatch(/\n{3,}/)
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
  })
})
