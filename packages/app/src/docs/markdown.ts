import { HERO, SECTIONS } from './content'
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

export function docsMarkdown(): string {
  const out: string[] = []
  out.push(`# ${HERO.title}`, '', HERO.tagline, '', HERO.blurb, '')

  out.push('## Guide', '')
  for (const s of SECTIONS) {
    out.push(`### ${s.title}`, '')
    for (const b of s.blocks) {
      if (b.kind === 'p') {
        out.push(b.text, '')
      } else {
        if (b.caption) out.push(`_${b.caption}_`, '')
        out.push(b.lang === 'rondo' ? '```rondo' : '```js', b.text, '```', '')
      }
    }
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
