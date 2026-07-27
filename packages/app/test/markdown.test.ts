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

  it('keeps rich blocks STRUCTURED: real Markdown tables, lists and blockquotes', () => {
    const tables = SECTIONS.flatMap((s) => s.blocks).filter((b) => b.kind === 'table')
    const lists = SECTIONS.flatMap((s) => s.blocks).filter((b) => b.kind === 'list')
    const notes = SECTIONS.flatMap((s) => s.blocks).filter((b) => b.kind === 'note')
    expect(tables.length).toBeGreaterThan(0)
    expect(lists.length).toBeGreaterThan(0)
    expect(notes.length).toBeGreaterThan(0)

    for (const t of tables) {
      // header row + its delimiter row, verbatim (pipes inside cells escaped)
      expect(md, `table headers '${t.headers.join('/')}'`).toContain(`| ${t.headers.join(' | ')} |`)
      expect(md).toContain(`| ${t.headers.map(() => '---').join(' | ')} |`)
      for (const row of t.rows) {
        expect(md, `row '${row[0] ?? ''}'`).toContain(`| ${row.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`)
      }
    }
    for (const l of lists) {
      l.items.forEach((it, i) => expect(md).toContain(l.ordered === true ? `${i + 1}. ${it}` : `- ${it}`))
    }
    for (const n of notes) {
      expect(md).toContain(`> **${n.tone === 'warn' ? 'Warning' : 'Note'}:** ${n.text}`)
    }
  })

  it('a Markdown table is well formed: a delimiter row under every header row, columns matching', () => {
    const lines = md.split('\n')
    const cells = (line: string): number => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length
    let sawOne = false
    for (const [i, line] of lines.entries()) {
      if (!/^\|\s*---/.test(line)) continue
      sawOne = true
      const header = lines[i - 1] ?? ''
      expect(header.startsWith('|'), `delimiter row at line ${i} has no header above it`).toBe(true)
      expect(cells(line), `delimiter width at line ${i}`).toBe(cells(header))
      // and a blank line above the header, or the table will not render
      expect((lines[i - 2] ?? '').trim() === '' || (lines[i - 2] ?? '').startsWith('_')).toBe(true)
      // every body row matches the header's column count
      for (let j = i + 1; j < lines.length && (lines[j] ?? '').startsWith('|'); j++) {
        expect(cells(lines[j] ?? ''), `body row at line ${j}`).toBe(cells(header))
      }
    }
    expect(sawOne).toBe(true)
  })

  it('is tidy text: no triple blank lines, single trailing newline', () => {
    expect(md).not.toMatch(/\n{3,}/)
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
  })
})
