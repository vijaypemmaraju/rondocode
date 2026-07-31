/* ------------------------------------------------------------------------- *
 * What the "?" reference lists, per language.
 *
 * The panel was generated straight from DSL_DOCS: globals, pattern methods,
 * the synth builder, mini-notation. All of it JavaScript. A rondo user opened
 * the reference and read `svf(inp, cutoff, opts?)` for a language whose actual
 * spelling is `svf cutoff res:…` — accurate about JavaScript and about nothing
 * they can type. The same complaint that produced rondoHover, one surface
 * later.
 *
 * rondo's vocabulary already exists, in OPTIONS: a signature, a summary and
 * (for most words) an example. This groups it the way the tokenizer already
 * classifies it — block headers, pattern modifiers, synth builtins — reading
 * the same word sets, so a word added to the language cannot go missing from
 * the reference.
 *
 * MINI-NOTATION IS SHARED. `<0 3>*2` means the same thing in both languages,
 * so those entries come from DSL_DOCS in both. Restating them in rondo's table
 * would be a second copy of notation that has only one implementation.
 *
 * Pure, so the grouping and the search are testable without a panel.
 * ------------------------------------------------------------------------- */

import type { DocEntry } from '../docs/dsl-docs'
import type { DocBlock } from './docblock'
import type { EditorLang } from './editor'
import type { RondoOption } from './rondo'
import { BUILDER_GROUPS } from '../docs/dsl-docs'
import { BUILTINS, KEYWORDS, MODIFIERS } from './rondo/words'

export interface RefGroup {
  title: string
  entries: DocBlock[]
}

const blockOf = (e: DocEntry): DocBlock => ({
  signature: e.signature,
  summary: e.summary,
  ...(e.example !== undefined ? { example: e.example } : {}),
})

const blockOfOption = (o: RondoOption): DocBlock => ({
  signature: String(o.detail ?? o.label),
  summary: String(o.info ?? ''),
  ...(o.example !== undefined ? { example: o.example } : {}),
})

/** The mini-notation entries, which both languages share verbatim. */
const miniGroup = (docs: readonly DocEntry[]): RefGroup => ({
  title: 'mini-notation',
  entries: docs.filter((e) => e.kind === 'mini-syntax').map(blockOf),
})

/**
 * The reference, grouped, in the language the project is written in.
 *
 * rondo's three groups follow the tokenizer's own three-way split, so what is
 * highlighted as a block word is listed as a block word. A word in OPTIONS
 * that belongs to none of the sets still appears, under "other" — silently
 * dropping a documented word is how a reference starts lying.
 */
export function referenceGroups(
  lang: EditorLang,
  options: readonly RondoOption[],
  docs: readonly DocEntry[],
): RefGroup[] {
  if (lang !== 'rondo') {
    return [
      ...BUILDER_GROUPS.map((g) => ({
        title: g.title,
        entries: docs.filter((e) => g.kinds.includes(e.kind)).map(blockOf),
      })),
      miniGroup(docs),
    ].filter((g) => g.entries.length > 0)
  }
  const pick = (has: (w: string) => boolean): DocBlock[] =>
    options.filter((o) => has(String(o.label))).map(blockOfOption)
  const known = (w: string): boolean => KEYWORDS.has(w) || MODIFIERS.has(w) || BUILTINS.has(w)
  return [
    { title: 'blocks', entries: pick((w) => KEYWORDS.has(w)) },
    { title: 'pattern modifiers', entries: pick((w) => MODIFIERS.has(w) && !KEYWORDS.has(w)) },
    { title: 'synth builtins', entries: pick((w) => BUILTINS.has(w) && !KEYWORDS.has(w) && !MODIFIERS.has(w)) },
    { title: 'other', entries: pick((w) => !known(w)) },
    miniGroup(docs),
  ].filter((g) => g.entries.length > 0)
}

/** Groups narrowed to a search, empty groups dropped. Matches on every field
 *  shown, so searching for a word you can see always finds its row. */
export function filterGroups(groups: readonly RefGroup[], query: string): RefGroup[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...groups]
  return groups
    .map((g) => ({
      title: g.title,
      entries: g.entries.filter((e) =>
        `${e.signature} ${e.summary} ${e.example ?? ''}`.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.entries.length > 0)
}
