import { describe, expect, it } from 'vitest'
import { codeSpan, dslReferenceMarkdown, examplesMarkdown } from '../src/docs-gen'
import { DSL_DOCS } from '../../app/src/docs/dsl-docs'
import { EXAMPLES } from '../../app/src/examples/index'

/* Generator tests run against the REAL data modules: the resource an agent
 * reads is dslReferenceMarkdown(DSL_DOCS), so that exact pairing is what
 * gets pinned — every documented name present, sections in place, and no
 * markdown-breaking backtick collisions from DSL code like m`...`. */

describe('codeSpan', () => {
  it('wraps plain content in single backticks', () => {
    expect(codeSpan('euclid(3, 8)')).toBe('`euclid(3, 8)`')
  })

  it('grows the delimiter past internal backtick runs', () => {
    expect(codeSpan('m`bd ~ sn ~`')).toBe('`` m`bd ~ sn ~` ``')
  })

  it('pads content that starts or ends with a backtick', () => {
    expect(codeSpan('`x')).toBe('`` `x ``')
    // Space padding keeps the delimiter unambiguous per CommonMark.
    expect(codeSpan('x`')).toBe('`` x` ``')
  })
})

describe('dslReferenceMarkdown', () => {
  const md = dslReferenceMarkdown(DSL_DOCS)

  it('contains every DocEntry name', () => {
    for (const e of DSL_DOCS) {
      expect(md, `missing entry '${e.name}'`).toContain(`**${e.name}**`)
    }
  })

  it('renders one bullet per entry (no drops, no dupes)', () => {
    expect(md.match(/^- \*\*/gm)?.length).toBe(DSL_DOCS.length)
  })

  it('groups entries under the five kind headings', () => {
    for (const heading of [
      '## Globals',
      '## Pattern methods',
      '## Synth building',
      '## Signal math',
      '## Mini-notation',
    ]) {
      expect(md).toContain(heading)
    }
  })

  it('keeps backtick-bearing signatures/examples inside safe code spans', () => {
    // The m global: signature and example both contain literal backticks.
    expect(md).toContain('`` m`...` ``')
    expect(md).toContain('`` m`bd ~ sn ~` ``')
    // No triple-backtick fences sneak into the reference (bullets only).
    expect(md).not.toContain('```')
  })

  it('carries a known entry with signature, summary and example', () => {
    expect(md).toContain('**euclid**')
    expect(md).toContain('`euclid(pulses: number, steps: number, rotation?: number)`')
    expect(md).toContain('tresillo')
  })
})

describe('examplesMarkdown', () => {
  const md = examplesMarkdown(EXAMPLES)

  it('includes every example name as a heading with its code fenced', () => {
    for (const ex of EXAMPLES) {
      expect(md).toContain(`## ${ex.name}`)
      expect(md).toContain(ex.code.trimEnd())
    }
    expect(md.match(/^```js$/gm)?.length).toBe(EXAMPLES.length)
  })

  it('derives the one-line description from the leading comment', () => {
    // Description line directly under the heading, `//` marker stripped
    // (the marker survives only inside the fenced code itself).
    expect(md).toContain('## ambient bells\n\nambient bells, long tails, lots of space.')
  })
})
