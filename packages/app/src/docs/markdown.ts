import { HERO, orderedSections } from './content'
import type { Block } from './content'
import { docsOfKind } from './dsl-docs'
import type { DocEntry } from './dsl-docs'

/* A single Markdown rendering of the whole docs page (guide + reference), for
 * LLMs to consume: served as /llms.txt (emitted at build) and offered via a
 * "copy for LLMs" button on the docs page. Pure data in, string out. */

const REF_GROUPS: { title: string; kinds: DocEntry['kind'][] }[] = [
  { title: 'Globals', kinds: ['global'] },
  { title: 'Pattern methods', kinds: ['pattern-method'] },
  { title: 'Synth builder', kinds: ['synth-ctx', 'sig-method'] },
  { title: 'Mini-notation', kinds: ['mini-syntax'] },
]

/** A cell's `|` would end the column early, so escape it. */
const cell = (s: string): string => s.replace(/\|/g, '\\|')

/** One guide block as real Markdown: tables stay tables, lists stay lists and
 *  notes stay blockquotes, so the structure survives into the LLM's context
 *  instead of collapsing back into a wall of prose. */
function blockMarkdown(b: Block, out: string[]): void {
  switch (b.kind) {
    case 'p':
      out.push(b.text, '')
      return
    case 'code':
      if (b.caption !== undefined && b.caption !== '') out.push(`_${b.caption}_`, '')
      out.push(b.lang === 'rondo' ? '```rondo' : '```js', b.text, '```', '')
      return
    case 'note':
      out.push(`> **${b.tone === 'warn' ? 'Warning' : 'Note'}:** ${b.text}`, '')
      return
    case 'list':
      b.items.forEach((it, i) => out.push(b.ordered === true ? `${i + 1}. ${it}` : `- ${it}`))
      out.push('')
      return
    case 'table':
      if (b.caption !== undefined && b.caption !== '') out.push(`_${b.caption}_`, '')
      out.push(`| ${b.headers.map(cell).join(' | ')} |`)
      out.push(`| ${b.headers.map(() => '---').join(' | ')} |`)
      for (const row of b.rows) out.push(`| ${b.headers.map((_, i) => cell(row[i] ?? '')).join(' | ')} |`)
      out.push('')
  }
}

export function docsMarkdown(): string {
  const out: string[] = []
  out.push(`# ${HERO.title}`, '', HERO.tagline, '', HERO.blurb, '')

  out.push('## Guide', '')
  for (const s of orderedSections()) {
    out.push(`### ${s.title}`, '')
    for (const b of s.blocks) blockMarkdown(b, out)
  }

  out.push('## Reference', '')
  for (const grp of REF_GROUPS) {
    out.push(`### ${grp.title}`, '')
    for (const e of grp.kinds.flatMap((k) => docsOfKind(k))) {
      out.push(`- \`${e.signature}\`: ${e.summary}`)
      if (e.example !== undefined) out.push(`  - example: \`${e.example}\``)
    }
    out.push('')
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
