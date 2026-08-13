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
import { rank, terms } from '../docs/search'
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

/**
 * Groups narrowed to a search, empty groups dropped, best match first.
 *
 * EVERY TERM must appear, not the query as one substring. Measured on the
 * shipped reference: `reverb` matched 5 entries and `mix` matched 17, while
 * `reverb mix` matched none — and so did every other two-word query, which is
 * how a reader naturally describes what they are after.
 *
 * Ranked within each group, because matching on every field shown means a
 * common word like `mix` matches 17 rows and the one actually called `mix`
 * has to be first.
 */
/** The leading identifier of a signature: `reverb` from `reverb(input, …)`,
 *  `a*n` from the mini-notation rows that have no parentheses. */
const symbolName = (signature: string): string =>
  (/^[^(\s:]+/.exec(signature.trim())?.[0] ?? signature).toLowerCase()

export function filterGroups(groups: readonly RefGroup[], query: string): RefGroup[] {
  const ts = terms(query)
  if (ts.length === 0) return [...groups]
  /* GROUPS MOVE TOO. Ranking only inside a group leaves the best answer under
   * whichever group happens to come first in authoring order: searching
   * `reverb` put a `synth(...)` row that merely mentions it above the `reverb`
   * entry itself, because globals are listed before effects. A search has no
   * reason to preserve the browsing order. */
  return groups
    .map((g) => {
      const ranked = rank(g.entries, ts, (e) => ({
        /* The SYMBOL NAME, not the whole signature. Every argument list is
         * full of common words, so `mix` ranked `supersaw(freq, opts?: {
         * detune?, mix? })` level with `mix(...)` itself. What a reader typed
         * is nearly always the name. */
        title: symbolName(e.signature),
        body: `${e.signature} ${e.summary} ${e.example ?? ''}`.toLowerCase(),
      }))
      return { title: g.title, entries: ranked.map((r) => r.item), best: ranked[0]?.score ?? -1 }
    })
    .filter((g) => g.entries.length > 0)
    .sort((a, b) => b.best - a.best)
    .map(({ title, entries }) => ({ title, entries }))
}
